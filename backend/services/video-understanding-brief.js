const MAX_SHOTS = 8
const MAX_FACTORS = 5
const MAX_RISKS = 6
const MAX_TEXT = 500

function clipText(value, max = MAX_TEXT) {
  if (value == null) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function formatShot(shot, index) {
  if (!isPlainObject(shot)) return null
  const start = Number.isFinite(Number(shot.start)) ? Number(shot.start) : null
  const end = Number.isFinite(Number(shot.end)) ? Number(shot.end) : null
  const time = start != null && end != null ? `${start}-${end}s` : `shot ${index + 1}`
  const fields = [
    `role=${clipText(shot.role || shot.shot_type || 'other', 80)}`,
    shot.intent ? `intent=${clipText(shot.intent, 160)}` : '',
    shot.camera ? `camera=${clipText(shot.camera, 160)}` : '',
    shot.action ? `action=${clipText(shot.action, 180)}` : '',
    shot.visual ? `visual=${clipText(shot.visual, 180)}` : '',
    shot.product_visibility ? `product=${clipText(shot.product_visibility, 160)}` : '',
    shot.scene ? `scene=${clipText(shot.scene, 140)}` : '',
    shot.lighting ? `lighting=${clipText(shot.lighting, 140)}` : '',
    shot.motion_complexity ? `motion=${clipText(shot.motion_complexity, 80)}` : '',
    shot.ai_generation_risk ? `risk=${clipText(shot.ai_generation_risk, 180)}` : '',
    shot.replication_notes ? `preserve=${clipText(shot.replication_notes, 220)}` : '',
  ].filter(Boolean)
  return `- ${time}: ${fields.join('; ')}`
}

function formatArray(label, rows, mapper, limit) {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  const body = rows.slice(0, limit).map(mapper).filter(Boolean).join('\n')
  return body ? `${label}:\n${body}` : ''
}

function formatReplicableTemplate(template) {
  if (!isPlainObject(template)) return ''
  const parts = []
  if (Array.isArray(template.fixed_structure) && template.fixed_structure.length) {
    parts.push(`preserve=${template.fixed_structure.slice(0, 6).map(v => clipText(v, 140)).join(' | ')}`)
  }
  if (Array.isArray(template.replaceable_variables) && template.replaceable_variables.length) {
    parts.push(`replace=${template.replaceable_variables.slice(0, 6).map(v => clipText(v, 140)).join(' | ')}`)
  }
  for (const key of ['recommended_scene', 'recommended_person', 'motion_complexity', 'lighting', 'camera_style', 'spoken_structure']) {
    if (template[key]) parts.push(`${key}=${clipText(template[key], 220)}`)
  }
  return parts.length ? `Replicable template:\n- ${parts.join('\n- ')}` : ''
}

export function buildVideoUnderstandingBrief(template) {
  if (!isPlainObject(template)) return ''
  const directorTimeline = Array.isArray(template.timeline) ? template.timeline : template.shot_list

  const sections = [
    `Summary: ${clipText(template.summary, 700)}`,
    `Hook type: ${clipText(template.hook_type || 'unknown', 120)}`,
    formatArray('Director timeline', directorTimeline, formatShot, MAX_SHOTS),
    formatReplicableTemplate(template.replicable_template),
    formatArray(
      'Quality drivers',
      template.quality_factors,
      item => isPlainObject(item)
        ? `- ${clipText(item.factor, 160)} | evidence=${clipText(item.evidence, 160)} | rule=${clipText(item.replication_rule, 220)}`
        : null,
      MAX_FACTORS
    ),
    template.prompt_recipe ? `Prompt recipe guidance:\n${clipText(template.prompt_recipe, 1200)}` : '',
    formatArray(
      'Risks to rewrite around',
      template.risks,
      item => isPlainObject(item)
        ? `- ${clipText(item.risk, 180)} | why=${clipText(item.why_it_happens, 180)} | mitigation=${clipText(item.mitigation, 220)}`
        : null,
      MAX_RISKS
    ),
  ].filter(section => section && !section.endsWith(': '))

  if (sections.length === 0) return ''

  return `=== VIDEO UNDERSTANDING BRIEF ===
Use this as a STRUCTURE BRIEF, not as final video-model wording.

${sections.join('\n\n')}

Priority rules:
1. PRODUCT VISUAL ANCHOR, COLOR LOCK, ACTION SAFETY, no-text, character consistency, and user instructions override this brief.
2. Preserve transferable timing, segment intent, shot roles, hand/body actions, camera framing/movement, product exposure pattern, hook logic, and spoken structure.
3. Do NOT copy identity, exact face/body, exact room, brand marks, captions, overlays, or unsafe/high-risk actions.
4. Rewrite every action so it truthfully fits THIS product's visual anchor. If the reference video demonstrates a feature THIS product does not have, replace it with a neutral truthful demo action.
5. Use risk mitigations from this brief when rewriting the [SHOT SEQUENCE] and [AVOID] blocks.
=== END VIDEO UNDERSTANDING BRIEF ===`
}
