// PostgreSQL 持久化层（AWS RDS）
// 4 张表：jobs（任务）/ videos（生成的视频）/ products（商品缓存）/ reference_videos（标杆参考视频库）
// 用 pg（异步 API）替代 better-sqlite3（同步）

import pg from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// SSL 证书（AWS RDS 要求）
let sslConfig
try {
  const certPath = join(__dirname, '..', 'global-bundle.pem')
  sslConfig = { ca: readFileSync(certPath).toString(), rejectUnauthorized: true }
} catch {
  // cert 文件缺失时 fallback（本地开发不走 RDS 的情况）
  sslConfig = { rejectUnauthorized: false }
}

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: sslConfig,
  max: 10,             // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
})

pool.on('error', (err) => {
  console.error('[DB] pg pool error:', err.message)
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function isTransientDbError(err) {
  const message = err?.message || ''
  const code = err?.code || ''
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === '57P01' ||
    /Connection terminated|timeout|ECONNRESET|ETIMEDOUT|connection/i.test(message)
  )
}

async function queryWithTransientRetry(sql, params, { label = 'query', attempts = 3 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await pool.query(sql, params)
    } catch (err) {
      lastError = err
      const shouldRetry = attempt < attempts - 1 && isTransientDbError(err)
      if (!shouldRetry) throw err

      const delayMs = 500 * (attempt + 1)
      console.warn(`[DB] ${label} transient error, retry ${attempt + 1}/${attempts - 1} after ${delayMs}ms: ${err.message}`)
      await sleep(delayMs)
    }
  }
  throw lastError
}

