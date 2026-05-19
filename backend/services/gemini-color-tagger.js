// 用 Gemini 一次性识别一批产品图的主色（每张返回一个 color 字符串）
// 用于产品管理页"AI 一键识别"功能

import { GoogleGenAI } from '@google/genai'
import axios from 'axios'
import sharp from 'sharp'

// AI Studio API key 直连（详见 gemini.js 注释）
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 600000 },
})

const STANDARD_COLORS = ['Warm Beige', 'Black', 'White', 'Nude Pink', 'Brown', 'Red', 'Navy', 'Gray']

// 下载图片 → 压缩 → 转成 Gemini inline part
async function imageUrlToInlinePart(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  // 压缩到 ≤1MB 1280px，加速 Gemini 处理
  let buffer = await sharp(Buffer.from(res.data))
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  if (buffer.length > 1 * 1024 * 1024) {
    buffer = await sharp(buffer).jpeg({ quality: 60 }).toBuffer()
  }
  return {
    inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') },
  }
}

/**
 * 批量识别图片 SKU/主色。urls 数组里每张图给出一个 color/sku 字符串。
 * - 单次 Gemini 调用最多 12 张图；超出自动分批
 * - 返回 [{ url, color, success, error? }, ...]，长度与 urls 一致，顺序不变
 * - options.skuOptions：约束 Gemini 必须从该词表里选（产品 variants）；空数组 = 自由识别
 */
export async function detectImageColors(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return []
  const skuOptions = Array.isArray(options.skuOptions) ? options.skuOptions.filter(Boolean) : []

  const BATCH = 12
  const results = []

  for (let start = 0; start < urls.length; start += BATCH) {
    const batch = urls.slice(start, start + BATCH)
    // 1) 并行下载这一批
    const parts = []
    const successIndices = []
    const downloadResults = await Promise.all(
      batch.map(url => imageUrlToInlinePart(url).then(p => ({ ok: true, p })).catch(e => ({ ok: false, e })))
    )
    for (let i = 0; i < batch.length; i++) {
      if (downloadResults[i].ok) {
        parts.push(downloadResults[i].p)
        successIndices.push(i)
      } else {
        results[start + i] = { url: batch[i], color: '', success: false, error: `download fail: ${downloadResults[i].e.message}` }
      }
    }

    if (parts.length === 0) continue

    // 2) 拼 prompt — 有 skuOptions 时强制从词表选，否则走原来自由识别
    const promptText = skuOptions.length > 0
      ? `You will look at ${parts.length} images of the same product. For each image IN ORDER, identify which SKU variant it shows.

ALLOWED SKU VALUES (you MUST pick one of these, no other words):
${skuOptions.map(v => `  - "${v}"`).join('\n')}

SPECIAL CASES (use these instead of inventing a new value):
- "Multi" — image is a swatch grid showing multiple SKU variants together
- "Unknown" — text poster / packaging / no product visible / can't tell

OUTPUT RULES:
- Return ONLY a JSON array of length ${parts.length}, one entry per image in order.
- Each entry: {"color": "<exactly one of the allowed values or Multi/Unknown>"}
- NEVER invent a new SKU name. If unsure, use "Unknown".

Return ONLY the JSON array, no markdown fences, no explanation.`
      : `You will look at ${parts.length} product images of the same product (likely a bra/lingerie or apparel item). For each image IN ORDER, identify the DOMINANT garment color visible.

OUTPUT RULES:
- Return ONLY a JSON array of length ${parts.length}, one entry per image in order.
- Each entry: {"color": "<color name>"}
- PREFER these standard names when applicable: ${STANDARD_COLORS.join(', ')}
- Use a custom short 1-2 word name ONLY if none of the standard names fit (e.g. "Mocha", "Coral", "Burgundy")
- If the image is a color swatch grid showing multiple SKU variants, use "Multi"
- If the garment isn't clearly visible (text poster, packaging shot, model close-up with no product), use "Unknown"
- For nude/skin-tone garments use "Warm Beige" or "Nude Pink" based on undertone

Return ONLY the JSON array, no markdown fences, no explanation.`

    const contentParts = []
    for (let j = 0; j < parts.length; j++) {
      contentParts.push({ text: `\n[Image ${j + 1}]` })
      contentParts.push(parts[j])
    }
    contentParts.push({ text: '\n\n' + promptText })

    // 3) 调 Gemini
    try {
      const response = await genai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ role: 'user', parts: contentParts }],
        config: { temperature: 0 },
      })
      const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const cleaned = raw.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed) || parsed.length !== parts.length) {
        throw new Error(`Gemini returned ${parsed.length || 0} entries, expected ${parts.length}`)
      }
      for (let k = 0; k < parts.length; k++) {
        const origIdx = successIndices[k]
        const color = (parsed[k]?.color || '').trim()
        results[start + origIdx] = { url: batch[origIdx], color, success: !!color }
      }
    } catch (e) {
      // 整批失败 → 给这一批已成功下载的都打错误标记
      for (let k = 0; k < parts.length; k++) {
        const origIdx = successIndices[k]
        results[start + origIdx] = { url: batch[origIdx], color: '', success: false, error: `gemini fail: ${e.message}` }
      }
    }
  }

  // 填补 holes（极少发生，但保险）
  for (let i = 0; i < urls.length; i++) {
    if (!results[i]) results[i] = { url: urls[i], color: '', success: false, error: 'unknown' }
  }
  return results
}

