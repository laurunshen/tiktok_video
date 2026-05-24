import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import os from 'os'
import { resolveFfmpegPath, resolveFfprobePath, ffmpegInstallHint } from './ffmpeg-paths.js'
import { createSmartSamplingStrategy } from './frame-sampling/strategy.js'
import {
  extractFixedFpsFrames,
  extractSceneFrames,
  buildSceneContextFrames,
  buildCandidates,
} from './frame-sampling/extractor.js'
import { scoreFramesHeuristic } from './frame-sampling/scorer-heuristic.js'
import { pickFramesWithBudget } from './frame-sampling/selector.js'

function runFfmpeg(args, { label = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error(ffmpegInstallHint()))
      else reject(err)
    })
    proc.on('close', code => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`${label} exit ${code}: ${stderr.slice(-800)}`))
    })
  })
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfprobePath(), args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error(ffmpegInstallHint()))
      else reject(err)
    })
    proc.on('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-500)}`))
    })
  })
}

export async function getVideoDuration(videoPath) {
  const out = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ])
  const duration = parseFloat(out.trim())
  return Number.isFinite(duration) ? duration : null
}

export async function extractBenchmarkFrames(videoPath, options = {}) {
  const strategy = createSmartSamplingStrategy({
    fps: {
      base: Number(options.baseFps) || undefined,
      hook: Number(options.hookFps) || undefined,
      hookDuration: Number(options.hookDuration) || undefined,
    },
    maxFrames: Number(options.maxFrames) || undefined,
    sceneThreshold: Number(options.sceneThreshold) || undefined,
  })
  const width = Number(options.width) || 512
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benchmark-frames-'))

  try {
    const duration = await getVideoDuration(videoPath).catch(() => null)
    const hookSeconds = duration
      ? Math.min(strategy.fps.hookDuration, duration)
      : strategy.fps.hookDuration
    const bodyStart = hookSeconds
    const bodyDuration = duration ? Math.max(0, duration - bodyStart) : null

    const hookFrames = await extractFixedFpsFrames(runFfmpeg, videoPath, dir, {
      prefix: 'hook',
      fps: strategy.fps.hook,
      width,
      start: 0,
      duration: hookSeconds,
      zone: 'hook',
    })

    const bodyFrames = bodyDuration === 0 ? [] : await extractFixedFpsFrames(runFfmpeg, videoPath, dir, {
      prefix: 'body',
      fps: strategy.fps.base,
      width,
      start: bodyStart,
      duration: bodyDuration,
      zone: 'body_candidate',
    })

    const sceneFrames = await extractSceneFrames(runFfmpeg, videoPath, dir, {
      width,
      threshold: strategy.sceneThreshold,
    })

    const sceneTimestamps = sceneFrames.map(f => f.timestamp)
    const sceneContextFrames = buildSceneContextFrames(
      sceneTimestamps,
      duration,
      strategy.sceneContextOffsets
    )
    const candidates = buildCandidates({
      hookFrames,
      bodyFrames,
      sceneFrames,
      sceneContextFrames,
      maxFrames: strategy.maxFrames,
    })

    const scored = await scoreFramesHeuristic(candidates, {
      hookSeconds,
      sceneTimestamps,
      scoreWeights: strategy.scoreWeights,
      hookBonus: strategy.hookBonus,
    })

    const frames = pickFramesWithBudget(scored, {
      maxFrames: strategy.maxFrames,
      hookSeconds,
      sceneTimestamps,
      budget: strategy.budget,
    })

    return {
      dir,
      duration,
      frames,
      stats: {
        strategy: strategy.name,
        hookFrames: hookFrames.length,
        bodyFrames: bodyFrames.length,
        sceneFrames: sceneFrames.length,
        candidateFrames: candidates.length,
        selectedFrames: frames.length,
      },
    }
  } catch (err) {
    await cleanupFrameDir(dir)
    throw err
  }
}

export async function cleanupFrameDir(dir) {
  if (dir) await rm(dir, { recursive: true, force: true })
}