// ===== 初始化（建表 + 迁移 + 清僵尸）=====
// server.js 启动时 await initDb()
export async function initDb() {
  const client = await pool.connect()
  try {
    // --- jobs 表 ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        step INTEGER,
        step_label TEXT,
        product_id TEXT,
        reference_video_url TEXT,
        reference_video_author TEXT,
        category TEXT,
        is_same_product INTEGER,
        duration INTEGER,
        resolution TEXT,
        batch_count INTEGER,
        user_description TEXT,
        variant_seed INTEGER,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        completed_at BIGINT,
        gemini_pass1_ms INTEGER,
        gemini_pass2_ms INTEGER,
        gemini_review_ms INTEGER,
        seedance_ms INTEGER,
        total_ms INTEGER,
        error_message TEXT,
        full_data TEXT
      )
    `)
    await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_jobs_product_id ON jobs(product_id)')

    // --- videos 表 ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS videos (
        video_id TEXT PRIMARY KEY,
        job_id TEXT,
        video_url TEXT,
        prompt TEXT,
        compressed_script TEXT,
        product_visual_features TEXT,
        selected_image_indices TEXT,
        selected_image_urls TEXT,
        dominant_color TEXT,
        review_score INTEGER,
        review_pass INTEGER,
        review_issues TEXT,
        revision_count INTEGER DEFAULT 0,
        user_rating INTEGER,
        user_feedback TEXT,
        is_published INTEGER DEFAULT 0,
        tiktok_video_id TEXT,
        ad_impressions INTEGER,
        ad_clicks INTEGER,
        ad_conversions INTEGER,
        ad_spend DOUBLE PRECISION,
        ad_revenue DOUBLE PRECISION,
        ctr DOUBLE PRECISION,
        cvr DOUBLE PRECISION,
        roas DOUBLE PRECISION,
        completion_rate DOUBLE PRECISION,
        ad_data_imported_at BIGINT,
        created_at BIGINT NOT NULL
      )
    `)
    await client.query('CREATE INDEX IF NOT EXISTS idx_videos_job_id ON videos(job_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_videos_roas ON videos(roas)')

    // --- products 表 ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY,
        name TEXT,
        region TEXT,
        product_info TEXT,
        main_image_urls TEXT,
        detail_image_urls TEXT,
        first_seen_at BIGINT NOT NULL,
        last_used_at BIGINT NOT NULL,
        job_count INTEGER DEFAULT 0
      )
    `)

    // --- reference_videos 表 ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS reference_videos (
        video_id TEXT PRIMARY KEY,
        video_url TEXT NOT NULL,
        author_username TEXT,
        title TEXT,
        product_id TEXT,
        product_name TEXT,
        category TEXT,
        roi DOUBLE PRECISION,
        revenue DOUBLE PRECISION,
        cost DOUBLE PRECISION,
        cvr DOUBLE PRECISION,
        play_2s_rate DOUBLE PRECISION,
        play_6s_rate DOUBLE PRECISION,
        impressions INTEGER,
        clicks INTEGER,
        ctr DOUBLE PRECISION,
        affiliate_gmv DOUBLE PRECISION,
        affiliate_likes INTEGER,
        affiliate_comments INTEGER,
        published_at TEXT,
        affiliate_orders INTEGER,
        affiliate_aov DOUBLE PRECISION,
        affiliate_commission DOUBLE PRECISION,
        affiliate_fixed_fee TEXT,
        affiliate_rpm DOUBLE PRECISION,
        affiliate_refund_count INTEGER,
        affiliate_refund_gmv DOUBLE PRECISION,
        source TEXT,
        is_benchmark INTEGER DEFAULT 0,
        benchmark_reason TEXT,
        imported_at BIGINT NOT NULL,
        raw_data TEXT
      )
    `)
    await client.query('CREATE INDEX IF NOT EXISTS idx_refvids_product_id ON reference_videos(product_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_refvids_roi ON reference_videos(roi)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_refvids_benchmark ON reference_videos(is_benchmark)')

    // --- my_templates 表 ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS my_templates (
        id SERIAL PRIMARY KEY,
        video_url TEXT NOT NULL,
        tiktok_video_id TEXT,
        job_id TEXT,
        prompt TEXT,
        review_scores TEXT,
        views INTEGER,
        orders INTEGER,
        ctr DOUBLE PRECISION,
        notes TEXT,
        created_at BIGINT
      )
    `)

    // --- 平滑升级：新列 ---
    const addCol = async (table, col, type) => {
      try { await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`) } catch {}
    }
    await addCol('jobs', 'variant_seed', 'INTEGER')
    await addCol('videos', 'video_judge_overall', 'DOUBLE PRECISION')
    await addCol('videos', 'video_judge_scores', 'TEXT')
    await addCol('videos', 'video_judge_issues', 'TEXT')
    await addCol('videos', 'video_judge_verdict', 'TEXT')
    await addCol('videos', 'diff_judge_overall', 'DOUBLE PRECISION')
    await addCol('videos', 'diff_judge_scores', 'TEXT')
    await addCol('videos', 'diff_judge_verdict', 'TEXT')
    await addCol('videos', 'narrative_dna', 'TEXT')
    await addCol('videos', 'poster_url', 'TEXT')
    await addCol('products', 'user_image_urls', 'TEXT')
    await addCol('products', 'is_curated', 'INTEGER DEFAULT 0')
    await addCol('products', 'main_image_colors', 'TEXT')
    await addCol('products', 'detail_image_colors', 'TEXT')
    await addCol('products', 'user_image_colors', 'TEXT')
    await addCol('products', 'main_image_thumb_urls', 'TEXT')
    await addCol('products', 'detail_image_thumb_urls', 'TEXT')
    await addCol('products', 'user_image_thumb_urls', 'TEXT')
    // reference_videos 新增联盟数据列
    await addCol('reference_videos', 'published_at', 'TEXT')
    await addCol('reference_videos', 'affiliate_orders', 'INTEGER')
    await addCol('reference_videos', 'affiliate_aov', 'DOUBLE PRECISION')
    await addCol('reference_videos', 'affiliate_commission', 'DOUBLE PRECISION')
    await addCol('reference_videos', 'affiliate_fixed_fee', 'TEXT')
    await addCol('reference_videos', 'affiliate_rpm', 'DOUBLE PRECISION')
    await addCol('reference_videos', 'affiliate_refund_count', 'INTEGER')
    await addCol('reference_videos', 'affiliate_refund_gmv', 'DOUBLE PRECISION')

    // --- 恢复/清理重启前的 job ---
    // single_pass 在 Seedance taskId 创建后可以靠轮询接管；不要在启动时误杀。
    const resumable = await client.query(`
      UPDATE jobs SET
        status = 'pending',
        step = 3,
        step_label = 'Seedance 生成中（后端重启后恢复轮询）'
      WHERE status = 'processing'
        AND COALESCE(full_data::jsonb->>'generationMode', 'single_pass') <> 'agentic_segments'
        AND jsonb_typeof(full_data::jsonb->'tasks') = 'array'
        AND jsonb_array_length(full_data::jsonb->'tasks') > 0
    `)
    if (resumable.rowCount > 0) {
      console.log(`[DB] 恢复 ${resumable.rowCount} 条已创建 Seedance task 的 job（processing → pending）`)
    }

    // 其余 processing 多半卡在 Gemini/上传/ffmpeg 等进程内阶段，HTTP 调用已随进程消失，无法原地恢复。
    const zombie = await client.query(`
      UPDATE jobs SET
        status = 'failed',
        error_message = COALESCE(error_message, 'backend 重启时进程被杀，job 未恢复（zombie cleanup on boot）')
      WHERE status = 'processing'
    `)
    if (zombie.rowCount > 0) {
      console.log(`[DB] 清理 ${zombie.rowCount} 条僵尸 job（status=processing）`)
    }
    const pending = await client.query(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'pending'`)
    const pendingCount = parseInt(pending.rows[0].c, 10)
    if (pendingCount > 0) {
      console.log(`[DB] 保留 ${pendingCount} 条 pending job（Seedance 远端仍在跑，/status 轮询会自动接管）`)
    }

    console.log('[DB] PostgreSQL 已初始化（AWS RDS）')
  } finally {
    client.release()
  }
}

// ===== Job 操作 =====

export async function saveJob(job) {
  const vals = {
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
  }

  const sql = `
    INSERT INTO jobs (
      job_id, status, step, step_label,
      product_id, reference_video_url, reference_video_author, category,
      is_same_product, duration, resolution, batch_count, user_description, variant_seed,
      created_at, started_at, completed_at,
      gemini_pass1_ms, gemini_pass2_ms, gemini_review_ms, seedance_ms, total_ms,
      error_message, full_data
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
      $15,$16,$17,$18,$19,$20,$21,$22,$23,$24
    )
    ON CONFLICT (job_id) DO UPDATE SET
      status=$2, step=$3, step_label=$4,
      product_id=$5, reference_video_url=$6, reference_video_author=$7, category=$8,
      is_same_product=$9, duration=$10, resolution=$11, batch_count=$12,
      user_description=$13, variant_seed=$14,
      created_at=$15, started_at=$16, completed_at=$17,
      gemini_pass1_ms=$18, gemini_pass2_ms=$19, gemini_review_ms=$20,
      seedance_ms=$21, total_ms=$22,
      error_message=$23, full_data=$24
  `
  const params = [
    vals.job_id, vals.status, vals.step, vals.step_label,
    vals.product_id, vals.reference_video_url, vals.reference_video_author, vals.category,
    vals.is_same_product, vals.duration, vals.resolution, vals.batch_count,
    vals.user_description, vals.variant_seed,
    vals.created_at, vals.started_at, vals.completed_at,
    vals.gemini_pass1_ms, vals.gemini_pass2_ms, vals.gemini_review_ms,
    vals.seedance_ms, vals.total_ms,
    vals.error_message, vals.full_data,
  ]

  await queryWithTransientRetry(sql, params, { label: 'saveJob' })
}

function hydrateJobRow(row) {
  if (!row) return null
  const job = JSON.parse(row.full_data)
  job.status = row.status ?? job.status
  job.step = row.step ?? job.step
  job.stepLabel = row.step_label ?? job.stepLabel
  job.error = row.error_message ?? job.error
  return job
}

export async function getJob(jobId) {
  const { rows } = await pool.query(
    'SELECT status, step, step_label, error_message, full_data FROM jobs WHERE job_id = $1',
    [jobId]
  )
  return hydrateJobRow(rows[0])
}

export async function listRecoverableJobs({ limit = 20 } = {}) {
  const { rows } = await pool.query(`
    SELECT status, step, step_label, error_message, full_data
    FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1
  `, [limit])
  return rows.map(hydrateJobRow).filter(job => {
    const mode = job.generationMode || 'single_pass'
    return mode !== 'agentic_segments' && Array.isArray(job.tasks) && job.tasks.length > 0
  })
}

export async function listJobs({ limit = 50, offset = 0, status = null, sortBy = 'time', published = false, unpublished = false, productId = null } = {}) {
  const baseCols = 'j.job_id, j.status, j.step_label, j.product_id, j.category, j.created_at, j.completed_at, j.total_ms, j.error_message'
  const params = []
  let pi = 0
  const np = (v) => { params.push(v); return `$${++pi}` }

  const needJoin = sortBy === 'quality'
  let query = `SELECT ${needJoin ? `${baseCols}, MAX(v.video_judge_overall) AS _max_score` : baseCols} FROM jobs j`
  if (needJoin) query += ' LEFT JOIN videos v ON v.job_id = j.job_id'
  const wheres = []
  if (status) wheres.push(`j.status = ${np(status)}`)
  if (productId) wheres.push(`j.product_id = ${np(productId)}`)
  if (published) wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = j.job_id AND vp.is_published = 1)')
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
  query += ` LIMIT ${np(limit)} OFFSET ${np(offset)}`
  const { rows } = await pool.query(query, params)
  return rows
}

export async function countJobs(status = null, published = false, unpublished = false, productId = null) {
  const params = []
  let pi = 0
  const np = (v) => { params.push(v); return `$${++pi}` }
  const wheres = []
  if (status) wheres.push(`status = ${np(status)}`)
  if (productId) wheres.push(`product_id = ${np(productId)}`)
  if (published) wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id AND vp.is_published = 1)')
  if (unpublished) {
    wheres.push('EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id)')
    wheres.push('NOT EXISTS (SELECT 1 FROM videos vp WHERE vp.job_id = jobs.job_id AND vp.is_published = 1)')
  }
  let q = 'SELECT COUNT(*) AS c FROM jobs'
  if (wheres.length) q += ' WHERE ' + wheres.join(' AND ')
  const { rows } = await pool.query(q, params)
  return parseInt(rows[0].c, 10)
}

export async function countJobsByProduct() {
  const { rows } = await pool.query(
    'SELECT product_id, COUNT(*) AS c FROM jobs WHERE product_id IS NOT NULL GROUP BY product_id'
  )
  return rows
}

// ===== Video 操作 =====

export async function saveVideo(video) {
  await pool.query(`
    INSERT INTO videos (
      video_id, job_id, video_url, poster_url, prompt, compressed_script,
      product_visual_features, selected_image_indices, selected_image_urls, dominant_color,
      review_score, review_pass, review_issues, revision_count,
      narrative_dna, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (video_id) DO UPDATE SET
      job_id=$2, video_url=$3, poster_url=$4, prompt=$5, compressed_script=$6,
      product_visual_features=$7, selected_image_indices=$8, selected_image_urls=$9, dominant_color=$10,
      review_score=$11, review_pass=$12, review_issues=$13, revision_count=$14,
      narrative_dna=$15
  `, [
    video.videoId,
    video.jobId,
    video.videoUrl ?? null,
    video.posterUrl ?? null,
    video.prompt ?? null,
    video.compressedScript ?? null,
    video.productVisualFeatures ? JSON.stringify(video.productVisualFeatures) : null,
    video.selectedImageIndices ? JSON.stringify(video.selectedImageIndices) : null,
    video.selectedImageUrls ? JSON.stringify(video.selectedImageUrls) : null,
    video.dominantColor ?? null,
    video.reviewScore ?? null,
    video.reviewPass == null ? null : (video.reviewPass ? 1 : 0),
    video.reviewIssues ? JSON.stringify(video.reviewIssues) : null,
    video.revisionCount ?? 0,
    video.narrativeDna ? JSON.stringify(video.narrativeDna) : null,
    Date.now(),
  ])
}

export async function updateVideoPosterUrl(videoId, posterUrl) {
  const { rowCount } = await pool.query(
    'UPDATE videos SET poster_url = $1 WHERE video_id = $2',
    [posterUrl, videoId]
  )
  return rowCount > 0
}

export async function updateVideoJudge(videoId, judge) {
  if (!judge) return
  const scoresWithExtras = judge.scores ? {
    ...judge.scores,
    ...(judge.reference_match_notes ? { reference_match_notes: judge.reference_match_notes } : {}),
    ...(judge.what_worked ? { what_worked: judge.what_worked } : {}),
  } : null
  await pool.query(`
    UPDATE videos SET
      video_judge_overall=$1, video_judge_scores=$2, video_judge_issues=$3, video_judge_verdict=$4
    WHERE video_id=$5
  `, [
    judge.overall ?? null,
    scoresWithExtras ? JSON.stringify(scoresWithExtras) : null,
    judge.top_issues ? JSON.stringify(judge.top_issues) : null,
    judge.verdict ?? null,
    videoId,
  ])
}

export async function updateVideoDiffJudge(videoId, diffJudge) {
  if (!diffJudge) return
  await pool.query(`
    UPDATE videos SET
      diff_judge_overall=$1, diff_judge_scores=$2, diff_judge_verdict=$3
    WHERE video_id=$4
  `, [
    diffJudge.overall_differentiation ?? null,
    diffJudge.scores ? JSON.stringify(diffJudge.scores) : null,
    diffJudge.verdict ?? null,
    videoId,
  ])
}

export async function getVideo(videoId) {
  const { rows } = await pool.query('SELECT * FROM videos WHERE video_id = $1', [videoId])
  return rows[0] || null
}

export async function getVideosByJob(jobId) {
  const { rows } = await pool.query(
    'SELECT * FROM videos WHERE job_id = $1 ORDER BY created_at',
    [jobId]
  )
  return rows
}

// ===== Product 缓存 =====

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

function alignColors(urls, colors) {
  const out = new Array(urls.length).fill('')
  if (!Array.isArray(colors)) return out
  for (let i = 0; i < urls.length && i < colors.length; i++) {
    out[i] = String(colors[i] || '')
  }
  return out
}

function alignThumbs(urls, thumbs) {
  const out = new Array(urls.length).fill('')
  if (!Array.isArray(thumbs)) return out
  for (let i = 0; i < urls.length && i < thumbs.length; i++) {
    out[i] = thumbs[i] || ''
  }
  return out
}

export async function saveProduct(productId, region, productInfo, thumbUrls = null) {
  const now = Date.now()
  const { rows } = await pool.query('SELECT 1 FROM products WHERE product_id = $1', [productId])
  const exists = rows.length > 0
  const mainThumbsJson = thumbUrls?.main ? JSON.stringify(thumbUrls.main) : null
  const detailThumbsJson = thumbUrls?.detail ? JSON.stringify(thumbUrls.detail) : null

  if (exists) {
    if (thumbUrls) {
      await pool.query(`
        UPDATE products SET
          product_info=$1, main_image_urls=$2, detail_image_urls=$3,
          main_image_thumb_urls=$4, detail_image_thumb_urls=$5,
          last_used_at=$6, job_count=job_count+1
        WHERE product_id=$7
      `, [
        JSON.stringify(productInfo),
        JSON.stringify(productInfo.mainImageUrls || []),
        JSON.stringify(productInfo.detailImageUrls || []),
        mainThumbsJson, detailThumbsJson,
        now, productId,
      ])
    } else {
      await pool.query(`
        UPDATE products SET
          product_info=$1, main_image_urls=$2, detail_image_urls=$3,
          last_used_at=$4, job_count=job_count+1
        WHERE product_id=$5
      `, [
        JSON.stringify(productInfo),
        JSON.stringify(productInfo.mainImageUrls || []),
        JSON.stringify(productInfo.detailImageUrls || []),
        now, productId,
      ])
    }
  } else {
    await pool.query(`
      INSERT INTO products (
        product_id, name, region, product_info,
        main_image_urls, detail_image_urls,
        main_image_thumb_urls, detail_image_thumb_urls,
        first_seen_at, last_used_at, job_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      productId,
      productInfo.name || null,
      region || null,
      JSON.stringify(productInfo),
      JSON.stringify(productInfo.mainImageUrls || []),
      JSON.stringify(productInfo.detailImageUrls || []),
      mainThumbsJson, detailThumbsJson,
      now, now, 1,
    ])
  }
}

