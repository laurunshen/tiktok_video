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

console.log(`[DB] SQLite 已初始化: ${DB_PATH}`)

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
      is_same_product, duration, resolution, batch_count, user_description,
      created_at, started_at, completed_at,
      gemini_pass1_ms, gemini_pass2_ms, gemini_review_ms, seedance_ms, total_ms,
      error_message, full_data
    ) VALUES (
      @job_id, @status, @step, @step_label,
      @product_id, @reference_video_url, @reference_video_author, @category,
      @is_same_product, @duration, @resolution, @batch_count, @user_description,
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

export function listJobs({ limit = 50, offset = 0, status = null } = {}) {
  let query = 'SELECT job_id, status, step_label, product_id, category, created_at, completed_at, total_ms, error_message FROM jobs'
  const params = []
  if (status) {
    query += ' WHERE status = ?'
    params.push(status)
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  return db.prepare(query).all(...params)
}

export function countJobs(status = null) {
  if (status) {
    return db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE status = ?').get(status).c
  }
  return db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c
}

// ===== Video 操作 =====

export function saveVideo(video) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO videos (
      video_id, job_id, video_url, prompt, compressed_script,
      product_visual_features, selected_image_indices, selected_image_urls, dominant_color,
      review_score, review_pass, review_issues, revision_count,
      created_at
    ) VALUES (
      @video_id, @job_id, @video_url, @prompt, @compressed_script,
      @product_visual_features, @selected_image_indices, @selected_image_urls, @dominant_color,
      @review_score, @review_pass, @review_issues, @revision_count,
      @created_at
    )
  `)

  stmt.run({
    video_id: video.videoId,
    job_id: video.jobId,
    video_url: video.videoUrl ?? null,
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
    created_at: Date.now(),
  })
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

export function getProductCache(productId, maxAgeMs = 24 * 3600 * 1000) {
  const row = db.prepare('SELECT product_info, last_used_at FROM products WHERE product_id = ?').get(productId)
  if (!row) return null
  if (Date.now() - row.last_used_at > maxAgeMs) return null  // 过期
  return JSON.parse(row.product_info)
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
