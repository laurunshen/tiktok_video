import { GoogleGenAI } from '@google/genai'
import { generateContentWithRetry } from './gemini-retry.js'
import { jsonFromText } from './json-utils.js'

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 900000 },
})

function clampDuration(seconds, max = 15) {
  return Math.min(Math.max(Math.round(seconds || 0), 5), max)
}

function safeStr(v) {
  return (v == null ? '' : String(v)).trim()
}

function countWords(text) {
  return (String(text || '').trim().match(/\b[\w']+\b/g) || []).length
}

function splitScriptIntoSegments(script, segmentDurations) {
  const words = String(script || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return segmentDurations.map(() => '')
  }

  const totalDuration = segmentDurations.reduce((sum, dur) => sum + dur, 0) || 1
  let cursor = 0

  return segmentDurations.map((duration, index) => {
    if (index === segmentDurations.length - 1) {
      return words.slice(cursor).join(' ')
    }

    const ratio = duration / totalDuration
    const remainingWords = words.length - cursor
    const nextCount = Math.max(1, Math.round(words.length * ratio))
    const take = Math.min(nextCount, remainingWords - (segmentDurations.length - index - 1))
    const excerpt = words.slice(cursor, cursor + take).join(' ')
    cursor += take
    return excerpt
  })
}

export function buildAgenticSegmentPlan({
  targetDuration,
  compressedScript = '',
  productVisualFeatures = {},
  dominantColor = '',
}) {
  const totalDuration = clampDuration(targetDuration)
  const canSplit = totalDuration >= 10

  const globalLocks = {
    dominantColor: dominantColor || productVisualFeatures.color || '',
    silhouette: productVisualFeatures.silhouette || '',
    structure: productVisualFeatures.structure || '',
    fabricVisual: productVisualFeatures.fabric_visual || '',
    distinguishingDetails: productVisualFeatures.distinguishing_details || '',
  }

  if (!canSplit) {
    return {
      generationMode: 'agentic_segments_v1',
      strategy: 'single_segment_fallback',
      totalDuration,
      globalLocks,
      segments: [
        {
          index: 1,
          role: 'full_video',
          duration: totalDuration,
          seedanceMode: 'multimodal_reference',
          scriptExcerpt: compressedScript,
          actionPolicy: 'low-risk',
          returnLastFrame: false,
        },
      ],
    }
  }

  const hookDuration = 5
  const bodyDuration = totalDuration - hookDuration
  const [hookScript, bodyScript] = splitScriptIntoSegments(compressedScript, [hookDuration, bodyDuration])

  return {
    generationMode: 'agentic_segments_v1',
    strategy: 'two_segment_keyframe_handoff',
    totalDuration,
    globalLocks,
    segments: [
      {
        index: 1,
        role: 'hook',
        duration: hookDuration,
        seedanceMode: 'multimodal_reference',
        scriptExcerpt: hookScript,
        actionPolicy: 'low-risk',
        returnLastFrame: true,
      },
      {
        index: 2,
        role: 'body_cta',
        duration: bodyDuration,
        seedanceMode: 'first_frame_continue',
        scriptExcerpt: bodyScript,
        actionPolicy: 'low-risk',
        firstFrameSource: 'segment_1_last_frame',
        returnLastFrame: false,
      },
    ],
  }
}

// 把 LLM 输出的 segments 规整成可执行计划：clamp 每段时长、按比例归一到 totalDuration、
// 强制第 1 段走 multimodal_reference 并返回尾帧、后续段走 first_frame_continue 链式衔接。
function normalizePlanSegments(rawSegments, totalDuration) {
  let segs = Array.isArray(rawSegments)
    ? rawSegments.filter(s => s && (safeStr(s.segmentPrompt) || safeStr(s.focus) || safeStr(s.scriptExcerpt)))
    : []
  if (segs.length < 2) return null

  const maxSegments = Math.max(2, Math.min(8, Math.floor(totalDuration / 4)))
  if (segs.length > maxSegments) segs = segs.slice(0, maxSegments)

  // clamp 原始时长后按比例归一到 totalDuration
  const raw = segs.map(s => Math.min(Math.max(Math.round(Number(s.duration) || 0), 4), 15))
  const sum = raw.reduce((a, b) => a + b, 0) || 1
  let durations = raw.map(d => Math.max(4, Math.round((d / sum) * totalDuration)))
  // 把累计取整误差并到最后一段，并保持 4-15 边界
  const diff = totalDuration - durations.reduce((a, b) => a + b, 0)
  const lastIdx = durations.length - 1
  durations[lastIdx] = Math.min(15, Math.max(4, durations[lastIdx] + diff))

  return segs.map((s, i) => {
    const isFirst = i === 0
    const isLast = i === segs.length - 1
    const seg = {
      index: i + 1,
      role: safeStr(s.role) || (isFirst ? 'hook' : isLast ? 'body_cta' : `segment_${i + 1}`),
      duration: durations[i],
      focus: safeStr(s.focus),
      seedanceMode: isFirst ? 'multimodal_reference' : 'first_frame_continue',
      scriptExcerpt: safeStr(s.scriptExcerpt),
      segmentPrompt: safeStr(s.segmentPrompt),
      actionPolicy: 'low-risk',
      returnLastFrame: !isLast,
    }
    if (!isFirst) seg.firstFrameSource = `segment_${i}_last_frame`
    return seg
  })
}

// LLM 驱动的分镜规划：读脚本+卖点+产品特征，自行决定分几段、每段聚焦什么、
// 并为每段写好「只关于本段」的精简 seedance prompt。失败时 fallback 到规则版。
export async function buildAgenticSegmentPlanLLM({ targetDuration, geminiResult = {}, maxDuration = 15 }) {
  const totalDuration = clampDuration(targetDuration, maxDuration)
  const pvf = geminiResult.product_visual_features || {}
  const globalLocks = {
    dominantColor: geminiResult.dominant_color || pvf.color || '',
    silhouette: pvf.silhouette || '',
    structure: pvf.structure || '',
    fabricVisual: pvf.fabric_visual || '',
    distinguishingDetails: pvf.distinguishing_details || '',
  }

  const fallback = () => buildAgenticSegmentPlan({
    targetDuration,
    compressedScript: geminiResult.compressed_script,
    productVisualFeatures: pvf,
    dominantColor: geminiResult.dominant_color,
  })

  // <10s 不值得拆，沿用规则版的单段逻辑
  if (totalDuration < 10) return fallback()

  try {
    const va = geminiResult.video_analysis || {}
    const dna = geminiResult.narrative_dna || {}
    const maxSegments = Math.max(2, Math.min(8, Math.floor(totalDuration / 4)))
    const lockBits = Object.entries(globalLocks)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')

    const promptText = `You are a shot planner for short-form UGC (TikTok-style) product videos.
Split ONE continuous ${totalDuration}-second handheld phone video into a SEQUENCE of segments that will be generated separately and then stitched. Treat it as one unbroken take: same AI-generated presenter, same room, same lighting, same product, same camera style across every segment.

GOAL: each segment must focus on exactly ONE thing so the video model is not overloaded. Do NOT cram multiple selling points into one segment.

CONSTRAINTS:
- Output between 2 and ${maxSegments} segments.
- Each segment duration is an integer between 4 and 15 seconds; the durations should sum to about ${totalDuration}.
- Segment 1 is the hook. The last segment ends with a short CTA.
- For each segment write a SELF-CONTAINED, CONCISE seedance prompt ("segmentPrompt") that describes ONLY that segment's single action/beat plus the minimum shared visual anchors needed for continuity (same presenter identity, same room, same lighting, same product, handheld phone-video style). DO NOT include a full multi-shot timeline, do NOT describe other segments, do NOT restate every rule. Keep each segmentPrompt tight and focused — this is the whole point.
- Split the dialogue ("scriptExcerpt") along natural sentence/semantic boundaries, never mid-sentence.

PRODUCT & STORY CONTEXT
Global visual locks (must stay identical across segments): ${lockBits || '(none provided)'}
Presenter: ${safeStr(va.presenter_description) || '(infer a consistent original AI presenter)'}
Filming style: ${safeStr(va.filming_style)}
Speaking style: ${safeStr(va.speaking_style)}
Key selling points: ${Array.isArray(va.key_selling_points) ? va.key_selling_points.join(' | ') : safeStr(va.key_selling_points)}
Reference shot sequence (for inspiration only, do NOT copy timing): ${safeStr(va.shot_sequence)}
Narrative hook type: ${safeStr(dna.hook_type)}
Narrative structure: ${safeStr(dna.narrative_structure)}
Full compressed script to distribute across segments:
"""${safeStr(geminiResult.compressed_script)}"""

Return ONLY valid JSON, no markdown, in this exact shape:
{
  "globalLocks": { "dominantColor": "", "silhouette": "", "structure": "", "fabricVisual": "", "distinguishingDetails": "" },
  "segments": [
    { "index": 1, "role": "hook", "duration": 5, "focus": "the single thing this segment emphasizes", "scriptExcerpt": "dialogue for this segment only", "segmentPrompt": "concise self-contained seedance prompt for THIS segment only" }
  ]
}`

    const response = await generateContentWithRetry(genai, {
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: { temperature: 0.4 },
    }, { label: 'Agentic Planner' })

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const parsed = jsonFromText(text)
    const segments = normalizePlanSegments(parsed.segments, totalDuration)
    if (!segments || segments.length < 2) throw new Error('LLM 规划返回的有效段数不足 2')

    const locks = { ...globalLocks }
    if (parsed.globalLocks && typeof parsed.globalLocks === 'object') {
      for (const [k, v] of Object.entries(parsed.globalLocks)) {
        if (v) locks[k] = v
      }
    }

    return {
      generationMode: 'agentic_segments_v1',
      strategy: 'llm_planned',
      totalDuration,
      globalLocks: locks,
      segments,
    }
  } catch (e) {
    console.warn(`[Agentic Planner] LLM 规划失败，fallback 规则版 2 段: ${e.message}`)
    return fallback()
  }
}

export function summarizeSegmentPlan(plan) {
  const segments = plan?.segments || []
  return {
    strategy: plan?.strategy || 'unknown',
    totalDuration: plan?.totalDuration || 0,
    segmentCount: segments.length,
    roles: segments.map(segment => segment.role),
    durations: segments.map(segment => segment.duration),
    focuses: segments.map(segment => segment.focus || ''),
    wordCounts: segments.map(segment => countWords(segment.scriptExcerpt)),
    promptChars: segments.map(segment => (segment.segmentPrompt || '').length),
  }
}
