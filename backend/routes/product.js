import express from 'express'
import axios from 'axios'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { uploadFileToKie } from '../services/kieai-upload.js'
import { getProductCache, saveProduct, listBenchmarkVideos } from '../services/db.js'

const router = express.Router()

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
function parseProductInfo(data) {
  const productInfo = data?.data?.product_data?.page_config?.components_map
    ?.find(c => c.component_name === 'product_info')
    ?.component_data?.product_info

  if (!productInfo) throw new Error('无法解析商品信息，请检查链接或 region 是否正确')

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
  const { url, region = 'SG' } = req.query

  if (!url) return res.status(400).json({ error: '缺少 url 参数' })

  const productId = extractProductId(url)
  if (!productId) return res.status(400).json({ error: '无法从链接中提取 product_id，请检查链接格式' })

  try {
    // 缓存命中：24 小时内同 productId 直接返回（kie.ai URL 也是稳定的）
    const cached = getProductCache(productId)
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

    console.log(`[Product] 下载并上传 ${allTikTokUrls.length} 张商品图到 kie.ai 稳定存储...`)
    const stableUrls = []
    for (let i = 0; i < allTikTokUrls.length; i++) {
      try {
        const tmpPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
        const dl = await axios.get(allTikTokUrls[i], {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        await writeFile(tmpPath, dl.data)
        const url = await uploadFileToKie(tmpPath, `product-${i + 1}.jpg`)
        await unlink(tmpPath).catch(() => {})
        stableUrls.push(url)
        console.log(`  [stable] ${i + 1}/${allTikTokUrls.length} ✅`)
      } catch (e) {
        console.warn(`  [stable] ${i + 1}/${allTikTokUrls.length} ❌ ${e.message}`)
      }
    }
    productInfo.mainImageUrls = stableUrls.slice(0, mainCount)
    productInfo.detailImageUrls = stableUrls.slice(mainCount)
    console.log(`[Product] 稳定 URL 完成：主图 ${productInfo.mainImageUrls.length} + 详情图 ${productInfo.detailImageUrls.length}`)

    // 写入产品缓存（下次同 productId 24h 内直接命中）
    try { saveProduct(productId, region, productInfo) } catch (e) { console.warn(`[Product] 缓存写入失败: ${e.message}`) }

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
router.get('/benchmark-videos', (req, res) => {
  const { productId, category } = req.query
  const limit = Math.min(parseInt(req.query.limit) || 10, 50)
  try {
    const videos = listBenchmarkVideos({ productId, category, limit })
    res.json({ count: videos.length, videos })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
