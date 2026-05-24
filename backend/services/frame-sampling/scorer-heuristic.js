import sharp from 'sharp'
import { clamp } from './shared.js'

async function readFrameFeatures(framePath) {
  const { data, info } = await sharp(framePath)
    .rotate()
    .resize(96, 96, { fit: 'inside' })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const width = info.width
  const height = info.height
  if (!width || !height || !data?.length) return null

  const yStart = Math.floor(height * 0.18)
  const yEnd = Math.max(yStart + 1, Math.floor(height * 0.7))
  const xStart = Math.floor(width * 0.15)
  const xEnd = Math.max(xStart + 1, Math.floor(width * 0.85))

  let mean = 0
  let sq = 0
  let count = 0
  let roiMean = 0
  let roiSq = 0
  let roiCount = 0
  let centerEdge = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const v = data[idx]
      mean += v
      sq += v * v
      count++

      const inRoi = y >= yStart && y < yEnd && x >= xStart && x < xEnd
      if (inRoi) {
        roiMean += v
        roiSq += v * v
        roiCount++
      }

      if (inRoi && x < width - 1 && y < height - 1) {
        const right = data[idx + 1]
        const down = data[idx + width]
        centerEdge += Math.abs(v - right) + Math.abs(v - down)
      }
    }
  }

  if (!count || !roiCount) return null

  const variance = sq / count - (mean / count) ** 2
  const roiVariance = roiSq / roiCount - (roiMean / roiCount) ** 2
  const centerEdgeNorm = centerEdge / (roiCount * 255 * 2)
  return {
    vector: data,
    variance: Math.max(0, variance),
    roiVariance: Math.max(0, roiVariance),
    centerEdgeNorm: clamp(centerEdgeNorm),
  }
}

function normalizedDiff(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return clamp(diff / (a.length * 255))
}

export async function scoreFramesHeuristic(frames, {
  hookSeconds,
  sceneTimestamps = [],
  scoreWeights,
  hookBonus,
}) {
  const ordered = [...frames].sort((a, b) => a.timestamp - b.timestamp)
  let prevVector = null

  for (const frame of ordered) {
    const feat = await readFrameFeatures(frame.path).catch(() => null)
    if (!feat) {
      frame.score = 0
      frame.metrics = {}
      frame.sampling_reason = ['feature_read_failed']
      continue
    }

    const sceneDelta = sceneTimestamps.length
      ? Math.min(...sceneTimestamps.map(t => Math.abs(frame.timestamp - t)))
      : Infinity
    const sceneContext = Number.isFinite(sceneDelta) ? clamp(1 - sceneDelta / 0.6) : 0
    const fullDiff = normalizedDiff(feat.vector, prevVector)

    const sharpness = clamp(Math.sqrt(feat.variance) / 70)
    const centerDetail = clamp(Math.sqrt(feat.roiVariance) / 75)
    const motion = clamp(fullDiff)
    const braRoiDetail = clamp(0.6 * centerDetail + 0.4 * feat.centerEdgeNorm)
    const diversity = clamp(fullDiff)

    const score = (
      scoreWeights.sharpness * sharpness +
      scoreWeights.braDetail * braRoiDetail +
      scoreWeights.motion * motion +
      scoreWeights.sceneContext * sceneContext +
      scoreWeights.diversity * diversity +
      (frame.timestamp <= hookSeconds ? hookBonus : 0)
    )

    const reasons = []
    if (frame.timestamp <= hookSeconds) reasons.push('hook')
    if (sceneContext > 0.35) reasons.push('scene_context')
    if (motion > 0.28) reasons.push('motion_peak')
    if (braRoiDetail > 0.3) reasons.push('bra_roi_detail')
    if (sharpness > 0.3) reasons.push('sharp_frame')
    if (!reasons.length) reasons.push('uniform')

    frame.score = Number(score.toFixed(4))
    frame.metrics = {
      sharpness: Number(sharpness.toFixed(4)),
      bra_roi_detail: Number(braRoiDetail.toFixed(4)),
      motion: Number(motion.toFixed(4)),
      scene_context: Number(sceneContext.toFixed(4)),
    }
    frame.sampling_reason = reasons

    prevVector = feat.vector
  }

  return ordered
}
