import { SEEDANCE_MANDATORY_BLOCKS } from './gemini.js'

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

// 精简模式：LLM 已为本段写好聚焦 prompt（segment.segmentPrompt）。
// 这里只补上跨段连续性指令 + 强制安全块，不再附带完整 basePrompt，
// 避免模型被无关的全片时间线和其它段内容稀释注意力。
function buildSlimSegmentPrompt({ segment, plan }) {
  const lockSummary = buildGlobalLockSummary(plan?.globalLocks)
  const lines = [
    '[AGENT SEGMENT MODE]',
    `You are generating segment ${segment.index}/${plan.segments.length}. This segment must be exactly ${segment.duration} seconds.`,
    `Role: ${segment.role}.${segment.focus ? ` Focus on ONE thing only: ${segment.focus}.` : ''}`,
    'This is ONE continuous video project, not an unrelated clip. Keep the exact same AI-generated presenter identity, face, hair, body, outfit, product, room, lighting, camera distance, and handheld phone-video style as the other segments.',
    lockSummary ? `Global locks that must stay identical across every segment: ${lockSummary}.` : '',
  ]

  if (segment.seedanceMode === 'keyframe_reference') {
    lines.push(
      'The provided first frame is the visual anchor for this segment. Start from it naturally: preserve the same presenter identity, product, room, lighting, camera distance, and handheld phone-video style.',
      'This segment will be stitched with other independently generated segments using a natural TikTok jump cut. Do not try to create a seamless transition; focus on making this one segment stable, clear, and product-accurate.',
    )
  } else if (segment.seedanceMode === 'first_frame_continue') {
    lines.push(
      'The provided first frame is a hard continuity anchor. Begin as if the camera never cut: same presenter, same pose direction, same room, same camera distance, same lighting, same product placement. No new establishing shot, no different person, no outfit reset, no sudden zoom or angle jump at the start.',
      'Product continuity is mandatory: the garment already visible in the first frame is the only product to continue. Preserve its exact color, silhouette, cup shape, band/edge finish, fabric texture, strap placement, and fit from the first frame and the global locks. Do not redesign, simplify, recolor, or swap it.',
    )
  }

  lines.push('', '[THIS SEGMENT — EXECUTE ONLY THIS]', segment.segmentPrompt)

  if (segment.returnLastFrame) {
    lines.push(
      'End this segment on a clean stable handoff frame: presenter face, hair, upper body, product, room, and lighting are all clearly visible and not motion-blurred. The final frame must be easy for the next segment to continue from.',
    )
  }

  const header = lines.filter(Boolean).join('\n')
  return `${header}\n\n[MANDATORY GLOBAL RULES — ALWAYS APPLY]\n${SEEDANCE_MANDATORY_BLOCKS}`
}

// 旧逻辑：规则版 planner 的段没有 segmentPrompt，仍把完整 basePrompt 当约束库使用。
function buildLegacySegmentPrompt({ basePrompt, segment, plan }) {
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

export function buildAgenticSegmentPrompt({ basePrompt, segment, plan }) {
  if (!segment || segment.role === 'full_video') {
    return basePrompt
  }
  // LLM 规划的段自带精简 segmentPrompt → 走精简模式；规则版段没有 → 退回旧逻辑
  if (segment.segmentPrompt) {
    return buildSlimSegmentPrompt({ segment, plan })
  }
  return buildLegacySegmentPrompt({ basePrompt, segment, plan })
}
