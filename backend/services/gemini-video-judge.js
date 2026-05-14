// Gemini 视频评分服务：让 Gemini 看完生成的视频和参考标杆视频，对比评分
// 用于自动评估"我们的生成视频是否真的复刻了标杆的叙事基因"

import { GoogleGenAI } from '@google/genai'
import { writeFile, unlink, readFile } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'

const genai = new GoogleGenAI({
  vertexai: true,
  project: 'eternal-concept-492907-q3',
  location: 'global',
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

/**
 * 评分单条生成视频（无标杆对比）
 */
export async function judgeGeneratedVideo({ generatedVideoUrl, productInfo, prompt }) {
  const parts = []
  parts.push({
    text: `You are a senior TikTok creative director reviewing an AI-generated UGC product video. Watch the video carefully and score it.`,
  })
  parts.push(await videoUrlToInlinePart(generatedVideoUrl))
  parts.push({
    text: `

Product: ${productInfo?.name || 'unknown'}
Color featured: ${productInfo?.color || 'not specified'}

Score the video on these dimensions (0-10 each):

1. PRODUCT_ACCURACY — does the bra in the video match the actual product (silhouette, color, edge, structure)?
2. CHARACTER_CONSISTENCY — same person across all cuts (face/hair/makeup/body)?
3. NATURAL_UGC_FEEL — looks like authentic creator-shot phone video, not AI-generated?
4. ANATOMICAL_CORRECTNESS — hands/fingers/face proportions all natural?
5. AUDIO_QUALITY — clean indoor voice, no wind/echo/glitches?
6. NO_TEXT_LEAKAGE — zero captions, no marketing text overlays?
7. NARRATIVE_CREATIVITY — does the video have a memorable hook/structure, or does it feel templated/generic?
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
  "verdict": "one sentence summary"
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

  const response = await genai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  })
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('[diff-judge] JSON parse fail:', e.message)
    return null
  }
}
