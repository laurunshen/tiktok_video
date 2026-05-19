import express from 'express'
import multer from 'multer'
import axios from 'axios'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { uploadMediaFile, uploadMediaFileWithThumb } from '../services/media-upload.js'
import {
  getProductCache, saveProduct, listBenchmarkVideos,
  listProducts, getProductFull, updateProductImages, renameProduct, deleteProduct,
  setImageColor, bulkSetImageColors, batchSetImageColors, getProductSkuOptions,
} from '../services/db.js'
import { detectImageColors, recommendBestSku } from '../services/gemini-color-tagger.js'

const router = express.Router()

// multer: 临时存到 ./uploads/，处理完上传 kie.ai 后清理
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`)
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },  // 20MB / 图
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '')
    cb(null, /jpeg|jpg|png|webp/.test(ext))
  },
})

const TIKHUB_API_KEY = 'jLENGegc5UayyV+YNqaF+Q6LJhDSZqs90T7/oxjebuCXm2q6e3GKdSu9Kw=='
const TIKHUB_BASE = 'https://api.tikhub.io'

// 从 TikTok Shop URL 或纯 product_id 中提取 product_id
function extractProductId(input) {
  input = input.trim()
  // 纯数字 ID
  if (/^\d+$/.test(input)) return input
  // URL 格式：/pdp/1732108663255959373 或 product_id=xxx
  const pdpMatch = input.match(/\/pdp\/(\d+)/)
  if (pdpMatch) return pdpMatch[1]
  const paramMatch = input.match(/product_id[=\/](\d+)/)
  if (paramMatch) return paramMatch[1]
  return null
}

// 从 response 中解析出结构化商品信息
// TikHub 历史上有两种包装深度：data.data.product_data... 和 data.data.data.product_data...
// 两种都试，避免 API 包装层数再变时整个站爬不了产品
function parseProductInfo(data) {
  const components =
    data?.data?.data?.product_data?.page_config?.components_map ||
    data?.data?.product_data?.page_config?.components_map ||
    []
  const productInfoComp = components.find(c => c.component_name === 'product_info')
  const productInfo = productInfoComp?.component_data?.product_info

  if (!productInfo) {
    // 如果 components 找得到但是 product_info 不存在 → 多半是 region 不对（TikTok 返回 error_code: 23002002 "not exist"）
    const cdErr = productInfoComp?.component_data?.error_message
    if (cdErr) throw new Error(`商品在该 region 不存在或下架：${cdErr}（试试切换 region，如 US/SG/GB）`)
    throw new Error('无法解析商品信息，请检查链接或 region 是否正确')
  }

  const model = productInfo.product_model
  const categoryInfo = productInfo.category_info?.recommended_categories || []

  // 商品名称
  const name = model.name || ''

  // 产品属性（材质、风格、季节等）
  const productProperties = (model.product_properties || []).map(p => ({
    name: p.property_name,
    value: p.property_values?.map(v => v.property_value_name).join(', ') || '',
  }))

  // 销售属性（颜色/款式、尺码）
  const saleProperties = (model.sale_properties || []).map(p => ({
    name: p.property_name,
    values: p.property_values?.map(v => v.property_value_name) || [],
  }))

  // 价格区间
  const rangePrice = productInfo.promotion_model?.promotion_product_price?.range_price
  const priceInfo = rangePrice
    ? `${rangePrice.currency_symbol}${rangePrice.range_price}`
    : null

  // 品类
  const categories = categoryInfo.map(c => c.category_name_en).filter(Boolean)

  // 主图 URLs（去重）
  const mainImageUrls = []
  const seenUris = new Set()
  for (const img of (model.images || [])) {
    if (img.uri && !seenUris.has(img.uri)) {
      seenUris.add(img.uri)
      const url = img.url_list?.[0]
      if (url) mainImageUrls.push(url)
    }
  }

  // 详情图 URLs（从 description JSON 字符串解析）
  const detailImageUrls = []
  if (model.description) {
    try {
      const descItems = JSON.parse(model.description)
      for (const item of descItems) {
        if (item.type === 'image' && item.image?.url_list?.[0]) {
          const uri = item.image.uri
          if (uri && !seenUris.has(uri)) {
            seenUris.add(uri)
            detailImageUrls.push(item.image.url_list[0])
          }
        }
      }
    } catch {}
  }

  const summary = {
    name,
    categories,
    price: priceInfo,
    materials: productProperties.find(p => p.name === 'Materials')?.value || '',
    style: productProperties.find(p => p.name === 'Style')?.value || '',
    season: productProperties.find(p => p.name === 'Season')?.value || '',
    sleeveLength: productProperties.find(p => p.name === 'Sleeve Length')?.value || '',
    design: productProperties.find(p => p.name === 'Design')?.value || '',
    otherProperties: productProperties.filter(
      p => !['Materials', 'Style', 'Season', 'Sleeve Length', 'Design'].includes(p.name)
    ),
    variants: saleProperties,
    shopName: productInfo.seller_model?.shop_name || '',
    mainImageUrls,     // 主图
    detailImageUrls,   // 详情图
  }

  return summary
}

// 下载图片到本地临时文件，返回 { path, originalname } 供 multer 格式兼容
async function downloadImage(url, index, prefix = 'product') {
  const ext = '.jpg'
  const filename = `${prefix}-${index}${ext}`
  const tmpPath = path.join(os.tmpdir(), `${uuidv4()}${ext}`)
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  await writeFile(tmpPath, response.data)
  return { path: tmpPath, originalname: filename, _isTmp: true }
}

// 批量下载，最多取 maxCount 张，失败的跳过
async function downloadImages(urls, maxCount = 15, prefix = 'product') {
  const results = []
  const targets = urls.slice(0, maxCount)
  for (let i = 0; i < targets.length; i++) {
    try {
      const file = await downloadImage(targets[i], i + 1, prefix)
      results.push(file)
      console.log(`  [img download] ${i + 1}/${targets.length} ✅`)
    } catch (e) {
      console.warn(`  [img download] ${i + 1}/${targets.length} ❌ ${e.message}`)
    }
  }
  return results
}

// 带重试的 TikHub 请求（400 错误最多重试 3 次，timeout 30s）
async function fetchWithRetry(productId, region, maxRetries = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Product] 请求 product_id=${productId} region=${region}（第 ${attempt} 次）`)
      const response = await axios.get(`${TIKHUB_BASE}/api/v1/tiktok/shop/web/fetch_product_detail_v3`, {
        params: { product_id: productId, region },
        headers: { Authorization: `Bearer ${TIKHUB_API_KEY}` },
        timeout: 30000, // 风控要求 30s
      })
      return response
    } catch (err) {
      lastErr = err
      const status = err.response?.status
      if (status === 400) {
        // 400 风控，重试
        console.warn(`[Product] 400 错误，${attempt < maxRetries ? `5s 后第 ${attempt + 1} 次重试` : '已达最大重试次数'}`)
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 5000))
      } else {
        // 其他错误直接抛出，不重试
        throw err
      }
    }
  }
  throw lastErr
}

