// 一次性 backfill：给所有已存在的产品图生成 400px thumbnail 并写回 DB
// 用法：node scripts/backfill-thumbs.js [productId]
//   - 不带参数：扫所有产品，跳过已有 thumb 的位
//   - 带 productId：只处理这一个
// 可中断重跑：每张图独立判断是否需要 backfill（thumb 缺失 = 需要）
import '../load-env.js'
// 导入 services/db.js 触发其内部 schema migrations（保证 *_image_thumb_urls 列存在）
import '../services/db.js'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import sharp from 'sharp'
import { v4 as uuidv4 } from 'uuid'
import { S3_ENABLED, uploadBufferToS3 } from '../services/s3-upload.js'

if (!S3_ENABLED) {
  console.error('S3 未开启（检查 .env 里 USE_S3 + AWS_*）')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db')
const db = new Database(DB_PATH)

const THUMB_MAX_SIDE = 400
const THUMB_QUALITY = 80
const CONCURRENCY = 4
const DOWNLOAD_TIMEOUT = 30000

const onlyProductId = process.argv[2] || null

const rows = onlyProductId
  ? db.prepare('SELECT product_id, name, main_image_urls, detail_image_urls, user_image_urls, main_image_thumb_urls, detail_image_thumb_urls, user_image_thumb_urls FROM products WHERE product_id = ?').all(onlyProductId)
  : db.prepare('SELECT product_id, name, main_image_urls, detail_image_urls, user_image_urls, main_image_thumb_urls, detail_image_thumb_urls, user_image_thumb_urls FROM products').all()

if (rows.length === 0) {
  console.error(onlyProductId ? `未找到 product_id=${onlyProductId}` : '库里没有产品')
  process.exit(1)
}

console.log(`[backfill] ${rows.length} 个产品待处理\n`)

// 一张图：下载 → resize → 上传 → 返回 thumbUrl（失败返回 ''）
async function backfillOne(originalUrl) {
  try {
    const resp = await axios.get(originalUrl, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const thumbBuf = await sharp(Buffer.from(resp.data))
      .rotate()
      .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
      .toBuffer()
    const thumbName = `${uuidv4()}_thumb.jpg`
    return await uploadBufferToS3(thumbBuf, thumbName, 'image/jpeg')
  } catch (e) {
    console.warn(`    ❌ ${originalUrl.slice(-30)}: ${e.message}`)
    return ''
  }
}

// 并发执行：把任务数组分批 CONCURRENCY 一组
async function runConcurrent(items, fn) {
  const results = new Array(items.length)
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(batch.map((it, j) => fn(it, i + j)))
    batchResults.forEach((r, j) => { results[i + j] = r })
  }
  return results
}

// 对齐 thumb 数组到 url 数组长度（空串 = 待处理）
function alignArray(urls, arr) {
  const out = new Array(urls.length).fill('')
  for (let i = 0; i < urls.length && i < (arr || []).length; i++) {
    out[i] = arr[i] || ''
  }
  return out
}

let totalDone = 0
let totalSkipped = 0
let totalFailed = 0
const startTime = Date.now()

for (const row of rows) {
  const main = row.main_image_urls ? JSON.parse(row.main_image_urls) : []
  const detail = row.detail_image_urls ? JSON.parse(row.detail_image_urls) : []
  const user = row.user_image_urls ? JSON.parse(row.user_image_urls) : []
  const mainThumbs = alignArray(main, row.main_image_thumb_urls ? JSON.parse(row.main_image_thumb_urls) : [])
  const detailThumbs = alignArray(detail, row.detail_image_thumb_urls ? JSON.parse(row.detail_image_thumb_urls) : [])
  const userThumbs = alignArray(user, row.user_image_thumb_urls ? JSON.parse(row.user_image_thumb_urls) : [])

  const sections = [
    { name: 'main', urls: main, thumbs: mainThumbs },
    { name: 'detail', urls: detail, thumbs: detailThumbs },
    { name: 'user', urls: user, thumbs: userThumbs },
  ]

  // 收集所有"需要 backfill"的位置
  const todo = []
  for (const sec of sections) {
    for (let i = 0; i < sec.urls.length; i++) {
      if (!sec.thumbs[i]) todo.push({ sec, i, url: sec.urls[i] })
    }
  }

  const skipped = main.length + detail.length + user.length - todo.length
  console.log(`▶ ${row.product_id}（${(row.name || '').slice(0, 40)}）`)
  console.log(`  待处理 ${todo.length} 张，跳过 ${skipped} 张（已有 thumb）`)

  if (todo.length === 0) {
    totalSkipped += skipped
    console.log(`  ✓ 全部已有 thumb，跳过\n`)
    continue
  }

  const results = await runConcurrent(todo, async (item, idx) => {
    const thumbUrl = await backfillOne(item.url)
    if (thumbUrl) console.log(`    [${idx + 1}/${todo.length}] ✅ ${item.sec.name}[${item.i}]`)
    return { item, thumbUrl }
  })

  // 写回 thumbs 数组
  for (const r of results) {
    if (r.thumbUrl) {
      r.item.sec.thumbs[r.item.i] = r.thumbUrl
      totalDone++
    } else {
      totalFailed++
    }
  }

  // 持久化（即使部分失败也要写：成功的 thumb 不要丢）
  db.prepare(`
    UPDATE products SET
      main_image_thumb_urls = ?,
      detail_image_thumb_urls = ?,
      user_image_thumb_urls = ?
    WHERE product_id = ?
  `).run(
    JSON.stringify(mainThumbs),
    JSON.stringify(detailThumbs),
    JSON.stringify(userThumbs),
    row.product_id,
  )
  totalSkipped += skipped
  console.log(`  ✓ 写入 DB\n`)
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
console.log(`\n========================`)
console.log(`完成：${totalDone} 张生成，${totalSkipped} 张跳过，${totalFailed} 张失败`)
console.log(`耗时：${elapsed}s`)
console.log(`========================`)

db.close()
process.exit(totalFailed > 0 ? 1 : 0)
