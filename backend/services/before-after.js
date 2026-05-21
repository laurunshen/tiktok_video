// before-after 概念助手（独立服务，不影响主生成流程）
// 两段式：
//  1) extractSellingPoints —— 看主图+详情图+商品信息，判断这个产品有哪些卖点
//  2) generateBeforeAfterConcepts —— 根据用户选中的卖点，产出 3 个 before/after 视频概念
// 概念里的 supplement 字段是一段可直接填进生成页「补充说明」的中文文案。

import { GoogleGenAI } from '@google/genai'
import axios from 'axios'
import sharp from 'sharp'
import { generateContentWithRetry } from './gemini-retry.js'

// AI Studio API key 直连（详见 gemini.js 注释）
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: 600000 },
})

// 下载图片 → 压缩 → 转成 Gemini inline part
async function imageUrlToInlinePart(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  let buffer = await sharp(Buffer.from(res.data))
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  if (buffer.length > 1 * 1024 * 1024) {
    buffer = await sharp(buffer).jpeg({ quality: 60 }).toBuffer()
  }
  return { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } }
}

// 并行下载一批图，失败的丢弃
async function downloadImageParts(urls) {
  const results = await Promise.all(
    urls.map(u => imageUrlToInlinePart(u).then(p => ({ ok: true, p })).catch(() => ({ ok: false })))
  )
  return results.filter(r => r.ok).map(r => r.p)
}

// 把商品信息对象压成一段文字给 Gemini
function formatProductText(productInfo = {}) {
  const lines = []
  if (productInfo.name) lines.push(`商品名称: ${productInfo.name}`)
  if (productInfo.shopName) lines.push(`店铺: ${productInfo.shopName}`)
  if (productInfo.category) lines.push(`类目: ${productInfo.category}`)
  if (Array.isArray(productInfo.skuOptions) && productInfo.skuOptions.length) {
    lines.push(`SKU/规格: ${productInfo.skuOptions.join(', ')}`)
  }
  if (productInfo.description && typeof productInfo.description === 'string') {
    lines.push(`描述: ${productInfo.description.slice(0, 600)}`)
  }
  return lines.join('\n') || '(无文字信息，仅凭图片判断)'
}

function parseJsonLoose(text, label) {
  const cleaned = (text || '').replace(/```json|```/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    console.error(`[before-after] ${label} JSON 解析失败:`, e.message)
    console.error('[before-after] 原始:', (text || '').slice(0, 500))
    throw new Error(`${label}: Gemini 响应解析失败`)
  }
}

/**
 * 第 1 步：识别卖点
 * @param {{ productInfo: object, mainImageUrls?: string[], detailImageUrls?: string[] }} opts
 * @returns {Promise<Array<{id, title, detail}>>}
 */
export async function extractSellingPoints({ productInfo = {}, mainImageUrls = [], detailImageUrls = [] }) {
  const imgUrls = [
    ...(mainImageUrls || []).slice(0, 4),
    ...(detailImageUrls || []).slice(0, 6),
  ]
  const imageParts = await downloadImageParts(imgUrls)

  const parts = [
    { text: `你是一名资深带货短视频策划。下面是一个商品的主图、详情图和文字信息。请判断这个商品有哪些真正能打动买家的卖点。

商品文字信息：
${formatProductText(productInfo)}

下面是商品图片（主图在前，详情图在后）：` },
  ]
  for (let i = 0; i < imageParts.length; i++) {
    parts.push({ text: `\n[图片 ${i + 1}]` })
    parts.push(imageParts[i])
  }
  parts.push({
    text: `

任务：综合图片和文字，列出 4-6 个最具体、最有说服力的卖点。
要求：
- 每个卖点必须是这个商品真实具备的（从图片或文字能看出来），不要编造。
- 卖点要具体，避免"质量好""性价比高"这种空话。
- title 用一句话概括（不超过 12 个字），detail 用一句话说明为什么这是卖点。

只返回 JSON，不要 markdown 代码块：
{
  "selling_points": [
    { "title": "卖点短语", "detail": "一句话说明" }
  ]
}`,
  })

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: '识别卖点' })
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const parsed = parseJsonLoose(text, '识别卖点')
  const list = Array.isArray(parsed.selling_points) ? parsed.selling_points : []
  return list.map((sp, i) => ({
    id: `sp_${i}`,
    title: String(sp.title || '').trim(),
    detail: String(sp.detail || '').trim(),
  })).filter(sp => sp.title)
}

