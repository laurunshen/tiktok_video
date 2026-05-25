function buildGlobalLockSummary(globalLocks = {}) {
  const bits = [
    globalLocks.dominantColor ? `dominant color = ${globalLocks.dominantColor}` : '',
    globalLocks.silhouette ? `silhouette = ${globalLocks.silhouette}` : '',
    globalLocks.structure ? `structure = ${globalLocks.structure}` : '',
    globalLocks.fabricVisual ? `fabric look = ${globalLocks.fabricVisual}` : '',
    globalLocks.distinguishingDetails ? `details = ${globalLocks.distinguishingDetails}` : '',
  ].filter(Boolean)

  return bits.join('; ')
}

export function buildAgenticSegmentPrompt({
  basePrompt,
  segment,
  plan,
}) {
  if (!segment || segment.role === 'full_video') {
    return basePrompt
  }

  const lockSummary = buildGlobalLockSummary(plan?.globalLocks)
  const headerLines = [
    '[AGENT SEGMENT MODE]',
    `You are generating segment ${segment.index}/${plan.segments.length}. This segment must be exactly ${segment.duration} seconds.`,
    `Role: ${segment.role}.`,
    lockSummary ? `Global locks that must remain unchanged across every segment: ${lockSummary}.` : '',
    'Treat this as one continuous video project, not an unrelated short clip.',
    'Continuity is mandatory: same exact AI-generated presenter identity, same face shape, same hair, same body type, same outfit, same product, same room, same lighting, same camera distance, same handheld phone-video style.',
    'Do not introduce a new person, new room, new background, new outfit, new camera setup, or a new color palette between segments.',
    'The full prompt below is a constraint library only. Preserve its PRODUCT VISUAL ANCHOR, presenter, scene, style, safety rules, and authenticity rules, but DO NOT execute its full-video SHOT SEQUENCE or full-video timing.',
    'Execute ONLY the segment instructions in this [AGENT SEGMENT MODE] block. Ignore any dialogue, CTA, or timing from the base prompt that falls outside this segment.',
  ]

  if (segment.role === 'hook') {
    headerLines.push(
      'Generate ONLY the opening hook. Do not include the main demo body or a closing CTA.',
      'Keep actions simple, stable, and low-risk. End on a clean, stable frame with the presenter centered, product visible, and the room/camera composition easy to continue.',
      'The final frame must look like a natural paused moment in the same shot, not like a scene ending or a transition card.',
      segment.scriptExcerpt ? `Use this dialogue excerpt for the hook only: "${segment.scriptExcerpt}"` : '',
    )
  } else if (segment.role === 'body_cta') {
    headerLines.push(
      'Generate ONLY the continuation after the hook. Do not repeat the opening hook.',
      'The first frame is a hard continuity anchor. The first second must continue that exact frame: same presenter identity, same pose direction, same room, same camera distance, same lighting, same product placement.',
      'Start as if the camera never changed and the presenter simply continues speaking from the previous segment.',
      'No new establishing shot. No cut to a different room. No different person. No outfit reset. No sudden zoom or angle change at the start.',
      'Move quickly into the product demo, then end with a short CTA. Keep actions low-risk and avoid complex hand interactions.',
      segment.scriptExcerpt ? `Use this dialogue excerpt for the continuation only: "${segment.scriptExcerpt}"` : '',
    )
  }

  const header = headerLines.filter(Boolean).join('\n')
  return `${header}\n\n[BASE PROMPT CONSTRAINT LIBRARY — DO NOT EXECUTE FULL TIMELINE]\n${basePrompt}`
}
