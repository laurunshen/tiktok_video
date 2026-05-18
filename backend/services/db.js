// SQLite 持久化层
// 4 张表：jobs（任务）/ videos（生成的视频）/ products（商品缓存）/ reference_videos（标杆参考视频库）
// 用 better-sqlite3（同步 API，C 实现，性能强）

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')      // 提升并发读写性能
db.pragma('foreign_keys = ON')

// ===== 建表 =====
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                -- processing / pending / completed / failed
    step INTEGER,
    step_label TEXT,

    product_id TEXT,
    reference_video_url TEXT,
    reference_video_author TEXT,
    category TEXT,                       -- lingerie / general
    is_same_product INTEGER,
    duration INTEGER,
    resolution TEXT,
    batch_count INTEGER,
    user_description TEXT,
    variant_seed INTEGER,                -- 1-5 = 同一标杆的裂变配方编号；NULL = 未指定

    -- 时间统计（毫秒）
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    gemini_pass1_ms INTEGER,
    gemini_pass2_ms INTEGER,
    gemini_review_ms INTEGER,
    seedance_ms INTEGER,
    total_ms INTEGER,

    error_message TEXT,

    -- 完整 job 数据 JSON（保留旧 jobStore 的所有字段方便迁移）
    full_data TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_product_id ON jobs(product_id);

  CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY,           -- Seedance taskId
    job_id TEXT,
    video_url TEXT,
    prompt TEXT,                         -- 实际发给 Seedance 的完整 prompt
    compressed_script TEXT,

    product_visual_features TEXT,        -- JSON
    selected_image_indices TEXT,         -- JSON array
    selected_image_urls TEXT,            -- JSON array
    dominant_color TEXT,

    review_score INTEGER,
    review_pass INTEGER,                 -- 0/1
    review_issues TEXT,                  -- JSON
    revision_count INTEGER DEFAULT 0,

    -- 用户反馈（前端实现后填）
    user_rating INTEGER,                 -- 1-5
    user_feedback TEXT,
    is_published INTEGER DEFAULT 0,
    tiktok_video_id TEXT,                -- 发布到 TikTok 后的视频 ID

    -- 投流数据（人工或脚本导入）
    ad_impressions INTEGER,
    ad_clicks INTEGER,
    ad_conversions INTEGER,
    ad_spend REAL,
    ad_revenue REAL,
    ctr REAL,
    cvr REAL,
    roas REAL,
    completion_rate REAL,
    ad_data_imported_at INTEGER,

    created_at INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(job_id)
  );

  CREATE INDEX IF NOT EXISTS idx_videos_job_id ON videos(job_id);
  CREATE INDEX IF NOT EXISTS idx_videos_roas ON videos(roas);

  CREATE TABLE IF NOT EXISTS products (
    product_id TEXT PRIMARY KEY,
    name TEXT,
    region TEXT,
    product_info TEXT,                   -- 完整 productInfo JSON
    main_image_urls TEXT,                -- JSON array
    detail_image_urls TEXT,              -- JSON array
    first_seen_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    job_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS reference_videos (
    -- 标杆参考视频库（投流数据 + 联盟数据导入而成）
    video_id TEXT PRIMARY KEY,           -- TikTok video_id
    video_url TEXT NOT NULL,
    author_username TEXT,
    title TEXT,

    product_id TEXT,                     -- 关联到具体 SKU（可空）
    product_name TEXT,
    category TEXT,                       -- lingerie / general / ...

    -- 投流表现指标
    roi REAL,                            -- ROI
    revenue REAL,                        -- 总收入
    cost REAL,                           -- 投放成本
    cvr REAL,                            -- 广告转化率
    play_2s_rate REAL,                   -- 2 秒播放率
    play_6s_rate REAL,                   -- 6 秒播放率（completion proxy）
    impressions INTEGER,                 -- 曝光
    clicks INTEGER,
    ctr REAL,

    -- 联盟数据
    affiliate_gmv REAL,
    affiliate_likes INTEGER,
    affiliate_comments INTEGER,

    source TEXT,                         -- 'ad' | 'affiliate' | 'manual'
    is_benchmark INTEGER DEFAULT 0,     -- 是否被标记为"标杆"（推荐给用户作参考视频）
    benchmark_reason TEXT,               -- 标记理由

    imported_at INTEGER NOT NULL,
    raw_data TEXT                        -- 原始数据 JSON（备份）
  );

  CREATE INDEX IF NOT EXISTS idx_refvids_product_id ON reference_videos(product_id);
  CREATE INDEX IF NOT EXISTS idx_refvids_roi ON reference_videos(roi);
  CREATE INDEX IF NOT EXISTS idx_refvids_benchmark ON reference_videos(is_benchmark);
`)

// 平滑升级：旧库可能没有新字段，加上忽略错误
try { db.exec('ALTER TABLE jobs ADD COLUMN variant_seed INTEGER') } catch {}
// 视频后评分（Gemini 看完生成视频后给出的多维度评分）
try { db.exec('ALTER TABLE videos ADD COLUMN video_judge_overall REAL') } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN video_judge_scores TEXT') } catch {}    // JSON of per-dim scores
try { db.exec('ALTER TABLE videos ADD COLUMN video_judge_issues TEXT') } catch {}    // JSON array
try { db.exec('ALTER TABLE videos ADD COLUMN video_judge_verdict TEXT') } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN diff_judge_overall REAL') } catch {}    // 与标杆视频的差异化评分
try { db.exec('ALTER TABLE videos ADD COLUMN diff_judge_scores TEXT') } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN diff_judge_verdict TEXT') } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN narrative_dna TEXT') } catch {}        // Pass 1 提取的 narrative_dna JSON
try { db.exec('ALTER TABLE videos ADD COLUMN poster_url TEXT') } catch {}            // 首帧缩略图 JPG（历史页轻量预览，省 100× 流量）
try { db.exec('ALTER TABLE products ADD COLUMN user_image_urls TEXT') } catch {}    // 用户手动上传的稳定 kie.ai 图 URL（JSON array）
try { db.exec('ALTER TABLE products ADD COLUMN is_curated INTEGER DEFAULT 0') } catch {}  // 1 = 用户已加图，缓存不再 24h 过期
try { db.exec('ALTER TABLE products ADD COLUMN main_image_colors TEXT') } catch {}   // 与 main_image_urls 同序的 color JSON array，空串=未标
try { db.exec('ALTER TABLE products ADD COLUMN detail_image_colors TEXT') } catch {} // 同上，对应 detail_image_urls
try { db.exec('ALTER TABLE products ADD COLUMN user_image_colors TEXT') } catch {}   // 同上，对应 user_image_urls

console.log(`[DB] SQLite 已初始化: ${DB_PATH}`)

// 启动时清理僵尸 job：
//  - status='processing'（Pass1/2/评估/修订阶段）= 纯 in-process 状态，重启后无人接管 → 标 failed
//  - status='pending'（已进 Seedance 队列）= kie.ai 远端任务还在跑，job.tasks[].taskId 已持久化在 full_data，
//    /status 轮询会自动 getJob→重新轮询 kie.ai 恢复 → 保留，不要杀
try {
  const zombieResult = db.prepare(`UPDATE jobs SET
    status = 'failed',
    error_message = COALESCE(error_message, 'backend 重启时进程被杀，job 未恢复（zombie cleanup on boot）')
    WHERE status = 'processing'
  `).run()
  if (zombieResult.changes > 0) {
    console.log(`[DB] 清理 ${zombieResult.changes} 条僵尸 job（status=processing，重启后不可恢复）`)
  }
  const pendingCount = db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'pending'`).get().c
  if (pendingCount > 0) {
    console.log(`[DB] 保留 ${pendingCount} 条 pending job（Seedance 远端仍在跑，/status 轮询会自动接管）`)
  }
} catch (e) {
  console.warn(`[DB] 僵尸 job 清理失败（不阻塞启动）: ${e.message}`)
}

