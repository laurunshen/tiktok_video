export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value))
}

export function dedupeFrames(frames, maxFrames) {
  const sorted = frames
    .filter(f => Number.isFinite(f.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)

  const out = []
  for (const frame of sorted) {
    const duplicate = out.some(existing =>
      Math.abs(existing.timestamp - frame.timestamp) < 0.2 &&
      existing.zone === frame.zone
    )
    if (!duplicate) out.push(frame)
  }

  const priority = { hook: 0, scene_change: 1, body: 2, body_candidate: 3, scene_context: 4 }
  return out
    .sort((a, b) => (priority[a.zone] ?? 9) - (priority[b.zone] ?? 9) || a.timestamp - b.timestamp)
    .slice(0, maxFrames)
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function mergeUniqueFrames(frames, spacingSec = 0.18) {
  const sorted = frames
    .filter(f => Number.isFinite(f.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)

  const out = []
  for (const frame of sorted) {
    const i = out.findIndex(x => Math.abs(x.timestamp - frame.timestamp) < spacingSec)
    if (i === -1) {
      out.push(frame)
      continue
    }
    if ((frame.score ?? 0) > (out[i].score ?? 0)) out[i] = frame
  }
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

export function sampleUniform(frames, count) {
  if (count <= 0 || !frames.length) return []
  const picked = []
  const step = Math.max(1, Math.floor(frames.length / count))
  for (let i = 0; i < frames.length && picked.length < count; i += step) {
    picked.push(frames[i])
  }
  return picked
}

export function takeTopByScore(candidates, count, spacingSec = 0.22) {
  if (count <= 0 || !candidates.length) return []
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)
  const picked = []
  for (const frame of sorted) {
    if (picked.length >= count) break
    const close = picked.some(x => Math.abs(x.timestamp - frame.timestamp) < spacingSec)
    if (!close) picked.push(frame)
  }
  return picked
}
