function cloneResult(geminiResult) {
  return {
    ...geminiResult,
    product_visual_features: {
      ...(geminiResult?.product_visual_features || {}),
    },
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceLineValue(text, label, value) {
  if (!text || value == null) return text
  const re = new RegExp(`^(${escapeRegExp(label)}\\s*:\\s*).*$`, 'gmi')
  return text.replace(re, `$1${value}`)
}

function replaceExactPhrase(text, before, after) {
  if (!text || !before || before === after) return text
  return text.replace(new RegExp(escapeRegExp(before), 'g'), after)
}

function replaceBlockByPrefix(prompt, blockPrefix, rewriter) {
  if (!prompt) return prompt
  const re = new RegExp(`(\\[${escapeRegExp(blockPrefix)}[^\\]]*\\]\\s*)([\\s\\S]*?)(?=\\n\\[[A-Z][^\\]]*\\]|\\n---|$)`, 'i')
  const match = prompt.match(re)
  if (!match) return prompt
  const [, header, body] = match
  const nextBody = rewriter(body)
  if (nextBody === body) return prompt
  return prompt.slice(0, match.index) + header + nextBody + prompt.slice(match.index + match[0].length)
}

function pushFix(fixes, type, field, before, after, reason) {
  if (before === after || after == null) return
  fixes.push({ type, field, before, after, reason })
}

function pickSingleColor(rawColor, dominantColor) {
  const candidates = [dominantColor, rawColor]
    .map(v => String(v || '').trim())
    .filter(Boolean)

  for (const value of candidates) {
    if (!/[,/]|\bor\b|\band\b/i.test(value)) return value
  }

  const source = candidates[0] || ''
  return source
    .split(/,|\/|\bor\b|\band\b/i)
    .map(v => v.trim())
    .filter(Boolean)[0] || ''
}

function repairProductAnchor(next, fixes) {
  const features = next.product_visual_features || {}
  let prompt = next.seedance_prompt || ''

  const construction = String(features.construction || '').trim()
  const edgeFinish = String(features.edge_finish || '').trim()
  const edgeFinishShort = edgeFinish.toLowerCase().split('—')[0].trim()
  const isSeamlessConstruction = /\bseamless\b/i.test(construction)
  const isLaceOrMeshConstruction = /\b(lace|mesh)\b/i.test(construction)
  const isStitchedEdge = /\b(stitch(ing|ed)?|folded|picot|bound|sewn)\b/i.test(edgeFinishShort)
  const isLaserCutEdge = /laser.?cut/i.test(edgeFinishShort)

  if (construction && edgeFinish && isSeamlessConstruction && isStitchedEdge) {
    const replacement = /lace/i.test(edgeFinish) ? 'lace panels' : 'visible seams'
    pushFix(
      fixes,
      'product_anchor',
      'product_visual_features.construction',
      features.construction,
      replacement,
      'Resolved construction/edge_finish contradiction by trusting the observed stitched edge.'
    )
    features.construction = replacement
    prompt = replaceLineValue(prompt, 'Construction', replacement)
    prompt = prompt.replace(/\bsmooth seamless\b/gi, replacement)
  }

  if (construction && edgeFinish && isLaceOrMeshConstruction && isLaserCutEdge) {
    const replacement = 'narrow folded fabric hem with low-profile stitching — clean fine stitched edge, minimal bulk'
    pushFix(
      fixes,
      'product_anchor',
      'product_visual_features.edge_finish',
      features.edge_finish,
      replacement,
      'Resolved lace/mesh plus laser-cut contradiction by switching edge_finish to a stitched option.'
    )
    features.edge_finish = replacement
    prompt = replaceLineValue(prompt, 'Edge finish', replacement)
    prompt = replaceExactPhrase(prompt, edgeFinish, replacement)
    prompt = prompt.replace(/\blaser-cut flat edges?\b/gi, 'narrow folded stitched edges')
    prompt = prompt.replace(/\bzero visible stitching\b/gi, 'low-profile visible stitching')
  }

  const color = String(features.color || '').trim()
  if (color && /[,/]|\bor\b|\band\b/i.test(color)) {
    const replacement = pickSingleColor(color, next.dominant_color)
    if (replacement) {
      pushFix(
        fixes,
        'product_anchor',
        'product_visual_features.color',
        features.color,
        replacement,
        'Reduced multi-color anchor to one dominant color so Seedance does not randomly choose a shade.'
      )
      features.color = replacement
      next.dominant_color = replacement
      prompt = replaceLineValue(prompt, 'Color', replacement)
      prompt = replaceExactPhrase(prompt, color, replacement)
    }
  }

  next.seedance_prompt = prompt
  next.product_visual_features = features
}

function isActionSafetyIssue(issue) {
  const text = `${issue?.field || ''} ${issue?.problem || ''} ${issue?.fix || ''}`.toLowerCase()
  if (!text) return false
  if (/product visual anchor|edge_finish|construction|color|underwire profile|brand name/.test(text)) return false
  return /finger|fingers|hand|hands|hair|strap|band|underwire|pinch|pull|tug|slipping|clip|fabric|lace|chest/.test(text)
}

function hasActionSafetyIssues(reviewIssues = []) {
  return reviewIssues.some(isActionSafetyIssue)
}

function hasRiskyActionText(line) {
  return /finger|fingers|hand|hands|pinch|pull|tug|stretch|slide|slips?|underwire|strap|band|cup|lace|touch|trace|adjust|clip|through|close-up/i.test(line)
}

function rewriteRiskyShotLine(line) {
  const trimmed = line.trim()
  if (!/^\[[^\]]+\]/.test(trimmed)) return line
  if (!hasRiskyActionText(trimmed)) return line
  if (/ACTION SAFETY|FORBIDDEN|AVOID|NEVER|NO /.test(trimmed)) return line

  const indent = line.match(/^\s*/)?.[0] || ''
  const prefix = trimmed.match(/^(\[[^\]]+\]\s*(?:LOOK [AB]\.\s*)?)/i)?.[1] || ''
  const speech = trimmed.match(/((?:Fast voiceover|Voiceover|Says quickly|Says):\s*"[^"]*")/i)?.[1] || ''
  const rewritten = `${prefix}Medium close-up, same camera angle. Hair is pulled back and clear of the chest. Hands stay away from the bra, resting out of frame or relaxed at her sides; she uses a small head tilt or shoulder angle change to show fit and silhouette.${speech ? ` ${speech}` : ''}`
  return indent + rewritten
}

function repairPresenterHair(prompt, fixes) {
  let changed = false
  const nextPrompt = replaceBlockByPrefix(prompt, 'PRESENTER', body => {
    const lines = body.split('\n')
    const nextLines = lines.map(line => {
      if (/hair/i.test(line) && /\b(long|loose|down|flowing)\b/i.test(line) && !/\b(never|no|not|avoid)\b/i.test(line)) {
        changed = true
        return 'Hair: pulled back in a low ponytail, messy bun, or clipped back; no loose hair over the chest or straps.'
      }
      return line
    })
    if (!nextLines.some(line => /Hair: pulled back/i.test(line))) {
      changed = true
      nextLines.push('Hair: pulled back in a low ponytail, messy bun, or clipped back; no loose hair over the chest or straps.')
    }
    return nextLines.join('\n')
  })
  if (changed) {
    pushFix(
      fixes,
      'action_safety',
      'PRESENTER.hair',
      'possible loose hair near chest',
      'hair pulled back away from chest and straps',
      'Reduced hair-on-product artifact risk.'
    )
  }
  return nextPrompt
}

function repairActionSafety(next, fixes, reviewIssues) {
  if (!hasActionSafetyIssues(reviewIssues)) return
  const before = next.seedance_prompt || ''
  let prompt = repairPresenterHair(before, fixes)

  const beforeShotRepair = prompt
  prompt = replaceBlockByPrefix(prompt, 'SHOT SEQUENCE', body => {
    const lines = body.split('\n')
    return lines.map(rewriteRiskyShotLine).join('\n')
  })

  if (prompt !== beforeShotRepair) {
    pushFix(
      fixes,
      'action_safety',
      'SHOT SEQUENCE',
      'hands/fingers/hair interacting with bra or thin parts',
      'hands away from bra, hair pulled back, simple silhouette-safe movement',
      'Rewrote risky body/garment interactions to Seedance-safe actions.'
    )
  }

  if (prompt !== before) {
    next.seedance_prompt = prompt
  }
}

export function autoRepairGeminiOutput(geminiResult, { reviewIssues = [] } = {}) {
  const next = cloneResult(geminiResult || {})
  const fixes = []
  repairProductAnchor(next, fixes)
  repairActionSafety(next, fixes, reviewIssues)
  return { result: next, fixes }
}
