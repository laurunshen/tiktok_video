import { GoogleGenAI } from '@google/genai'
import { readFile as readFileAsync, writeFile, unlink } from 'fs/promises'
import { statSync } from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { generateContentWithRetry } from './gemini-retry.js'

// 用 AI Studio API key 直连（key 绑定到 GCP 项目 eternal-concept-492907-q3，仍烧 Cloud 赠金）
// 之前走 Vertex（user-account ADC）会因 RAPT 政策每隔 16h-几周强制重登 → 已弃
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 900000 }, // 15分钟，给足多图分析时间（产品图越多 Gemini 理解越准确）
})

// Gemini inline 图片上限建议 1MB，超了先压缩
const GEMINI_IMAGE_MAX_BYTES = 1 * 1024 * 1024

// VARIANT 配方：同一标杆视频的多次裂变，每次用不同的模特 + 场景，避免 TikTok 查重
// 5 种配方都是美国 TikTok 内衣品类的真实主流分布（参考店铺投流标杆达人画像）
// 非美国市场或非内衣类目时，请相应调整这个表
export const VARIANT_RECIPES = {
  1: {
    label: 'Latina',
    presenter: 'Hispanic/Latina woman, mid-20s, olive to warm tan skin tone, dark brown wavy hair, warm facial features with a soft natural smile, naturally curvy body',
    scene: 'Bright morning bedroom with white linens and soft natural sunlight streaming through a sheer curtain. Minimal decor on the wall behind her.',
    cardigan_color: 'cream knit cardigan',
  },
  2: {
    label: 'All-American White',
    presenter: 'Caucasian woman, mid-20s, fair skin with light freckles, medium-length light brown or dirty blonde hair, soft oval face, slim-to-average body',
    scene: 'Cozy minimalist living room corner with a beige sofa and a single framed photo on the wall. Late afternoon golden window light from the side.',
    cardigan_color: 'oversized white linen cardigan',
  },
  3: {
    label: 'Curvy Influencer',
    presenter: 'Caucasian/mixed woman, mid-to-late 20s, fair skin, medium brown hair pulled back, full round face, plus-size curvy body type (size 14-16)',
    scene: 'White-tile bathroom with a large vanity mirror behind her. Bright overhead daylight + warm vanity bulbs. Clean uncluttered counter.',
    cardigan_color: 'soft taupe oversized cardigan',
  },
  4: {
    label: 'Mixed/Light Black',
    presenter: 'Light-skinned Black or mixed-race woman, mid-20s, warm caramel skin tone, natural curly hair pulled into a high puff, defined cheekbones, slim athletic body',
    scene: 'Hallway with a full-length mirror behind her, neutral beige wall paint and a hardwood floor. Soft window light from the left.',
    cardigan_color: 'black ribbed open cardigan',
  },
  5: {
    label: 'Girl-Next-Door Brunette',
    presenter: 'Caucasian/mixed-race woman, early-to-mid 20s, fair-to-light tan skin, dark brown or black straight long hair pulled into a low ponytail, friendly approachable face, slim body',
    scene: 'Vanity table corner with a small ring of soft warm bulbs around an oval mirror. Bedroom in the background blurred. Cozy intimate vibe.',
    cardigan_color: 'cropped grey hoodie left open',
  },
}

export function getVariantRecipe(seed) {
  const n = parseInt(seed)
  if (n >= 1 && n <= 5) return VARIANT_RECIPES[n]
  return null
}

// 强制注入 Seedance prompt 的固定指令块。Gemini 在长 prompt 里会偷偷压缩这些规则，
// 所以由 generate.js 拿到 Gemini 输出后用代码硬拼接，保证 100% 进入 Seedance prompt。
// 强制注入到 prompt 末尾的硬性约束块。按重要性从高到低排列。
// 设计原则：每块只保留 1-2 句最关键命令，避免稀释 PRODUCT VISUAL ANCHOR 的注意力。
export const SEEDANCE_MANDATORY_BLOCKS = `
[CHARACTER CONSISTENCY — TOP PRIORITY]
ONE PERSON only across the entire video. Same face, same hair, same makeup, same skin tone, same body in every shot — both LOOK A and LOOK B. The ONLY allowed change between shots is the cardigan being on or off (and body angle / hand position). NEVER swap to a different-looking woman.

[NO ON-SCREEN TEXT — TOP PRIORITY]
ZERO text in any frame: no subtitles, captions, watermarks, brand text, product names, or characters. Reference images may contain marketing text overlays ("Inbarely Plus Collection", "Double Layer Fabric", etc.) — IGNORE that text completely; the bra itself is clean and unmarked. Output must be LIVE-ACTION video of a person, NOT a slideshow stitching the reference photos.

[FACE & LIKENESS]
The presenter is a completely original AI-generated face — NOT the person in the reference video. Different face shape, different eyes, different nose.

[REFERENCE VIDEO BOUNDARY]
Use the reference video ONLY for camera shake, pacing, and gesture style. DO NOT copy from it: face, accessories on body, on-screen text/captions/stickers, audio ambience.

[AUDIO ENVIRONMENT]
INDOOR residential setting. Clean voice + very soft room tone only. NO outdoor wind, traffic, music, echo, or background noise. If reference was filmed outdoors, ignore that ambience.

[ANATOMICAL ACCURACY]
Hands have exactly 5 fingers in natural positions. No fused/extra/missing fingers. If a hand can't be rendered correctly, keep it out of frame.

[NO IMPROVISED DIALOGUE]
The presenter speaks ONLY the exact lines in SHOT SEQUENCE. NO "link in bio", "okay bye", "thanks for watching" or other ad-libbed closers.

[NO MIRROR FLIP — anti-shortcut for shot variation, CRITICAL]
Horizontally mirroring a previous frame is the #1 way the model cheats when given "another angle / different view / turn". DO NOT do this. Detection cues that EVERY shot must keep CONSISTENT (any flip = failure):
  • The asymmetric face mole / freckle stays on the SAME cheek across all shots
  • The hair parting stays on the SAME side (left part stays left)
  • The higher eyebrow stays on the SAME side
  • Any wall art / lamp / window / pillow stays on the SAME side of frame
  • Any visible asymmetric clothing detail (logo / bow / contrast trim) stays on the SAME side
If the SHOT SEQUENCE asks for "another angle", produce a genuine 3D-rotated body in the SAME room with the SAME camera position — never a horizontal flip. If a true rotation can't render cleanly, change the shot to "same camera angle, different action or expression" instead.
`.trim()

async function imageToInlinePart(filePath, originalName) {
  const { default: sharp } = await import('sharp')
  const ext = path.extname(originalName).toLowerCase()

  // 压缩到 1MB 以内
  let buffer = await sharp(filePath)
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()

  if (buffer.length > GEMINI_IMAGE_MAX_BYTES) {
    buffer = await sharp(buffer).jpeg({ quality: 60 }).toBuffer()
  }

  return {
    inlineData: {
      mimeType: 'image/jpeg',
      data: buffer.toString('base64'),
    },
  }
}

// 用 Gemini Files API 上传视频，返回 fileUri（避免 base64 inline 超时）
// 从本地文件上传视频到 Gemini Files API
async function uploadVideoFileToGemini(videoFilePath) {
  const ext = path.extname(videoFilePath).toLowerCase()
  const mimeType = ext === '.mov' ? 'video/quicktime' : 'video/mp4'
  const fileSize = statSync(videoFilePath).size

  console.log(`  [Gemini Files] 上传本地视频 ${(fileSize / 1024 / 1024).toFixed(1)} MB...`)

  const uploadedFile = await genai.files.upload({
    file: videoFilePath,
    config: { mimeType },
  })

  let file = uploadedFile
  let attempts = 0
  while (file.state === 'PROCESSING' && attempts < 30) {
    await new Promise(r => setTimeout(r, 3000))
    file = await genai.files.get({ name: file.name })
    attempts++
    console.log(`  [Gemini Files] 处理中... ${file.state} (${attempts})`)
  }

  if (file.state !== 'ACTIVE') {
    throw new Error(`Gemini Files 处理失败，state: ${file.state}`)
  }

  console.log(`  [Gemini Files] 上传完成: ${file.uri}`)
  return { uri: file.uri, mimeType, name: file.name }
}

// 远程视频 URL 直接作为 fileData URI 传给 Gemini（CDN 链接可直接访问）
function buildVideoUriPart(videoUrl) {
  return {
    fileData: {
      mimeType: 'video/mp4',
      fileUri: videoUrl,
    },
  }
}

// 单次请求：同时分析参考视频 + 筛选产品图 + 生成 Seedance 提示词
// 把 productInfo 对象格式化为给 Gemini 的文字描述
function formatProductInfo(productInfo) {
  if (!productInfo) return ''
  const lines = []
  if (productInfo.name) lines.push(`Product name: ${productInfo.name}`)
  if (productInfo.materials) lines.push(`Materials: ${productInfo.materials}`)
  if (productInfo.style) lines.push(`Style: ${productInfo.style}`)
  if (productInfo.season) lines.push(`Season: ${productInfo.season}`)
  if (productInfo.sleeveLength) lines.push(`Sleeve length: ${productInfo.sleeveLength}`)
  if (productInfo.design) lines.push(`Design: ${productInfo.design}`)
  if (productInfo.otherProperties?.length) {
    productInfo.otherProperties.forEach(p => {
      if (p.value) lines.push(`${p.name}: ${p.value}`)
    })
  }
  if (productInfo.variants?.length) {
    productInfo.variants.forEach(v => {
      if (v.values?.length) lines.push(`${v.name} options: ${v.values.join(', ')}`)
    })
  }
  if (productInfo.categories?.length) lines.push(`Category: ${productInfo.categories.join(' > ')}`)
  if (productInfo.price) lines.push(`Price: ${productInfo.price}`)
  return lines.join('\n')
}

