// Gemini 视频评分服务：让 Gemini 看完生成的视频和参考标杆视频，对比评分
// 用于自动评估"我们的生成视频是否真的复刻了标杆的叙事基因"

import { GoogleGenAI } from '@google/genai'
import { writeFile, unlink, readFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import sharp from 'sharp'
import { generateContentWithRetry } from './gemini-retry.js'

// AI Studio API key 直连（详见 gemini.js 注释）
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 600000 },
})

async function videoUrlToInlinePart(url) {
  const tmp = path.join(os.tmpdir(), `${uuidv4()}.mp4`)
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  await writeFile(tmp, res.data)
  const buf = await readFile(tmp)
  await unlink(tmp).catch(() => {})
  return {
    inlineData: { mimeType: 'video/mp4', data: buf.toString('base64') },
  }
}

// 下载 + 压缩 产品参考图，给 judge 做视觉对比用
async function imageUrlToInlinePart(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  let buffer = await sharp(Buffer.from(res.data))
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  if (buffer.length > 1024 * 1024) {
    buffer = await sharp(buffer).jpeg({ quality: 60 }).toBuffer()
  }
  return {
    inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') },
  }
}

/**
 * 评分单条生成视频（无标杆对比）
 * referenceImageUrls：传给 Seedance 的原始产品图（让 judge 做视觉对比，product_accuracy 才有依据）
 */
export async function judgeGeneratedVideo({ generatedVideoUrl, productInfo, prompt, referenceImageUrls = [], mode = 'normal' }) {
  const parts = []
  // before-after 视频前 0-4 秒故意展示一件不同的旧 bra（LOOK A），评分时不能据此判产品不一致
  const beforeAfterJudgeNote = mode === 'before-after'
    ? ` IMPORTANT — this is a BEFORE/AFTER video: the first 4 seconds (0:00-0:04) deliberately alternate a DIFFERENT, inferior OLD "before" bra with the product. Judge PRODUCT_ACCURACY ONLY on the product bra shown from 0:04 onward. Do NOT penalize the 0:00-0:04 hook for showing a different bra — that different "before" bra is intentional by design, NOT an error or inconsistency.`
    : ''

  // 1) 先放参考图（带 label，让 judge 知道"产品应该长这样"）
  const refImages = []
  if (Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) {
    const cap = Math.min(referenceImageUrls.length, 6)  // 最多 6 张避免 payload 太大
    parts.push({
      text: `You are a senior TikTok creative director. First, here are ${cap} REFERENCE IMAGES showing what the actual product looks like — use these to judge whether the bra in the AI-generated video matches the real product:`,
    })
    for (let i = 0; i < cap; i++) {
      try {
        const p = await imageUrlToInlinePart(referenceImageUrls[i])
        parts.push({ text: `\n[Reference image ${i + 1} of ${cap}]` })
        parts.push(p)
        refImages.push(referenceImageUrls[i])
      } catch (e) {
        console.warn(`[judge] ref image ${i + 1} 下载失败（跳过）: ${e.message}`)
      }
    }
    parts.push({ text: `\n\nNow watch the AI-generated video below and judge how well its bra matches those reference images.\n` })
  } else {
    parts.push({
      text: `You are a senior TikTok creative director reviewing an AI-generated UGC product video. Watch the video carefully and score it.`,
    })
  }

  // 2) 视频
  parts.push(await videoUrlToInlinePart(generatedVideoUrl))

  // 3) 评分指令
  const hasRefs = refImages.length > 0
  parts.push({
    text: `

Product: ${productInfo?.name || 'unknown'}
Color featured: ${productInfo?.color || 'not specified'}

Score the video on these dimensions (0-10 each):

1. PRODUCT_ACCURACY — ${hasRefs
      ? `compare the bra in the VIDEO against the ${refImages.length} REFERENCE IMAGES at the top of this prompt. Score how well it matches: silhouette / neckline shape / color / edge style / underwire visibility / strap style / closure / distinguishing details. 10 = identical to references; 0 = completely different garment.`
      : `does the bra in the video look like a coherent real product (silhouette, color, edges, structure)? NOTE: no reference images provided — judge based on internal consistency only.`}${beforeAfterJudgeNote}
2. CHARACTER_CONSISTENCY — same person across all cuts (face/hair/makeup/body)? ${mode === 'before-after' ? 'NOTE: the BRA intentionally changes during the 0:00-0:04 hook (before/after) — that is by design; judge only the PERSON (face/hair/body), not the bra.' : ''}
3. NATURAL_UGC_FEEL — looks like authentic creator-shot phone video, not AI-generated? Specifically watch for: too-perfect symmetric face / "plastic" skin / artificial lighting / unnatural smile holds.
4. ANATOMICAL_CORRECTNESS — hands/fingers/face proportions all natural? No fused / extra / melted fingers.
5. AUDIO_QUALITY — clean indoor voice, no wind/echo/glitches?
6. NO_TEXT_LEAKAGE — zero captions, no marketing text overlays?
7. NARRATIVE_CREATIVITY — does the video have a memorable hook/structure, or does it feel templated/generic? NOTE: this video is INTENTIONALLY a faithful adaptation of a reference creator's script, so "feels like the reference" is GOOD not bad; only mark down if it feels machine-templated (not human-templated).
8. SHARE_WORTHINESS — would you share or save this video as a real TikTok user?

Return ONLY valid JSON:
{
  "scores": {
    "product_accuracy": 0-10,
    "character_consistency": 0-10,
    "natural_ugc_feel": 0-10,
    "anatomical_correctness": 0-10,
    "audio_quality": 0-10,
    "no_text_leakage": 0-10,
    "narrative_creativity": 0-10,
    "share_worthiness": 0-10
  },
  "overall": 0-10,
  "top_issues": ["specific issue 1", "specific issue 2", ...],
  "what_worked": ["specific strength 1", ...],
  "verdict": "one sentence summary",
  "reference_match_notes": "${hasRefs ? 'specific notes on how the video bra deviates from the reference images (or "matches reference cleanly")' : 'N/A — no reference images provided'}"
}`,
  })

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'Gemini 视频评分' })
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('[judge] JSON parse fail:', e.message)
    return null
  }
}

