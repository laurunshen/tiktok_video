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

  // 2b. construction ↔ edge_finish 物理一致性检查（程序化兜底，防止 Pass 1 漏过）
  // 阶段 4 烟测暴露：Pass 1 在 temperature=0 下会稳定输出 seamless + stitched-hem 这种物理矛盾组合
  // 注意：edge_finish 完整描述里可能包含 "zero visible stitching, no folded trim" 之类的否定短语，
  // 所以只看"—"分隔符前的短名（即枚举的几个固定选项的开头），避免误匹配负向描述
  const construction = (features.construction || '').toLowerCase()
  const edgeFinishFull = (features.edge_finish || '').toLowerCase()
  const edgeFinishShort = edgeFinishFull.split('—')[0].trim()
  if (construction && edgeFinishShort) {
    const isSeamlessConstruction = /\bseamless\b/.test(construction)
    const isLaceOrMeshConstruction = /\b(lace|mesh)\b/.test(construction)
    // 短名里的关键词：stitched/folded/picot/bound 都是缝合类标志
    const isStitchedEdge = /\b(stitch(ing|ed)?|folded|picot|bound)\b/.test(edgeFinishShort)
    const isLaserCutEdge = /laser.?cut/.test(edgeFinishShort)

    if (isSeamlessConstruction && isStitchedEdge) {
      issues.push({
        severity: 'critical',
        field: 'product_visual_features',
        problem: `construction="${features.construction}" 与 edge_finish="${features.edge_finish}" 物理矛盾：无缝构造不可能有缝合边。修订时应改 construction 为 "visible seams" 或 "lace panels"`,
      })
    }
    if (isLaceOrMeshConstruction && isLaserCutEdge) {
      issues.push({
        severity: 'critical',
        field: 'product_visual_features',
        problem: `construction="${features.construction}" 与 edge_finish="${features.edge_finish}" 物理矛盾：lace/mesh 有缝合周界，不可能是 laser-cut 边。修订时应改 edge_finish 为缝合类选项`,
      })
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

  // 8a. color 字段必须是单个颜色，不能是 "Beige, Black" 这种多色组合
  // （Seedance 看到多色会随机抓一个，导致颜色不可控）
  const colorVal = (features.color || '').trim()
  if (colorVal) {
    // 检测多个用 / , 或 " or " " and " 分隔的颜色
    const multiColorPattern = /[,/]|\bor\b|\band\b/i
    if (multiColorPattern.test(colorVal)) {
      issues.push({
        severity: 'critical',
        field: 'product_visual_features.color',
        problem: `color 字段包含多个颜色 "${colorVal}" — Seedance 会随机抓一个，导致颜色不可控。Pass 1 必须从产品图的 hero 镜头里挑一个具体颜色。`,
      })
    }
  }

  // 8. 禁止 if/then 元逻辑泄漏到 prompt（Seedance 不解析条件，会把两个分支的关键词混在一起）
  const conditionalPatterns = [
    /\bif\s+edge_finish\b/i,
    /\bif\s+underwire_profile\b/i,
    /\bif\s+fabric_drape\b/i,
    /\bif\s+anchor\s+says\b/i,
    /\bwhen\s+anchor\s+says\b/i,
    /=\s*"laser-cut/i,    // 模板占位符泄漏
    /=\s*"invisible"\s+or\s+"low-profile"/i,
    /=\s*"second-skin"/i,
  ]
  for (const re of conditionalPatterns) {
    const m = prompt.match(re)
    if (m) {
      issues.push({
        severity: 'critical',
        field: 'seedance_prompt',
        problem: `检测到未解析的条件逻辑 "${m[0]}" 泄漏到 prompt — Seedance 会把所有分支关键词混在一起生成。Gemini 必须根据本产品的实际 anchor 值写成纯陈述句。`,
      })
      break
    }
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