/**
 * 给定一个产品（带 SKU 标签的所有图），推荐最适合用于生成视频的 SKU
 * 输入：product = { mainImageUrls/Colors, detailImageUrls/Colors, userImageUrls/Colors }（来自 getProductFull）
 * 输出：{ recommended: 'Warm Beige', reason: '...', counts: { Beige: 8, Black: 3 } } 或 { recommended: null, reason: '...' }
 */
export async function recommendBestSku(product) {
  // 1) 聚合所有 (url, color)
  const all = []
  const push = (urls, colors) => {
    for (let i = 0; i < (urls || []).length; i++) {
      const c = (colors?.[i] || '').trim()
      all.push({ url: urls[i], color: c })
    }
  }
  push(product.mainImageUrls, product.mainImageColors)
  push(product.detailImageUrls, product.detailImageColors)
  push(product.userImageUrls, product.userImageColors)

  // 2) 按 SKU 分组（排除 Unknown/Multi/空）
  const groups = new Map()
  for (const { url, color } of all) {
    if (!color || color === 'Unknown' || color === 'Multi') continue
    if (!groups.has(color)) groups.set(color, [])
    groups.get(color).push(url)
  }

  const counts = Object.fromEntries([...groups.entries()].map(([k, v]) => [k, v.length]))

  if (groups.size === 0) {
    return { recommended: null, reason: '没有任何 SKU 已标记，先去识别 SKU。', counts }
  }
  if (groups.size === 1) {
    const only = [...groups.keys()][0]
    return { recommended: only, reason: `只有一个 SKU（${only}），共 ${groups.get(only).length} 张图。`, counts }
  }

  // 3) 取 top-3 by count
  const top = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3)

  // 4) 每组取最多 6 张图（优先靠前的，覆盖主图+前几张详情图）
  const samples = top.map(([sku, urls]) => ({ sku, urls: urls.slice(0, 6) }))

  // 5) 拼 Gemini prompt
  const parts = []
  for (const { sku, urls } of samples) {
    parts.push({ text: `\n=== SKU: ${sku} (${urls.length} sample images of ${counts[sku]} total) ===` })
    const downloaded = await Promise.all(
      urls.map((u, i) => imageUrlToInlinePart(u)
        .then(p => ({ ok: true, p, i }))
        .catch(() => ({ ok: false, i }))
      )
    )
    for (const d of downloaded) {
      if (d.ok) {
        parts.push({ text: `[${sku} - img ${d.i + 1}]` })
        parts.push(d.p)
      }
    }
  }
  parts.push({
    text: `\n\nYou are choosing the BEST SKU among the above to use as reference material for generating a TikTok UGC product video.

Evaluate each SKU on:
1. Image count (more = more variety)
2. Detail richness (close-ups of texture, edge, stitching, hardware)
3. Variety of angles (front, side, back, model wearing, on-mannequin, flat-lay)
4. Clarity (sharp, well-lit images vs blurry/dim)

Pick exactly ONE SKU name from those shown. Return ONLY this JSON:
{"recommended": "<exact SKU name>", "reason": "<1-2 sentences why>"}`,
  })

  try {
    const response = await genai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts }],
      config: { temperature: 0 },
    })
    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      recommended: parsed.recommended || null,
      reason: parsed.reason || '',
      counts,
    }
  } catch (e) {
    // 兜底：返回图数最多的 SKU
    const fallback = top[0][0]
    return {
      recommended: fallback,
      reason: `AI 评估失败（${e.message.slice(0, 80)}），回退到图数最多的 SKU：${fallback}（${counts[fallback]} 张图）`,
      counts,
    }
  }
}