// ===== Job 操作 =====

/**
 * 用 INSERT OR REPLACE 整体写入/更新 job
 * @param {Object} job - 完整 job 对象（兼容旧 jobStore 结构）
 */
export function saveJob(job) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO jobs (
      job_id, status, step, step_label,
      product_id, reference_video_url, reference_video_author, category,
      is_same_product, duration, resolution, batch_count, user_description, variant_seed,
      created_at, started_at, completed_at,
      gemini_pass1_ms, gemini_pass2_ms, gemini_review_ms, seedance_ms, total_ms,
      error_message, full_data
    ) VALUES (
      @job_id, @status, @step, @step_label,
      @product_id, @reference_video_url, @reference_video_author, @category,
      @is_same_product, @duration, @resolution, @batch_count, @user_description, @variant_seed,
      @created_at, @started_at, @completed_at,
      @gemini_pass1_ms, @gemini_pass2_ms, @gemini_review_ms, @seedance_ms, @total_ms,
      @error_message, @full_data
    )
  `)

  stmt.run({
    job_id: job.jobId,
    status: job.status || 'processing',
    step: job.step ?? null,
    step_label: job.stepLabel ?? null,
    product_id: job.productId ?? null,
    reference_video_url: job.referenceVideoUrl ?? null,
    reference_video_author: job.referenceVideoAuthor ?? null,
    category: job.category ?? null,
    is_same_product: job.isSameProduct == null ? null : (job.isSameProduct ? 1 : 0),
    duration: job.duration ?? null,
    resolution: job.resolution ?? null,
    batch_count: job.batchCount ?? null,
    user_description: job.userDescription ?? null,
    variant_seed: job.variantSeed ?? null,
    created_at: job.createdAt ? new Date(job.createdAt).getTime() : Date.now(),
    started_at: job.startedAt ?? null,
    completed_at: job.completedAt ?? null,
    gemini_pass1_ms: job.geminiPass1Ms ?? null,
    gemini_pass2_ms: job.geminiPass2Ms ?? null,
    gemini_review_ms: job.geminiReviewMs ?? null,
    seedance_ms: job.seedanceMs ?? null,
    total_ms: job.totalMs ?? null,
    error_message: job.error ?? null,
    full_data: JSON.stringify(job),
  })
}

export function getJob(jobId) {
  const row = db.prepare('SELECT full_data FROM jobs WHERE job_id = ?').get(jobId)
  return row ? JSON.parse(row.full_data) : null
}

export function listJobs({ limit = 50, offset = 0, status = null, sortBy = 'time', published = false, unpublished = false } = {}) {
  const baseCols = 'j.job_id, j.status, j.step_label, j.product_id, j.category, j.created_at, j.completed_at, j.total_ms, j.error_message'
  const params = []
  const needJoin = sortBy === 'quality'
  let query = `SELECT ${needJoin ? `${baseCols}, MAX(v.video_judge_overall) AS _max_score` : baseCols} FROM jobs j`
  if (needJoin) query += ' LEFT JOIN videos v ON v.job_id = j.job_id'
  const wheres = []
  if (status) { wheres.push('j.status = ?'); params.push(status) }
  if (published) wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = j.job_id AND vp.is_published = 1)')
  // unpublished = 至少有一个视频 + 没有任何已发布的视频（"完成了但没发"的语义）
  if (unpublished) {
    wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = j.job_id)')
    wheres.push('NOT EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = j.job_id AND vp.is_published = 1)')
  }
  if (wheres.length) query += ' WHERE ' + wheres.join(' AND ')
  if (needJoin) query += ' GROUP BY j.job_id'
  if (sortBy === 'quality') {
    query += ' ORDER BY (_max_score IS NULL), _max_score DESC, j.created_at DESC'
  } else {
    query += ' ORDER BY j.created_at DESC'
  }
  query += ' LIMIT ? OFFSET ?'
  params.push(limit, offset)
  return db.prepare(query).all(...params)
}

export function countJobs(status = null, published = false, unpublished = false) {
  const params = []
  const wheres = []
  if (status) { wheres.push('status = ?'); params.push(status) }
  if (published) wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id AND vp.is_published = 1)')
  if (unpublished) {
    wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id)')
    wheres.push('NOT EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id AND vp.is_published = 1)')
  }
  let q = 'SELECT COUNT(*) AS c FROM jobs'
  if (wheres.length) q += ' WHERE ' + wheres.join(' AND ')
  return db.prepare(q).get(...params).c
}

// ===== Video 操作 =====

export function saveVideo(video) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO videos (
      video_id, job_id, video_url, poster_url, prompt, compressed_script,
      product_visual_features, selected_image_indices, selected_image_urls, dominant_color,
      review_score, review_pass, review_issues, revision_count,
      narrative_dna,
      created_at
    ) VALUES (
      @video_id, @job_id, @video_url, @poster_url, @prompt, @compressed_script,
      @product_visual_features, @selected_image_indices, @selected_image_urls, @dominant_color,
      @review_score, @review_pass, @review_issues, @revision_count,
      @narrative_dna,
      @created_at
    )
  `)

  stmt.run({
    video_id: video.videoId,
    job_id: video.jobId,
    video_url: video.videoUrl ?? null,
    poster_url: video.posterUrl ?? null,
    prompt: video.prompt ?? null,
    compressed_script: video.compressedScript ?? null,
    product_visual_features: video.productVisualFeatures ? JSON.stringify(video.productVisualFeatures) : null,
    selected_image_indices: video.selectedImageIndices ? JSON.stringify(video.selectedImageIndices) : null,
    selected_image_urls: video.selectedImageUrls ? JSON.stringify(video.selectedImageUrls) : null,
    dominant_color: video.dominantColor ?? null,
    review_score: video.reviewScore ?? null,
    review_pass: video.reviewPass == null ? null : (video.reviewPass ? 1 : 0),
    review_issues: video.reviewIssues ? JSON.stringify(video.reviewIssues) : null,
    revision_count: video.revisionCount ?? 0,
    narrative_dna: video.narrativeDna ? JSON.stringify(video.narrativeDna) : null,
    created_at: Date.now(),
  })
}