export async function getProductCache(productId, maxAgeMs = 24 * 3600 * 1000, colorFilter = null) {
  const { rows } = await pool.query(`
    SELECT product_info, last_used_at, main_image_urls, detail_image_urls, user_image_urls,
           main_image_colors, detail_image_colors, user_image_colors, is_curated
    FROM products WHERE product_id = $1
  `, [productId])
  const row = rows[0]
  if (!row) return null
  if (!row.is_curated && Date.now() - Number(row.last_used_at) > maxAgeMs) return null

  const productInfo = JSON.parse(row.product_info)
  const mainUrls = row.main_image_urls ? JSON.parse(row.main_image_urls) : []
  const detailUrls = row.detail_image_urls ? JSON.parse(row.detail_image_urls) : []
  const userUrls = row.user_image_urls ? JSON.parse(row.user_image_urls) : []
  const mainColors = alignColors(mainUrls, row.main_image_colors ? JSON.parse(row.main_image_colors) : [])
  const detailColors = alignColors(detailUrls, row.detail_image_colors ? JSON.parse(row.detail_image_colors) : [])
  const userColors = alignColors(userUrls, row.user_image_colors ? JSON.parse(row.user_image_colors) : [])

  if (colorFilter) {
    productInfo.mainImageUrls = filterUrlsByColor(mainUrls, mainColors, colorFilter)
    const filteredDetail = filterUrlsByColor(detailUrls, detailColors, colorFilter)
    const filteredUser = filterUrlsByColor(userUrls, userColors, colorFilter)
    productInfo.detailImageUrls = [...filteredDetail, ...filteredUser]
  } else {
    if (userUrls.length > 0) {
      productInfo.detailImageUrls = [...(productInfo.detailImageUrls || []), ...userUrls]
    }
  }
  return productInfo
}

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