/**
 * 评分生成视频与标杆视频的"叙事差异化"程度
 * 关键问题：我们的生成视频是不是只换了模特但叙事完全照搬？
 */
export async function judgeNarrativeDifferentiation({ generatedVideoUrl, benchmarkVideoUrl }) {
  const parts = []
  parts.push({
    text: `You are evaluating whether an AI-generated video has its OWN unique narrative or just copies the reference video's structure.

Below are two videos:
1. The REFERENCE benchmark video (a high-ROI human-made TikTok)
2. The GENERATED AI video (which used the reference for inspiration)`,
  })
  parts.push({ text: `\n[VIDEO 1: REFERENCE BENCHMARK]` })
  parts.push(await videoUrlToInlinePart(benchmarkVideoUrl))
  parts.push({ text: `\n[VIDEO 2: GENERATED AI]` })
  parts.push(await videoUrlToInlinePart(generatedVideoUrl))
  parts.push({
    text: `

Compare them on:

1. HOOK_DIVERSITY (0-10): Does the generated video use a DIFFERENT opening hook than the reference, or just copy the same opening style?
   • 10 = completely different hook strategy
   • 5 = similar approach, different words
   • 0 = identical opening structure

2. NARRATIVE_STRUCTURE_DIVERSITY (0-10): Different shot sequence pattern, or same A-B-A-B template?
   • 10 = completely different rhythm/structure
   • 5 = similar pacing, different shot types
   • 0 = same shot-by-shot structure

3. PRESENTER_DIFFERENTIATION (0-10): Visibly different person?
   • 10 = totally different look/race/age
   • 5 = similar demographic but different individual
   • 0 = looks like same person

4. TONE_DIVERSITY (0-10): Different speaking energy/tone?
   • 10 = completely different vibe
   • 5 = similar energy, different words
   • 0 = identical speaking style

5. RISK_OF_TIKTOK_DUPLICATE_FLAG (0-10): How likely TikTok algorithm would flag the generated video as duplicate of the reference if both are posted?
   • 10 = zero duplicate risk, totally distinct
   • 5 = noticeably similar but probably ok
   • 0 = high duplicate flag risk

Return ONLY valid JSON:
{
  "scores": {
    "hook_diversity": 0-10,
    "narrative_structure_diversity": 0-10,
    "presenter_differentiation": 0-10,
    "tone_diversity": 0-10,
    "risk_of_tiktok_duplicate_flag": 0-10
  },
  "overall_differentiation": 0-10,
  "what_was_copied_too_closely": ["aspect 1", ...],
  "what_was_genuinely_different": ["aspect 1", ...],
  "verdict": "one sentence summary"
}`,
  })

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'Gemini 视频评分' })
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('[diff-judge] JSON parse fail:', e.message)
    return null
  }
}