export async function analyzeAndGeneratePrompt_OLD_SINGLE_CALL({
  videoFilePath,        // 参考视频本地路径（与 videoUrl 二选一）
  videoUrl,             // 参考视频远程直链，如 snaptik 无水印链接（与 videoFilePath 二选一）
  imageFiles,           // multer file objects [{ path, originalname }]（与 productImageUrls 二选一）
  productImageUrls,     // 产品图公网 URL 数组（从商品链接爬取，与 imageFiles 二选一）
  imageUrls,            // [{ index, url, originalname }] kie.ai 上传后的公网 URL（imageFiles 上传后的结果）
  userDescription,      // 用户补充说明
  targetDuration,       // 视频时长（秒）
  category = 'general', // 品类：'lingerie' | 'general'
  productInfo = null,   // 从 TikTok Shop 抓取的结构化商品信息
  isSameProduct = true, // 参考视频是否为本产品的带货视频
}) {
  // 视频：下载到本地后 inline base64 传给 Vertex AI（Vertex 不支持 Files API 也不能访问 TikTok CDN）
  let videoFilePart
  let uploadedVideoName = null
  let tmpVideoPath = null

  const sourceVideoPath = videoUrl ? null : videoFilePath
  if (videoUrl) {
    console.log(`  [Gemini] 下载视频...`)
    tmpVideoPath = path.join(os.tmpdir(), `${uuidv4()}.mp4`)
    const dlRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    await writeFile(tmpVideoPath, dlRes.data)
    console.log(`  [Gemini] 下载完成 ${(dlRes.data.byteLength / 1024 / 1024).toFixed(1)} MB`)
  }

  const finalVideoPath = tmpVideoPath || videoFilePath
  const videoBuffer = await readFileAsync(finalVideoPath)
  const videoMime = finalVideoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
  console.log(`  [Gemini] 视频 inline base64 传入 (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`)
  videoFilePart = {
    inlineData: {
      mimeType: videoMime,
      data: videoBuffer.toString('base64'),
    },
  }

  const parts = []

  // 1. 参考视频
  parts.push({
    text: `You are an expert AI video production assistant specializing in e-commerce UGC promotional videos across all product categories. You understand Seedance2 video generation prompts deeply.

First, here is the REFERENCE VIDEO to analyze:`,
  })
  parts.push(videoFilePart)

  // 2. 产品图（本地文件 或 商品链接抓取的 URL，二选一）
  // 合并：本地上传 + 远程链接 → 一组连续编号，Gemini 从全集中筛选
  const localImages = imageFiles || []
  const remoteImages = productImageUrls || []
  const totalImages = localImages.length + remoteImages.length

  // imageOrigins 记录每个 index 对应的来源信息，后续用来还原 selected_image_urls
  // { source: 'local'|'remote', uploadedUrl?, sourceUrl? }
  const imageOrigins = []

  parts.push({ text: `\nNext, here are ${totalImages} PRODUCT IMAGES to choose from (numbered 1..${totalImages}):` })

  // 1) 本地上传图（已经被 kie.ai 上传过，imageUrls 给了公网 URL，可作 Seedance reference）
  for (let i = 0; i < localImages.length; i++) {
    const idx = i + 1
    parts.push({ text: `[Image ${idx}: uploaded "${localImages[i].originalname}"]` })
    parts.push(await imageToInlinePart(localImages[i].path, localImages[i].originalname))
    imageOrigins.push({
      source: 'local',
      // 优先用 kie.ai 上传后的公网 URL；如果没上传到 kie，留 null
      uploadedUrl: imageUrls?.find(u => u.index === i)?.url || null,
    })
  }

  // 2) 远程链接图（先下载 inline 给 Gemini，后续如被选中再上传到 kie.ai）
  if (remoteImages.length > 0) {
    console.log(`  [Gemini] 下载 ${remoteImages.length} 张远程产品图...`)
    const { default: sharp } = await import('sharp')
    for (let i = 0; i < remoteImages.length; i++) {
      const idx = localImages.length + i + 1
      try {
        const imgRes = await axios.get(remoteImages[i], {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        let buf = await sharp(Buffer.from(imgRes.data))
          .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer()
        if (buf.length > GEMINI_IMAGE_MAX_BYTES) {
          buf = await sharp(buf).jpeg({ quality: 60 }).toBuffer()
        }
        parts.push({ text: `[Image ${idx}: from product listing]` })
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: buf.toString('base64'),
          },
        })
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i] })
      } catch (e) {
        console.warn(`  [Gemini] 图片 ${idx} 下载失败: ${e.message}`)
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i], failed: true })
      }
    }
  }

  // 3. 任务指令
  const dialogueRule = isSameProduct
    ? `1. SPOKEN DIALOGUE: Compress directly from the TASK 1 transcript. Preserve exact wording of pain points, product details, and CTAs. If product listing info is available, supplement with material/fabric facts not already in the transcript — weave them in naturally, do NOT replace original lines.`
    : `1. SPOKEN DIALOGUE: Write fresh dialogue based on the PRODUCT LISTING INFO and product images. Do NOT copy lines from the transcript. Mirror the speaking style, rhythm, and structure observed in the transcript (opener type, pacing, CTA style) — but all content must be about the actual product being promoted.`

  const task3Lingerie = `
TASK 3 - Generate a Seedance2 prompt. [CATEGORY: LINGERIE / SHAPEWEAR]

CRITICAL RULES:
${dialogueRule}
2. DO NOT reference @ImageN or insert static images in the shot sequence. Product images are for your reference only — use them to write accurate ACTION descriptions. The video must show a REAL PERSON PERFORMING ACTIONS.
3. The presenter wears the product throughout. Use TWO distinct looks cut between via edits (NOT in-frame undressing).
4. Speaking pace: FAST and energetic. Pack lines tightly — minimal pauses between sentences.

Use this FIXED STRUCTURE:

---
[PRODUCT VISUAL ANCHOR — READ THIS FIRST. Every frame of the video must be consistent with these specs. This is the highest-priority constraint.]
Silhouette: [from TASK 2b silhouette field]
Structure: [from TASK 2b structure field — underwire/wireless, padded/unlined, molded/soft cup]
Construction: [from TASK 2b construction field — lace / seamless / mesh, etc.]
Edge finish: [from TASK 2b edge_finish field — copy verbatim]
Underwire profile: [from TASK 2b underwire_profile field — copy verbatim]
Fabric drape: [from TASK 2b fabric_drape field — copy verbatim]
Straps: [from TASK 2b straps field]
Closure: [from TASK 2b closure field]
Fabric look: [from TASK 2b fabric_visual field]
Color: [from TASK 2b color field]
Distinguishing details: [from TASK 2b distinguishing_details field]
Required visual outcome: [Write 1-3 plain declarative sentences here that describe — based on the actual edge_finish/underwire_profile/fabric_drape values for THIS product — what the cups, band edges, and underwire should literally look like in the video. Examples of correctly-resolved sentences:
  • "Cups have flat laser-cut edges with no visible stitching or folded trim."
  • "Underwire sits inside an invisible channel with no raised ridge."
  • "Fabric drapes as a second skin, cup edges flush against the body."
DO NOT write conditional logic ("if edge_finish is X then..."). Resolve the conditions yourself based on this product's anchor values and write the final outcome as plain statements. Video models ignore if/then logic and will blend all keywords from both branches, causing hallucinations.]

[PRODUCT NOTES - internal only, do NOT speak or display these words in video]
Based on product images: [note key visible details — fabric color, texture, strap style, clasp type, construction]. Use to write accurate action descriptions only.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for [one precise sentence describing the product using PRODUCT VISUAL ANCHOR fields — e.g. 'a deep-V plunge underwire bra with laser-cut flat edges, unlined smooth microfiber cups in warm beige']."

[PRESENTER]
Real everyday person, NOT a model or influencer.
[Fill in: age range, body type, hair color/length casually styled, skin tone with natural features — visible pores, possible freckles, natural texture. NOT "flawless".]
Warm, relaxed energy. Talks fast like she's sharing a secret with a friend.

OUTFIT — two looks, alternating via clean cuts:
- LOOK A (talking shots): wears an open casual cardigan over the product. Relaxed at-home feel.
- LOOK B (product demo shots): wears only the product — no outer layer. Shows fit, silhouette, strap placement, fabric on skin.
Cuts between Look A ↔ Look B are intentional. Do NOT attempt in-frame undressing.

[SHOT SEQUENCE]
Every shot = a real person doing something. No static images. No product-on-white-background shots.

WORD BUDGET — calculate this BEFORE writing any dialogue line:
- Speaking pace: ~2.8 words per second (fast UGC style)
- Total budget for ${targetDuration}s video: ${targetDuration} × 2.8 = ~${Math.round(targetDuration * 2.8)} words MAXIMUM across ALL spoken lines combined
- Each shot's dialogue must fit within its assigned time window at this pace
- COUNT the words in every line you write. If total exceeds budget, CUT — do not squeeze.
- Leave the last 1–2 seconds of the final shot SILENT or with a gesture/smile — never end mid-sentence.

[0–Xs] LOOK A. Medium close-up — she faces camera, talks fast. Says: "[compressed opening line from transcript — include specific pain point in original wording. COUNT words to fit within this segment's seconds × 2.8]"
[Xs–Ys] LOOK B. She adjusts/demonstrates the product directly on her body — [specific action from product notes: e.g. "she slides a finger under the underwire showing it sits completely flat", "she turns sideways showing the silhouette", "she pulls the band away from her torso then releases it snapping back"]. Fast voiceover: "[next transcript line — COUNT words]"
[Ys–Zs] LOOK B close-up. Hands demonstrate a specific product component — [e.g. "she pinches and stretches the bra strap showing elasticity and snap-back", "she traces the seamless edge along her ribcage"]. Action is on the actual product, NOT on outer clothing. Voiceover: "[key selling point — COUNT words]"
[Zs–${targetDuration}s] LOOK A. She smiles at camera. Says quickly: "[SHORT CTA only — max 6 words, e.g. 'size up!', 'grab yours now', 'link below'. Must finish with 1s to spare.]"

Key requirements:
- Include 2+ specific real-life pain point scenarios from the transcript (use exact original words)
- At least one LOOK B shot shows the product worn on the body (fit/silhouette)
- All spoken lines from transcript — no invented marketing copy
- VERIFY total word count before finalizing. The last line MUST complete before the video ends.

[STYLE]
Camera: Phone-held, VISIBLY SHAKY — slight drift, micro-wobble, occasional reframe. NOT a tripod or gimbal.
Lighting: Soft directional window light, warm and diffused, from a nearby window at a gentle angle. Creates a SOFT natural shadow — subtle and gradual, NOT a harsh stark black shadow. Like overcast daylight through sheer curtains. Skin looks warm and dimensional. NOT ring light, NOT studio strobe, NOT sharp spotlight.
Background: Lived-in home — bedroom, living room, or bathroom. Slightly cluttered. NOT a studio backdrop.
Audio environment: INDOOR ONLY — quiet residential interior. Clean voice + very soft room tone. NO outdoor wind, NO traffic, NO street noise, NO music, NO echo. If reference video was filmed outside, ignore that ambience.
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture, possible blemishes. NOT airbrushed.
Hair casually styled, slightly imperfect — a strand out of place is good.
Expression: warm, fast-talking, spontaneous. Like sharing a secret. NOT posed or rehearsed.
Body language: loose, continuous, slightly imprecise movements. No theatrical pauses.

[SPEAKING STYLE]
TONE: Match pass1Result.narrative_dna.tone_register. Pick the matching delivery style:
  • EXCITED_BEST_FRIEND — high-energy, fast, exclamations like "OMG you guys", barely pauses, voice goes up at end of sentences
  • CALM_REVIEWER — measured medium pace, lower-pitched, expert tone, slight pauses for emphasis
  • SASSY_CONFIDENT — moderate pace with attitude, slight smirk in voice, occasional eye-roll inflection
  • GEN_Z_CASUAL — laid-back medium-slow pace, drops "literally", "deadass", "no cap", trailing off at end of phrases
  • SOFT_INTIMATE — quiet, slower, breathy ASMR-like quality, like sharing in bedroom
  • VULNERABLE_AUTHENTIC — slightly hesitant, real, occasional pauses to find words, like being honest
  • DEADPAN_FUNNY — flat affect with comedic timing, slight pause before punch lines
  • TEACHER_EDUCATIONAL — clear articulation, slight pauses to let info land, "let me show you" energy
Natural speech patterns appropriate to the tone.

ANTI-BROADCASTER (CRITICAL — the #1 reason AI videos sound machine-generated):
SPEAKING RATE matches the reference video (do NOT force fast; do NOT force slow). BUT no matter the rate, the CADENCE must be conversational human, NEVER broadcaster.
KILL these robotic patterns:
  • Over-articulated consonants (crisp Ts and Ds at every word) — NO. Let endings soften and slur.
  • Even rhythm on every word — NO. Stress 1-2 keywords per sentence, let other words run together.
  • Formal mid-sentence pauses ("the . product . is . amazing") — NO. Run clauses together; pause only between thoughts.
  • Uniform pitch contour ending each sentence flat — NO. Drop / rise / trail off unpredictably.
  • Perfect grammar / textbook diction — NO. Allow contractions, mild filler ("like", "you know"), occasional self-correction.
TARGET: sounds like a real person recording on her phone in one take — comfortable, slightly imperfect, with natural micro-hesitations and uneven word stress. NOT a TV anchor reading copy.

[AVOID]
No static images in video. No shots without a person. No gimbal. No harsh one-sided lighting. No airbrushed skin. No model poses. No slow delivery. No invented lines. No @Image references in video content.
PRODUCT ACCURACY — [Write 1-2 plain declarative sentences here describing exactly what visual features must NOT appear, based on this product's actual anchor values. Examples of correctly-resolved sentences:
  • "Do not show visible stitched trim, folded hems, or thick bound edges on the cups." (when this product has laser-cut edges)
  • "Do not show a prominent underwire ridge or thick channel seam." (when this product has invisible underwire)
DO NOT write "if anchor says X then..." — resolve it based on this product and state the bans as plain facts. Video models will blend keywords from both branches of an if/then.]
PRODUCT INTEGRITY — when the product is shown held in hand or off-body, it must still match the PRODUCT VISUAL ANCHOR exactly: straps in correct positions, closure on the BACK only (never on the front of a back-closure bra), cup count and shape matching the anchor. Do NOT generate distorted, mirror-flipped, or structurally incorrect versions of the product.
---`

  const task3General = `
TASK 3 - Generate a Seedance2 prompt. [CATEGORY: GENERAL]

CRITICAL RULES:
${dialogueRule}
2. DO NOT reference @ImageN or insert static images in the shot sequence. Product images are reference only — use them to write accurate ACTION descriptions. Video must show a REAL PERSON PERFORMING ACTIONS.
3. The presenter actively uses/demonstrates the product throughout. Describe specific physical interactions with the product.
4. Speaking pace: FAST and energetic. Pack lines tightly — minimal pauses.

Use this FIXED STRUCTURE:

---
[PRODUCT VISUAL ANCHOR — READ THIS FIRST. Every frame of the video must be consistent with these specs. This is the highest-priority constraint.]
Silhouette/Shape: [overall form of the product — be specific, not generic]
Structure: [key structural features — buttons, panels, hardware, functional parts]
Construction: [material construction — molded, knitted, assembled, woven, etc.]
Color: [exact color as seen in images]
Distinguishing details: [specific elements that identify THIS product — do NOT describe a generic version of this product type]
ENFORCEMENT: The product appearing in every frame must match every field above exactly. Do NOT substitute a similar-looking generic product. When visual details conflict with a "default" version of this product type, always follow the anchor.

[PRODUCT NOTES - internal only, do NOT speak or display these words in video]
Based on product images: [note key visible details — shape, color, material, key features, how it's used]. Use to write accurate action descriptions only.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for [one precise sentence describing the product using PRODUCT VISUAL ANCHOR fields]."

[PRESENTER]
Real everyday person, NOT a model or influencer.
[Fill in: age range, body type, hair color/length casually styled, skin tone with natural features — visible pores, possible freckles. NOT "flawless".]
Warm, relaxed energy. Talks fast like sharing a discovery with a friend.
Clothing: casual everyday wear appropriate for demonstrating this type of product at home.

[SHOT SEQUENCE]
Every shot = a real person doing something. No static images. No product-on-white-background shots.

WORD BUDGET — calculate this BEFORE writing any dialogue line:
- Speaking pace: ~2.8 words per second (fast UGC style)
- Total budget for ${targetDuration}s video: ${targetDuration} × 2.8 = ~${Math.round(targetDuration * 2.8)} words MAXIMUM across ALL spoken lines combined
- Each shot's dialogue must fit within its assigned time window at this pace
- COUNT the words in every line you write. If total exceeds budget, CUT — do not squeeze.
- Leave the last 1–2 seconds of the final shot SILENT or with a gesture/smile — never end mid-sentence.

[0–Xs] Medium close-up — faces camera, talks fast. Says: "[compressed opening line from transcript — include specific pain point in original wording. COUNT words to fit within this segment's seconds × 2.8]"
[Xs–Ys] Presenter actively uses/demonstrates the product — [specific action based on product type: e.g. "applies it to her face with two fingers in circular motion", "holds the device against her neck showing the ergonomic fit", "pours a measured amount showing the texture"]. Fast voiceover: "[next transcript line — COUNT words]"
[Ys–Zs] Close-up on hands/product interaction showing a specific feature — [e.g. "fingers press the button, LED indicator lights up", "she stretches the material showing flexibility then releases"]. Voiceover: "[key selling point — COUNT words]"
[Zs–${targetDuration}s] She looks at camera, smiles. Says quickly: "[SHORT CTA only — max 6 words. Must finish with 1s to spare.]"

Key requirements:
- Include 2+ specific real-life scenarios/pain points from the transcript (exact original words)
- Show the product BEING USED, not just held or displayed
- All spoken lines from transcript — no invented marketing copy
- VERIFY total word count before finalizing. The last line MUST complete before the video ends.

[STYLE]
Camera: Phone-held, VISIBLY SHAKY — slight drift, micro-wobble, occasional reframe. NOT a tripod or gimbal.
Lighting: Soft directional window light, warm and diffused. Creates a subtle soft shadow — NOT harsh or stark. Like overcast daylight through sheer curtains. NOT ring light, NOT studio strobe.
Background: Lived-in home — kitchen counter, bathroom shelf, living room couch. Slightly cluttered. NOT a studio backdrop.
Audio environment: INDOOR ONLY — quiet residential interior. Clean voice + very soft room tone. NO outdoor wind, NO traffic, NO street noise, NO music, NO echo. If reference video was filmed outside, ignore that ambience.
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture. NOT airbrushed.
Hair casually styled, slightly imperfect.
Expression: warm, fast-talking, spontaneous. NOT posed or rehearsed.
Body language: loose, continuous movements. No theatrical pauses.

[SPEAKING STYLE]
FAST pace — excited, barely pauses between sentences.
Natural speech patterns from transcript: brief "um" or "like" where they appeared.
One or two interjections: "Honestly", "Oh my god", "Seriously" — only where natural.
NOT a broadcaster voice.

[AVOID]
No static images in video. No shots without a person. No gimbal. No harsh lighting. No airbrushed skin. No model poses. No slow delivery. No invented lines. No @Image references in video content.
PRODUCT ACCURACY — never substitute a generic version of this product type. The product shown must match the PRODUCT VISUAL ANCHOR in every frame. When in doubt, follow the anchor description over any creative interpretation.
PRODUCT INTEGRITY — when the product is shown held in hand or off-body, it must still match the PRODUCT VISUAL ANCHOR exactly. Do NOT generate distorted or structurally incorrect versions of the product.
---`

  const task3 = category === 'lingerie' ? task3Lingerie : task3General

  const productInfoText = formatProductInfo(productInfo)

  const scriptModeInstruction = isSameProduct ? `
=== SCRIPT MODE: SAME PRODUCT ===
The reference video IS for the same product being promoted. Therefore:
- The transcript from Step 1a is the PRIMARY source for spoken dialogue in the generated video.
- Compress the transcript directly into a ${targetDuration}-second script. Keep specific pain points, product details, and CTAs as close to the original wording as possible.
- If PRODUCT LISTING INFO is provided below, use it to SUPPLEMENT the transcript — add material/fabric details or technical specs that weren't mentioned in the transcript, woven naturally into the dialogue. Do NOT replace the original lines.
===` : `
=== SCRIPT MODE: DIFFERENT PRODUCT ===
The reference video is NOT for the same product — it is used as a STYLE REFERENCE ONLY. Therefore:
- Extract speaking pace, tone, sentence rhythm, energy level, and UGC authenticity cues from the transcript. Note which types of lines work well (hook opener, pain point, demo line, CTA).
- Do NOT use the actual spoken content from the transcript as dialogue in the generated video.
- The spoken dialogue in the generated video must be written FRESH based on the PRODUCT LISTING INFO provided below. If no product listing info is provided, base it on what you observe in the product images.
- Mirror the style and structure of the reference transcript (e.g. if it opens with a relatable pain point, starts with "Okay so...", uses self-deprecating humor) — but with content about the actual product being promoted.
===`

  parts.push({
    text: `
User's additional ideas: ${userDescription || 'None provided'}
Target duration: ${targetDuration} seconds
${productInfoText ? `\n=== PRODUCT LISTING INFO (from TikTok Shop — treat as ground truth for product facts) ===\n${productInfoText}\n===` : ''}
${scriptModeInstruction}

=== YOUR TASKS ===

TASK 1 - Transcribe and analyze the reference video:

Step 1a — Full word-for-word transcript:
Listen carefully and transcribe EVERY spoken word in the video into English, verbatim. Include filler words ("um", "like", "honestly"), pauses marked with "...", and natural interjections.
${isSameProduct
  ? 'This transcript will be compressed into the final script — preserve it accurately.'
  : 'This transcript is a STYLE REFERENCE ONLY — extract speaking patterns, not content.'}

Step 1b — Video analysis:
- product_category: generic product type (e.g. apparel, skincare, kitchenware)
- product_description: what the product is, key features, colors/materials
- presenter_description: age range, body type, hair, skin tone, clothing, energy level
- filming_style: handheld/static/shaky, shot distance, lighting, background
- speaking_style: pace, tone, emotional register, use of gestures
- shot_sequence: full sequence of shots with EXACT timestamps and what was said at each moment
- key_selling_points: specific product benefits mentioned (use the EXACT words from the transcript)
- ugc_style_notes: authenticity cues, casual delivery, relatable moments
- mood: overall energy and feel

TASK 2 - Select the best 5-9 product images.
Prioritize: hero/overview shot, key feature close-ups, texture/material details, functional details.
Judge based on what you actually see — do NOT assume product category.

TASK 2b - Describe the product's KEY VISUAL FEATURES (CRITICAL — generated video must match these exactly):
Look at the product images carefully. Describe ONLY what you actually see — no assumptions.
Required fields (use null if not visible):
- silhouette: overall shape — describe what the bra LOOKS LIKE in the images, NOT what the product NAME says.
  CRITICAL: Product names often contain marketing/SEO terms like "Demi", "Balconette", "Plunge", "Halter", "Bralette", "Push-Up" all bundled together (e.g. "Inbarely Plus Plunge Bra - Sexy Demi Balconette" — this name combines THREE different silhouettes that are physically incompatible). DO NOT copy product name into this field. Pick the ONE silhouette type that matches what you actually see in the hero shot.
  Pick from these mutually-exclusive silhouettes:
  • "deep V plunge with center gore well below cleavage line" (V-shape neckline going low between breasts)
  • "demi cup with horizontal neckline cutting across the upper bust" (straight horizontal cut, wide-set straps)
  • "balconette with squared/rectangular neckline and wide-set straps" (similar to demi but more rectangular)
  • "full coverage with rounded scoop neckline"
  • "high-neck / halter neckline"
  • "triangle bralette with V-shaped triangular cups and minimal coverage"
  • "sports bra band / pullover style"
  Output ONE phrase only. Never combine two from this list.
- structure: underwire / wireless, padded / unlined, molded cup / soft cup
- construction: lace panels / smooth seamless / bonded edges / visible seams / mesh inserts
  IMPORTANT: "smooth seamless" means NO stitching ANYWHERE on the garment — including cup edges and band edges. If you can see ANY stitched hem, picot border, or topstitching in the images, do NOT use "smooth seamless" — pick "visible seams" or another option that allows stitching.
- edge_finish: How are the cup and band edges finished? Choose the MOST accurate.
  CRITICAL ASSUMPTION RULE: When you cannot clearly tell from the images, DEFAULT to "narrow folded fabric hem with low-profile stitching". Reason: 90%+ of e-commerce bras have folded stitched hems; truly seamless laser-cut edges are RARE and only appear on premium technical fabrics. False-negative-stitching (claiming seamless when there's actually a hem) causes the AI to render a structurally wrong garment. False-positive-stitching (claiming hem when actually seamless) only adds a barely-visible thin line. Always err toward "stitched hem" if uncertain.
  Choose ONE:
  • "narrow folded fabric hem with low-profile stitching — clean fine stitched edge, minimal bulk" ← DEFAULT when uncertain
  • "laser-cut flat edges — zero visible stitching, no folded trim, edges lie completely flat against skin" ← only if 100% confirmed by close-up
  • "narrow bonded edge — thin heat-bonded tape, no thread visible" ← only if 100% confirmed by close-up
  • "fabric-covered underwire channel — slim channel, mostly hidden, low profile"
  • "visible sewn trim / picot edge — decorative stitched border visible on cup or band"
  • "thick bound edge — clearly raised folded fabric trim with visible topstitching"
  Be precise: this field directly controls whether visible stitching, trim, or thick edges appear in the generated video.

- CROSS-CHECK construction ↔ edge_finish (do this AFTER picking both fields; MANDATORY):
  These two fields describe the same physical garment and MUST NOT contradict. Apply this rule and fix construction if it conflicts (edge_finish is more directly observable from images and has a strong default — trust edge_finish, adjust construction):
  • If edge_finish is any STITCHED option ("narrow folded fabric hem with low-profile stitching" / "visible sewn trim / picot edge" / "thick bound edge"):
      → construction MUST NOT be "smooth seamless". A seamless garment cannot have stitched/folded/bound edges. Change construction to "visible seams" or "lace panels" — whichever better matches the actual fabric.
  • If construction = "smooth seamless":
      → edge_finish MUST be "laser-cut flat edges" OR "narrow bonded edge" (the two non-stitched options). If you wrote a stitched edge_finish, that means construction was wrong — change construction to "visible seams".
  • If construction = "lace panels" OR "mesh inserts":
      → edge_finish MUST NOT be "laser-cut flat edges". Lace and mesh have stitched perimeters — pick a stitched edge_finish.
  Your final construction and edge_finish output MUST satisfy all three rules above. Pass 2 will fail the job if they contradict.
- underwire_profile: How prominent is the underwire channel? Choose:
  • "invisible underwire — channel completely hidden within seamless fabric, no visible ridge"
  • "low-profile channel — subtle gentle ridge, blends into fabric"
  • "standard channel — moderately visible raised channel"
  • "prominent channel — clearly raised thick seam"
- fabric_drape: How does the fabric behave against the body?
  • "second-skin drape — fabric conforms instantly to body contours, no stiff edges, no gaps"
  • "semi-structured — mostly conforming but cup maintains some shape away from skin"
  • "structured / stiff — cup holds shape independent of body, visible gap at edges"
- straps: width, adjustability, color, racerback / standard / convertible
- closure: hook-and-eye rows count / front-clasp / pullover
- fabric_visual: how the fabric looks on screen (e.g. "matte microfiber, slight sheen", "stretch lace with floral pattern", "ribbed athletic mesh")
- color: exact color name as shown
- distinguishing_details: anything that makes this product unique (bow, contrast trim, decorative panels, etc.)

This block will be inserted verbatim into the [PRODUCT VISUAL ANCHOR] section of the Seedance prompt to lock the model on the right product look.

TASK 2c - Identify the BEST 15-second segment of the reference video to use as a Seedance reference clip.
Pick the segment with the highest information density: presenter on camera + product visible + key actions.
Skip intros/outros that are just talking heads or static shots.
Output start/end seconds (integers). end - start MUST be ≤ 15.

${task3}

CONTENT POLICY (apply to compressed_script — both same-product and different-product modes):
Replace any of these words/phrases with ad-platform-safe alternatives, even if they appear in the transcript verbatim:
- "saggy", "saggy boobs", "saggy titty", "saggy tits" → "lift and shape", "volume loss", "chest support"
- "titty", "titties", "tits", "boobs", "boobies" → "chest", "bust"
- "ass", "booty" → "shape", "silhouette" (when describing fit)
- profanity (fuck, shit, damn) → remove or replace with "literally", "honestly", "seriously"
- explicit sexual descriptors → neutral fit/shape language
Keep the meaning and energy intact; only swap the flagged words.
This applies to the [SHOT SEQUENCE] dialogue lines as well.

IMPORTANT RULES:
- The compressed_script field must be a ${targetDuration}-second version of the TASK 1 transcript — compressed, not rewritten
- Structure is FIXED — only content changes per product
- The seedance_prompt MUST include a [PRODUCT VISUAL ANCHOR] block listing the TASK 2b fields verbatim, so Seedance generates the correct silhouette/cups/straps/closure.
- Do NOT include [FACE & LIKENESS], [REFERENCE VIDEO USAGE], [ANATOMICAL ACCURACY], [NO ON-SCREEN TEXT], [NO IMPROVISED DIALOGUE], or [BODY ATTACHMENT BAN] blocks — these are appended automatically by the pipeline. Focus on generating the dynamic content (PRODUCT VISUAL ANCHOR, PRESENTER, OUTFIT, SHOT SEQUENCE, STYLE, AUTHENTICITY, SPEAKING STYLE, AVOID).
- CRITICAL — NO CONDITIONAL LOGIC IN PROMPT: The seedance_prompt is consumed by a video model that does NOT understand "if/then" / "if X then Y" / "when anchor says X" / conditional clauses. It blends ALL keywords from BOTH branches of any conditional, causing severe hallucinations. Whenever the template contains a conditional placeholder, RESOLVE the condition based on this product's actual TASK 2b values and write the FINAL OUTCOME as a plain declarative sentence. Never leave words like "if", "when anchor says", "depending on", or template variable names like "edge_finish = ..." in the final prompt. The final prompt must read as a list of facts, not rules.

Return ONLY this valid JSON, no markdown fences, no explanation:
{
  "video_analysis": {
    "product_category": "",
    "product_description": "",
    "presenter_description": "",
    "filming_style": "",
    "speaking_style": "",
    "shot_sequence": "",
    "key_selling_points": [],
    "ugc_style_notes": "",
    "mood": "",
    "script": ""
  },
  "product_visual_features": {
    "silhouette": "",
    "structure": "",
    "construction": "",
    "edge_finish": "",
    "underwire_profile": "",
    "fabric_drape": "",
    "straps": "",
    "closure": "",
    "fabric_visual": "",
    "color": "",
    "distinguishing_details": ""
  },
  "key_segment_start_seconds": 0,
  "key_segment_end_seconds": 15,
  "selected_image_indices": [1, 3, 5, 7, 9],
  "compressed_script": "${isSameProduct ? `The ${targetDuration}-second script compressed from the transcript. WORD COUNT CHECK: must be ≤${Math.round(targetDuration * 2.8)} words total. Supplemented with product info where relevant, all flagged words replaced` : `The ${targetDuration}-second script written fresh for the actual product. WORD COUNT CHECK: must be ≤${Math.round(targetDuration * 2.8)} words total. Mirrors the reference video speaking style, all flagged words replaced`}",
  "seedance_prompt": "The full Seedance2 prompt with [PRODUCT VISUAL ANCHOR] block included",
  "reasoning": "Brief explanation of image selection"
}`,
  })

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'Gemini 单次调用' })

  if (!response.candidates || response.candidates.length === 0) {
    console.error('Gemini 返回空 candidates，完整响应:', JSON.stringify(response, null, 2))
    throw new Error(`Gemini 无返回内容。promptFeedback: ${JSON.stringify(response.promptFeedback)}`)
  }

  const text = response.candidates[0].content.parts[0].text
  const cleaned = text.replace(/```json|```/g, '').trim()

  let result
  try {
    result = JSON.parse(cleaned)
  } catch (e) {
    console.error('Gemini JSON parse error:', e)
    console.error('Raw response:', text)
    throw new Error('Failed to parse Gemini response')
  }

  // 把选中图片编号映射到来源信息：
  // - 本地上传：直接用 kie.ai 的 uploadedUrl（已上传过）
  // - 远程链接：返回 sourceUrl，generate.js 负责下载后上传到 kie.ai
  const selectedIndices = (result.selected_image_indices || []).filter(
    idx => idx >= 1 && idx <= imageOrigins.length
  )
  result.selected_images = selectedIndices.map(idx => {
    const origin = imageOrigins[idx - 1]
    if (!origin || origin.failed) return null
    if (origin.source === 'local') {
      return { source: 'local', publicUrl: origin.uploadedUrl }
    }
    return { source: 'remote', sourceUrl: origin.sourceUrl }
  }).filter(Boolean)
  // 兼容字段：本地上传图直接给 URL；远程图先留空，后续在 generate.js 填充
  result.selected_image_urls = result.selected_images
    .map(s => s.publicUrl)
    .filter(Boolean)

  // 清理 Gemini Files 里的临时视频
  if (uploadedVideoName) {
    genai.files.delete({ name: uploadedVideoName }).catch(e =>
      console.warn(`  [Gemini Files] 清理失败（忽略）: ${e.message}`)
    )
  }
  // 清理本地临时下载的视频文件
  if (tmpVideoPath) {
    unlink(tmpVideoPath).catch(() => {})
  }

  return result
}

