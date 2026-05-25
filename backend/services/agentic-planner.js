function clampDuration(seconds) {
  return Math.min(Math.max(Math.round(seconds || 0), 5), 15)
}

function countWords(text) {
  return (String(text || '').trim().match(/\b[\w']+\b/g) || []).length
}

function splitScriptIntoSegments(script, segmentDurations) {
  const words = String(script || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return segmentDurations.map(() => '')
  }

  const totalDuration = segmentDurations.reduce((sum, dur) => sum + dur, 0) || 1
  let cursor = 0

  return segmentDurations.map((duration, index) => {
    if (index === segmentDurations.length - 1) {
      return words.slice(cursor).join(' ')
    }

    const ratio = duration / totalDuration
    const remainingWords = words.length - cursor
    const nextCount = Math.max(1, Math.round(words.length * ratio))
    const take = Math.min(nextCount, remainingWords - (segmentDurations.length - index - 1))
    const excerpt = words.slice(cursor, cursor + take).join(' ')
    cursor += take
    return excerpt
  })
}

export function buildAgenticSegmentPlan({
  targetDuration,
  compressedScript = '',
  productVisualFeatures = {},
  dominantColor = '',
}) {
  const totalDuration = clampDuration(targetDuration)
  const canSplit = totalDuration >= 10

  const globalLocks = {
    dominantColor: dominantColor || productVisualFeatures.color || '',
    silhouette: productVisualFeatures.silhouette || '',
    structure: productVisualFeatures.structure || '',
    fabricVisual: productVisualFeatures.fabric_visual || '',
    distinguishingDetails: productVisualFeatures.distinguishing_details || '',
  }

  if (!canSplit) {
    return {
      generationMode: 'agentic_segments_v1',
      strategy: 'single_segment_fallback',
      totalDuration,
      globalLocks,
      segments: [
        {
          index: 1,
          role: 'full_video',
          duration: totalDuration,
          seedanceMode: 'multimodal_reference',
          scriptExcerpt: compressedScript,
          actionPolicy: 'low-risk',
          returnLastFrame: false,
        },
      ],
    }
  }

  const hookDuration = 5
  const bodyDuration = totalDuration - hookDuration
  const [hookScript, bodyScript] = splitScriptIntoSegments(compressedScript, [hookDuration, bodyDuration])

  return {
    generationMode: 'agentic_segments_v1',
    strategy: 'two_segment_keyframe_handoff',
    totalDuration,
    globalLocks,
    segments: [
      {
        index: 1,
        role: 'hook',
        duration: hookDuration,
        seedanceMode: 'multimodal_reference',
        scriptExcerpt: hookScript,
        actionPolicy: 'low-risk',
        returnLastFrame: true,
      },
      {
        index: 2,
        role: 'body_cta',
        duration: bodyDuration,
        seedanceMode: 'first_frame_continue',
        scriptExcerpt: bodyScript,
        actionPolicy: 'low-risk',
        firstFrameSource: 'segment_1_last_frame',
        returnLastFrame: false,
      },
    ],
  }
}

export function summarizeSegmentPlan(plan) {
  const segments = plan?.segments || []
  return {
    strategy: plan?.strategy || 'unknown',
    totalDuration: plan?.totalDuration || 0,
    segmentCount: segments.length,
    roles: segments.map(segment => segment.role),
    wordCounts: segments.map(segment => countWords(segment.scriptExcerpt)),
  }
}
