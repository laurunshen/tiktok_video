// 整夜实验报告生成器：扫描 jobs.log，把所有跑过的任务 + 视频 + 评分汇总成 markdown
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db')
const db = new Database(DB_PATH, { readonly: true })

const JOBS_LOG = '/tmp/overnight_results/jobs.log'
const REPORT_PATH = '/tmp/overnight-experiment-report.md'

if (!fs.existsSync(JOBS_LOG)) {
  console.error('No jobs.log found')
  process.exit(1)
}

const lines = fs.readFileSync(JOBS_LOG, 'utf8').split('\n').filter(l => l.startsWith('JOB|'))
const phases = {}
for (const line of lines) {
  const [, phase, jobId, ref, ...rest] = line.split('|')
  if (!phases[phase]) phases[phase] = []
  phases[phase].push({ jobId, ref, note: rest.join('|') })
}

const md = []
md.push(`# 🌙 整夜实验报告\n`)
md.push(`生成时间: ${new Date().toISOString()}\n`)

const startTime = parseInt(fs.readFileSync('/tmp/overnight_start.txt', 'utf8'))
const elapsed = Math.round((Date.now()/1000 - startTime) / 60)
md.push(`实验总时长: ${elapsed} 分钟\n`)

let totalCost = 0
let videoCount = 0

for (const [phase, jobs] of Object.entries(phases)) {
  md.push(`\n## 阶段：${phase}\n`)
  for (const job of jobs) {
    const j = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(job.jobId)
    if (!j) {
      md.push(`### ❓ ${job.jobId} — ${job.ref}\n  数据库无记录\n`)
      continue
    }
    const videos = db.prepare('SELECT * FROM videos WHERE job_id = ?').all(job.jobId)

    md.push(`\n### ${j.status === 'completed' ? '✅' : '❌'} ${job.jobId}\n`)
    md.push(`- **参考视频**: ${job.ref}`)
    md.push(`- **状态**: ${j.status}`)
    md.push(`- **耗时**: ${j.total_ms ? Math.round(j.total_ms/1000) + 's' : '-'}`)
    if (job.note) md.push(`- **备注**: ${job.note}`)
    if (j.variant_seed) md.push(`- **Variant**: ${j.variant_seed}`)
    if (j.error_message) md.push(`- **错误**: ${j.error_message}`)

    for (const v of videos) {
      videoCount++
      totalCost += 12
      md.push(`\n  #### 🎬 视频`)
      md.push(`  - URL: ${v.video_url}`)
      md.push(`  - 二次评估: ${v.review_score ?? '-'}/10 (修订 ${v.revision_count} 次)`)

      if (v.narrative_dna) {
        try {
          const dna = JSON.parse(v.narrative_dna)
          md.push(`  - **叙事 DNA**:`)
          md.push(`    - hook_type: \`${dna.hook_type}\``)
          md.push(`    - narrative_structure: \`${dna.narrative_structure}\``)
          md.push(`    - tone_register: \`${dna.tone_register}\``)
          md.push(`    - unique_signature: ${dna.unique_creative_signature || '-'}`)
          md.push(`    - key_phrases: ${(dna.key_phrases || []).map(p => `"${p}"`).join(', ')}`)
        } catch {}
      }

      if (v.video_judge_overall != null) {
        md.push(`  - **Gemini 视频评分**: ${v.video_judge_overall}/10`)
        if (v.video_judge_verdict) md.push(`    - 结论: ${v.video_judge_verdict}`)
        if (v.video_judge_scores) {
          try {
            const s = JSON.parse(v.video_judge_scores)
            md.push(`    - 各维度: ${Object.entries(s).map(([k,val]) => `${k}=${val}`).join(', ')}`)
          } catch {}
        }
        if (v.video_judge_issues) {
          try {
            const issues = JSON.parse(v.video_judge_issues)
            if (issues.length > 0) {
              md.push(`    - 问题:`)
              issues.forEach(i => md.push(`      - ${i}`))
            }
          } catch {}
        }
      }

      if (v.diff_judge_overall != null) {
        md.push(`  - **vs 标杆差异化**: ${v.diff_judge_overall}/10`)
        if (v.diff_judge_verdict) md.push(`    - 结论: ${v.diff_judge_verdict}`)
        if (v.diff_judge_scores) {
          try {
            const s = JSON.parse(v.diff_judge_scores)
            md.push(`    - 各维度: ${Object.entries(s).map(([k,val]) => `${k}=${val}`).join(', ')}`)
          } catch {}
        }
      }
    }
  }
}

md.push(`\n---\n## 实验总成本估算\n`)
md.push(`- 生成视频数: ${videoCount}`)
md.push(`- Seedance 成本: ¥${totalCost}`)
md.push(`- Gemini 成本估算: ¥${(videoCount * 1.5).toFixed(0)} (含 Pass 1/2/review/judge/diff)`)
md.push(`- **总计**: 约 ¥${totalCost + Math.round(videoCount * 1.5)}`)

fs.writeFileSync(REPORT_PATH, md.join('\n'))
console.log(`✅ 报告已生成: ${REPORT_PATH}`)
console.log(`   视频数: ${videoCount}, 估算总成本: ¥${totalCost + Math.round(videoCount * 1.5)}`)