/**
 * 第 2 步：根据选中的卖点生成 3 个 before/after 概念
 * @param {{ sellingPoints: Array<{title, detail}>, productInfo: object, userIdea?: string }} opts
 * @returns {Promise<Array<{id, hook, before, after, supplement}>>}
 */
export async function generateBeforeAfterConcepts({ sellingPoints = [], productInfo = {}, userIdea = '' }) {
  const spText = sellingPoints
    .map((sp, i) => `${i + 1}. ${sp.title}${sp.detail ? ` —— ${sp.detail}` : ''}`)
    .join('\n') || '(未指定卖点)'

  const idea = String(userIdea || '').trim()
  const ideaBlock = idea
    ? `\n用户已经有明确的想法/方向（这是硬约束，3 个概念都必须围绕这个方向，只在拍摄细节/对比呈现上做变体，不要换成别的角度）：\n「${idea}」\n`
    : `\n用户没有指定方向，请自由从卖点中挑最有冲击力的角度。\n`

  const parts = [{
    text: `你是一名资深带货短视频策划，专精 TikTok before/after（前后对比）爆款结构。

商品文字信息：
${formatProductText(productInfo)}

用户选中的卖点（围绕这些卖点做 before/after）：
${spText}
${ideaBlock}
【关键背景 —— 这个概念会怎么被用】
生成的概念会喂给一个 before-after 模板：视频前 2 秒是 LOOK A（before）和 LOOK B（after）每半秒一刀的快切 hook。
因此 before 和 after 必须是「一眼可辨」的对比 —— 每帧只闪半秒，观众必须在半秒内看出差别。

硬性要求（不满足就做不出 hook）：
1. before 和 after 必须是「同一个人、同一个姿势、同一个机位、同一件外层衣服」的两帧，唯一变化的是内衣（以及内衣带来的、立刻可见的效果）。
2. 对比必须是「静态可辨」的视觉差异 —— 半秒定格也能看出来。绝对不要依赖动作、流汗、表情、扯领口、慢慢展示这类需要时间才能看懂的东西。
3. before 和 after 各自必须能被描述成「一张静止画面」。
4. 对比点要单一、明确、夸张可见（例如：领口处有没有露出 bra 边缘 / 上衣表面有没有杯型轮廓凸起 / 肩带有没有从衣服里滑出来）。

任务：${idea ? '严格围绕用户上面的想法/方向' : '基于选中的卖点'}，生成 3 个不同角度的 before/after 视频概念。${idea ? '注意：3 个概念不能偏离用户的方向，差异只体现在「半秒可辨的对比点」选取上。' : ''}
每个概念包含：
- hook：一句话概括这个「半秒可辨」的对比点
- before：用旧内衣时那一帧静止画面长什么样（写清机位、姿势、外层衣服、那个可见缺陷）
- after：换上本商品后同机位同姿势那一帧长什么样（同样的人、姿势、衣服，只有缺陷消失了；必须确保画面里就是本商品）
- supplement：一段中文「补充说明」，会被直接填进视频生成页的补充说明框。要求：
  · 只描述前 2 秒的快切 hook，不要写 2 秒之后的内容（2 秒后由模板自动跟随参考视频的风格，无需在这里指定）
  · 第一句先点明那个「半秒可辨对比点」是什么
  · 写清 before 帧、after 帧分别长什么样，强调两帧除了内衣其它全相同
  · 必须确保 after 帧里出现的是本商品本身
  · 60-100 字，口语化但信息密度高

3 个概念的「对比点」要各不相同，但都必须满足「半秒可辨」。

只返回 JSON，不要 markdown 代码块：
{
  "concepts": [
    { "hook": "...", "before": "...", "after": "...", "supplement": "..." }
  ]
}`,
  }]

  const response = await generateContentWithRetry(genai, {
    model: 'gemini-3.1-pro-preview',
    contents: [{ role: 'user', parts }],
  }, { label: '生成概念' })
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const parsed = parseJsonLoose(text, '生成概念')
  const list = Array.isArray(parsed.concepts) ? parsed.concepts : []
  return list.slice(0, 3).map((c, i) => ({
    id: `concept_${i}`,
    hook: String(c.hook || '').trim(),
    before: String(c.before || '').trim(),
    after: String(c.after || '').trim(),
    supplement: String(c.supplement || '').trim(),
  })).filter(c => c.supplement)
}