// =====================================================================
// 新版：拆分为两次 Gemini 调用
//   Pass 1 — 分析（视频 + 全部图）：transcript / video_analysis / 选图 /
//             产品视觉特征 / 关键片段 / compressed_script
//   Pass 2 — 撰写（仅选中的图，不带视频）：seedance_prompt
// 优点：每次任务专注，质量↑；Pass 2 payload 小、速度快；总时间 ↓
// =====================================================================

// 把视频准备成 inline part（如果是 URL 先下载到本地临时文件）
async function prepareVideoPart(videoUrl, videoFilePath) {
  let tmpVideoPath = null
  if (videoUrl) {
    console.log(`  [Gemini] 下载视频...`)
    tmpVideoPath = path.join(os.tmpdir(), `${uuidv4()}.mp4`)
    const dlRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    await writeFile(tmpVideoPath, dlRes.data)
    console.log(`  [Gemini] 下载完成 ${(dlRes.data.byteLength / 1024 / 1024).toFixed(1)} MB`)
  }
  const finalVideoPath = tmpVideoPath || videoFilePath
  const videoBuffer = await readFileAsync(finalVideoPath)
  const videoMime = finalVideoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
  console.log(`  [Gemini] 视频 inline base64 (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`)
  const videoPart = {
    inlineData: { mimeType: videoMime, data: videoBuffer.toString('base64') },
  }
  return { videoPart, tmpVideoPath }
}

