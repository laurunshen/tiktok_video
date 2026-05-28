import { GoogleGenAI } from '@google/genai'
import { generateContentWithRetry } from './gemini-retry.js'
import { jsonFromText } from './json-utils.js'

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 120000 },
})

// 让 AI 审核某段的脚本或视频提示词：判断有没有问题、给建议、给改写版本（不自动套用）。
export async function aiReviewSegment({ step, segment, wf }) {
  const isScript = step === 'script'
  const target = isScript ? (segment.script || '') : (segment.videoPrompt || '')
  const kind = isScript
    ? 'spoken dialogue script for ONE segment of a short-form UGC TikTok product video'
    : 'image/video generation prompt for ONE segment of a short-form UGC TikTok product video'

  const va = wf.geminiResult?.video_analysis || {}
  const ctx = [
    `Segment role: ${segment.role}; duration: ${segment.duration}s; focus: ${segment.focus || '(none)'}.`,
    wf.globalLocks?.dominantColor ? `Product color (locked): ${wf.globalLocks.dominantColor}.` : '',
    Array.isArray(va.key_selling_points) && va.key_selling_points.length ? `Key selling points: ${va.key_selling_points.join('; ')}.` : '',
    isScript ? `At ~2.8 words/sec, a ${segment.duration}s segment fits roughly ${Math.round(segment.duration * 2.8)} words.` : '',
  ].filter(Boolean).join('\n')

  const checklist = isScript
    ? 'Check: does it fit the duration (not too many words), stay on the segment focus, open with a strong hook (especially segment 1), sound like natural spoken UGC (not ad copy), and avoid improvised closers?'
    : 'Check: is it concise and focused on THIS segment only, does it keep product/presenter/scene continuity anchors, avoid full-video timeline, avoid conditional "if/then" wording, and clearly describe one beat?'

  const promptText = `You are a senior short-form UGC creative reviewing the ${kind} below.
Context:
${ctx}

${checklist}

Content to review:
"""${target}"""

Return ONLY valid JSON, no markdown:
{
  "ok": true,                 // true if it's good as-is, false if it has real problems
  "issues": "1-2 sentences naming concrete problems (empty if ok)",
  "suggestion": "1-2 sentences of concrete advice",
  "rewritten": "an improved version of the content above (same language as the original); if already good, return it lightly polished"
}`

  const resp = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    config: { temperature: 0.4 },
  }, { label: 'Workflow AI Assist' })

  const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const parsed = jsonFromText(text)
  return {
    ok: !!parsed.ok,
    issues: String(parsed.issues || ''),
    suggestion: String(parsed.suggestion || ''),
    rewritten: String(parsed.rewritten || target),
  }
}
