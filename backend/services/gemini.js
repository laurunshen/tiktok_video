import { GoogleGenAI } from '@google/genai'
import { readFile as readFileAsync, writeFile, unlink } from 'fs/promises'
import { statSync } from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'

const genai = new GoogleGenAI({
  vertexai: true,
  project: 'eternal-concept-492907-q3',
  location: 'global',
  httpOptions: { timeout: 900000 }, // 15分钟，给足多图分析时间（产品图越多 Gemini 理解越准确）
})

// Gemini inline 图片上限建议 1MB，超了先压缩
const GEMINI_IMAGE_MAX_BYTES = 1 * 1024 * 1024

// 强制注入 Seedance prompt 的固定指令块。Gemini 在长 prompt 里会偷偷压缩这些规则，
// 所以由 generate.js 拿到 Gemini 输出后用代码硬拼接，保证 100% 进入 Seedance prompt。
export const SEEDANCE_MANDATORY_BLOCKS = `
[FACE & LIKENESS — HARD CONSTRAINT]
The presenter's face must be a completely original AI-generated face. Seedance MUST NOT use the person from the reference video as the presenter. Treat the reference video purely as a STYLE and ENERGY guide — the actor in it is NOT the actor in the output. The output presenter must have visibly different facial features (different face shape, different eye shape, different nose, different lips), and ideally different hair color and skin tone from the reference person. This is a hard constraint, not a preference.

[REFERENCE VIDEO USAGE — STRICT BOUNDARY]
The attached reference video is provided ONLY as a guide for: camera movement (handheld shake pattern, framing rhythm), lighting style (window light angle, soft natural shadows), pacing (cut frequency, energy), and the presenter's body language and gesture style.
DO NOT copy from the reference video: the presenter's face, body, or any identifying features; any objects, accessories, or items attached to the presenter's body (microphones, badges, lanyards, jewelry, logos, tags, lapel mics, dark spots on clothing); background props, room layout, or specific environment details; clothing items the reference person is wearing.
If the reference video contains anything attached to the person (lapel mic, clip, badge, dark spot, sticker), DO NOT replicate it. The output presenter wears ONLY what is described in [OUTFIT] / [PRESENTER] — nothing else attached to the body or clothing.

[ANATOMICAL ACCURACY]
Hands must have exactly 5 fingers each, in natural anatomical positions. No extra digits, no fused fingers, no missing fingers, no impossible joint angles, no rubber-like distortions. If a hand cannot be rendered correctly in a given shot, keep it OUT OF FRAME instead of generating a deformed hand. Same rule for feet, eyes, and ears.

[NO ON-SCREEN TEXT]
ABSOLUTELY NO subtitles, captions, burned-in text, lyric overlays, watermarks, on-screen labels, brand text, or any kind of text appearing in the video frame. This is a clean visual UGC video — only the spoken audio carries the words. Suppress any default tendency to add captions or auto-generated subtitles.

[NO IMPROVISED DIALOGUE]
The presenter speaks ONLY the exact lines written in [SHOT SEQUENCE]. Do NOT add any improvised lines such as "link in bio", "link down below", "okay bye", "thanks for watching", "follow me", "comment below", "check it out", or any closing CTAs that are not explicitly in the shot sequence script. When the scripted lines end before the video does, fill the remaining time with the presenter smiling silently, adjusting hair, or looking at camera — NO additional speech.

[BODY ATTACHMENT BAN]
No microphones, lapel mics, clip-on mics, recording devices, name tags, badges, lanyards, brooches, pins, stickers, or unexplained dark spots/objects on the presenter's chest, shoulders, neck, or clothing. The presenter's torso area is CLEAN — only the product and the optional cardigan from [OUTFIT] are present.
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
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture, possible blemishes. NOT airbrushed.
Hair casually styled, slightly imperfect — a strand out of place is good.
Expression: warm, fast-talking, spontaneous. Like sharing a secret. NOT posed or rehearsed.
Body language: loose, continuous, slightly imprecise movements. No theatrical pauses.

[SPEAKING STYLE]
FAST pace throughout — excited, can't wait to tell you. Barely pauses between sentences.
Natural speech: brief "um" or "like" from transcript where they appeared.
One or two interjections: "Honestly", "Oh my god", "Seriously" — only where natural.
NOT a broadcaster voice.

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
- silhouette: overall shape (e.g. "deep V plunge with center gore well below cleavage line", "high-neck halter", "sports bra band")
- structure: underwire / wireless, padded / unlined, molded cup / soft cup
- construction: lace panels / smooth seamless / bonded edges / visible seams / mesh inserts
- edge_finish: How are the cup and band edges finished? Choose the MOST accurate:
  • "laser-cut flat edges — zero visible stitching, no folded trim, edges lie completely flat against skin"
  • "narrow bonded edge — thin heat-bonded tape, minimal visible stitching, nearly flush with skin"
  • "fabric-covered underwire channel — slim channel, mostly hidden, low profile"
  • "visible sewn trim / picot edge — decorative stitched border visible on cup or band"
  • "thick bound edge — clearly raised folded fabric trim with visible topstitching"
  Be precise: this field directly controls whether visible stitching, trim, or thick edges appear in the generated video.
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

  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })

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
        const inlinePart = {
          inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') },
        }
        labelParts.push({
          idx,
          labelText: `[Image ${idx}: from product listing]`,
          inlinePart,
        })
        inlinePartByIndex[idx] = inlinePart
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i] })
      } catch (e) {
        console.warn(`  [Gemini] 图片 ${idx} 下载失败: ${e.message}`)
        imageOrigins.push({ source: 'remote', sourceUrl: remoteImages[i], failed: true })
      }
    }
  }

  return { labelParts, imageOrigins, totalImages, inlinePartByIndex }
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

STEP 2.2 — Select 5-9 images using these priority rules:
  • PRIORITIZE: images showing the DOMINANT color in hero/overview/on-body/close-up shots
  • ACCEPT (with caution): non-dominant-color images ONLY when they show structural information (e.g. back closure, strap placement) that NO dominant-color image covers, AND mark them in image_color_role as "structure-only-different-color"
  • Each selected image gets a role label in image_color_role: either "dominant-color" or "structure-only-different-color"

Return indices (1-based) and the role array. Pass 2 will only see selected images.

TASK 2b - Describe the product's KEY VISUAL FEATURES (CRITICAL — generated video must match these exactly):
Look at the product images carefully. Describe ONLY what you actually see — no assumptions.
Required fields (use null if not visible):
- silhouette: overall shape (e.g. "deep V plunge with center gore well below cleavage line", "high-neck halter", "sports bra band")
- structure: underwire / wireless, padded / unlined, molded cup / soft cup
- construction: lace panels / smooth seamless / bonded edges / visible seams / mesh inserts
- edge_finish: How are the cup and band edges finished? Choose the MOST accurate:
  • "laser-cut flat edges — zero visible stitching, no folded trim, edges lie completely flat against skin"
  • "narrow bonded edge — thin heat-bonded tape, minimal visible stitching, nearly flush with skin"
  • "fabric-covered underwire channel — slim channel, mostly hidden, low profile"
  • "visible sewn trim / picot edge — decorative stitched border visible on cup or band"
  • "thick bound edge — clearly raised folded fabric trim with visible topstitching"
  Be precise: this field directly controls whether visible stitching, trim, or thick edges appear in the generated video.
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
- distinguishing_details: anything that makes this product unique (bow, contrast trim, decorative panels, etc.)

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
  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })
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
}) {
  const dialogueRule = isSameProduct
    ? `1. SPOKEN DIALOGUE: Use the compressed_script verbatim from PASS 1 ANALYSIS. Distribute it across the SHOT SEQUENCE shots, preserving the exact wording.`
    : `1. SPOKEN DIALOGUE: Use the compressed_script verbatim from PASS 1 ANALYSIS as the dialogue. It was already written fresh based on this product.`

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
Required visual outcome: <write 1-3 plain declarative sentences describing — based on the actual edge_finish/underwire_profile/fabric_drape values for THIS product — what the cups, band edges, and underwire should literally look like in the video. Examples: "Cups have flat laser-cut edges with no visible stitching or folded trim." / "Underwire sits inside an invisible channel with no raised ridge." / "Fabric drapes as a second skin, cup edges flush against the body." DO NOT write conditional logic. Resolve the conditions yourself based on this product's anchor values and write the final outcome as plain statements. Video models ignore if/then logic and will blend all keywords from both branches, causing hallucinations.>

[COLOR LOCK — CRITICAL, applies to every frame and every shot]
The product in the generated video MUST appear in <DOMINANT_COLOR> ONLY. Reference images may show multiple color SKUs (variant images for the listing) — IGNORE all colors except <DOMINANT_COLOR>. Specifically:
  • Any reference image showing a different color (black/white/nude/etc.) is included ONLY for STRUCTURAL information (back closure, strap layout, hardware) — DO NOT copy its color into the video
  • The bra worn by the presenter throughout LOOK A and LOOK B must be <DOMINANT_COLOR>
  • The presenter's [OUTFIT] description must explicitly say "<DOMINANT_COLOR> bra"
  • In the [SHOT SEQUENCE], every shot describing the bra must mention "<DOMINANT_COLOR>" at least once across the sequence
  • In the [OPENING LINE], the color must appear
Treat <DOMINANT_COLOR> as a hard lock. If you (the prompt writer) feel tempted to write "any color" or "<color1> or <color2>" — STOP and use <DOMINANT_COLOR> only.

[PRODUCT NOTES - internal only, do NOT speak or display these words in video]
Based on product images: <note key visible details — fabric color, texture, strap style, clasp type, construction>. Use to write accurate action descriptions only.

[OPENING LINE]
"Generate a ${targetDuration}-second authentic UGC-style promotional video for <one precise sentence describing the product using PRODUCT VISUAL ANCHOR fields — e.g. 'a deep-V plunge underwire bra with laser-cut flat edges, unlined smooth microfiber cups in warm beige'>."

[PRESENTER]
Real everyday person, NOT a model or influencer.
<Fill in: age range, body type, skin tone with natural features — visible pores, possible freckles, natural texture. NOT "flawless".>
HAIR — IMPORTANT: hair must be PULLED AWAY from the chest area to keep the bra straps and neckline fully visible. Use one of: high ponytail / low ponytail / messy bun / topknot / hair clipped back / hair tucked securely behind both shoulders. NEVER "long loose hair" / "long hair flowing over chest" / "long hair down" — loose long hair occluding the chest causes severe AI rendering artifacts (flickering between hair and straps, melting hair-on-fabric textures, distorted neckline geometry).
Warm, relaxed energy. Talks fast like she's sharing a secret with a friend.

OUTFIT — two looks, alternating via clean cuts:
- LOOK A (talking shots): wears an open casual cardigan over the product. Relaxed at-home feel.
- LOOK B (product demo shots): wears only the product — no outer layer. Shows fit, silhouette, strap placement, fabric on skin.
Cuts between Look A ↔ Look B are intentional. Do NOT attempt in-frame undressing.

[SHOT SEQUENCE]
Every shot = a real person doing something. No static images. No product-on-white-background shots.

WORD BUDGET: total dialogue ≤ ${Math.round(targetDuration * 2.8)} words. Distribute the compressed_script across these shots, never exceeding the per-shot time × 2.8 words limit. Leave the last 1-2 seconds SILENT or with a gesture/smile.

ACTION SAFETY — Seedance has known weaknesses with complex 3D intersections. NEVER write actions that involve:
  • Fingers slipping UNDER tight clothing (e.g. "slides finger under the underwire", "tucks fingers behind the band") — causes hand-into-fabric distortion
  • Hands clipping THROUGH straps or band — causes melted/floating finger artifacts
  • Hair flowing over hands or product — causes hair-fabric merging
ALWAYS prefer SURFACE-ONLY interactions:
  ✅ "she traces the OUTSIDE of the underwire channel with her fingertip"
  ✅ "she runs her palm flat along the band, on top of the fabric"
  ✅ "she pinches the strap between two fingers and gently lifts it"
  ✅ "she turns sideways showing the silhouette"
  ❌ "she slides a finger under the underwire" / "tucks fingers behind the strap"

ANTI-LOOPING RULE — Seedance has a documented "boomerang effect": when two consecutive shots in the same outfit show similar hand-on-body actions for 8+ seconds total, Seedance falls back to looping/reversing the same animation segment (looks like a stuttering GIF). To prevent this:
  • Use the A-B-A-B alternating cut structure: LOOK A (talk) → LOOK B (demo) → LOOK A (talk) → LOOK B (demo)
  • OR introduce a clear PHYSICAL DISPLACEMENT between consecutive LOOK B shots: turn the body, walk a step, change angle, switch hand position completely
  • NEVER place two consecutive LOOK B shots that both involve "hand-on-chest-area" actions
  • Each LOOK B segment should be ≤ 5 seconds at most — if longer demo time is needed, break with a LOOK A cutaway

[0–4s] LOOK A. Medium close-up — she faces camera, talks fast. Says: "<part 1 of compressed_script>"
[4–8s] LOOK B. Wears only the product. SURFACE-ONLY action — <e.g. "she turns sideways showing the silhouette", "she runs her palm flat along the band on top of the fabric", "she pinches the strap between two fingers and lifts gently">. Fast voiceover: "<part 2 of compressed_script>"
[8–11s] LOOK A. Cuts back to the cardigan look, talking head. Says: "<part 3 of compressed_script>"
[11–${targetDuration}s] LOOK B. PHYSICALLY DIFFERENT angle/position from the [4-8s] LOOK B (e.g. if [4-8s] was front-facing palm-on-band, this one is back-turned showing the seamless back design / strap pull). SURFACE-ONLY interaction. Voiceover: "<SHORT closing — max 6 words. Must finish with 1s to spare.>"

[STYLE]
Camera: Phone-held, VISIBLY SHAKY — slight drift, micro-wobble, occasional reframe. NOT a tripod or gimbal.
Lighting: Soft directional window light, warm and diffused, from a nearby window at a gentle angle. Creates a SOFT natural shadow — subtle and gradual, NOT a harsh stark black shadow. Like overcast daylight through sheer curtains. Skin looks warm and dimensional. NOT ring light, NOT studio strobe, NOT sharp spotlight.
Background: Lived-in home — bedroom, living room, or bathroom. Slightly cluttered. NOT a studio backdrop.
Color grade: Slightly desaturated, warm, matte/flat like an iPhone without filters. Low sharpening. NOT vivid or cinematic.
Aspect ratio: 9:16 vertical.

[AUTHENTICITY]
Minimal/no makeup. Natural skin — visible pores, slight texture, possible blemishes. NOT airbrushed.
Hair casually styled, slightly imperfect — a strand out of place is good.
Expression: warm, fast-talking, spontaneous. Like sharing a secret. NOT posed or rehearsed.
Body language: loose, continuous, slightly imprecise movements. No theatrical pauses.

[SPEAKING STYLE]
FAST pace throughout — excited, can't wait to tell you. Barely pauses between sentences.
Natural speech: brief "um" or "like" from transcript where they appeared.
One or two interjections: "Honestly", "Oh my god", "Seriously" — only where natural.
NOT a broadcaster voice.

[AVOID]
No static images in video. No shots without a person. No gimbal. No harsh one-sided lighting. No airbrushed skin. No model poses. No slow delivery. No invented lines. No @Image references in video content.
PRODUCT ACCURACY — <write 1-2 plain declarative sentences listing what visual features must NOT appear. CRITICAL CONSISTENCY RULE: Only ban features this product DOES NOT HAVE. NEVER ban a feature that PRODUCT VISUAL ANCHOR / product_visual_features says this product DOES have — that creates a self-contradiction that confuses the model. Examples (resolved by product):
  • For a product with laser-cut edges: "Do not show visible stitched trim, folded hems, or thick bound edges on the cups."
  • For a product with stitched/folded hems: "Do not show raw unfinished edges or harsh laser-cut lines." (do NOT ban stitching here — this product has stitching)
  • For a product with invisible underwire: "Do not show a prominent underwire ridge or thick channel seam."
Cross-check the AVOID list against the ANCHOR before finalizing — if any banned feature is also listed in the ANCHOR as present, REMOVE it from AVOID.>
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

  const task3 = category === 'lingerie' ? task3Lingerie : task3General

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
${JSON.stringify(pass1Result, null, 2)}
=== END PASS 1 ===

${task3}

IMPORTANT RULES:
- The seedance_prompt MUST follow the FIXED STRUCTURE above exactly. Replace every <...> placeholder with concrete content based on the PASS 1 analysis and the product images shown.
- Copy product_visual_features values VERBATIM into the [PRODUCT VISUAL ANCHOR] block. Do not paraphrase.
- Use the compressed_script from PASS 1 as the source of all spoken dialogue — distribute it across SHOT SEQUENCE lines, preserving exact wording.
- COLOR LOCK: Pass 1 chose dominant_color = "${pass1Result.dominant_color || 'unspecified'}". Replace EVERY occurrence of <DOMINANT_COLOR> in the template with this exact color name. Mention this color at least 3 times across the whole prompt: in [OPENING LINE], [OUTFIT], and [SHOT SEQUENCE]. Never write "any color" or "<color1> or <color2>" — only this single color.
- Do NOT include [FACE & LIKENESS], [REFERENCE VIDEO USAGE], [ANATOMICAL ACCURACY], [NO ON-SCREEN TEXT], [NO IMPROVISED DIALOGUE], or [BODY ATTACHMENT BAN] blocks — these are appended automatically by the pipeline.
- CRITICAL — NO CONDITIONAL LOGIC IN PROMPT: The seedance_prompt is consumed by a video model that does NOT understand "if/then" / "if X then Y" / "when anchor says X" / conditional clauses. It blends ALL keywords from BOTH branches of any conditional, causing severe hallucinations. RESOLVE every conditional based on PASS 1's actual product_visual_features values and write the FINAL OUTCOME as plain declarative sentences. Never leave words like "if", "when anchor says", "depending on" in the final prompt.

Return ONLY this valid JSON, no markdown fences, no explanation:
{
  "seedance_prompt": "the full Seedance2 prompt with all placeholders resolved into concrete sentences"
}`,
  })

  const t0 = Date.now()
  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })
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
}) {
  // 1) 准备视频和图片 inline parts
  const { videoPart, tmpVideoPath } = await prepareVideoPart(videoUrl, videoFilePath)
  const { labelParts, imageOrigins, totalImages, inlinePartByIndex } =
    await prepareImageParts({ imageFiles, productImageUrls, imageUrls })

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
    })
  } finally {
    // 清理临时视频文件
    if (tmpVideoPath) unlink(tmpVideoPath).catch(() => {})
  }

  // 6) 合并 Pass 1 + Pass 2 结果，组装成与旧版兼容的返回结构
  const result = {
    video_analysis: pass1Result.video_analysis || {},
    product_visual_features: pass1Result.product_visual_features || {},
    key_segment_start_seconds: pass1Result.key_segment_start_seconds,
    key_segment_end_seconds: pass1Result.key_segment_end_seconds,
    selected_image_indices: pass1Result.selected_image_indices || [],
    compressed_script: pass1Result.compressed_script || '',
    seedance_prompt: pass2Result.seedance_prompt || '',
    reasoning: pass1Result.image_selection_reasoning || '',
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