export async function listProducts({ limit = 200, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT product_id, name, region, main_image_urls, detail_image_urls, user_image_urls,
           main_image_colors, detail_image_colors, user_image_colors,
           main_image_thumb_urls, detail_image_thumb_urls, user_image_thumb_urls,
           is_curated, job_count, first_seen_at, last_used_at
    FROM products
    ORDER BY last_used_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset])

  return rows.map(r => {
    const main = r.main_image_urls ? JSON.parse(r.main_image_urls) : []
    const detail = r.detail_image_urls ? JSON.parse(r.detail_image_urls) : []
    const user = r.user_image_urls ? JSON.parse(r.user_image_urls) : []
    const mainThumbs = r.main_image_thumb_urls ? JSON.parse(r.main_image_thumb_urls) : []
    const detailThumbs = r.detail_image_thumb_urls ? JSON.parse(r.detail_image_thumb_urls) : []
    const userThumbs = r.user_image_thumb_urls ? JSON.parse(r.user_image_thumb_urls) : []
    const mainColors = alignColors(main, r.main_image_colors ? JSON.parse(r.main_image_colors) : [])
    const detailColors = alignColors(detail, r.detail_image_colors ? JSON.parse(r.detail_image_colors) : [])
    const userColors = alignColors(user, r.user_image_colors ? JSON.parse(r.user_image_colors) : [])
    const coverThumb = mainThumbs[0] || detailThumbs[0] || userThumbs[0] || null
    return {
      productId: r.product_id,
      name: r.name,
      region: r.region,
      coverImageUrl: coverThumb || main[0] || detail[0] || user[0] || null,
      mainImageCount: main.length,
      detailImageCount: detail.length,
      userImageCount: user.length,
      colorCounts: summarizeColors(mainColors, detailColors, userColors),
      isCurated: !!r.is_curated,
      jobCount: r.job_count,
      firstSeenAt: Number(r.first_seen_at),
      lastUsedAt: Number(r.last_used_at),
    }
  })
}

