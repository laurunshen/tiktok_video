// Gemini 二次评估：拿到第一次 Gemini 输出的 prompt 后，让 Gemini（伪装成"独立审稿"）
// 对照产品图重新审查，定向检查 4 件事：
// 1. PRODUCT VISUAL ANCHOR 描述与产品图实际特征是否吻合
// 2. PRESENTER 描述是否照搬参考视频达人外貌
// 3. SHOT SEQUENCE 字数预算是否合理
// 4. 整体是否有遗漏或自相矛盾

import { GoogleGenAI } from '@google/genai'
import { readFile as readFileAsync, writeFile, unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'

// AI Studio API key 直连（详见 gemini.js 注释）
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 600000 }, // 10分钟，二次评估也要带产品图
})

const MAX_IMG_BYTES = 1 * 1024 * 1024

// In-memory 缓存：URL → inlineData base64 part
// 避免 review 和 revise（最多 4 次调用）重复下载 + sharp 压缩同一批产品图
// 简单 LRU：超过 100 条删最旧的，避免长期内存泄漏
const imagePartCache = new Map()
const IMAGE_CACHE_MAX = 100

function cacheGet(url) {
  const v = imagePartCache.get(url)
  if (v) {
    // 重新插入到末尾，模拟 LRU 访问顺序
    imagePartCache.delete(url)
    imagePartCache.set(url, v)
  }
  return v
}

function cacheSet(url, part) {
  if (imagePartCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imagePartCache.keys().next().value
    imagePartCache.delete(oldest)
  }
  imagePartCache.set(url, part)
}

async function imageUrlToInlinePart(url) {
  const cached = cacheGet(url)
  if (cached) {
    return cached
  }
  const { default: sharp } = await import('sharp')
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  let buf = await sharp(Buffer.from(res.data))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer()
  if (buf.length > MAX_IMG_BYTES) {
    buf = await sharp(buf).jpeg({ quality: 55 }).toBuffer()
  }
  const part = {
    inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') },
  }
  cacheSet(url, part)
  return part
}

/**
 * 二次评估 prompt
 * @param {Object} opts
 * @param {string} opts.prompt - Gemini 第一次生成的 seedance_prompt（不含强制注入的块）
 * @param {string} opts.compressedScript
 * @param {Object} opts.productVisualFeatures - product_visual_features 字段
 * @param {string[]} opts.productImageUrls - 用于审查 ANCHOR 是否准确（最多取 5 张）
 * @param {number} opts.targetDuration
 * @returns {{ pass: boolean, score: number, issues: Array<{severity, field, problem, fix}>, suggestion: string }}
 */
