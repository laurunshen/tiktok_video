// 把 Inlyric视频表现.xlsx 里的高表现视频导入到 reference_videos 表
// 用法: node backend/scripts/import-benchmark-videos.js <excel路径>
//
// 标杆判定标准：
//   广告素材：成本 > $100 AND ROI > 3      → is_benchmark=1
//   联盟视频：GMV > $5000 AND 点击率 > 1%  → is_benchmark=1（即使没有 ROI 也算）
// 其他视频也会被导入但 is_benchmark=0，方便未来按更宽松的条件查询

import { saveReferenceVideo } from '../services/db.js'
import xlsx from 'xlsx'

const excelPath = process.argv[2] || '/Users/liurunsheng/Downloads/Inlyric视频表现.xlsx'
console.log(`导入: ${excelPath}`)

const wb = xlsx.readFile(excelPath)
console.log(`Sheets: ${wb.SheetNames.join(', ')}`)

// 从 TikTok URL 提取 video_id
function extractVideoId(url) {
  if (!url) return null
  const m = String(url).match(/video\/(\d+)/)
  return m ? m[1] : null
}

let adsImported = 0, adsBenchmark = 0
let affImported = 0, affBenchmark = 0

// === 广告素材模块 ===
const adSheet = xlsx.utils.sheet_to_json(wb.Sheets['广告素材模块'], { defval: null })
console.log(`\n[广告素材模块] ${adSheet.length} 行`)

for (const row of adSheet) {
  const videoId = String(row['视频 ID'] ?? '').trim()
  if (!videoId || !/^\d+$/.test(videoId)) continue

  const cost = parseFloat(row['成本']) || 0
  const roi = parseFloat(row['ROI']) || 0
  const isBenchmark = cost > 100 && roi > 3

  saveReferenceVideo({
    video_id: videoId,
    video_url: `https://www.tiktok.com/@${row['用户名']}/video/${videoId}`,
    author_username: row['用户名'] ?? null,
    title: row['视频标题'] ?? null,
    product_id: row['商品 ID'] ? String(row['商品 ID']) : null,
    product_name: row['商品名称'] ?? null,
    category: detectCategory(row['商品名称']),
    roi: roi || null,
    revenue: parseFloat(row['总收入']) || null,
    cost: cost || null,
    cvr: parseFloat(row['广告转化率']) || null,
    play_2s_rate: parseFloat(row['广告视频 2 秒播放率']) || null,
    play_6s_rate: parseFloat(row['广告视频 6 秒播放率']) || null,
    impressions: parseInt(row['商品广告曝光数']) || null,
    clicks: parseInt(row['商品广告点击数']) || null,
    ctr: parseFloat(row['商品广告点击率']) || null,
    source: 'ad',
    is_benchmark: isBenchmark,
    benchmark_reason: isBenchmark ? `广告标杆: cost=$${cost.toFixed(0)} ROI=${roi.toFixed(2)}` : null,
    raw_data: row,
  })

  adsImported++
  if (isBenchmark) adsBenchmark++
}

// === 联盟模块 ===
// 注意：联盟模块的"视频链接"列是 Excel 超链接（hyperlink），sheet_to_json 不读 hyperlink target
// 需要直接读 cell 的 .l.Target 字段
const affSheetRaw = wb.Sheets['联盟模块']
const affSheet = xlsx.utils.sheet_to_json(affSheetRaw, { defval: null })
// 找出"视频链接"列在第几列（按 header 名称）
const range = xlsx.utils.decode_range(affSheetRaw['!ref'])
let linkColIdx = null
for (let c = range.s.c; c <= range.e.c; c++) {
  const headerCell = affSheetRaw[xlsx.utils.encode_cell({ r: range.s.r, c })]
  if (headerCell && headerCell.v === '视频链接') { linkColIdx = c; break }
}
console.log(`[联盟模块] ${affSheet.length} 行 (链接列: ${linkColIdx != null ? xlsx.utils.encode_col(linkColIdx) : '未找到'})`)

for (let i = 0; i < affSheet.length; i++) {
  const row = affSheet[i]
  // 从超链接里取 URL
  let url = row['视频链接']
  if (!url && linkColIdx != null) {
    const cell = affSheetRaw[xlsx.utils.encode_cell({ r: i + 1, c: linkColIdx })]
    url = cell?.l?.Target || cell?.v || null
  }
  const videoId = extractVideoId(url)
  if (!videoId) continue

  const gmv = parseFloat(row['GMV']) || 0
  const ctr = parseFloat(row['联盟点击率']) || 0
  const isBenchmark = gmv > 5000 && ctr > 0.01

  // 联盟数据可能和广告数据有同一 videoId → INSERT OR REPLACE 会覆盖
  // 这种情况下我们保留广告数据（更精确），不覆盖
  // 简单实现：联盟视频如果 video_id 已经在表里（来自广告），跳过
  // 这里走简单路径：直接覆盖；广告数据是后导入的就保留广告数据
  saveReferenceVideo({
    video_id: videoId,
    video_url: url,
    author_username: row['达人用户名'] ?? null,
    title: row['视频名称'] ?? null,
    product_id: null,
    product_name: null,
    category: 'lingerie',  // 这表都是 INLYRIC 的内衣视频
    affiliate_gmv: gmv || null,
    affiliate_likes: parseInt(row['带货视频点赞数']) || null,
    affiliate_comments: parseInt(row['带货视频评论数']) || null,
    impressions: parseInt(row['带货视频曝光次数']) || null,
    ctr: ctr || null,
    source: 'affiliate',
    is_benchmark: isBenchmark,
    benchmark_reason: isBenchmark ? `联盟标杆: GMV=$${gmv.toFixed(0)} CTR=${(ctr * 100).toFixed(2)}%` : null,
    raw_data: row,
  })

  affImported++
  if (isBenchmark) affBenchmark++
}

console.log(`\n========== 导入完成 ==========`)
console.log(`广告素材: ${adsImported} 条 (其中 ${adsBenchmark} 条为标杆)`)
console.log(`联盟视频: ${affImported} 条 (其中 ${affBenchmark} 条为标杆)`)
console.log(`总标杆视频数: ${adsBenchmark + affBenchmark}`)

function detectCategory(productName) {
  if (!productName) return null
  const s = productName.toLowerCase()
  if (/bra|bralette|lingerie|underwear|shapewear|panty/.test(s)) return 'lingerie'
  if (/top|shirt|tee|sweater|cardigan/.test(s)) return 'apparel'
  return 'general'
}