export async function getProductFull(productId) {
  const { rows } = await pool.query(`
    SELECT product_id, name, region, product_info, main_image_urls, detail_image_urls,
           user_image_urls, main_image_colors, detail_image_colors, user_image_colors,
           main_image_thumb_urls, detail_image_thumb_urls, user_image_thumb_urls,
           is_curated, job_count, first_seen_at, last_used_at
    FROM products WHERE product_id = $1
  `, [productId])
  const row = rows[0]
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
    mainImageThumbUrls: alignThumbs(mainUrls, row.main_image_thumb_urls ? JSON.parse(row.main_image_thumb_urls) : []),
    detailImageThumbUrls: alignThumbs(detailUrls, row.detail_image_thumb_urls ? JSON.parse(row.detail_image_thumb_urls) : []),
    userImageThumbUrls: alignThumbs(userUrls, row.user_image_thumb_urls ? JSON.parse(row.user_image_thumb_urls) : []),
    isCurated: !!row.is_curated,
    jobCount: row.job_count,
    firstSeenAt: Number(row.first_seen_at),
    lastUsedAt: Number(row.last_used_at),
  }
}

export async function updateProductImages(productId, userImageUrls, userImageColors = null, userImageThumbUrls = null) {
  const urls = userImageUrls || []
  const colors = alignColors(urls, userImageColors || [])
  const thumbs = alignThumbs(urls, userImageThumbUrls || [])
  const { rowCount } = await pool.query(`
    UPDATE products SET
      user_image_urls=$1, user_image_colors=$2, user_image_thumb_urls=$3,
      is_curated=1, last_used_at=$4
    WHERE product_id=$5
  `, [JSON.stringify(urls), JSON.stringify(colors), JSON.stringify(thumbs), Date.now(), productId])
  return rowCount > 0
}

