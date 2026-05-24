import { GoogleGenAI } from '@google/genai'
import { readFile, unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { spawn } from 'child_process'
import { generateContentWithRetry } from './gemini-retry.js'
import { jsonFromText } from './json-utils.js'
import { resolveFfmpegPath, ffmpegInstallHint } from './ffmpeg-paths.js'

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 600000 },
})

function runFfmpeg(args, { label = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error(ffmpegInstallHint()))
      } else {
        reject(err)
      }
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${label} exit ${code}: ${stderr.slice(-800)}`))
    })
  })
}

async function extractAudio(videoPath) {
  const audioPath = path.join(os.tmpdir(), `${uuidv4()}-audio.mp3`)
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '64k',
    audioPath,
  ], { label: 'ffmpeg audio' })
  return audioPath
}

async function transcribeAudio(audioPath) {
  const buffer = await readFile(audioPath)
  const parts = [
    {
      text: `Transcribe this short-form commerce video audio with timestamps.

Return ONLY valid JSON:
{
  "language": "detected language",
  "segments": [
    { "start": 0.0, "end": 1.8, "speaker": "creator", "text": "exact spoken words", "confidence": 0-1 }
  ],
  "full_text": "complete transcript",
  "audio_notes": ["music/noise/silence/voiceover observations"]
}

Rules:
- Use second-level timestamps.
- If the audio is silent or unintelligible, return an empty segments array and explain in audio_notes.
- Do not invent lines.`,
    },
    {
      inlineData: {
        mimeType: 'audio/mpeg',
        data: buffer.toString('base64'),
      },
    },
  ]

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: 'benchmark ASR' })

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  return jsonFromText(text)
}

export async function transcribeVideo(videoPath) {
  let audioPath = null
  try {
    audioPath = await extractAudio(videoPath)
    return await transcribeAudio(audioPath)
  } catch (err) {
    console.warn(`[benchmark] ASR skipped: ${err.message}`)
    return {
      language: 'unknown',
      segments: [],
      full_text: '',
      audio_notes: [`ASR failed or no usable audio: ${err.message}`],
    }
  } finally {
    if (audioPath) await unlink(audioPath).catch(() => {})
  }
}