// 把所有产品图准备成 inline parts，同时返回 imageOrigins 用于后续映射
// 远程图的 inline buffer 一并返回，给 Pass 2 复用，避免重新下载
async function prepareImageParts({ imageFiles, productImageUrls, imageUrls }) {
  const localImages = imageFiles || []
  const remoteImages = productImageUrls || []
  const totalImages = localImages.length + remoteImages.length
  const imageOrigins = []
  // 保存每张图对应的 inline part（按 1-based index）→ Pass 2 直接复用
  const inlinePartByIndex = {}

  const labelParts = [] // [{ idx, labelText, inlinePart }]

  for (let i = 0; i < localImages.length; i++) {
    const idx = i + 1
    const labelText = `[Image ${idx}: uploaded "${localImages[i].originalname}"]`
    const inlinePart = await imageToInlinePart(localImages[i].path, localImages[i].originalname)
    labelParts.push({ idx, labelText, inlinePart })
    inlinePartByIndex[idx] = inlinePart
    imageOrigins.push({
      source: 'local',
      uploadedUrl: imageUrls?.find(u => u.index === i)?.url || null,
    })
  }

  if (remoteImages.length > 0) {
    const t0 = Date.now()
    console.log(`  [Gemini] 下载 ${remoteImages.length} 张远程产品图（并发 4）...`)
    const { default: sharp } = await import('sharp')
    const CONCURRENCY = 4
    const results = new Array(remoteImages.length)
    let cursor = 0
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = cursor++
        if (i >= remoteImages.length) return
        const idx = localImages.length + i + 1
        try {
          const imgRes = await axios.get(remoteImages[i], {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          })
          let buf = await sharp(Buffer.from(imgRes.data))
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer()
          if (buf.length > GEMINI_IMAGE_MAX_BYTES) {
            buf = await sharp(buf).jpeg({ quality: 60 }).toBuffer()
          }
          const inlinePart = {
            inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') },
          }
          results[i] = { ok: true, idx, inlinePart }
        } catch (e) {
          console.warn(`  [Gemini] 图片 ${idx} 下载失败: ${e.message}`)
          results[i] = { ok: false }
        }
      }
    }))
    // 按原顺序写回，保持 idx 编号稳定
    for (let i = 0; i < remoteImages.length; i++) {
      const r = results[i]
      const idx = localImages.length + i + 1
      if (r && r.ok) {
        labelParts.push({ idx, labelText: `[Image ${idx}: from product listing]`, inlinePart: r.inlinePart })
        inlinePartByIndex[idx] = r.inlinePart
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i] })
      } else {
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i], failed: true })
      }
    }
    console.log(`  [Gemini] 远程图下载完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  return { labelParts, imageOrigins, totalImages, inlinePartByIndex }
}

// 当用户提供 ≥6 张同 SKU 图时，Seedance 已有充足视觉 ground truth；
// 此时可以省掉 edge_finish/underwire_profile/fabric_drape/construction 这种"靠图看更准"的字段
// 既减少 Pass 1 prompt 量（~2700 字符），又消除 construction ↔ edge_finish 矛盾源（阶段 4 20% 失败率根因）
const SLIM_IMAGE_THRESHOLD = 6

function buildTask2bText(slimMode) {
  const silhouetteEnum = `  Pick from these mutually-exclusive silhouettes:
  • "deep V plunge with center gore well below cleavage line" (V-shape neckline going low between breasts)
  • "demi cup with horizontal neckline cutting across the upper bust" (straight horizontal cut, wide-set straps)
  • "balconette with squared/rectangular neckline and wide-set straps" (similar to demi but more rectangular)
  • "full coverage with rounded scoop neckline"
  • "high-neck / halter neckline"
  • "triangle bralette with V-shaped triangular cups and minimal coverage"
  • "sports bra band / pullover style"
  Output ONE phrase only. Never combine two from this list.`

  if (slimMode) {
    return `TASK 2b - KEY VISUAL FEATURES (SLIM mode — ≥${SLIM_IMAGE_THRESHOLD} reference images available, focus on essentials only):
Look at the product images carefully. Describe ONLY what you actually see.
Required fields (use null if not visible):
- silhouette: overall shape — describe what the bra LOOKS LIKE in the images, NOT what the product NAME says (product names often combine incompatible terms like "Demi Balconette Plunge"; pick ONE from below that matches the hero shot).
${silhouetteEnum}
- structure: underwire / wireless, padded / unlined, molded cup / soft cup (short phrase)
- straps: width, adjustability, color, racerback / standard / convertible
- closure: hook-and-eye rows count / front-clasp / pullover (short phrase)
- fabric_visual: one phrase (e.g. "matte microfiber slight sheen", "stretch lace floral pattern")
- color: PICK EXACTLY ONE color name. NEVER output multiple colors separated by commas/slashes.
- distinguishing_details: anything that makes this product unique (bow, contrast trim, decorative panels)

SKIPPED in slim mode (output null — reference images give these to video model directly): edge_finish, underwire_profile, fabric_drape, construction.`
  }

  return `TASK 2b - Describe the product's KEY VISUAL FEATURES (CRITICAL — generated video must match these exactly):
Look at the product images carefully. Describe ONLY what you actually see — no assumptions.
Required fields (use null if not visible):
- silhouette: overall shape — describe what the bra LOOKS LIKE in the images, NOT what the product NAME says.
  CRITICAL: Product names often contain marketing/SEO terms like "Demi", "Balconette", "Plunge", "Halter", "Bralette", "Push-Up" all bundled together (e.g. "Inbarely Plus Plunge Bra - Sexy Demi Balconette" — this name combines THREE different silhouettes that are physically incompatible). DO NOT copy product name into this field. Pick the ONE silhouette type that matches what you actually see in the hero shot.
${silhouetteEnum}
- structure: underwire / wireless, padded / unlined, molded cup / soft cup
- construction: lace panels / smooth seamless / bonded edges / visible seams / mesh inserts
  IMPORTANT: "smooth seamless" means NO stitching ANYWHERE on the garment — including cup edges and band edges. If you can see ANY stitched hem, picot border, or topstitching in the images, do NOT use "smooth seamless" — pick "visible seams" or another option that allows stitching.
- edge_finish: How are the cup and band edges finished? Choose the MOST accurate.
  CRITICAL ASSUMPTION RULE: When you cannot clearly tell from the images, DEFAULT to "narrow folded fabric hem with low-profile stitching". Reason: 90%+ of e-commerce bras have folded stitched hems; truly seamless laser-cut edges are RARE and only appear on premium technical fabrics. False-negative-stitching (claiming seamless when there's actually a hem) causes the AI to render a structurally wrong garment. False-positive-stitching (claiming hem when actually seamless) only adds a barely-visible thin line. Always err toward "stitched hem" if uncertain.
  Choose ONE:
  • "narrow folded fabric hem with low-profile stitching — clean fine stitched edge, minimal bulk" ← DEFAULT when uncertain
  • "laser-cut flat edges — zero visible stitching, no folded trim, edges lie completely flat against skin" ← only if 100% confirmed by close-up
  • "narrow bonded edge — thin heat-bonded tape, no thread visible" ← only if 100% confirmed by close-up
  • "fabric-covered underwire channel — slim channel, mostly hidden, low profile"
  • "visible sewn trim / picot edge — decorative stitched border visible on cup or band"
  • "thick bound edge — clearly raised folded fabric trim with visible topstitching"
  Be precise: this field directly controls whether visible stitching, trim, or thick edges appear in the generated video.

- CROSS-CHECK construction ↔ edge_finish (do this AFTER picking both fields; MANDATORY):
  These two fields describe the same physical garment and MUST NOT contradict. Apply this rule and fix construction if it conflicts (edge_finish is more directly observable from images and has a strong default — trust edge_finish, adjust construction):
  • If edge_finish is any STITCHED option ("narrow folded fabric hem with low-profile stitching" / "visible sewn trim / picot edge" / "thick bound edge"):
      → construction MUST NOT be "smooth seamless". A seamless garment cannot have stitched/folded/bound edges. Change construction to "visible seams" or "lace panels" — whichever better matches the actual fabric.
  • If construction = "smooth seamless":
      → edge_finish MUST be "laser-cut flat edges" OR "narrow bonded edge" (the two non-stitched options). If you wrote a stitched edge_finish, that means construction was wrong — change construction to "visible seams".
  • If construction = "lace panels" OR "mesh inserts":
      → edge_finish MUST NOT be "laser-cut flat edges". Lace and mesh have stitched perimeters — pick a stitched edge_finish.
  Your final construction and edge_finish output MUST satisfy all three rules above. Pass 2 will fail the job if they contradict.
- underwire_profile: How prominent is the underwire channel? Choose:
  • "invisible underwire — channel completely hidden within seamless fabric, no visible ridge"
  • "low-profile channel — subtle gentle ridge, blends into fabric"
  • "standard channel — moderately visible raised channel"
  • "prominent channel — clearly raised thick seam"
- fabric_drape: How does the fabric behave against the body?
  • "second-skin drape — fabric conforms instantly to body contours, no stiff edges, no gaps"
  • "semi-structured — mostly conforming but cup maintains some shape away from skin"
  • "structured / stiff — cup holds shape independent of body, visible gap at edges"
- straps: width, adjustability, color, racerback / standard / convertible
- closure: hook-and-eye rows count / front-clasp / pullover
- fabric_visual: how the fabric looks on screen (e.g. "matte microfiber, slight sheen", "stretch lace with floral pattern", "ribbed athletic mesh")
- color: PICK EXACTLY ONE color name. The product listing may offer multiple variants (Beige / Black / White / Nude Pink etc.) but the video can only show ONE. Look at the product images and identify which color is featured in the HERO/FRONT shots — output ONLY that single color name. NEVER output multiple colors separated by commas/slashes (e.g. "Beige, Black" is WRONG — Seedance will randomly mix). The color you write here is what the video will render.
- distinguishing_details: anything that makes this product unique (bow, contrast trim, decorative panels, etc.)`
}

// ==== Pass 1: 分析 ====
async function geminiPass1Analyze({
  videoPart,
  labelParts,
  totalImages,
  productInfoText,
  scriptModeInstruction,
  isSameProduct,
  targetDuration,
  slimMode = false,
}) {
  const parts = []
  parts.push({
    text: `You are an expert AI video production analyst for e-commerce UGC videos.

This is PASS 1 of 2 — your job is ANALYSIS ONLY. A second pass will write the actual video generation prompt later, using your structured output. Focus all your attention on accurate observation, not creative writing.

First, here is the REFERENCE VIDEO to analyze:`,
  })
  parts.push(videoPart)
  parts.push({ text: `\nNext, here are ${totalImages} PRODUCT IMAGES to choose from (numbered 1..${totalImages}):` })
  for (const { labelText, inlinePart } of labelParts) {
    parts.push({ text: labelText })
    parts.push(inlinePart)
  }

  parts.push({
    text: `

Target video duration: ${targetDuration} seconds
${productInfoText ? `\n=== PRODUCT LISTING INFO (from TikTok Shop — treat as ground truth for product facts) ===\n${productInfoText}\n===` : ''}
${scriptModeInstruction}

=== YOUR ANALYSIS TASKS ===

TASK 1 - Transcribe and analyze the reference video:

Step 1a — Full word-for-word transcript:
Listen carefully and transcribe EVERY spoken word in the video into English, verbatim. Include filler words ("um", "like", "honestly"), pauses marked with "...", and natural interjections.
${isSameProduct
  ? 'This transcript will be compressed into the final script in Pass 2 — preserve it accurately.'
  : 'This transcript is a STYLE REFERENCE ONLY — extract speaking patterns, not content.'}

Step 1b — Video analysis (used by Pass 2 to write the prompt):
- product_category: generic product type (e.g. apparel, skincare, kitchenware)
- product_description: what the product is, key features, colors/materials
- presenter_description: age range, body type, hair, skin tone, clothing, energy level (THIS WILL BE USED ONLY AS A STYLE REFERENCE — Pass 2 will generate a DIFFERENT person, not copy this one)
- filming_style: handheld/static/shaky, shot distance, lighting, background
- speaking_style: pace, tone, emotional register, use of gestures
- shot_sequence: full sequence of shots with EXACT timestamps and what was said at each moment
- key_selling_points: specific product benefits mentioned (use EXACT words from the transcript)
- ugc_style_notes: authenticity cues, casual delivery, relatable moments
- mood: overall energy and feel

TASK 2 - Select the best 5-9 product images, with COLOR-AWARE selection.

STEP 2.1 — Identify the DOMINANT color SKU first:
The product likely has multiple color variants in the images (e.g. beige, black, white, nude pink). Pick ONE color to be the DOMINANT color featured in the video. Decision rule:
  • Prefer the color shown in the FIRST few images (typically the merchant's hero/main SKU)
  • If multiple colors appear equally, pick the most photogenic neutral (beige > nude > white > black)
  • Output this single color name in the dominant_color field below

STEP 2.2 — Select 5-9 images, ALL of dominant_color (zero exceptions):
  • EVERY selected image MUST be dominant_color. If a candidate image is a different color, DO NOT select it — even if it shows a critical structural angle that no dominant-color image covers. Better to miss an angle than to contaminate the video model with the wrong color.
  • IGNORE images that are mainly a marketing poster with large text overlays — those text elements pollute the video model.
  • All entries in image_color_role MUST be "dominant-color". The "structure-only-different-color" label is DEPRECATED and must not be used.

WHY THIS MATTERS: The video model is visual-first — ANY non-dominant-color reference image risks the model rendering that color in some frame. Zero off-color images is the only reliable defense.

Return indices (1-based) and the role array. Pass 2 will only see selected images.

${buildTask2bText(slimMode)}

TASK 2c - Identify the BEST 15-second segment of the reference video.
Pick the segment with the highest information density: presenter on camera + product visible + key actions.
Skip intros/outros that are just talking heads or static shots.
Output start/end seconds (integers). end - start MUST be ≤ 15.

TASK 3 - Compress the script.
Produce a ${targetDuration}-second compressed_script (≤ ${Math.round(targetDuration * 2.8)} words at ~2.8 words/sec).

CONTENT POLICY (apply to compressed_script):
- "saggy", "saggy boobs", "saggy titty", "saggy tits" → "lift and shape", "volume loss", "chest support"
- "titty", "titties", "tits", "boobs", "boobies" → "chest", "bust"
- "ass", "booty" → "shape", "silhouette"
- profanity (fuck, shit, damn) → remove or replace with "literally", "honestly", "seriously"
- explicit sexual descriptors → neutral fit/shape language

TASK 4 — NARRATIVE DNA EXTRACTION (THIS IS WHAT MAKES THIS REFERENCE UNIQUE):
This is the most important task. The goal is to identify what makes THIS specific reference video different from a generic "person talks about bra" template. Pass 2 will use this DNA to write a Seedance prompt that copies the SOUL of this reference, not just its style.

For each field below, watch the reference video carefully and identify the SPECIFIC pattern (NOT generic descriptions):

A. hook_type — Which of these opening hook types does the reference use? Pick ONE:
   • "PAIN_POINT_RANT" — opens by complaining about a problem (e.g. "I HATE that all my bras..."), then reveals product as solution
   • "RESULT_FIRST" — opens by showing a confident result/transformation, then explains how
   • "CURIOSITY_LOOP" — opens with a question or unexpected statement that makes you keep watching ("You won't believe what this bra did...")
   • "SOCIAL_PROOF" — opens with citing other people's reactions ("Everyone is asking about this...")
   • "DIRECT_CONFESSION" — opens with a personal vulnerable admission ("OK I never spend $X on bras but...")
   • "COMPARISON_HOOK" — opens by comparing to a known brand/product ("This is literally Skims for $20...")
   • "DEMO_FIRST" — opens by physically demonstrating the product, talking later
   • "ENERGY_REACTION" — opens with raw emotional reaction ("OH MY GOD you guys—")
   • "STORY_HOOK" — opens with a mini-story ("So I bought 3 sizes because...")

B. narrative_structure — Which structural template does this reference follow? Pick ONE:
   • "PROBLEM_SOLUTION_DEMO" — pain point → product reveal → demo → CTA
   • "AB_REVEAL" — alternating talking-head and product-shot cuts (the typical "outfit reveal" structure)
   • "ONE_TAKE_WALKTHROUGH" — single continuous shot, talks while moving/showing
   • "GRWM_STYLE" — gets-ready-with-me, multitasking while reviewing
   • "TRY_ON_HAUL" — tries multiple variations in sequence
   • "SIDE_BY_SIDE_COMPARISON" — explicitly compares to another product/brand
   • "DEMO_THEN_TALK" — silent product demo first, then sits down to talk about it
   • "TESTIMONIAL_MONOLOGUE" — straight to camera, single setup, talking the whole time
   • "Q&A_SELF_ANSWER" — poses questions to herself and answers
   • "THREE_REASONS" — explicitly lists "1st thing... 2nd... 3rd..."

C. tone_register — What's the speaking energy? Pick ONE:
   • "EXCITED_BEST_FRIEND" — high energy, fast, "OMG you guys"
   • "CALM_REVIEWER" — measured, slower, expert tone
   • "SASSY_CONFIDENT" — bold, slightly cheeky, holding her own
   • "GEN_Z_CASUAL" — laid back, "literally" "deadass" "no cap" lingo
   • "SOFT_INTIMATE" — quiet, ASMR-like, like sharing in a bedroom
   • "VULNERABLE_AUTHENTIC" — slightly hesitant, real, like talking to a therapist
   • "DEADPAN_FUNNY" — flat delivery for comedic effect
   • "TEACHER_EDUCATIONAL" — explanatory, "let me show you"

D. unique_creative_signature — Free-text 1-3 sentences. What is the ONE specific creative element that makes THIS reference video memorable and would be a shame to lose if we generated a generic version? Examples:
   • "She films herself in front of an open closet, pulling other failed bras out of a pile to compare against the new one"
   • "She uses a slow-mo hair flip transition between Look A and Look B"
   • "She does the entire video while folding laundry — never looks at camera until the last 2 seconds"
   • "She talks to her reflection in the mirror, never to the camera directly"
   • "She uses a self-shot bathroom mirror angle for half the video"
   This field captures things that TASKs A/B/C above might miss.

E. key_phrases — Extract 2-3 specific phrases the creator says that are catchy/memorable hook lines (verbatim from transcript). These should be the lines that, if removed, would make the video lose its punch. Pass 2 should preserve at least one of these in the final script.

CRITICAL: Do NOT default to generic answers. The whole point is capturing what's UNIQUE about THIS video. If you find yourself reaching for the most common option in each list, look harder.

Return ONLY this valid JSON, no markdown fences, no explanation:
{
  "video_analysis": {
    "product_category": "",
    "product_description": "",
    "presenter_description": "",
    "filming_style": "",
    "speaking_style": "",
    "shot_sequence": "",
    "key_selling_points": [],
    "ugc_style_notes": "",
    "mood": ""
  },
  "product_visual_features": {
    "silhouette": "",
    "structure": "",
    "construction": "",
    "edge_finish": "",
    "underwire_profile": "",
    "fabric_drape": "",
    "straps": "",
    "closure": "",
    "fabric_visual": "",
    "color": "",
    "distinguishing_details": ""
  },
  "narrative_dna": {
    "hook_type": "",
    "narrative_structure": "",
    "tone_register": "",
    "unique_creative_signature": "",
    "key_phrases": ["", "", ""]
  },
  "key_segment_start_seconds": 0,
  "key_segment_end_seconds": 15,
  "dominant_color": "the single SKU color the video should feature (e.g. 'Warm Beige')",
  "selected_image_indices": [1, 3, 5, 7, 9],
  "image_color_role": ["dominant-color", "dominant-color", "dominant-color", "structure-only-different-color", "dominant-color"],
  "compressed_script": "the ${targetDuration}s script (≤${Math.round(targetDuration * 2.8)} words, all flagged words replaced)",
  "image_selection_reasoning": "1-2 sentences explaining why these images were chosen, and which images are non-dominant-color but kept for structural reasons"
}`,
  })

  const t0 = Date.now()
  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
    config: { temperature: 0 },
  }, { label: 'Gemini Pass 1' })
  console.log(`  [Gemini Pass 1] 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`)

  if (!response.candidates || response.candidates.length === 0) {
    throw new Error(`Gemini Pass 1 无返回内容。promptFeedback: ${JSON.stringify(response.promptFeedback)}`)
  }
  const text = response.candidates[0].content.parts[0].text
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('Pass 1 JSON parse error:', e)
    console.error('Raw:', text.slice(0, 800))
    throw new Error('Pass 1: failed to parse Gemini response')
  }
}

// ==== Pass 2: 撰写 Seedance prompt ====
// 只传选中的产品图（不带视频），payload 小、速度快、Gemini 专注于撰写
async function geminiPass2WritePrompt({
  pass1Result,
  selectedImageParts, // [{ idx, labelText, inlinePart }]
  productInfoText,
  scriptModeInstruction,
  isSameProduct,
  targetDuration,
  category,
  userDescription,
  variantRecipe,  // 可选：{label, presenter, scene, cardigan_color}，用于裂变
  slimMode = false,
  mode = 'normal',  // 'normal' | 'before-after'：before-after 走独立衍生模板，普通任务字节级不变
}) {
  const dialogueRule = isSameProduct
    ? `1. SPOKEN DIALOGUE: Use the compressed_script verbatim from PASS 1 ANALYSIS. Distribute it across the SHOT SEQUENCE shots, preserving the exact wording.`
    : `1. SPOKEN DIALOGUE: Write ENTIRELY NEW dialogue based on the product info and "User's additional ideas" provided below. DO NOT use any content, wording, or selling points from the reference video's compressed_script or transcript — the reference video is a DIFFERENT product. The dialogue must only talk about THIS product's features and the concept described by the user.`

  // PRODUCT VISUAL ANCHOR 块 — slim 模式（≥6 张同 SKU 图）只列必要字段，省 ~300 字符且消除矛盾源
  const productAnchorBlock = slimMode
    ? `[PRODUCT VISUAL ANCHOR — READ THIS FIRST. Every frame of the video must be consistent with these specs.]
Silhouette: <copy verbatim from product_visual_features.silhouette>
Structure: <copy verbatim from product_visual_features.structure>
Straps: <copy verbatim from product_visual_features.straps>
Closure: <copy verbatim from product_visual_features.closure>
Fabric look: <copy verbatim from product_visual_features.fabric_visual>
Color: <copy verbatim from product_visual_features.color>
Distinguishing details: <copy verbatim from product_visual_features.distinguishing_details>
[Note: edge finish / underwire / fabric drape / construction are inferred from the ${selectedImageParts.length} reference images attached — do NOT add text guesses.]`
    : `[PRODUCT VISUAL ANCHOR — READ THIS FIRST. Every frame of the video must be consistent with these specs. This is the highest-priority constraint.]
Silhouette: <copy verbatim from product_visual_features.silhouette>
Structure: <copy verbatim from product_visual_features.structure>
Construction: <copy verbatim from product_visual_features.construction>
Edge finish: <copy verbatim from product_visual_features.edge_finish>
Underwire profile: <copy verbatim from product_visual_features.underwire_profile>
Fabric drape: <copy verbatim from product_visual_features.fabric_drape>
Straps: <copy verbatim from product_visual_features.straps>
Closure: <copy verbatim from product_visual_features.closure>
Fabric look: <copy verbatim from product_visual_features.fabric_visual>
Color: <copy verbatim from product_visual_features.color>
Distinguishing details: <copy verbatim from product_visual_features.distinguishing_details>
Required visual outcome: <write 1-3 plain declarative sentences describing — based on the actual edge_finish/underwire_profile/fabric_drape values for THIS product — what the cups, band edges, and underwire should literally look like in the video. Examples: "Cups have flat laser-cut edges with no visible stitching or folded trim." / "Underwire sits inside an invisible channel with no raised ridge." / "Fabric drapes as a second skin, cup edges flush against the body." DO NOT write conditional logic. Resolve the conditions yourself based on this product's anchor values and write the final outcome as plain statements. Video models ignore if/then logic and will blend all keywords from both branches, causing hallucinations.>`

  const task3Lingerie = `
TASK 3 - Generate a Seedance2 prompt. [CATEGORY: LINGERIE / SHAPEWEAR]

CRITICAL RULES:
${dialogueRule}
2. DO NOT reference @ImageN or insert static images in the shot sequence. Product images are for your reference only — use them to write accurate ACTION descriptions. The video must show a REAL PERSON PERFORMING ACTIONS.
3. The presenter wears the product throughout. If the reference's SHOT SEQUENCE specifies an outfit switch (cardigan on→off), use clean edit cuts between looks (NOT in-frame undressing). If reference is single-outfit, keep the same outfit throughout.
4. Speaking pace: match what the reference shows. Do NOT force "FAST and energetic" if the reference is calm/measured/intimate.

Use this FIXED STRUCTURE:

---
${productAnchorBlock}

[COLOR — only <DOMINANT_COLOR>]
The bra is <DOMINANT_COLOR> in every frame. OUTFIT must say "<DOMINANT_COLOR> bra"; OPENING LINE must include the color; mention "<DOMINANT_COLOR>" in SHOT SEQUENCE at least 2 more times. NEVER write "any color" or alternate color names.

[PRODUCT NOTES - internal only, do NOT speak or display these words in video]
Based on product images: <note key visible details — fabric color, texture, strap style, clasp type, construction>. Use to write accurate action descriptions only.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for <one precise sentence describing the product using PRODUCT VISUAL ANCHOR fields — e.g. 'a deep-V plunge underwire bra with laser-cut flat edges, unlined smooth microfiber cups in warm beige'>."

[PRESENTER — used IDENTICALLY in both LOOK A and LOOK B]
Real everyday person, NOT a model or influencer.
<Fill in: age range, body type, hair color, skin tone with natural features — visible pores, possible freckles, natural texture. NOT "flawless".>
ANTI-AI-FACE — face MUST have asymmetric human imperfection. Pick 2-3 of these (NEVER all symmetric/perfect):
  • one eyebrow sits slightly higher than the other
  • a single small beauty mark or freckle on cheek or near lip (only ONE side)
  • slight nose tip asymmetry (tilted slightly to one side)
  • uneven lower lash density (one side fuller)
  • faint under-eye shadow more visible on ONE side
  • lips slightly fuller on one side / one corner sits higher when neutral
  • slight smile-line asymmetry (one cheek dimples deeper)
DO NOT generate "perfect symmetric model face". AI symmetry is the #1 tell — kill it.
ANTI-AI-BODY — the chest/bust is the focal point of a bra video and the #1 place AI looks fake. Enforce:
  • Natural soft asymmetry — the two sides of the bust are slightly different in shape/position (real bodies are never perfectly mirrored). NEVER perfectly symmetric.
  • Real skin on chest/décolletage — visible pores, faint natural texture, subtle natural tan/skin-tone variation. NOT airbrushed, NOT plastic-doll smooth, NOT glowing.
  • Soft directional shadow under the bust and along the neckline — gives real volume. NOT flat even CGI lighting.
  • The bra cup meets skin with a believable soft contact line — NO glowing edge, NO melting/blurring where fabric meets skin, NO fabric-into-skin bleed.
  • Natural breast physics — soft, gravity-affected, NOT gravity-defying spherical "implant" shape, NOT exaggerated.
  • Camera framing on the chest stays MEDIUM (waist-up or chest-up). AVOID extreme tight cleavage close-ups — that magnifies every AI artifact (this overrides any "close-up of the cups" instruction from shot_sequence; replace with a medium framing that still shows the bra clearly).
HAIR — IMPORTANT: hair must be PULLED AWAY from the chest area to keep the bra straps and neckline fully visible. Use one of: high ponytail / low ponytail / messy bun / topknot / hair clipped back / hair tucked securely behind both shoulders. NEVER "long loose hair" / "long hair flowing over chest" / "long hair down" — loose long hair occluding the chest causes severe AI rendering artifacts (flickering between hair and straps, melting hair-on-fabric textures, distorted neckline geometry).
MAKEUP & ACCESSORIES (specifics not covered by global character consistency):
  • NO necklaces, earrings, rings, bracelets, or watches — bare neck and ears throughout
  • Minimal natural makeup only: clean skin, neutral lip tint (NEVER bold or glossy lipstick), light or no eye makeup
Warm, relaxed energy. Talks fast like sharing a secret with a friend.

OUTFIT — match what the reference does (see SHOT SEQUENCE block):
- If the reference shows an outfit change (e.g. cardigan removed mid-video): presenter wears LOOK A (bra + open cardigan over it) before the switch and LOOK B (cardigan removed, bra fully visible) after. SAME PERSON, SAME hair/makeup/bare neck throughout.
- If the reference is single-outfit (one-take, no outfit change): keep LOOK A (bra + open cardigan) for the entire video. Bra is glimpsed through the open cardigan but never fully revealed.
- NEVER force A-B-A-B if the reference doesn't have it.

[SHOT SEQUENCE]
Every shot = a real person doing something. No static images. No product-on-white-background shots.

WORD BUDGET: total dialogue ≤ ${Math.round(targetDuration * 2.8)} words. Distribute the compressed_script across shots, never exceeding the per-shot time × 2.8 words limit. Leave the last 1-2 seconds SILENT or with a gesture/smile.

ACTION SAFETY — Seedance fails on these specific actions; avoid all of them: fingers slipping UNDER clothing, multi-finger pinching/pulling of thin straps or lace, hands clipping through straps or band, hair flowing over hands or product. Prefer SURFACE-ONLY contact on large flat areas (single finger or open palm on band/cup, hand resting on collarbone, body turning to show silhouette).

REFERENCE SHOT-BY-SHOT — PASS 1 extracted this shot sequence from the reference video. Use it as the structural skeleton (do NOT replace it with a generic A-B-A-B template):

${pass1Result.video_analysis?.shot_sequence || '(no shot sequence extracted — fall back to a single LOOK A talking-head shot for the full duration)'}

REWRITE this reference shot sequence into our SHOT SEQUENCE format following these rules:
  1. PRESERVE original TIMING — scale the reference's timestamps proportionally to fit ${targetDuration}s total. If reference is 30s and our target is 13s, divide every timestamp by 30/13.
  2. PRESERVE original ACTIONS — keep what the presenter does each shot.
     EXCEPTION A — SAFETY: if a reference action violates ACTION SAFETY above, replace with the closest SURFACE-ONLY alternative (e.g. "tugs at strap with fingers" → "flat palm rests on strap area").
     EXCEPTION B — FEATURE MISMATCH: if a reference action demonstrates or draws attention to a SPECIFIC product feature (e.g. squeezing a padded cup to show push-up lift, unclipping a front closure, flipping lace trim, converting/re-routing a multiway strap, peeling off a stick-on cup), cross-check that feature against [PRODUCT VISUAL ANCHOR]. If THIS product does NOT have that feature, copying the action would misrepresent the product — REPLACE it with a neutral action that does not reference the missing feature (talking to camera, hand resting on collarbone, turning slightly to show overall fit/silhouette). NEVER demonstrate or call attention to a feature this product does not have.
  3. ${isSameProduct
    ? 'PRESERVE original DIALOGUE DISTRIBUTION — use compressed_script lines for each shot following the reference\'s word-per-shot distribution.'
    : 'PRESERVE original TIMING/WORD-COUNT DISTRIBUTION only — copy how many words fall in each shot based on the reference\'s timing. But write ENTIRELY NEW dialogue content from the product info and user\'s concept. DO NOT copy any words, phrases, or selling points from the reference shot sequence.'
  }
  4. ADAPT locations/props to a generic indoor home setting (bedroom / living room / bathroom). Do NOT copy the reference's specific location.
  5. MAP OUTFITS to what the reference does: if the reference shows an outfit change (cardigan on→off) at a specific time, preserve that switch at the same proportional time. If reference is single-outfit one-take, KEEP single-outfit.
  6. ANTI-MIRROR-FLIP REWRITE (CRITICAL — Seedance frequently cheats here by horizontally flipping the previous frame):
     • If shot_sequence contains vague phrases like "different angle", "turns to side", "another view", "shows the other side", or just "[different angle of the same outfit]" — REWRITE that shot to "SAME camera angle, presenter does a DIFFERENT specific action".
     • SAFE substitution examples — hand AWAY from the bra and other thin parts (these are the ONLY hand placements allowed for invented actions):
       - "raises one hand to chin / cheek / temple, looks slightly down then up"
       - "tucks loose hair behind one ear"
       - "lightly touches her own collarbone / neckline area with one fingertip" (above the bra, not on it)
       - "lets both hands fall to her sides, posture relaxed"
       - "hand goes out of frame (resting on a counter / hip below frame line)"
       - "head tilts slightly, soft smile, no hand movement at all"
       - "looks briefly off-camera to one side then back, hands still"
     • FORBIDDEN substitutions (ALL violate ACTION SAFETY, do NOT invent these even when trying to avoid mirror-flip):
       - hand or palm ON the bra cup, band, strap, or underwire
       - fingers near the bra at all (gap < 1 fist width = forbidden)
       - hand "demonstrating" the product fit by touching it
     • If shot_sequence describes a 3D body rotation Seedance can't render cleanly (e.g. "spins 360°", "shows the back"), REPLACE with a SAFE static-camera shot from the safe list above.
     • Only PRESERVE explicit camera moves the reference clearly does (e.g. "camera follows her walking from bed to mirror" — that's a location change, allowed).
     • The goal: every cut in our SHOT SEQUENCE must be either (a) a location change, (b) a clear outfit switch, or (c) same camera + a SAFE different action from the list above. NEVER "same camera + slightly turned body" (mirror-flip trap). NEVER "same camera + hand on bra" (anatomy hallucination trap).

DO NOT impose A-B-A-B if the reference doesn't have it. DO NOT add edit cuts the reference doesn't have. DO NOT invent shots not in the reference.

REFERENCE METADATA (use as soft guides when rewriting):
  • hook_type: <copy from pass1Result.narrative_dna.hook_type>
  • tone_register: <copy from pass1Result.narrative_dna.tone_register>
  • unique_creative_signature: <copy from pass1Result.narrative_dna.unique_creative_signature> — at least one shot must visibly reflect this element.
  • key_phrases: <copy from pass1Result.narrative_dna.key_phrases as JSON array> — ${isSameProduct ? 'at least ONE of these phrases must appear verbatim in the dialogue.' : 'use ONLY as speaking cadence/energy reference. DO NOT use these words in the new video — they are from a different product.'}

[STYLE]
Camera: Phone-held, VISIBLY SHAKY — slight drift, micro-wobble, occasional reframe. NOT a tripod or gimbal.
Lighting: Soft directional window light, warm and diffused, from a nearby window at a gentle angle. Creates a SOFT natural shadow — subtle and gradual, NOT a harsh stark black shadow. Like overcast daylight through sheer curtains. Skin looks warm and dimensional. NOT ring light, NOT studio strobe, NOT sharp spotlight.
Background: Lived-in home — bedroom, living room, or bathroom. Slightly cluttered. NOT a studio backdrop.
Audio environment: INDOOR ONLY — quiet residential interior. Clean voice + very soft room tone. NO outdoor wind, NO traffic, NO street noise, NO music, NO echo. If reference video was filmed outside, ignore that ambience.
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture, possible blemishes. NOT airbrushed.
Hair casually styled, slightly imperfect — a strand out of place is good.
Expression: warm, fast-talking, spontaneous. Like sharing a secret. NOT posed or rehearsed.
Body language: loose, continuous, slightly imprecise movements. No theatrical pauses.

[SPEAKING STYLE]
TONE: Match pass1Result.narrative_dna.tone_register. Pick the matching delivery style:
  • EXCITED_BEST_FRIEND — high-energy, fast, exclamations like "OMG you guys", barely pauses, voice goes up at end of sentences
  • CALM_REVIEWER — measured medium pace, lower-pitched, expert tone, slight pauses for emphasis
  • SASSY_CONFIDENT — moderate pace with attitude, slight smirk in voice, occasional eye-roll inflection
  • GEN_Z_CASUAL — laid-back medium-slow pace, drops "literally", "deadass", "no cap", trailing off at end of phrases
  • SOFT_INTIMATE — quiet, slower, breathy ASMR-like quality, like sharing in bedroom
  • VULNERABLE_AUTHENTIC — slightly hesitant, real, occasional pauses to find words, like being honest
  • DEADPAN_FUNNY — flat affect with comedic timing, slight pause before punch lines
  • TEACHER_EDUCATIONAL — clear articulation, slight pauses to let info land, "let me show you" energy
Natural speech patterns appropriate to the tone.

ANTI-BROADCASTER (CRITICAL — the #1 reason AI videos sound machine-generated):
SPEAKING RATE matches the reference video (do NOT force fast; do NOT force slow). BUT no matter the rate, the CADENCE must be conversational human, NEVER broadcaster.
KILL these robotic patterns:
  • Over-articulated consonants (crisp Ts and Ds at every word) — NO. Let endings soften and slur.
  • Even rhythm on every word — NO. Stress 1-2 keywords per sentence, let other words run together.
  • Formal mid-sentence pauses ("the . product . is . amazing") — NO. Run clauses together; pause only between thoughts.
  • Uniform pitch contour ending each sentence flat — NO. Drop / rise / trail off unpredictably.
  • Perfect grammar / textbook diction — NO. Allow contractions, mild filler ("like", "you know"), occasional self-correction.
TARGET: sounds like a real person recording on her phone in one take — comfortable, slightly imperfect, with natural micro-hesitations and uneven word stress. NOT a TV anchor reading copy.

[AVOID]
No static images in video. No shots without a person. No gimbal. No harsh one-sided lighting. No airbrushed skin. No model poses. No slow delivery. No invented lines. No @Image references in video content.
PRODUCT ACCURACY — <write 1-2 plain declarative sentences listing visual features that must NOT appear. RULE: Only ban features this product DOES NOT HAVE — never ban a feature listed in PRODUCT VISUAL ANCHOR as present (that creates a self-contradiction). Cross-check AVOID against the ANCHOR before finalizing.>
PRODUCT INTEGRITY — when the product is shown held in hand or off-body, it must still match the PRODUCT VISUAL ANCHOR exactly: straps in correct positions, closure on the BACK only (never on the front of a back-closure bra), cup count and shape matching the anchor. Do NOT generate distorted, mirror-flipped, or structurally incorrect versions of the product.
---`

  const task3General = `
TASK 3 - Generate a Seedance2 prompt. [CATEGORY: GENERAL]

CRITICAL RULES:
${dialogueRule}
2. DO NOT reference @ImageN or insert static images in the shot sequence. Product images are reference only — use them to write accurate ACTION descriptions. Video must show a REAL PERSON PERFORMING ACTIONS.
3. The presenter actively uses/demonstrates the product throughout. Describe specific physical interactions with the product.
4. Speaking pace: FAST and energetic. Pack lines tightly — minimal pauses.

Use this FIXED STRUCTURE:

---
[PRODUCT VISUAL ANCHOR — READ THIS FIRST. Every frame of the video must be consistent with these specs. This is the highest-priority constraint.]
Silhouette/Shape: <copy from product_visual_features.silhouette — be specific, not generic>
Structure: <copy from product_visual_features.structure>
Construction: <copy from product_visual_features.construction>
Color: <copy from product_visual_features.color>
Distinguishing details: <copy from product_visual_features.distinguishing_details — specific elements that identify THIS product, not a generic version>
ENFORCEMENT: The product appearing in every frame must match every field above exactly. Do NOT substitute a similar-looking generic product. When visual details conflict with a "default" version of this product type, always follow the anchor.

[PRODUCT NOTES - internal only, do NOT speak or display these words in video]
Based on product images: <note key visible details — shape, color, material, key features, how it's used>. Use to write accurate action descriptions only.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for <one precise sentence describing the product using PRODUCT VISUAL ANCHOR fields>."

[PRESENTER]
Real everyday person, NOT a model or influencer.
<Fill in: age range, body type, skin tone with natural features — visible pores, possible freckles. NOT "flawless".>
HAIR — IMPORTANT: hair must be PULLED AWAY from any area where the product is held, applied, or demonstrated. Use one of: high ponytail / low ponytail / messy bun / topknot / hair clipped back / hair tucked securely behind both shoulders. NEVER "long loose hair flowing over hands or product" — hair near hands or interacting with the product causes severe AI rendering artifacts (hair-fabric merging, melted finger textures).
Warm, relaxed energy. Talks fast like sharing a discovery with a friend.
Clothing: casual everyday wear appropriate for demonstrating this type of product at home.

[SHOT SEQUENCE]
Every shot = a real person doing something. No static images. No product-on-white-background shots.

WORD BUDGET: total dialogue ≤ ${Math.round(targetDuration * 2.8)} words. Distribute the compressed_script across these shots. Leave the last 1-2 seconds SILENT.

ACTION SAFETY — Seedance has known weaknesses with complex 3D intersections. PREFER SURFACE-ONLY interactions whenever possible:
  ✅ Holding the product, pressing buttons on its surface, gesturing toward it, applying it to skin in simple strokes
  ❌ Fingers slipping inside small openings, hands clipping through gaps, tools operating at extreme angles
When unsure, choose the simpler interaction — Seedance handles "hand holds object" reliably but struggles with "fingers manipulate small parts inside object".

[0–Xs] Medium close-up — faces camera, talks fast. Says: "<part 1 of compressed_script>"
[Xs–Ys] Presenter actively uses/demonstrates the product — <specific SURFACE-LEVEL action based on product type>. Fast voiceover: "<part 2 of compressed_script>"
[Ys–Zs] Close-up on hands/product interaction showing a specific feature — <specific demo, prefer surface-level>. Voiceover: "<part 3 of compressed_script>"
[Zs–${targetDuration}s] She looks at camera, smiles. Says quickly: "<SHORT closing — max 6 words.>"

[STYLE]
Camera: Phone-held, VISIBLY SHAKY — slight drift, micro-wobble, occasional reframe. NOT a tripod or gimbal.
Lighting: Soft directional window light, warm and diffused. Creates a subtle soft shadow — NOT harsh or stark. Like overcast daylight through sheer curtains. NOT ring light, NOT studio strobe.
Background: Lived-in home — kitchen counter, bathroom shelf, living room couch. Slightly cluttered. NOT a studio backdrop.
Audio environment: INDOOR ONLY — quiet residential interior. Clean voice + very soft room tone. NO outdoor wind, NO traffic, NO street noise, NO music, NO echo. If reference video was filmed outside, ignore that ambience.
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture. NOT airbrushed.
Hair casually styled, slightly imperfect.
Expression: warm, fast-talking, spontaneous. NOT posed or rehearsed.
Body language: loose, continuous movements. No theatrical pauses.

[SPEAKING STYLE]
FAST pace — excited, barely pauses between sentences.
Natural speech patterns from transcript: brief "um" or "like" where they appeared.
One or two interjections: "Honestly", "Oh my god", "Seriously" — only where natural.
NOT a broadcaster voice.

[AVOID]
No static images in video. No shots without a person. No gimbal. No harsh lighting. No airbrushed skin. No model poses. No slow delivery. No invented lines. No @Image references in video content.
PRODUCT ACCURACY — never substitute a generic version of this product type. The product shown must match the PRODUCT VISUAL ANCHOR in every frame.
PRODUCT INTEGRITY — when the product is shown held in hand or off-body, it must still match the PRODUCT VISUAL ANCHOR exactly. Do NOT generate distorted or structurally incorrect versions of the product.
CONSISTENCY: Cross-check the AVOID list against the ANCHOR before finalizing — if any banned feature is also listed in the ANCHOR as present (e.g. "no buttons" but ANCHOR says product has buttons), REMOVE it from AVOID. Self-contradicting rules confuse the model.
---`

  // === before-after 模板（独立衍生，不污染主流程）===
  // 原则：task3Lingerie 本体一字不改；before-after 模式对它做两处定向替换后另存为 task3BeforeAfter。
  // mode !== 'before-after' 时这段完全不执行，普通任务的 task3 与改动前字节级一致。
  function deriveBeforeAfterTemplate(base) {
    const colorOld = `[COLOR — only <DOMINANT_COLOR>]
The bra is <DOMINANT_COLOR> in every frame. OUTFIT must say "<DOMINANT_COLOR> bra"; OPENING LINE must include the color; mention "<DOMINANT_COLOR>" in SHOT SEQUENCE at least 2 more times. NEVER write "any color" or alternate color names.`
    const colorNew = `[COLOR — only <DOMINANT_COLOR>]
The bra is <DOMINANT_COLOR> in every frame. In addition to the color NAME, write a plain VISUAL description of the shade — its lightness and hue (e.g. "a light nude close to pale skin tone", "a true mid-grey") — AND an explicit exclusion of the nearest WRONG shades the video model tends to drift toward (e.g. "NOT brown, NOT mocha, NOT dark tan"). OUTFIT must say "<DOMINANT_COLOR> bra"; OPENING LINE must include the color; mention the color name + its visual description in SHOT SEQUENCE at least 2 more times. NEVER write "any color" or alternate color names.`

    const shotAnchor = `Every shot = a real person doing something. No static images. No product-on-white-background shots.`
    const hookDirective = `${shotAnchor}

BEFORE-AFTER HOOK (MANDATORY — this is a before/after template video):
The FIRST 2 seconds (0:00-0:02) MUST be a rapid-fire hook: jump cuts alternating between LOOK A (the old/problem bra) and LOOK B (this product) roughly every half second. This is a deliberate, EXECUTABLE TikTok editing pattern — the video model renders it as separate short cut segments, NOT as in-frame morphing. Keep the presenter's pose simple and stable in the hook (hands relaxed at her sides) so ONLY the bra changes between cuts.
LOOK B in the hook MUST be described with MAXIMUM RIGIDITY: a single dense sentence built from the [PRODUCT VISUAL ANCHOR] fields (silhouette + structure + cup type + straps + fabric) PLUS the color name and its visual description from the [COLOR] block PLUS the wrong-shade exclusions. Reuse this exact LOOK B sentence verbatim every time LOOK B appears.
ACCEPT that the rapid-cut zone will show slight product drift — that is an inherent cost of fast cuts and is acceptable here, because the hook's job is the A/B contrast impact, not product detail. Product accuracy is carried by the slower dwell shots AFTER 0:02.
After 0:02 — TRANSITION THEN NORMAL:
The FIRST 1-2 spoken sentences after 0:02 MUST briefly land the SAME before/after selling point the hook is built around (see "User's additional ideas" / the user's concept) — a quick verbal pay-off that bridges the hook into the main content. Keep it to 1-2 sentences, do not dwell.
Cover that hook selling point ONCE here only — do NOT mention or repeat it again anywhere later in the video.
Everything after this transition follows the reference video's shot-by-shot skeleton and rhythm normally (same as a normal-mode video), covering the product's OTHER content and selling points — simply SKIP the hook's selling point since it is already addressed in the transition.`

    let out = base
    if (!out.includes(colorOld)) {
      throw new Error('before-after 衍生失败：COLOR 块锚点未匹配，task3Lingerie 模板可能已变更')
    }
    out = out.replace(colorOld, colorNew)
    if (!out.includes(shotAnchor)) {
      throw new Error('before-after 衍生失败：SHOT SEQUENCE 锚点未匹配，task3Lingerie 模板可能已变更')
    }
    out = out.replace(shotAnchor, hookDirective)
    return out
  }

  const task3 = mode === 'before-after'
    ? deriveBeforeAfterTemplate(task3Lingerie)  // before-after 强制走衍生 lingerie 模板
    : (category === 'lingerie' ? task3Lingerie : task3General)

  const parts = []
  parts.push({
    text: `You are an expert UGC video prompt writer.

This is PASS 2 of 2. PASS 1 already analyzed the reference video and product images. Your job now is to WRITE the final Seedance2 prompt using PASS 1's structured output. You do NOT have access to the reference video — only to the product images PASS 1 selected as best.

Below are the SELECTED product images (the same indices PASS 1 chose):`,
  })
  for (const { labelText, inlinePart } of selectedImageParts) {
    parts.push({ text: labelText })
    parts.push(inlinePart)
  }

  parts.push({
    text: `

User's additional ideas: ${userDescription || 'None provided'}
Target duration: ${targetDuration} seconds
${productInfoText ? `\n=== PRODUCT LISTING INFO (treat as ground truth) ===\n${productInfoText}\n===` : ''}
${scriptModeInstruction}

=== PASS 1 ANALYSIS RESULT (use as input) ===
${JSON.stringify((() => {
  if (isSameProduct) return pass1Result
  // isSameProduct=false: 把台词内容替换成节奏模板，保留语速/句长/语气，抹掉产品相关语义
  const cleaned = JSON.parse(JSON.stringify(pass1Result))

  // 把一段台词转换成节奏模板："After two kids..." → "[~9 words, fast, personal confession]"
  const toRhythmTemplate = (text) => {
    if (!text || typeof text !== 'string') return text
    const words = text.trim().split(/\s+/).length
    const isExclamation = /[!]/.test(text) || /^(oh|wow|omg|wait|no)/i.test(text)
    const isQuestion = /[?]/.test(text)
    const isConfession = /(i |my |me )/i.test(text)
    const isProblem = /(hate|wrong|bad|never|always|every time|struggle)/i.test(text)
    const energy = isExclamation ? 'high energy exclamation' : isProblem ? 'frustrated problem statement' : isConfession ? 'personal confession' : isQuestion ? 'rhetorical question' : 'conversational statement'
    return `[~${words} words, ${energy} — write new content from product info and user concept, match this rhythm]`
  }

  // 替换 compressed_script
  if (cleaned.compressed_script) {
    cleaned.compressed_script = toRhythmTemplate(cleaned.compressed_script)
  }
  if (cleaned.transcript) {
    cleaned.transcript = '[REDACTED — different product. Use speaking_style and tone_register for cadence reference only.]'
  }

  // 替换 shot_sequence 里的台词行，保留时间戳和动作
  if (cleaned.video_analysis?.shot_sequence) {
    cleaned.video_analysis.shot_sequence = cleaned.video_analysis.shot_sequence
      .replace(/Dialogue:\s*"([^"]*)"/gi, (_, dialogue) =>
        `Dialogue: "${toRhythmTemplate(dialogue)}"`)
      .replace(/dialogue:\s*"([^"]*)"/gi, (_, dialogue) =>
        `dialogue: "${toRhythmTemplate(dialogue)}"`)
  }

  // key_phrases：只保留语气词，去掉产品相关短语
  if (cleaned.narrative_dna?.key_phrases) {
    cleaned.narrative_dna.key_phrases = '[REDACTED — different product. Use tone_register and speaking_style for cadence only, do not copy phrases.]'
  }

  return cleaned
})(), null, 2)}
=== END PASS 1 ===

${task3}

IMPORTANT RULES:
- The seedance_prompt MUST follow the FIXED STRUCTURE above exactly. Replace every <...> placeholder with concrete content based on the PASS 1 analysis and the product images shown.
- Copy product_visual_features values VERBATIM into the [PRODUCT VISUAL ANCHOR] block. Do not paraphrase.
- Use the compressed_script from PASS 1 as the source of all spoken dialogue — distribute it across SHOT SEQUENCE lines, preserving exact wording.
- COLOR LOCK: Pass 1 chose dominant_color = "${pass1Result.dominant_color || 'unspecified'}". Replace EVERY occurrence of <DOMINANT_COLOR> in the template with this exact color name. Mention this color at least 3 times across the whole prompt: in [OPENING LINE], [OUTFIT], and [SHOT SEQUENCE]. Never write "any color" or "<color1> or <color2>" — only this single color.
- REFERENCE FIDELITY LOCK (CRITICAL — copies the reference's rhythm/actions/style faithfully):
  PASS 1 extracted from the reference:
    • shot_sequence (the actual shot-by-shot breakdown): used as the structural skeleton in [SHOT SEQUENCE] — do NOT replace with a generic A-B-A-B template
    • hook_type: ${pass1Result.narrative_dna?.hook_type || 'unspecified'}
    • tone_register: ${pass1Result.narrative_dna?.tone_register || 'unspecified'}
    • unique_creative_signature: ${pass1Result.narrative_dna?.unique_creative_signature || 'unspecified'}
    • key_phrases: ${JSON.stringify(pass1Result.narrative_dna?.key_phrases || [])}
  REQUIREMENTS:
  (1) The [SHOT SEQUENCE] block MUST rewrite the reference's shot_sequence with timing scaled to ${targetDuration}s, actions preserved (unsafe actions replaced per ACTION SAFETY), dialogue distributed per the reference's word distribution. Do NOT impose A-B-A-B if the reference doesn't have it.
  (2) The [SPEAKING STYLE] block MUST match tone_register (see SPEAKING STYLE block for the 8 tones). Do NOT default to "EXCITED_BEST_FRIEND" if tone_register is something else.
  (3) The unique_creative_signature MUST be reflected in [SHOT SEQUENCE] — at least one shot must visibly incorporate this specific element (e.g. if signature says "she's folding laundry", at least one shot must show this).
  (4) At least ONE key_phrase MUST appear verbatim in [SHOT SEQUENCE] dialogue.
  This is what makes the generated video faithfully echo the reference's style+rhythm+actions while staying physically safe. Do NOT skip this.${variantRecipe ? `
- VARIANT RECIPE LOCK (this run is variant "${variantRecipe.label}" — used to diversify outputs from the same reference video for TikTok anti-duplicate):
  • PRESENTER block MUST describe exactly: ${variantRecipe.presenter}
  • [STYLE] background MUST be: ${variantRecipe.scene}
  • OUTFIT LOOK A cardigan MUST be: ${variantRecipe.cardigan_color}
  • Override any conflicting hint from the reference video. The presenter and scene are NOT inferred from the reference — they are FIXED by this variant recipe.` : ''}
- Do NOT include [FACE & LIKENESS], [REFERENCE VIDEO USAGE], [ANATOMICAL ACCURACY], [NO ON-SCREEN TEXT], [NO IMPROVISED DIALOGUE], or [BODY ATTACHMENT BAN] blocks — these are appended automatically by the pipeline.
- CRITICAL — NO CONDITIONAL LOGIC IN PROMPT: The seedance_prompt is consumed by a video model that does NOT understand "if/then" / "if X then Y" / "when anchor says X" / conditional clauses. It blends ALL keywords from BOTH branches of any conditional, causing severe hallucinations. RESOLVE every conditional based on PASS 1's actual product_visual_features values and write the FINAL OUTCOME as plain declarative sentences. Never leave words like "if", "when anchor says", "depending on" in the final prompt.

Return ONLY this valid JSON, no markdown fences, no explanation:
{
  "seedance_prompt": "the full Seedance2 prompt with all placeholders resolved into concrete sentences"
}`,
  })

  const t0 = Date.now()
  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'Gemini Pass 2' })
  console.log(`  [Gemini Pass 2] 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`)

  if (!response.candidates || response.candidates.length === 0) {
    throw new Error(`Gemini Pass 2 无返回内容。promptFeedback: ${JSON.stringify(response.promptFeedback)}`)
  }
  const text = response.candidates[0].content.parts[0].text
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('Pass 2 JSON parse error:', e)
    console.error('Raw:', text.slice(0, 800))
    throw new Error('Pass 2: failed to parse Gemini response')
  }
}