export async function reviewPrompt({
  prompt,
  compressedScript,
  productVisualFeatures,
  productImageUrls = [],
  targetDuration,
}) {
  const parts = []

  parts.push({
    text: `You are a senior creative director reviewing a draft video generation prompt written by a junior copywriter. Your job is to catch problems BEFORE the prompt is sent to an expensive video generation model. Be ruthless — every issue caught saves significant compute cost.

Below are the PRODUCT IMAGES the video should accurately depict. Look at them carefully:`,
  })

  // 取全部选中的产品图（最多 9 张，与上游 Gemini 选图范围一致），保证评估依据完整
  const imageSubset = productImageUrls.slice(0, 9)
  for (let i = 0; i < imageSubset.length; i++) {
    try {
      parts.push({ text: `\n[Product Image ${i + 1}]` })
      parts.push(await imageUrlToInlinePart(imageSubset[i]))
    } catch (e) {
      console.warn(`  [review] 图片 ${i + 1} 下载失败: ${e.message}`)
    }
  }

  parts.push({
    text: `\n\n=== DRAFT PROMPT TO REVIEW ===
${prompt}
=== END DRAFT PROMPT ===

=== STRUCTURED PRODUCT FEATURES (from junior's analysis) ===
${JSON.stringify(productVisualFeatures, null, 2)}
=== END FEATURES ===

=== TRANSCRIPT/SCRIPT TO BE SPOKEN (target duration: ${targetDuration}s) ===
${compressedScript}
=== END SCRIPT ===

=== YOUR REVIEW TASKS ===

You are reviewing this prompt before it goes to an EXPENSIVE video generation model (¥12 per video). Your job is to catch issues that will produce a UNUSABLE / SEVERELY DEFECTIVE video. NOT to nitpick.

ONLY two classes of problems should be flagged "critical":

CLASS A — PRODUCT INACCURACY (will produce a video that misrepresents the product)
   - Compare the product images against the [PRODUCT VISUAL ANCHOR] block.
   - Flag CRITICAL only if the prompt describes the product DIFFERENTLY from what the images clearly show. Examples:
     ❌ Anchor says "laser-cut seamless edges" but images clearly show stitched hems
     ❌ Anchor says "wireless" but images clearly show underwire
     ❌ Anchor says "padded" but images clearly show unlined
     ❌ Brand name in script does not match brand name visible on product packaging in images
     ❌ Self-contradicting descriptions in the same anchor (e.g. "deep V plunge" AND "balconette" — these are different garments)
     ❌ construction ↔ edge_finish contradiction: "smooth seamless" + any stitched edge_finish (folded hem / picot / bound edge / topstitching) is physically impossible — seamless garments can't have stitched edges. When flagging, the revision instruction MUST tell Gemini: "trust edge_finish, change construction to 'visible seams' or 'lace panels'". Similarly: "lace panels" or "mesh inserts" + "laser-cut flat edges" is impossible (lace/mesh have stitched perimeters).
     ❌ AVOID list bans a feature this product actually has (forces the AI to misrepresent)
   - DO NOT flag critical for: minor wording choices, generic vs specific phrasing, optional details missing.

CLASS B — SEVERE PHYSICAL HALLUCINATION RISK (will produce visible body/garment distortion)
   - Flag CRITICAL only for actions/descriptions known to break Seedance:
     ❌ Long loose hair flowing over the chest where bra/garment is shown
     ❌ Fingers slipping UNDER tight clothing (bra band, underwire, strap)
     ❌ Hands clipping THROUGH straps or fabric
     ❌ Multi-finger interaction with thin/delicate product parts at extreme angles
   - DO NOT flag critical for: speaking pace too fast, shot length too short, scene description not vivid enough, missing variety.

EVERYTHING ELSE = warning (does NOT block, will not trigger revision):
   - Word budget overflow (even +20% over) → warning only
   - Speaking pace 2.8 vs 3.3 words/sec → warning only
   - Final 1-2s not perfectly silent → warning only
   - Generic vs specific descriptions → warning only
   - Likeness concerns (the pipeline already injects FACE & LIKENESS block) → warning only
   - Missing optional elements (interjections, fillers, etc) → warning only

KEY HEURISTIC: Will this issue produce a video that is UNUSABLE for the merchant? If yes → critical. If it just makes the video slightly less polished → warning.

=== OUTPUT FORMAT ===

Return ONLY valid JSON, no markdown:
{
  "pass": true/false,
  "score": 0-10,
  "issues": [
    { "severity": "critical|warning", "field": "PRODUCT VISUAL ANCHOR|SHOT SEQUENCE|...", "problem": "specific issue", "fix": "specific corrective action" }
  ],
  "suggestion": "If pass=false, write a concise instruction (under 200 words) for the junior to fix CRITICAL issues only. If pass=true, write 'No changes needed.'"
}

PASS RULE:
- pass=true ONLY if zero "critical" issues. ANY number of "warning" issues is OK to pass.
- score: 10 = perfect, 8-9 = minor warnings, 5-7 = product accuracy concerns, <5 = severely broken.`,
  })

  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('[review] JSON parse failed:', e.message)
    console.error('[review] Raw:', text.slice(0, 500))
    // 解析失败按通过处理，避免阻塞主流程
    return { pass: true, score: 5, issues: [], suggestion: '审查响应解析失败，跳过此次评估' }
  }
}

/**
 * 把审查反馈喂给 Gemini，让它修订 prompt
 * @returns 修订后的 { seedance_prompt, compressed_script, product_visual_features }
 */
