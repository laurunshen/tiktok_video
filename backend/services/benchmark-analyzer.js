import { GoogleGenAI } from '@google/genai'
import { readFile } from 'fs/promises'
import { statSync } from 'fs'
import path from 'path'
import { generateContentWithRetry } from './gemini-retry.js'
import { transcribeVideo } from './audio-transcriber.js'
import { validateBenchmarkTemplate } from './benchmark-template-validator.js'
import { jsonFromText } from './json-utils.js'

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 900000 },
})

async function uploadVideoFileToGemini(videoPath) {
  const ext = path.extname(videoPath).toLowerCase()
  const mimeType = ext === '.mov' ? 'video/quicktime' : 'video/mp4'
  const fileSize = statSync(videoPath).size
  console.log(`[benchmark] uploading video to Gemini Files (${(fileSize / 1024 / 1024).toFixed(1)} MB)`)

  const uploadedFile = await genai.files.upload({
    file: videoPath,
    config: { mimeType },
  })

  let file = uploadedFile
  for (let attempt = 0; file.state === 'PROCESSING' && attempt < 40; attempt++) {
    await new Promise(r => setTimeout(r, 3000))
    file = await genai.files.get({ name: file.name })
    console.log(`[benchmark] Gemini file state ${file.state} (${attempt + 1})`)
  }
  if (file.state !== 'ACTIVE') throw new Error(`Gemini Files processing failed: ${file.state}`)
  return { uri: file.uri, mimeType, name: file.name }
}

async function frameToInlinePart(framePath) {
  const buffer = await readFile(framePath)
  return {
    inlineData: {
      mimeType: 'image/jpeg',
      data: buffer.toString('base64'),
    },
  }
}

function buildFrameTimeline(frames) {
  return frames.map((frame, index) => ({
    index: index + 1,
    timestamp: frame.timestamp,
    zone: frame.zone,
    source: frame.source,
    score: frame.score ?? null,
    sampling_reason: frame.sampling_reason ?? [],
    metrics: frame.metrics ?? {},
  }))
}

export async function analyzeBenchmarkVideo({ videoPath, frames, frameStats, duration, sourceName }) {
  const transcript = await transcribeVideo(videoPath)
  const videoFile = await uploadVideoFileToGemini(videoPath)
  const frameTimeline = buildFrameTimeline(frames)

  const parts = [
    {
      text: `You are a senior AI video creative director building a benchmark analyzer for high-quality AI TikTok commerce videos.

Your job is NOT to summarize loosely. Extract a hard, reusable replication template.

Inputs:
- The original benchmark video.
- Explicit ASR transcript with timestamps.
- Extracted visual frames with timestamps. Hook frames are denser, body frames are 1 FPS, scene_change frames mark likely cuts/transitions.

Source video name: ${sourceName || 'unknown'}
Duration seconds: ${duration ?? 'unknown'}
Frame extraction stats: ${JSON.stringify(frameStats)}

Explicit ASR transcript:
${JSON.stringify(transcript, null, 2)}

Frame timeline:
${JSON.stringify(frameTimeline, null, 2)}

Return ONLY valid JSON with this exact top-level schema:
{
  "summary": "one concise paragraph",
  "hook_type": "problem-solution | curiosity | direct claim | before-after | demo-first | testimonial | other",
  "timeline": [
    {
      "start": 0,
      "end": 2,
      "role": "hook | pain_point | product_demo | proof | transition | CTA | other",
      "visual": "what is visible",
      "spoken_line": "spoken line from ASR or empty string",
      "camera": "camera distance/movement/framing",
      "action": "physical action",
      "product_visibility": "none | partial | clear | close-up",
      "replication_notes": "what to preserve when recreating"
    }
  ],
  "shot_list": [
    {
      "start": 0,
      "end": 2,
      "shot_type": "close-up | medium | full-body | over-shoulder | product close-up | screen | other",
      "camera": "specific camera behavior",
      "action": "single executable action",
      "spoken_line": "line aligned to this shot or empty string",
      "product_visibility": "specific visibility and position",
      "scene": "location/background",
      "lighting": "specific lighting",
      "motion_complexity": "low | medium | high",
      "ai_generation_risk": "risk to avoid when generating"
    }
  ],
  "quality_factors": [
    { "factor": "specific quality driver", "evidence": "timestamp/frame evidence", "replication_rule": "actionable rule" }
  ],
  "replicable_template": {
    "fixed_structure": ["things to preserve"],
    "replaceable_variables": ["product-specific variables to swap"],
    "recommended_scene": "scene recipe",
    "recommended_person": "presenter recipe without copying identity",
    "motion_complexity": "low | medium | high",
    "lighting": "lighting recipe",
    "camera_style": "camera recipe",
    "spoken_structure": "how dialogue is distributed"
  },
  "prompt_recipe": "Seedance-ready prompt skeleton that preserves structure but does not copy identity or brand marks",
  "risks": [
    { "risk": "specific failure mode", "why_it_happens": "reason", "mitigation": "prompt/control fix" }
  ],
  "scorecard": {
    "visual_quality": 0,
    "ai_stability": 0,
    "product_clarity": 0,
    "ugc_authenticity": 0,
    "replicability": 0
  }
}

Hard requirements:
- Use timestamps in seconds.
- Align spoken_line to the explicit ASR transcript. If no ASR line exists, use "".
- Include product visibility in every timeline item and shot.
- Make actions simple and executable. Flag complex hand/body actions as risks.
- Do not copy the presenter's identity. Describe transferable structure only.`,
    },
    {
      fileData: {
        mimeType: videoFile.mimeType,
        fileUri: videoFile.uri,
      },
    },
  ]

  const cappedFrames = frames.slice(0, 60)
  for (let i = 0; i < cappedFrames.length; i++) {
    const frame = cappedFrames[i]
    parts.push({ text: `\n[Frame ${i + 1} | ${frame.timestamp.toFixed(2)}s | ${frame.zone} | ${frame.source}]` })
    parts.push(await frameToInlinePart(frame.path))
  }

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'benchmark analyzer' })

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const template = jsonFromText(text)
  const validation = validateBenchmarkTemplate(template)

  try {
    if (videoFile.name) await genai.files.delete({ name: videoFile.name })
  } catch (err) {
    console.warn(`[benchmark] Gemini file cleanup skipped: ${err.message}`)
  }

  return {
    transcript,
    frameTimeline,
    template,
    validation,
  }
}