// GET /api/product/fetch?url=xxx&region=SG
router.get('/fetch', async (req, res) => {
  const { url, region = 'US' } = req.query

  if (!url) return res.status(400).json({ error: '缺少 url 参数' })

  const productId = extractProductId(url)
  if (!productId) return res.status(400).json({ error: '无法从链接中提取 product_id，请检查链接格式' })

  try {
    // 缓存命中：24 小时内同 productId 直接返回（kie.ai URL 也是稳定的）
    const cached = await getProductCache(productId)
    if (cached) {
      console.log(`[Product] 缓存命中 ${productId}: ${cached.name}`)
      return res.json({ productId, region, productInfo: cached, cached: true })
    }

    const response = await fetchWithRetry(productId, region)
    const productInfo = parseProductInfo(response.data)
    console.log(`[Product] 解析成功: ${productInfo.name}`)

    // 立即下载图片并上传到 kie.ai 拿稳定 URL（TikTok CDN 链接会过期）
    const allTikTokUrls = [
      ...(productInfo.mainImageUrls || []),
      ...(productInfo.detailImageUrls || []),
    ].slice(0, 15) // 最多 15 张避免太慢
    const mainCount = (productInfo.mainImageUrls || []).slice(0, 15).length

    console.log(`[Product] 下载并上传 ${allTikTokUrls.length} 张商品图到 S3 稳定存储（含缩略图）...`)
    const stableUrls = []
    const stableThumbs = []
    for (let i = 0; i < allTikTokUrls.length; i++) {
      try {
        const tmpPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
        const dl = await axios.get(allTikTokUrls[i], {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        await writeFile(tmpPath, dl.data)
        const { url, thumbUrl } = await uploadMediaFileWithThumb(tmpPath, `product-${i + 1}.jpg`)
        await unlink(tmpPath).catch(() => {})
        stableUrls.push(url)
        stableThumbs.push(thumbUrl || '')
        console.log(`  [stable] ${i + 1}/${allTikTokUrls.length} ✅`)
      } catch (e) {
        console.warn(`  [stable] ${i + 1}/${allTikTokUrls.length} ❌ ${e.message}`)
      }
    }
    productInfo.mainImageUrls = stableUrls.slice(0, mainCount)
    productInfo.detailImageUrls = stableUrls.slice(mainCount)
    const mainThumbs = stableThumbs.slice(0, mainCount)
    const detailThumbs = stableThumbs.slice(mainCount)
    console.log(`[Product] 稳定 URL 完成：主图 ${productInfo.mainImageUrls.length} + 详情图 ${productInfo.detailImageUrls.length}`)

    // 写入产品缓存（下次同 productId 24h 内直接命中），thumb 数组与 url 数组同序
    try { await saveProduct(productId, region, productInfo, { main: mainThumbs, detail: detailThumbs }) }
    catch (e) { console.warn(`[Product] 缓存写入失败: ${e.message}`) }

    res.json({ productId, region, productInfo })

  } catch (err) {
    if (err.response) {
      const status = err.response.status
      console.error(`[Product] TikHub API 错误 ${status}:`, err.response.data)
      if (status === 400) {
        res.status(502).json({ error: '请求被风控拦截，已重试 3 次仍失败。请确认 region 与商品所在地区一致，稍后再试。' })
      } else {
        res.status(502).json({ error: `TikHub API 错误: ${status}`, detail: err.response.data })
      }
    } else {
      console.error('[Product] 请求失败:', err.message)
      res.status(500).json({ error: err.message })
    }
  }
})

// GET /api/product/benchmark-videos?productId=xxx&category=lingerie&limit=10
// 返回某商品的标杆参考视频列表（按 ROI 降序）
router.get('/benchmark-videos', async (req, res) => {
  const { productId, category } = req.query
  const limit = Math.min(parseInt(req.query.limit) || 10, 50)
  try {
    const videos = await listBenchmarkVideos({ productId, category, limit })
    res.json({ count: videos.length, videos })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/product/affiliate-videos — 达人带货视频库（支持筛选 + 排序 + 分页）
// query: page, limit, sort, order, author, dateFrom, dateTo, minGmv, maxGmv
router.get('/affiliate-videos', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1)
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = (page - 1) * limit

  const SORT_WHITELIST = ['affiliate_gmv','affiliate_rpm','impressions','affiliate_orders','affiliate_likes','affiliate_comments','ctr','published_at']
  const sort  = SORT_WHITELIST.includes(req.query.sort) ? req.query.sort : 'affiliate_gmv'
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC'

  const author   = req.query.author?.trim() || null
  const dateFrom = req.query.dateFrom || null   // YYYY-MM-DD
  const dateTo   = req.query.dateTo || null
  const minGmv   = req.query.minGmv ? parseFloat(req.query.minGmv) : null
  const maxGmv   = req.query.maxGmv ? parseFloat(req.query.maxGmv) : null

  const params = []
  let pi = 0
  const np = v => { params.push(v); return `$${++pi}` }

  const wheres = []
  if (author)   wheres.push(`author_username ILIKE ${np('%' + author + '%')}`)
  if (dateFrom) wheres.push(`published_at >= ${np(dateFrom)}`)
  if (dateTo)   wheres.push(`published_at <= ${np(dateTo)}`)
  if (minGmv != null) wheres.push(`affiliate_gmv >= ${np(minGmv)}`)
  if (maxGmv != null) wheres.push(`affiliate_gmv <= ${np(maxGmv)}`)

  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''

  try {
    const { pool } = await import('../services/db.js')
    // 分页参数单独追加，count 查询不需要
    const whereParams = [...params]
    const dataParams  = [...params, limit, offset]
    const limitPh     = `$${pi + 1}`
    const offsetPh    = `$${pi + 2}`
    const [dataRes, cntRes] = await Promise.all([
      pool.query(`
        SELECT video_id, video_url, author_username, title, published_at,
               affiliate_gmv, revenue, affiliate_orders, affiliate_aov,
               affiliate_commission, impressions, ctr, affiliate_rpm,
               affiliate_refund_count, affiliate_refund_gmv,
               affiliate_comments, affiliate_likes, is_benchmark
        FROM reference_videos
        ${where}
        ORDER BY ${sort} ${order} NULLS LAST
        LIMIT ${limitPh} OFFSET ${offsetPh}
      `, dataParams),
      pool.query(`SELECT COUNT(*) AS c FROM reference_videos ${where}`, whereParams),
    ])
    res.json({
      total: parseInt(cntRes.rows[0].c, 10),
      page, limit,
      videos: dataRes.rows,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ===== 产品管理 API =====

// GET /api/product/list — 列出所有缓存产品（按 last_used_at DESC）
router.get('/list', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500)
    const offset = parseInt(req.query.offset) || 0
    const items = await listProducts({ limit, offset })
    res.json({ count: items.length, items })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/product/cache/:productId — 单个产品的完整缓存详情（含 user_image_urls 分开列出）
// 注意：路径前缀 /cache/ 区分于 /fetch（爬虫）和 /benchmark-videos（标杆）
router.get('/cache/:productId', async (req, res) => {
  try {
    const product = await getProductFull(req.params.productId)
    if (!product) return res.status(404).json({ error: 'Product not cached' })
    res.json({ product })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/product/:productId/images — 上传自定义图（multipart），每张走 kie.ai 拿稳定 URL，追加到 user_image_urls
// 可选 form field "color"：新上传的图默认绑定到此颜色（否则空串=未标）
router.post('/:productId/images', upload.array('images', 10), async (req, res) => {
  const { productId } = req.params
  const product = await getProductFull(productId)
  if (!product) {
    // 清理已上传的临时文件
    for (const f of req.files || []) await unlink(f.path).catch(() => {})
    return res.status(404).json({ error: 'Product not cached, fetch it first via /api/product/fetch' })
  }
  const files = req.files || []
  if (files.length === 0) return res.status(400).json({ error: 'No images uploaded' })

  const uploadColor = (req.body.color || '').trim()
  const successUrls = []
  const successThumbs = []
  const failures = []
  for (const f of files) {
    try {
      const { url, thumbUrl } = await uploadMediaFileWithThumb(f.path, f.originalname)
      successUrls.push(url)
      successThumbs.push(thumbUrl || '')
    } catch (e) {
      failures.push({ name: f.originalname, error: e.message })
    } finally {
      await unlink(f.path).catch(() => {})
    }
  }

  const newUserImages = [...product.userImageUrls, ...successUrls]
  const newUserColors = [...product.userImageColors, ...successUrls.map(() => uploadColor)]
  const newUserThumbs = [...(product.userImageThumbUrls || []), ...successThumbs]
  await updateProductImages(productId, newUserImages, newUserColors, newUserThumbs)
  res.json({
    added: successUrls,
    failed: failures,
    userImageUrls: newUserImages,
    userImageColors: newUserColors,
    userImageThumbUrls: newUserThumbs,
  })
})

// PATCH /api/product/:productId/image-color — body: { url, color } 单张图打标
router.patch('/:productId/image-color', express.json(), async (req, res) => {
  const { url, color } = req.body
  if (!url) return res.status(400).json({ error: '缺少 url 参数' })
  const ok = await setImageColor(req.params.productId, url, color || '')
  if (!ok) return res.status(404).json({ error: 'URL not found in this product' })
  res.json({ ok: true, url, color: (color || '').trim() })
})

// POST /api/product/:productId/bulk-tag — body: { urls: [...], color } 批量打标
router.post('/:productId/bulk-tag', express.json(), async (req, res) => {
  const { urls, color } = req.body
  if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: '缺少 urls 数组' })
  const success = await bulkSetImageColors(req.params.productId, urls, color || '')
  res.json({ ok: true, taggedCount: success, total: urls.length })
})

// GET /api/product/:productId/sku-options — 返回该产品的 SKU 词表（约束 AI 打标）
router.get('/:productId/sku-options', async (req, res) => {
  try {
    res.json(await getProductSkuOptions(req.params.productId))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/product/:productId/recommend-sku — AI 推荐最适合生成视频的 SKU
router.get('/:productId/recommend-sku', async (req, res) => {
  try {
    const product = await getProductFull(req.params.productId)
    if (!product) return res.status(404).json({ error: 'Product not found' })
    const result = await recommendBestSku(product)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/product/:productId/ai-detect-colors — AI 一键识别图片 SKU（用产品 variants 词表约束）
// body: { scope: 'untagged' | 'all' }，默认 untagged。返回识别结果但同时已写 DB
router.post('/:productId/ai-detect-colors', express.json(), async (req, res) => {
  const { productId } = req.params
  const scope = req.body?.scope === 'all' ? 'all' : 'untagged'
  const product = await getProductFull(productId)
  if (!product) return res.status(404).json({ error: 'Product not found' })

  // 拿这个产品的 SKU 词表（变体），如果没有就走自由识别老路
  const skuOptions = await getProductSkuOptions(productId)

  // 收集待识别的 urls：scope='untagged' 只挑现在没颜色的
  const sections = [
    { urls: product.mainImageUrls, colors: product.mainImageColors },
    { urls: product.detailImageUrls, colors: product.detailImageColors },
    { urls: product.userImageUrls, colors: product.userImageColors },
  ]
  const targetUrls = []
  for (const sec of sections) {
    for (let i = 0; i < sec.urls.length; i++) {
      if (scope === 'all' || !(sec.colors[i] || '').trim()) {
        targetUrls.push(sec.urls[i])
      }
    }
  }
  if (targetUrls.length === 0) {
    return res.json({ taggedCount: 0, total: 0, results: [], skippedCount: 0, message: '没有需要识别的图（所有图都已标）' })
  }

  try {
    const results = await detectImageColors(targetUrls, { skuOptions: skuOptions.values })
    const failed = []
    const toWrite = []
    for (const r of results) {
      if (r.success && r.color) {
        toWrite.push({ url: r.url, color: r.color })
      } else {
        failed.push({ url: r.url, error: r.error || 'no color returned' })
      }
    }
    // 一次性批量写回 DB（原来逐张写：53张×3次RDS = 159次；现在：1次读+1次写 = 2次）
    const taggedCount = await batchSetImageColors(productId, toWrite)
    res.json({
      taggedCount,
      total: targetUrls.length,
      results: results.map(r => ({ url: r.url, color: r.color, success: r.success })),
      failed,
    })
  } catch (e) {
    res.status(500).json({ error: `AI 识别失败：${e.message}` })
  }
})

// DELETE /api/product/:productId/images — body: { url } 从 user_image_urls 移除指定 URL（同时移除对齐的 color）
router.delete('/:productId/images', express.json(), async (req, res) => {
  const { productId } = req.params
  const { url } = req.body
  if (!url) return res.status(400).json({ error: '缺少 url 参数' })
  const product = await getProductFull(productId)
  if (!product) return res.status(404).json({ error: 'Product not found' })

  const idx = product.userImageUrls.indexOf(url)
  if (idx < 0) return res.status(404).json({ error: 'URL not found in user_image_urls' })
  const filteredUrls = product.userImageUrls.filter((_, i) => i !== idx)
  const filteredColors = product.userImageColors.filter((_, i) => i !== idx)
  const filteredThumbs = (product.userImageThumbUrls || []).filter((_, i) => i !== idx)
  await updateProductImages(productId, filteredUrls, filteredColors, filteredThumbs)
  res.json({ userImageUrls: filteredUrls, userImageColors: filteredColors, userImageThumbUrls: filteredThumbs })
})

// PATCH /api/product/:productId — body: { name } 重命名
router.patch('/:productId', express.json(), async (req, res) => {
  const { name } = req.body
  if (!name || typeof name !== 'string') return res.status(400).json({ error: '缺少 name 参数' })
  const ok = await renameProduct(req.params.productId, name.trim())
  if (!ok) return res.status(404).json({ error: 'Product not found' })
  res.json({ ok: true, name: name.trim() })
})

// DELETE /api/product/:productId — 删除整个产品缓存
router.delete('/:productId', async (req, res) => {
  const ok = await deleteProduct(req.params.productId)
  if (!ok) return res.status(404).json({ error: 'Product not found' })
  res.json({ ok: true })
})

export default router