// 入口：兼容旧签名，内部串联 Pass 1 + Pass 2
export async function analyzeAndGeneratePrompt({
  videoFilePath,
  videoUrl,
  imageFiles,
  productImageUrls,
  imageUrls,
  userDescription,
  targetDuration,
  category = 'general',
  productInfo = null,
  isSameProduct = true,
  variantSeed = null,  // 1-5 选不同的模特+场景配方，避免标杆复用时被查重
  mode = 'normal',  // 'normal' | 'before-after'
}) {
  const variantRecipe = getVariantRecipe(variantSeed)
  if (variantRecipe) {
    console.log(`  [Gemini] 使用 VARIANT ${variantSeed}: ${variantRecipe.label}`)
  }
  // 1) 准备视频和图片 inline parts
  const { videoPart, tmpVideoPath } = await prepareVideoPart(videoUrl, videoFilePath)
  const { labelParts, imageOrigins, totalImages, inlinePartByIndex } =
    await prepareImageParts({ imageFiles, productImageUrls, imageUrls })

  // 动态精简：≥6 张同 SKU 图时省掉 visual-only 字段（图就是 ground truth）
  const slimMode = totalImages >= SLIM_IMAGE_THRESHOLD
  console.log(`  [Gemini] 图数=${totalImages}, slimMode=${slimMode ? 'ON（省 edge/underwire/fabric_drape/construction 4 字段）' : 'OFF（保留完整描述）'}`)

  // 2) 公用文本块
  const productInfoText = formatProductInfo(productInfo)
  const scriptModeInstruction = isSameProduct ? `
=== SCRIPT MODE: SAME PRODUCT ===
The reference video IS for the same product being promoted. Therefore:
- The transcript from PASS 1 is the PRIMARY source for spoken dialogue.
- Compress the transcript directly into a ${targetDuration}-second script. Keep specific pain points, product details, and CTAs as close to the original wording as possible.
- If PRODUCT LISTING INFO is provided below, use it to SUPPLEMENT the transcript — add material/fabric details or specs that weren't mentioned. Do NOT replace original lines.
===` : `
=== SCRIPT MODE: DIFFERENT PRODUCT ===
The reference video is NOT for the same product — it is used as a STYLE REFERENCE ONLY. Therefore:
- Extract speaking pace, tone, sentence rhythm, energy level, and UGC authenticity cues from the transcript.
- Do NOT use the actual spoken content from the transcript as dialogue.
- The compressed_script must be written FRESH based on the PRODUCT LISTING INFO and product images.
- Mirror the style and structure of the reference transcript (opener type, pacing, CTA style) — but with content about the actual product.
===`

  let pass1Result, pass2Result
  try {
    // 3) Pass 1: 分析
    console.log(`  [Gemini] === Pass 1: 分析视频 + 选图 + 提取特征 ===`)
    pass1Result = await geminiPass1Analyze({
      videoPart,
      labelParts,
      totalImages,
      productInfoText,
      scriptModeInstruction,
      isSameProduct,
      targetDuration,
      slimMode,
    })

    // 4) 把 Pass 1 选中的图准备成 Pass 2 的输入（复用 inline part，不重新下载/压缩）
    const selectedIndices = (pass1Result.selected_image_indices || []).filter(
      idx => idx >= 1 && idx <= totalImages
    )
    if (selectedIndices.length === 0) {
      throw new Error('Pass 1 没有选出任何图片')
    }
    const selectedImageParts = selectedIndices
      .map(idx => ({
        idx,
        labelText: `[Image ${idx}]`,
        inlinePart: inlinePartByIndex[idx],
      }))
      .filter(p => p.inlinePart) // 过滤下载失败的
    console.log(`  [Gemini] Pass 1 选中 ${selectedImageParts.length} 张图，传给 Pass 2`)

    // 5) Pass 2: 撰写 Seedance prompt（无视频，仅选中的图）
    console.log(`  [Gemini] === Pass 2: 撰写 Seedance prompt（无视频，仅 ${selectedImageParts.length} 张选中图）===`)
    pass2Result = await geminiPass2WritePrompt({
      pass1Result,
      selectedImageParts,
      productInfoText,
      scriptModeInstruction,
      isSameProduct,
      targetDuration,
      category,
      userDescription,
      variantRecipe,
      slimMode,
      mode,
    })
  } finally {
    // 清理临时视频文件
    if (tmpVideoPath) unlink(tmpVideoPath).catch(() => {})
  }

  // 6) 合并 Pass 1 + Pass 2 结果，组装成与旧版兼容的返回结构
  const result = {
    video_analysis: pass1Result.video_analysis || {},
    product_visual_features: pass1Result.product_visual_features || {},
    narrative_dna: pass1Result.narrative_dna || null,  // Pass 1 提取的叙事基因
    key_segment_start_seconds: pass1Result.key_segment_start_seconds,
    key_segment_end_seconds: pass1Result.key_segment_end_seconds,
    dominant_color: pass1Result.dominant_color || null,
    selected_image_indices: pass1Result.selected_image_indices || [],
    image_color_role: pass1Result.image_color_role || [],
    compressed_script: pass1Result.compressed_script || '',
    seedance_prompt: pass2Result.seedance_prompt || '',
    reasoning: pass1Result.image_selection_reasoning || '',
    slim_mode: slimMode,  // 下游 generate.js 用来决定 PRODUCT REMINDER 是否省字段
  }

  // 把选中图片编号映射到来源信息（与旧版一致）
  const validSelectedIndices = (result.selected_image_indices || []).filter(
    idx => idx >= 1 && idx <= imageOrigins.length
  )
  result.selected_images = validSelectedIndices.map(idx => {
    const origin = imageOrigins[idx - 1]
    if (!origin || origin.failed) return null
    if (origin.source === 'local') {
      return { source: 'local', publicUrl: origin.uploadedUrl }
    }
    return { source: 'remote', sourceUrl: origin.sourceUrl }
  }).filter(Boolean)
  result.selected_image_urls = result.selected_images.map(s => s.publicUrl).filter(Boolean)

  return result
}
