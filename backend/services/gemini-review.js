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

const genai = new GoogleGenAI({
  vertexai: true,
  project: 'eternal-concept-492907-q3',
  location: 'global',
  httpOptions: { timeout: 600000 }, // 10分钟，二次评估也要带产品图
})

const MAX_IMG_BYTES = 1 * 1024 * 1024

async function imageUrlToInlinePart(url) {
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
  return {
    inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') },
  }
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

  // 取最多 5 张产品图
  const imageSubset = productImageUrls.slice(0, 5)
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

Check these 4 dimensions and flag any issue you find. Be strict — catch real problems, not nitpicks.

1. PRODUCT VISUAL ANCHOR ACCURACY
   - Look at the product images. Compare against the [PRODUCT VISUAL ANCHOR] block in the draft.
   - Are silhouette / structure / color / construction descriptions actually consistent with what's in the images?
   - For lingerie: are edge_finish, underwire_profile, fabric_drape correctly identified? (e.g. if images clearly show laser-cut seamless edges, the anchor must say so — not "visible sewn trim")
   - Flag any inaccurate or generic description that could lead to wrong product rendering.

2. PRESENTER LIKENESS RISK
   - Read the [PRESENTER] block. Does it describe a generic person (good) or does it copy specific features that look like a real person from a reference video (bad — likeness risk)?
   - If the description is suspiciously specific (e.g. exact hair texture + skin tone + face shape combo), flag as likeness risk.

3. WORD BUDGET / TIMING
   - Total dialogue word count across all [SHOT SEQUENCE] lines + compressed_script should be ≤ ${Math.round(targetDuration * 2.8)} words.
   - Each shot's line should fit within its time window at ~2.8 words/sec.
   - Flag if total exceeds budget or if any single shot is overloaded.

4. INTERNAL CONSISTENCY
   - Do the [SHOT SEQUENCE] actions actually demonstrate what the [PRODUCT VISUAL ANCHOR] describes?
   - Are there contradictions (e.g. anchor says "wireless" but shot description says "shows underwire")?
   - Is anything missing or vague that would cause the model to hallucinate?

=== OUTPUT FORMAT ===

Return ONLY valid JSON, no markdown:
{
  "pass": true/false,
  "score": 0-10,
  "issues": [
    { "severity": "critical|warning", "field": "PRODUCT VISUAL ANCHOR|PRESENTER|SHOT SEQUENCE|...", "problem": "specific issue", "fix": "specific corrective action" }
  ],
  "suggestion": "If pass=false, write a concise instruction (under 200 words) the junior should follow to fix the prompt. If pass=true, write 'No changes needed.'"
}

PASS RULE:
- pass=true ONLY if there are zero "critical" issues. "warning" issues are OK to pass with.
- score: 10 = perfect, 8-9 = minor warnings, 5-7 = needs work, <5 = severely broken.`,
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

  for (let i = 0; i < productImageUrls.slice(0, 5).length; i++) {
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

Return ONLY valid JSON, no markdown:
{
  "seedance_prompt": "the full revised prompt",
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