async function findImageLocation(productId, url) {
  const { rows } = await pool.query(
    'SELECT main_image_urls, detail_image_urls, user_image_urls FROM products WHERE product_id = $1',
    [productId]
  )
  if (!rows[0]) return null
  const row = rows[0]
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

export async function setImageColor(productId, url, color) {
  const loc = await findImageLocation(productId, url)
  if (!loc) return false
  const colorCol = `${loc.section}_image_colors`
  const { rows } = await pool.query(`SELECT ${colorCol} AS c FROM products WHERE product_id = $1`, [productId])
  const colors = alignColors(loc.urls, rows[0]?.c ? JSON.parse(rows[0].c) : [])
  colors[loc.index] = String(color || '').trim()
  await pool.query(
    `UPDATE products SET ${colorCol}=$1, last_used_at=$2 WHERE product_id=$3`,
    [JSON.stringify(colors), Date.now(), productId]
  )
  return true
}

export async function bulkSetImageColors(productId, urls, color) {
  let success = 0
  for (const url of urls || []) {
    if (await setImageColor(productId, url, color)) success++
  }
  return success
}

// 批量写多张图各自的颜色，只做 3 次 DB 操作（读一次，改内存，写一次，每个 section 各一次）
// urlColorMap: [{ url, color }, ...]
export async function batchSetImageColors(productId, urlColorMap) {
  if (!urlColorMap || urlColorMap.length === 0) return 0
  const { rows } = await pool.query(
    `SELECT main_image_urls, detail_image_urls, user_image_urls,
            main_image_colors, detail_image_colors, user_image_colors
     FROM products WHERE product_id = $1`,
    [productId]
  )
  if (!rows[0]) return 0
  const row = rows[0]
  const sections = {
    main:   { urls: JSON.parse(row.main_image_urls   || '[]'), colors: JSON.parse(row.main_image_colors   || '[]') },
    detail: { urls: JSON.parse(row.detail_image_urls || '[]'), colors: JSON.parse(row.detail_image_colors || '[]') },
    user:   { urls: JSON.parse(row.user_image_urls   || '[]'), colors: JSON.parse(row.user_image_colors   || '[]') },
  }
  // 确保 colors 数组长度对齐
  for (const [, sec] of Object.entries(sections)) {
    while (sec.colors.length < sec.urls.length) sec.colors.push('')
  }
  // 建 url → {section, index} 查找表
  const lookup = new Map()
  for (const [sec, { urls }] of Object.entries(sections)) {
    urls.forEach((u, i) => lookup.set(u, { sec, i }))
  }
  let taggedCount = 0
  for (const { url, color } of urlColorMap) {
    const loc = lookup.get(url)
    if (!loc) continue
    sections[loc.sec].colors[loc.i] = String(color || '').trim()
    taggedCount++
  }
  // 一次写回（3 个 section 一条 UPDATE）
  await pool.query(
    `UPDATE products SET
       main_image_colors=$1, detail_image_colors=$2, user_image_colors=$3,
       last_used_at=$4
     WHERE product_id=$5`,
    [
      JSON.stringify(sections.main.colors),
      JSON.stringify(sections.detail.colors),
      JSON.stringify(sections.user.colors),
      Date.now(),
      productId,
    ]
  )
  return taggedCount
}

export async function renameProduct(productId, newName) {
  const { rowCount } = await pool.query(
    'UPDATE products SET name=$1 WHERE product_id=$2',
    [newName, productId]
  )
  return rowCount > 0
}

export async function updateVideoUrl(videoId, newUrl) {
  const { rowCount } = await pool.query(
    'UPDATE videos SET video_url=$1 WHERE video_id=$2',
    [newUrl, videoId]
  )
  return rowCount > 0
}

export async function markVideoPublished(videoId, tiktokVideoId, isPublished = true) {
  const { rowCount } = await pool.query(`
    UPDATE videos SET is_published=$1, tiktok_video_id=$2 WHERE video_id=$3
  `, [isPublished ? 1 : 0, tiktokVideoId || null, videoId])
  return rowCount > 0
}

export async function getProductSkuOptions(productId) {
  const { rows } = await pool.query('SELECT product_info FROM products WHERE product_id = $1', [productId])
  if (!rows[0] || !rows[0].product_info) return { axis: null, values: [] }
  try {
    const info = JSON.parse(rows[0].product_info)
    const first = (info.variants || [])[0]
    if (!first || !Array.isArray(first.values)) return { axis: null, values: [] }
    return { axis: first.name || null, values: first.values.filter(v => v && typeof v === 'string') }
  } catch {
    return { axis: null, values: [] }
  }
}

export async function deleteProduct(productId) {
  const { rowCount } = await pool.query('DELETE FROM products WHERE product_id = $1', [productId])
  return rowCount > 0
}

// ===== Reference Video 操作 =====

export async function saveReferenceVideo(refVideo) {
  const { rows } = await pool.query('SELECT * FROM reference_videos WHERE video_id = $1', [refVideo.video_id])
  const existing = rows[0]

  const finalData = existing ? {
    video_id: refVideo.video_id,
    video_url: refVideo.video_url || existing.video_url,
    author_username: refVideo.author_username ?? existing.author_username,
    title: refVideo.title ?? existing.title,
    product_id: refVideo.product_id ?? existing.product_id,
    product_name: refVideo.product_name ?? existing.product_name,
    category: refVideo.category ?? existing.category,
    roi: existing.roi ?? refVideo.roi ?? null,
    revenue: existing.revenue ?? refVideo.revenue ?? null,
    cost: existing.cost ?? refVideo.cost ?? null,
    cvr: existing.cvr ?? refVideo.cvr ?? null,
    play_2s_rate: existing.play_2s_rate ?? refVideo.play_2s_rate ?? null,
    play_6s_rate: existing.play_6s_rate ?? refVideo.play_6s_rate ?? null,
    impressions: refVideo.impressions ?? existing.impressions ?? null,
    clicks: refVideo.clicks ?? existing.clicks ?? null,
    ctr: refVideo.ctr ?? existing.ctr ?? null,
    affiliate_gmv: refVideo.affiliate_gmv ?? existing.affiliate_gmv ?? null,
    affiliate_likes: refVideo.affiliate_likes ?? existing.affiliate_likes ?? null,
    affiliate_comments: refVideo.affiliate_comments ?? existing.affiliate_comments ?? null,
    source: existing.source === refVideo.source ? existing.source : 'both',
    is_benchmark: (existing.is_benchmark || refVideo.is_benchmark) ? 1 : 0,
    benchmark_reason: [existing.benchmark_reason, refVideo.benchmark_reason].filter(Boolean).join(' | ') || null,
    imported_at: Date.now(),
    raw_data: existing.raw_data,
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

  const d = finalData
  await pool.query(`
    INSERT INTO reference_videos (
      video_id, video_url, author_username, title,
      product_id, product_name, category,
      roi, revenue, cost, cvr, play_2s_rate, play_6s_rate,
      impressions, clicks, ctr,
      affiliate_gmv, affiliate_likes, affiliate_comments,
      source, is_benchmark, benchmark_reason,
      imported_at, raw_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (video_id) DO UPDATE SET
      video_url=$2, author_username=$3, title=$4,
      product_id=$5, product_name=$6, category=$7,
      roi=$8, revenue=$9, cost=$10, cvr=$11, play_2s_rate=$12, play_6s_rate=$13,
      impressions=$14, clicks=$15, ctr=$16,
      affiliate_gmv=$17, affiliate_likes=$18, affiliate_comments=$19,
      source=$20, is_benchmark=$21, benchmark_reason=$22,
      imported_at=$23, raw_data=$24
  `, [
    d.video_id, d.video_url, d.author_username, d.title,
    d.product_id, d.product_name, d.category,
    d.roi, d.revenue, d.cost, d.cvr, d.play_2s_rate, d.play_6s_rate,
    d.impressions, d.clicks, d.ctr,
    d.affiliate_gmv, d.affiliate_likes, d.affiliate_comments,
    d.source, d.is_benchmark, d.benchmark_reason,
    d.imported_at, d.raw_data,
  ])
}

export async function listBenchmarkVideos({ productId = null, category = null, limit = 10 } = {}) {
  const params = []
  let pi = 0
  const np = (v) => { params.push(v); return `$${++pi}` }
  let query = 'SELECT * FROM reference_videos WHERE is_benchmark = 1'
  if (productId) query += ` AND product_id = ${np(productId)}`
  if (category) query += ` AND category = ${np(category)}`
  query += ` ORDER BY roi DESC LIMIT ${np(limit)}`
  const { rows } = await pool.query(query, params)
  return rows
}

// ===== My Templates 操作 =====

export async function listTemplates() {
  const { rows } = await pool.query('SELECT * FROM my_templates ORDER BY created_at DESC')
  return rows
}

export async function saveTemplate(data) {
  const { rows } = await pool.query(`
    INSERT INTO my_templates (video_url, tiktok_video_id, job_id, prompt, review_scores, views, orders, ctr, notes, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [
    data.video_url,
    data.tiktok_video_id ?? null,
    data.job_id ?? null,
    data.prompt ?? null,
    data.review_scores ?? null,
    data.views ?? null,
    data.orders ?? null,
    data.ctr ?? null,
    data.notes ?? null,
    Date.now(),
  ])
  return rows[0]
}

export async function updateTemplate(id, data) {
  const fields = ['views', 'orders', 'ctr', 'notes', 'prompt', 'review_scores']
  const sets = []
  const vals = []
  let i = 1
  for (const f of fields) {
    if (data[f] !== undefined) {
      sets.push(`${f}=$${i++}`)
      vals.push(data[f])
    }
  }
  if (sets.length === 0) {
    const { rows } = await pool.query('SELECT * FROM my_templates WHERE id = $1', [id])
    return rows[0] || null
  }
  vals.push(id)
  const { rows } = await pool.query(
    `UPDATE my_templates SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
    vals
  )
  return rows[0] || null
}

export async function deleteTemplate(id) {
  const { rowCount } = await pool.query('DELETE FROM my_templates WHERE id = $1', [id])
  return rowCount > 0
}

export async function pruneOldFailedJobs(daysAgo = 30) {
  const cutoff = Date.now() - daysAgo * 24 * 3600 * 1000
  const { rowCount } = await pool.query(
    "DELETE FROM jobs WHERE status = 'failed' AND created_at < $1",
    [cutoff]
  )
  if (rowCount > 0) {
    console.log(`[DB] 清理了 ${rowCount} 条 ${daysAgo} 天前的失败任务`)
  }
}

export default pool
