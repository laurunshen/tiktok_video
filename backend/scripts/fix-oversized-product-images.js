// 修复指定产品的 user_image_urls 中单边 > 5500 的图。
// 并行 + 增量落库（每修好一张立刻 UPDATE，崩了也不丢进度）。
//
// 用法：
//   node scripts/fix-oversized-product-images.js <productId> [colorFilter]
//   colorFilter: 只处理 user_image_colors 等于该值的图（如 Black）。默认全部检查。

import '../load-env.js'
import axios from 'axios'
import sharp from 'sharp'
import { writeFile, unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { getProductFull, updateProductImages } from '../services/db.js'
import { uploadMediaFile } from '../services/media-upload.js'

const MAX_SIDE = 5500
const CONCURRENCY = 4

const productId = process.argv[2]
const colorFilter = process.argv[3] || null
if (!productId) {
  console.error('用法：node scripts/fix-oversized-product-images.js <productId> [colorFilter]')
  process.exit(1)
}

const detail = getProductFull(productId)
if (!detail) {
  console.error(`产品不存在：${productId}`)
  process.exit(1)
}

const urls = [...(detail.userImageUrls || [])]
const colors = [...(detail.userImageColors || [])]

const targetIndices = []
for (let i = 0; i < urls.length; i++) {
  if (colorFilter && colors[i] !== colorFilter) continue
  targetIndices.push(i)
}

console.log(`产品 ${productId}: 共 ${urls.length} 张 user 图，候选 ${targetIndices.length} 张${colorFilter ? `（color=${colorFilter}）` : ''}`)

async function processOne(idx) {
  const url = urls[idx]
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 })
    const buf = Buffer.from(res.data)
    const meta = await sharp(buf).metadata()
    const maxSide = Math.max(meta.width, meta.height)
    if (maxSide <= MAX_SIDE) {
      console.log(`  [#${idx}] ${meta.width}x${meta.height} ✅ skip`)
      return null
    }
    const scale = MAX_SIDE / maxSide
    const newW = Math.round(meta.width * scale)
    const newH = Math.round(meta.height * scale)
    const resized = await sharp(buf).resize(newW, newH).jpeg({ quality: 85 }).toBuffer()
    const tmpFile = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
    await writeFile(tmpFile, resized)
    try {
      const newUrl = await uploadMediaFile(tmpFile, 'resized.jpg')
      console.log(`  [#${idx}] ${meta.width}x${meta.height} → ${newW}x${newH} ✅`)
      return newUrl
    } finally {
      await unlink(tmpFile).catch(() => {})
    }
  } catch (err) {
    console.error(`  [#${idx}] ❌ ${err.message}`)
    return undefined  // 用 undefined 区别于明确 skip 的 null
  }
}

// 并行 worker 池
let fixed = 0
const queue = [...targetIndices]
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) {
    const idx = queue.shift()
    const newUrl = await processOne(idx)
    if (newUrl) {
      urls[idx] = newUrl
      updateProductImages(productId, urls, colors)  // 增量落库
      fixed++
    }
  }
})
await Promise.all(workers)

console.log(`\n✅ 修复 ${fixed} 张（${colorFilter ? colorFilter + ' SKU' : '全部'}）`)
