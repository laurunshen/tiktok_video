import { mergeUniqueFrames, sampleUniform, takeTopByScore } from './shared.js'

export function pickFramesWithBudget(scored, {
  maxFrames,
  hookSeconds,
  sceneTimestamps,
  budget,
}) {
  const sceneSet = new Set(sceneTimestamps.map(t => Number(t.toFixed(2))))
  const hookFrames = scored.filter(f => f.timestamp <= hookSeconds)
  const sceneFrames = scored.filter(f => {
    if (f.zone === 'scene_change') return true
    return sceneTimestamps.some(t => Math.abs(f.timestamp - t) <= 0.55)
  })
  const actionFrames = scored.filter(f => f.timestamp > hookSeconds)
  const detailFrames = scored.filter(f => (f.metrics?.bra_roi_detail ?? 0) > 0.26)

  const hookBudget = Math.min(Math.max(budget.minHook, Math.floor(maxFrames * budget.hookRatio)), maxFrames)
  const sceneBudget = Math.min(Math.max(budget.minScene, Math.floor(maxFrames * budget.sceneRatio)), maxFrames - hookBudget)
  const actionBudget = Math.min(Math.max(budget.minAction, Math.floor(maxFrames * budget.actionRatio)), maxFrames - hookBudget - sceneBudget)
  const detailBudget = Math.min(Math.max(budget.minDetail, Math.floor(maxFrames * budget.detailRatio)), maxFrames - hookBudget - sceneBudget - actionBudget)
  const reserve = Math.max(0, maxFrames - hookBudget - sceneBudget - actionBudget - detailBudget)

  const picked = [
    ...takeTopByScore(hookFrames, hookBudget),
    ...takeTopByScore(sceneFrames, sceneBudget),
    ...takeTopByScore(actionFrames, actionBudget),
    ...takeTopByScore(detailFrames, detailBudget),
  ]

  const merged = mergeUniqueFrames(picked)
  if (merged.length < maxFrames) {
    const left = maxFrames - merged.length
    merged.push(...sampleUniform(scored, Math.max(reserve, left)))
  }

  return mergeUniqueFrames(merged)
    .slice(0, maxFrames)
    .map(frame => ({
      ...frame,
      zone: sceneSet.has(Number(frame.timestamp.toFixed(2)))
        ? 'scene_change'
        : frame.timestamp <= hookSeconds ? 'hook' : frame.zone || 'body_candidate',
      source: frame.source || 'smart_selector',
    }))
}