export async function reviseGeminiOutput({
  originalPrompt,
  originalScript,
  originalFeatures,
  reviewSuggestion,
  reviewIssues,
  productImageUrls = [],
  targetDuration,
}) {
  const parts = []

  parts.push({
    text: `You wrote a draft video prompt. A senior reviewer found issues. Revise the prompt to fix them.

Below are the PRODUCT IMAGES (for re-checking visual accuracy):`,
  })

  for (let i = 0; i < productImageUrls.slice(0, 9).length; i++) {
    try {
      parts.push({ text: `\n[Product Image ${i + 1}]` })
      parts.push(await imageUrlToInlinePart(productImageUrls[i]))
    } catch {}
  }

  parts.push({
    text: `\n\n=== ORIGINAL DRAFT PROMPT ===
${originalPrompt}
=== END ===

=== ORIGINAL SCRIPT ===
${originalScript}
=== END ===

=== ORIGINAL PRODUCT FEATURES ===
${JSON.stringify(originalFeatures, null, 2)}
=== END ===

=== REVIEWER'S SPECIFIC ISSUES ===
${reviewIssues.map(i => `[${i.severity}] ${i.field}: ${i.problem} → FIX: ${i.fix}`).join('\n')}
=== END ===

=== REVIEWER'S OVERALL GUIDANCE ===
${reviewSuggestion}
=== END ===

TASK: Output a REVISED version that addresses every "critical" issue. Keep the same structure (the [PRODUCT VISUAL ANCHOR], [PRESENTER], [SHOT SEQUENCE], etc. blocks must all still exist). Word budget for dialogue: ${Math.round(targetDuration * 2.8)} words max.

Do NOT add or remove top-level blocks. Do NOT change formatting style. ONLY fix the flagged content.

CRITICAL HARD RULES (these MUST hold in the revised prompt — if any violation remains, the revision will be rejected and re-submitted):

1. NO CONDITIONAL LOGIC. The revised prompt must NOT contain any phrase like "if edge_finish = ...", "if anchor says ...", "when X then Y", "depending on ...", or any other if/then/conditional construct. Video models do NOT process conditional logic — they blend keywords from BOTH branches, causing severe hallucinations. RESOLVE every conditional yourself based on this product's actual product_visual_features values, then write the resolved outcome as plain declarative sentences. Example:
   ❌ WRONG: "If edge_finish = 'laser-cut flat edges': zero visible stitching."
   ✅ RIGHT: "Cups have flat laser-cut edges with no visible stitching." (assuming this product's edge_finish is laser-cut)
   ✅ RIGHT: "Cups have a folded fabric hem with visible topstitching along the top edge." (assuming this product's edge_finish is bound)

2. NO TEMPLATE PLACEHOLDERS. The revised prompt must NOT contain phrases like "[from TASK 2b ... field]", "[Fill in: ...]", or any other unresolved placeholder. Every bracketed slot must be filled with concrete content based on this product.

3. PRODUCT FEATURES MUST MATCH THE IMAGES. Re-examine the product images above. If the original product_visual_features got any field wrong (e.g. described laser-cut edges when the images clearly show stitched hems), CORRECT IT in the revised features AND in the prompt's [PRODUCT VISUAL ANCHOR] block. Trust the images over the original analysis.

4. ADDRESS EVERY CRITICAL ISSUE LISTED ABOVE. Do not leave any reviewer-flagged issue unfixed.

Return ONLY valid JSON, no markdown:
{
  "seedance_prompt": "the full revised prompt with NO conditional logic and NO unresolved placeholders",
  "compressed_script": "the revised script",
  "product_visual_features": { ... revised features ... }
}`,
  })

  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('[revise] JSON parse failed, returning original:', e.message)
    return null
  }
}

// 任务结束时清理这次任务用到的图片缓存（避免长期运行内存膨胀）
export function clearImageCache(urls) {
  if (!urls) {
    imagePartCache.clear()
    return
  }
  for (const url of urls) imagePartCache.delete(url)
}

export function formatReviewReport(review) {
  const lines = [
    review.pass
      ? `✅ Gemini 二次评估通过（评分 ${review.score}/10）`
      : `❌ Gemini 二次评估未通过（评分 ${review.score}/10）`,
  ]
  for (const i of review.issues || []) {
    const icon = i.severity === 'critical' ? '❌' : '⚠️'
    lines.push(`  ${icon} [${i.field}] ${i.problem}`)
    if (i.fix) lines.push(`     → 建议: ${i.fix}`)
  }
  return lines.join('\n')
}