// 更新 poster_url（backfill / 后置生成场景）
export function updateVideoPosterUrl(videoId, posterUrl) {
  return db.prepare('UPDATE videos SET poster_url = ? WHERE video_id = ?').run(posterUrl, videoId).changes > 0
}

// 视频生成完成后，更新 video judge 评分（异步调用 Gemini 后写入）
// reference_match_notes 合并进 scores JSON 一起持久化（避免新加 DB 列）
export function updateVideoJudge(videoId, judge) {
  if (!judge) return
  const scoresWithExtras = judge.scores ? {
    ...judge.scores,
    ...(judge.reference_match_notes ? { reference_match_notes: judge.reference_match_notes } : {}),
    ...(judge.what_worked ? { what_worked: judge.what_worked } : {}),
  } : null
  db.prepare(`UPDATE videos SET
    video_judge_overall = ?, video_judge_scores = ?, video_judge_issues = ?, video_judge_verdict = ?
    WHERE video_id = ?`).run(
    judge.overall ?? null,
    scoresWithExtras ? JSON.stringify(scoresWithExtras) : null,
    judge.top_issues ? JSON.stringify(judge.top_issues) : null,
    judge.verdict ?? null,
    videoId,
  )
}

// 与标杆视频的差异化评分
export function updateVideoDiffJudge(videoId, diffJudge) {
  if (!diffJudge) return
  db.prepare(`UPDATE videos SET
    diff_judge_overall = ?, diff_judge_scores = ?, diff_judge_verdict = ?
    WHERE video_id = ?`).run(
    diffJudge.overall_differentiation ?? null,
    diffJudge.scores ? JSON.stringify(diffJudge.scores) : null,
    diffJudge.verdict ?? null,
    videoId,
  )
}

