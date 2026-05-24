export function validateBenchmarkTemplate(template) {
  const issues = []
  const requiredArrays = ['timeline', 'shot_list', 'quality_factors', 'risks']
  for (const key of requiredArrays) {
    if (!Array.isArray(template?.[key])) issues.push(`${key} must be an array`)
  }
  if (!template?.replicable_template || typeof template.replicable_template !== 'object') {
    issues.push('replicable_template must be an object')
  }
  if (!template?.prompt_recipe || typeof template.prompt_recipe !== 'string') {
    issues.push('prompt_recipe must be a string')
  }

  for (const [i, shot] of (template?.shot_list || []).entries()) {
    for (const field of ['start', 'end', 'shot_type', 'camera', 'action', 'product_visibility', 'spoken_line']) {
      if (shot[field] == null) issues.push(`shot_list[${i}].${field} is required`)
    }
    if (Number(shot.end) < Number(shot.start)) issues.push(`shot_list[${i}] end is before start`)
  }

  return { pass: issues.length === 0, issues }
}

