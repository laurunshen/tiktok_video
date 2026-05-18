// 一次性脚本：给已有视频生成 poster JPG 并回填 videos.poster_url
// 幂等：poster_url 已存在的 skip
// 串行执行避免饱和 us-east-1 → CN 带宽（每条要先把视频拉下来）
import '../load-env.js'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { S3_ENABLED, generatePosterForExistingVideo } from '../services/s3-upload.js'

if (!S3_ENABLED) {
  console.error('S3 未开启（检查 USE_S3 + AWS_* env vars）')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db')
const db = new Database(DB_PATH)

const rows = db.prepare(`
  SELECT video_id, video_url FROM videos
  WHERE video_url IS NOT NULL
    AND poster_url IS NULL
`).all()

console.log(`待生成 poster: ${rows.length} 条`)

let ok = 0, failed = 0
const failures = []
const t0 = Date.now()

for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  process.stdout.write(`[${i + 1}/${rows.length}] ${r.video_id.slice(0, 12)}… `)
  try {
    const posterUrl = await generatePosterForExistingVideo(r.video_url, r.video_id)
    db.prepare('UPDATE videos SET poster_url = ? WHERE video_id = ?').run(posterUrl, r.video_id)
    console.log(`✅ ${posterUrl.split('/').pop()}`)
    ok++
  } catch (e) {
    const status = e.response?.status || e.$metadata?.httpStatusCode || '?'
    console.log(`❌ ${status} ${e.message.slice(0, 120)}`)
    failed++
    failures.push({ video_id: r.video_id, error: e.message })
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n=== 完成 (${dt}s) ===`)
console.log(`成功: ${ok}`)
console.log(`失败: ${failed}`)
if (failures.length > 0 && failures.length <= 30) {
  console.log(`\n失败明细:`)
  for (const f of failures) console.log(`  ${f.video_id}: ${f.error.slice(0, 150)}`)
}

db.close()
process.exit(0)
