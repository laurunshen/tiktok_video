// 一次性脚本：把 backend/uploads/ 里残留的本地 jpg 上传到 S3，
// 替换某产品的 user_image_urls（所有 kie tempfile URL 已 404，没救）
// 用法：node scripts/restore-product-images.js <productId>
//      （省略 productId 时若库里只有 1 个产品则自动选它）
import '../load-env.js'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { readdirSync, statSync } from 'fs'
import { S3_ENABLED } from '../services/s3-upload.js'
import { uploadMediaFile } from '../services/media-upload.js'
import { updateProductImages } from '../services/db.js'

if (!S3_ENABLED) {
  console.error('S3 未开启（检查 .env 里 USE_S3 + AWS_*）')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db')
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')
const db = new Database(DB_PATH)

let productId = process.argv[2]
if (!productId) {
  const rows = db.prepare('SELECT product_id, name FROM products').all()
  if (rows.length === 0) { console.error('库里没产品'); process.exit(1) }
  if (rows.length > 1) {
    console.error('库里有多个产品，请指定 productId:')
    rows.forEach(r => console.error(`  ${r.product_id}  ${r.name}`))
    process.exit(1)
  }
  productId = rows[0].product_id
  console.log(`自动选中唯一产品: ${productId}  (${rows[0].name?.slice(0, 50)})`)
}

// 扫本地 uploads/ 找所有图片（mp4 等视频排除）
const IMG_EXT = /\.(jpe?g|png|webp)$/i
const files = readdirSync(UPLOADS_DIR)
  .filter(f => IMG_EXT.test(f))
  .map(f => ({
    name: f,
    path: path.join(UPLOADS_DIR, f),
    size: statSync(path.join(UPLOADS_DIR, f)).size,
    mtime: statSync(path.join(UPLOADS_DIR, f)).mtimeMs,
  }))
  .sort((a, b) => a.mtime - b.mtime)  // 按修改时间升序，UI 顺序更直观

if (files.length === 0) {
  console.error(`backend/uploads/ 里没找到图片`)
  process.exit(1)
}

console.log(`找到 ${files.length} 张本地图片，开始上传 S3...`)

const uploadedUrls = []
let failed = 0
for (let i = 0; i < files.length; i++) {
  const f = files[i]
  process.stdout.write(`[${i + 1}/${files.length}] ${f.name} (${(f.size / 1024).toFixed(0)}KB) … `)
  try {
    const url = await uploadMediaFile(f.path, f.name)
    uploadedUrls.push(url)
    console.log(`✅ ${url.split('/').pop()}`)
  } catch (e) {
    console.log(`❌ ${e.message.slice(0, 120)}`)
    failed++
  }
}

if (uploadedUrls.length === 0) {
  console.error(`全部失败，DB 不更新`)
  process.exit(1)
}

console.log(`\n替换产品 ${productId} 的 user_image_urls（${uploadedUrls.length} 张 S3 URL，旧 kie URL 已全部 404 → 整体覆写）`)
const ok = updateProductImages(productId, uploadedUrls)
console.log(ok ? `✅ DB 更新成功` : `❌ DB 更新失败`)

console.log(`\n=== 完成 ===`)
console.log(`上传成功: ${uploadedUrls.length}`)
console.log(`上传失败: ${failed}`)
console.log(`提示：main_image_urls / detail_image_urls 没动（那些是爬虫抓的），如需恢复请在前端重新拉取产品`)

db.close()
process.exit(0)