// 直接读取一条视频（含所有 judge 字段）
export function getVideo(videoId) {
  return db.prepare('SELECT * FROM videos WHERE video_id = ?').get(videoId)
}

// 读一个 job 的所有 videos
export function getVideosByJob(jobId) {
  return db.prepare('SELECT * FROM videos WHERE job_id = ? ORDER BY created_at').all(jobId)
}

// ===== Product 缓存 =====

export function saveProduct(productId, region, productInfo) {
  const now = Date.now()
  const exists = db.prepare('SELECT 1 FROM products WHERE product_id = ?').get(productId)
  if (exists) {
    db.prepare(`
      UPDATE products SET
        product_info = ?, main_image_urls = ?, detail_image_urls = ?,
        last_used_at = ?, job_count = job_count + 1
      WHERE product_id = ?
    `).run(
      JSON.stringify(productInfo),
      JSON.stringify(productInfo.mainImageUrls || []),
      JSON.stringify(productInfo.detailImageUrls || []),
      now,
      productId,
    )
  } else {
    db.prepare(`
      INSERT INTO products (
        product_id, name, region, product_info,
        main_image_urls, detail_image_urls,
        first_seen_at, last_used_at, job_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      productId,
      productInfo.name || null,
      region || null,
      JSON.stringify(productInfo),
      JSON.stringify(productInfo.mainImageUrls || []),
      JSON.stringify(productInfo.detailImageUrls || []),
      now, now, 1,
    )
  }
}

// 把一个 url 数组按 colorFilter 过滤，保留 colors 中匹配的索引位置（case-insensitive）
function filterUrlsByColor(urls, colors, colorFilter) {
  if (!colorFilter) return urls
  const target = String(colorFilter).trim().toLowerCase()
  const result = []
  for (let i = 0; i < urls.length; i++) {
    const c = (colors[i] || '').trim().toLowerCase()
    if (c === target) result.push(urls[i])
  }
  return result
}

// 把 urls 数组和 colors 数组对齐（如果 colors 比 urls 短，用空串补齐；长则截断）
function alignColors(urls, colors) {
  const out = new Array(urls.length).fill('')
  if (!Array.isArray(colors)) return out
  for (let i = 0; i < urls.length && i < colors.length; i++) {
    out[i] = String(colors[i] || '')
  }
  return out
}

export function getProductCache(productId, maxAgeMs = 24 * 3600 * 1000, colorFilter = null) {
  const row = db.prepare(`
    SELECT product_info, last_used_at, main_image_urls, detail_image_urls, user_image_urls,
           main_image_colors, detail_image_colors, user_image_colors, is_curated
    FROM products WHERE product_id = ?
  `).get(productId)
  if (!row) return null
  // curated 产品（用户已加图）不再过期；其他走 24h 检查
  if (!row.is_curated && Date.now() - row.last_used_at > maxAgeMs) return null
  const productInfo = JSON.parse(row.product_info)
  const mainUrls = row.main_image_urls ? JSON.parse(row.main_image_urls) : []
  const detailUrls = row.detail_image_urls ? JSON.parse(row.detail_image_urls) : []
  const userUrls = row.user_image_urls ? JSON.parse(row.user_image_urls) : []
  const mainColors = alignColors(mainUrls, row.main_image_colors ? JSON.parse(row.main_image_colors) : [])
  const detailColors = alignColors(detailUrls, row.detail_image_colors ? JSON.parse(row.detail_image_colors) : [])
  const userColors = alignColors(userUrls, row.user_image_colors ? JSON.parse(row.user_image_colors) : [])

  // colorFilter 模式：覆盖 productInfo 里的 url 数组，只留匹配色的图（user 图并入 detail 池）
  if (colorFilter) {
    productInfo.mainImageUrls = filterUrlsByColor(mainUrls, mainColors, colorFilter)
    const filteredDetail = filterUrlsByColor(detailUrls, detailColors, colorFilter)
    const filteredUser = filterUrlsByColor(userUrls, userColors, colorFilter)
    productInfo.detailImageUrls = [...filteredDetail, ...filteredUser]
  } else {
    // 不过滤：保留 productInfo 自身的 url 数组（与原行为一致），把用户图合并进 detail
    if (userUrls.length > 0) {
      productInfo.detailImageUrls = [...(productInfo.detailImageUrls || []), ...userUrls]
    }
  }
  return productInfo
}

// 把 colors 数组算成 {color: count, '': untaggedCount}
function summarizeColors(...colorArrays) {
  const counts = {}
  for (const arr of colorArrays) {
    for (const c of (arr || [])) {
      const key = (c || '').trim()
      counts[key] = (counts[key] || 0) + 1
    }
  }
  return counts
}

// 列出所有缓存产品（管理页用）。按 last_used_at DESC 排
export function listProducts({ limit = 200, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT product_id, name, region, main_image_urls, detail_image_urls, user_image_urls,
           main_image_colors, detail_image_colors, user_image_colors,
           is_curated, job_count, first_seen_at, last_used_at
    FROM products
    ORDER BY last_used_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset)
  return rows.map(r => {
    const main = r.main_image_urls ? JSON.parse(r.main_image_urls) : []
    const detail = r.detail_image_urls ? JSON.parse(r.detail_image_urls) : []
    const user = r.user_image_urls ? JSON.parse(r.user_image_urls) : []
    const mainColors = alignColors(main, r.main_image_colors ? JSON.parse(r.main_image_colors) : [])
    const detailColors = alignColors(detail, r.detail_image_colors ? JSON.parse(r.detail_image_colors) : [])
    const userColors = alignColors(user, r.user_image_colors ? JSON.parse(r.user_image_colors) : [])
    return {
      productId: r.product_id,
      name: r.name,
      region: r.region,
      coverImageUrl: main[0] || detail[0] || user[0] || null,  // 列表卡片用
      mainImageCount: main.length,
      detailImageCount: detail.length,
      userImageCount: user.length,
      colorCounts: summarizeColors(mainColors, detailColors, userColors),
      isCurated: !!r.is_curated,
      jobCount: r.job_count,
      firstSeenAt: r.first_seen_at,
      lastUsedAt: r.last_used_at,
    }
  })
}

// 取单个产品的完整信息（管理页详情用，user_image_urls 单独返回不合并）
export function getProductFull(productId) {
  const row = db.prepare(`
    SELECT product_id, name, region, product_info, main_image_urls, detail_image_urls,
           user_image_urls, main_image_colors, detail_image_colors, user_image_colors,
           is_curated, job_count, first_seen_at, last_used_at
    FROM products WHERE product_id = ?
  `).get(productId)
  if (!row) return null
  const mainUrls = row.main_image_urls ? JSON.parse(row.main_image_urls) : []
  const detailUrls = row.detail_image_urls ? JSON.parse(row.detail_image_urls) : []
  const userUrls = row.user_image_urls ? JSON.parse(row.user_image_urls) : []
  return {
    productId: row.product_id,
    name: row.name,
    region: row.region,
    productInfo: row.product_info ? JSON.parse(row.product_info) : null,
    mainImageUrls: mainUrls,
    detailImageUrls: detailUrls,
    userImageUrls: userUrls,
    mainImageColors: alignColors(mainUrls, row.main_image_colors ? JSON.parse(row.main_image_colors) : []),
    detailImageColors: alignColors(detailUrls, row.detail_image_colors ? JSON.parse(row.detail_image_colors) : []),
    userImageColors: alignColors(userUrls, row.user_image_colors ? JSON.parse(row.user_image_colors) : []),
    isCurated: !!row.is_curated,
    jobCount: row.job_count,
    firstSeenAt: row.first_seen_at,
    lastUsedAt: row.last_used_at,
  }
}

// 整体覆写 user_image_urls + user_image_colors（保持对齐），自动 is_curated=1
export function updateProductImages(productId, userImageUrls, userImageColors = null) {
  const urls = userImageUrls || []
  const colors = alignColors(urls, userImageColors || [])
  const result = db.prepare(`
    UPDATE products SET
      user_image_urls = ?, user_image_colors = ?, is_curated = 1, last_used_at = ?
    WHERE product_id = ?
  `).run(JSON.stringify(urls), JSON.stringify(colors), Date.now(), productId)
  return result.changes > 0
}

// 找单张图所在的 (section, index)，section ∈ {'main','detail','user'}
// 返回 null 表示没找到
function findImageLocation(productId, url) {
  const row = db.prepare(
    'SELECT main_image_urls, detail_image_urls, user_image_urls FROM products WHERE product_id = ?'
  ).get(productId)
  if (!row) return null
  const sections = [
    { name: 'main', urls: row.main_image_urls ? JSON.parse(row.main_image_urls) : [] },
    { name: 'detail', urls: row.detail_image_urls ? JSON.parse(row.detail_image_urls) : [] },
    { name: 'user', urls: row.user_image_urls ? JSON.parse(row.user_image_urls) : [] },
  ]
  for (const s of sections) {
    const idx = s.urls.indexOf(url)
    if (idx >= 0) return { section: s.name, index: idx, urls: s.urls }
  }
  return null
}

// 设置某张图的颜色（自动定位在 main/detail/user 哪个数组）。返回是否成功
export function setImageColor(productId, url, color) {
  const loc = findImageLocation(productId, url)
  if (!loc) return false
  const colorCol = `${loc.section}_image_colors`
  const row = db.prepare(`SELECT ${colorCol} as c FROM products WHERE product_id = ?`).get(productId)
  const colors = alignColors(loc.urls, row.c ? JSON.parse(row.c) : [])
  colors[loc.index] = String(color || '').trim()
  db.prepare(`UPDATE products SET ${colorCol} = ?, last_used_at = ? WHERE product_id = ?`)
    .run(JSON.stringify(colors), Date.now(), productId)
  return true
}

// 批量打标：把所有传入 url 的颜色都设成同一个值。返回成功数
export function bulkSetImageColors(productId, urls, color) {
  let success = 0
  for (const url of urls || []) {
    if (setImageColor(productId, url, color)) success++
  }
  return success
}

export function renameProduct(productId, newName) {
  const result = db.prepare('UPDATE products SET name = ? WHERE product_id = ?').run(newName, productId)
  return result.changes > 0
}

// 更新某条视频的 video_url（migration / S3 替换 kie URL 用）
export function updateVideoUrl(videoId, newUrl) {
  const result = db.prepare('UPDATE videos SET video_url = ? WHERE video_id = ?').run(newUrl, videoId)
  return result.changes > 0
}

// 标记某条视频已发布到 TikTok。tiktokVideoId 可为空（仅标记 is_published）
export function markVideoPublished(videoId, tiktokVideoId, isPublished = true) {
  const result = db.prepare(`UPDATE videos SET
    is_published = ?, tiktok_video_id = ?
    WHERE video_id = ?
  `).run(isPublished ? 1 : 0, tiktokVideoId || null, videoId)
  return result.changes > 0
}

// 从产品的 product_info JSON 拿到 SKU 选项词表（用于约束 AI 打标）
// 默认取 variants 第一轴（一般是 Color）。返回 { axis, values }，没有 variants 时 values=[]
export function getProductSkuOptions(productId) {
  const row = db.prepare('SELECT product_info FROM products WHERE product_id = ?').get(productId)
  if (!row || !row.product_info) return { axis: null, values: [] }
  try {
    const info = JSON.parse(row.product_info)
    const first = (info.variants || [])[0]
    if (!first || !Array.isArray(first.values)) return { axis: null, values: [] }
    return { axis: first.name || null, values: first.values.filter(v => v && typeof v === 'string') }
  } catch {
    return { axis: null, values: [] }
  }
}

export function deleteProduct(productId) {
  const result = db.prepare('DELETE FROM products WHERE product_id = ?').run(productId)
  return result.changes > 0
}

// ===== Reference Video（标杆参考视频库）操作 =====

export function saveReferenceVideo(refVideo) {
  // Merge 策略：如果 video_id 已存在，只更新本次提供的非空字段
  // 这样广告数据和联盟数据可以叠加（广告先导入 → 联盟补充联盟字段，不覆盖 product_id/ROI 等）
  const existing = db.prepare('SELECT * FROM reference_videos WHERE video_id = ?').get(refVideo.video_id)

  const finalData = existing ? {
    video_id: refVideo.video_id,
    video_url: refVideo.video_url || existing.video_url,
    author_username: refVideo.author_username ?? existing.author_username,
    title: refVideo.title ?? existing.title,
    product_id: refVideo.product_id ?? existing.product_id,
    product_name: refVideo.product_name ?? existing.product_name,
    category: refVideo.category ?? existing.category,
    // 广告指标：优先保留已有值（广告先导入），否则用新值
    roi: existing.roi ?? refVideo.roi ?? null,
    revenue: existing.revenue ?? refVideo.revenue ?? null,
    cost: existing.cost ?? refVideo.cost ?? null,
    cvr: existing.cvr ?? refVideo.cvr ?? null,
    play_2s_rate: existing.play_2s_rate ?? refVideo.play_2s_rate ?? null,
    play_6s_rate: existing.play_6s_rate ?? refVideo.play_6s_rate ?? null,
    impressions: refVideo.impressions ?? existing.impressions ?? null,  // 联盟曝光数也有效，取新的
    clicks: refVideo.clicks ?? existing.clicks ?? null,
    ctr: refVideo.ctr ?? existing.ctr ?? null,
    // 联盟字段：以新值优先（联盟数据后导入）
    affiliate_gmv: refVideo.affiliate_gmv ?? existing.affiliate_gmv ?? null,
    affiliate_likes: refVideo.affiliate_likes ?? existing.affiliate_likes ?? null,
    affiliate_comments: refVideo.affiliate_comments ?? existing.affiliate_comments ?? null,
    // source: 标记为 both
    source: existing.source === refVideo.source ? existing.source : 'both',
    // is_benchmark: 任一来源是 benchmark 就标 1
    is_benchmark: (existing.is_benchmark || refVideo.is_benchmark) ? 1 : 0,
    benchmark_reason: [existing.benchmark_reason, refVideo.benchmark_reason].filter(Boolean).join(' | ') || null,
    imported_at: Date.now(),
    raw_data: existing.raw_data,  // 保留首次导入的 raw_data
  } : {
    video_id: refVideo.video_id,
    video_url: refVideo.video_url,
    author_username: refVideo.author_username ?? null,
    title: refVideo.title ?? null,
    product_id: refVideo.product_id ?? null,
    product_name: refVideo.product_name ?? null,
    category: refVideo.category ?? null,
    roi: refVideo.roi ?? null,
    revenue: refVideo.revenue ?? null,
    cost: refVideo.cost ?? null,
    cvr: refVideo.cvr ?? null,
    play_2s_rate: refVideo.play_2s_rate ?? null,
    play_6s_rate: refVideo.play_6s_rate ?? null,
    impressions: refVideo.impressions ?? null,
    clicks: refVideo.clicks ?? null,
    ctr: refVideo.ctr ?? null,
    affiliate_gmv: refVideo.affiliate_gmv ?? null,
    affiliate_likes: refVideo.affiliate_likes ?? null,
    affiliate_comments: refVideo.affiliate_comments ?? null,
    source: refVideo.source ?? 'manual',
    is_benchmark: refVideo.is_benchmark ? 1 : 0,
    benchmark_reason: refVideo.benchmark_reason ?? null,
    imported_at: Date.now(),
    raw_data: refVideo.raw_data ? JSON.stringify(refVideo.raw_data) : null,
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO reference_videos (
      video_id, video_url, author_username, title,
      product_id, product_name, category,
      roi, revenue, cost, cvr, play_2s_rate, play_6s_rate,
      impressions, clicks, ctr,
      affiliate_gmv, affiliate_likes, affiliate_comments,
      source, is_benchmark, benchmark_reason,
      imported_at, raw_data
    ) VALUES (
      @video_id, @video_url, @author_username, @title,
      @product_id, @product_name, @category,
      @roi, @revenue, @cost, @cvr, @play_2s_rate, @play_6s_rate,
      @impressions, @clicks, @ctr,
      @affiliate_gmv, @affiliate_likes, @affiliate_comments,
      @source, @is_benchmark, @benchmark_reason,
      @imported_at, @raw_data
    )
  `)
  stmt.run(finalData)
}

/**
 * 查询某个商品的标杆参考视频（按 ROI 降序）
 */
export function listBenchmarkVideos({ productId = null, category = null, limit = 10 } = {}) {
  let query = 'SELECT * FROM reference_videos WHERE is_benchmark = 1'
  const params = []
  if (productId) {
    query += ' AND product_id = ?'
    params.push(productId)
  }
  if (category) {
    query += ' AND category = ?'
    params.push(category)
  }
  query += ' ORDER BY roi DESC LIMIT ?'
  params.push(limit)
  return db.prepare(query).all(...params)
}

// 自动清理 30 天前的失败任务（避免数据库无限膨胀）
export function pruneOldFailedJobs(daysAgo = 30) {
  const cutoff = Date.now() - daysAgo * 24 * 3600 * 1000
  const result = db.prepare("DELETE FROM jobs WHERE status = 'failed' AND created_at < ?").run(cutoff)
  if (result.changes > 0) {
    console.log(`[DB] 清理了 ${result.changes} 条 ${daysAgo} 天前的失败任务`)
  }
}

export default db
