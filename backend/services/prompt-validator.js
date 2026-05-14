// 程序化校验 Gemini 输出的 seedance_prompt，拦截硬性问题，避免浪费 Seedance 配额
// 这层是确定性规则检查，零成本零延迟；通过后再走 Gemini 二次评估

const BANNED_WORDS = [
  // 广告违禁词
  /\bsaggy\b/i,
  /\btitty\b/i, /\btitties\b/i, /\btits\b/i,
  /\bboobs?\b/i, /\bboobies\b/i,
  // 脏话
  /\bfuck(ing|ed)?\b/i,
  /\bshit\b/i,
  /\bdamn\b/i,
]

// 抽取 prompt 里指定 [BLOCK] 的内容
function extractBlock(prompt, blockName) {
  const re = new RegExp(`\\[${blockName.replace(/[[\]]/g, '')}\\]([\\s\\S]*?)(?=\\n\\[|---|$)`, 'i')
  const m = prompt.match(re)
  return m ? m[1].trim() : ''
}

function countWords(text) {
  return (text.match(/\b[\w']+\b/g) || []).length
}

/**
 * 程序化校验 Gemini 输出
 * @returns {{ pass: boolean, issues: Array<{severity, field, problem}> }}
 */
export function validateGeminiOutput(geminiResult, { targetDuration, finalReferenceImageUrls }) {
  const issues = []
  const prompt = geminiResult.seedance_prompt || ''
  const script = geminiResult.compressed_script || ''
  const features = geminiResult.product_visual_features || {}

  // 1. 产品图必须非空
  if (!finalReferenceImageUrls || finalReferenceImageUrls.length === 0) {
    issues.push({ severity: 'critical', field: 'reference_image_urls', problem: '没有可用的产品图片 URL' })
  }

  // 2. ANCHOR 关键字段必须非空（lingerie 类目检查更严格的字段）
  const requiredFeatureFields = ['silhouette', 'structure', 'color']
  for (const f of requiredFeatureFields) {
    if (!features[f] || features[f].trim() === '' || features[f].toLowerCase() === 'null') {
      issues.push({ severity: 'critical', field: `product_visual_features.${f}`, problem: `字段为空，无法锁定产品视觉特征` })
    }
  }
  // 内衣类目额外要求 edge_finish / underwire_profile / fabric_drape
  const lingerieKeywords = /bra|lingerie|shapewear|underwire|cup|plunge/i
  const productCategory = (geminiResult.video_analysis?.product_category || '') + ' ' + (features.silhouette || '')
  if (lingerieKeywords.test(productCategory)) {
    for (const f of ['edge_finish', 'underwire_profile', 'fabric_drape']) {
      if (!features[f] || features[f].trim() === '' || features[f].toLowerCase() === 'null') {
        issues.push({ severity: 'warning', field: `product_visual_features.${f}`, problem: `内衣类目缺少 ${f} 字段，可能导致细节失真` })
      }
    }
  }

  // 3. 字数预算检查（每秒 2.8 词）
  const maxWords = Math.round(targetDuration * 2.8)
  const scriptWords = countWords(script)
  if (scriptWords > maxWords * 1.1) {
    issues.push({ severity: 'critical', field: 'compressed_script', problem: `脚本 ${scriptWords} 词超出 ${maxWords} 词上限（≥10% 超标），会被 Seedance 切断` })
  } else if (scriptWords > maxWords) {
    issues.push({ severity: 'warning', field: 'compressed_script', problem: `脚本 ${scriptWords} 词略超 ${maxWords} 词上限` })
  }

  // 4. 违禁词扫描（在 compressed_script 和 prompt 的 SHOT SEQUENCE 里都扫）
  const shotSeq = extractBlock(prompt, 'SHOT SEQUENCE')
  const allDialogueText = script + '\n' + shotSeq
  for (const re of BANNED_WORDS) {
    const m = allDialogueText.match(re)
    if (m) {
      issues.push({ severity: 'critical', field: 'dialogue', problem: `出现广告违禁词 "${m[0]}"，必须替换` })
    }
  }

  // 5. prompt 长度健全性检查
  if (prompt.length < 1500) {
    issues.push({ severity: 'critical', field: 'seedance_prompt', problem: `prompt 长度 ${prompt.length} 字符过短，可能 Gemini 解析失败` })
  }
  if (prompt.length > 12000) {
    issues.push({ severity: 'warning', field: 'seedance_prompt', problem: `prompt 长度 ${prompt.length} 字符偏长，Seedance 可能丢失尾部约束` })
  }

  // 6. PRODUCT VISUAL ANCHOR 块必须存在（Gemini 偶尔会忘）
  if (!/\[PRODUCT VISUAL ANCHOR/i.test(prompt)) {
    issues.push({ severity: 'critical', field: 'seedance_prompt', problem: '缺少 [PRODUCT VISUAL ANCHOR] 块' })
  }

  // 7. SHOT SEQUENCE 块必须存在
  if (!/\[SHOT SEQUENCE\]/i.test(prompt)) {
    issues.push({ severity: 'critical', field: 'seedance_prompt', problem: '缺少 [SHOT SEQUENCE] 块' })
  }

  const hasCritical = issues.some(i => i.severity === 'critical')
  return { pass: !hasCritical, issues }
}

export function formatValidationReport(result) {
  if (result.pass && result.issues.length === 0) return '✅ 程序化校验通过'
  const lines = [result.pass ? '⚠️ 程序化校验通过（含 warning）' : '❌ 程序化校验失败']
  for (const i of result.issues) {
    const icon = i.severity === 'critical' ? '❌' : '⚠️'
    lines.push(`  ${icon} [${i.field}] ${i.problem}`)
  }
  return lines.join('\n')
}
