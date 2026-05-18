// 一次性脚本：把现有 videos 表里 kie.ai tempfile URL 全部下载并上传到 S3，更新 DB
// 幂等：已经是本 S3 bucket 的 URL 会 skip
// 容错：单条失败不中断，最后打印统计
import '../load-env.js'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { S3_ENABLED, uploadUrlToS3, isOurS3Url } from '../services/s3-upload.js'

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
    AND (video_url LIKE '%tempfile%' OR video_url LIKE '%aiquickdraw%' OR video_url LIKE '%hypit%')
`).all()

console.log(`找到 ${rows.length} 条待迁移视频`)

let migrated = 0, skipped = 0, failed = 0
const failures = []

for (const r of rows) {
  if (isOurS3Url(r.video_url)) {
    skipped++
    continue
  }
  process.stdout.write(`[${migrated + skipped + failed + 1}/${rows.length}] ${r.video_id.slice(0, 12)}… `)
  try {
    const newUrl = await uploadUrlToS3(r.video_url, `${r.video_id}.mp4`, 'video/mp4')
    db.prepare('UPDATE videos SET video_url = ? WHERE video_id = ?').run(newUrl, r.video_id)
    console.log(`✅`)
    migrated++
  } catch (e) {
    const status = e.response?.status || e.$metadata?.httpStatusCode || '?'
    console.log(`❌ ${status} ${e.message.slice(0, 100)}`)
    failed++
    failures.push({ video_id: r.video_id, url: r.video_url, error: e.message })
  }
}

console.log(`\n=== 完成 ===`)
console.log(`迁移成功: ${migrated}`)
console.log(`跳过 (已是 S3): ${skipped}`)
console.log(`失败 (kie 可能已过期): ${failed}`)
if (failures.length > 0 && failures.length <= 30) {
  console.log(`\n失败明细:`)
  for (const f of failures) console.log(`  ${f.video_id}: ${f.error.slice(0, 120)}`)
}

db.close()
process.exit(0)
