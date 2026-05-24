import { readdir } from 'fs/promises'
import path from 'path'
import { dedupeFrames } from './shared.js'

export async function extractFixedFpsFrames(runFfmpeg, videoPath, dir, {
  prefix,
  fps,
  width,
  start = 0,
  duration = null,
  zone,
}) {
  const pattern = path.join(dir, `${prefix}_%04d.jpg`)
  const args = ['-y']
  if (start > 0) args.push('-ss', String(start))
  args.push('-i', videoPath)
  if (duration != null) args.push('-t', String(duration))
  args.push('-vf', `fps=${fps},scale=${width}:-2`, '-q:v', '4', pattern)
  await runFfmpeg(args, { label: `ffmpeg ${prefix}` })

  const files = (await readdir(dir))
    .filter(f => f.startsWith(`${prefix}_`) && f.endsWith('.jpg'))
    .sort()

  return files.map((file, index) => ({
    path: path.join(dir, file),
    timestamp: Number((start + index / fps).toFixed(2)),
    zone,
    source: 'fixed_fps',
  }))
}

export async function extractSceneFrames(runFfmpeg, videoPath, dir, { width, threshold = 0.3 }) {
  const pattern = path.join(dir, 'scene_%04d.jpg')
  const args = [
    '-y',
    '-i', videoPath,
    '-vf', `select=gt(scene\\,${threshold}),showinfo,scale=${width}:-2`,
    '-vsync', 'vfr',
    '-q:v', '4',
    pattern,
  ]
  const stderr = await runFfmpeg(args, { label: 'ffmpeg scene' }).catch(err => {
    console.warn(`[frames] scene extraction skipped: ${err.message}`)
    return ''
  })

  const timestamps = []
  for (const match of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    timestamps.push(parseFloat(match[1]))
  }

  const files = (await readdir(dir))
    .filter(f => f.startsWith('scene_') && f.endsWith('.jpg'))
    .sort()

  return files.map((file, index) => ({
    path: path.join(dir, file),
    timestamp: Number((timestamps[index] ?? 0).toFixed(2)),
    zone: 'scene_change',
    source: 'scene_detection',
  }))
}

export function buildSceneContextFrames(sceneTimestamps, duration, offsets) {
  const out = []
  for (const ts of sceneTimestamps) {
    for (const offset of offsets) {
      const t = Number((ts + offset).toFixed(2))
      if (t <= 0 || (duration && t >= duration)) continue
      out.push({
        timestamp: t,
        zone: 'scene_context',
        source: 'scene_context',
      })
    }
  }
  return out
}

export function buildCandidates({ hookFrames, bodyFrames, sceneFrames, sceneContextFrames, maxFrames }) {
  return dedupeFrames(
    [...hookFrames, ...bodyFrames, ...sceneFrames, ...sceneContextFrames],
    Math.max(maxFrames * 2, 120)
  )
}
