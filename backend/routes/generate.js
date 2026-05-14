import express from 'express'
import multer from 'multer'
import path from 'path'
import os from 'os'
import { unlink, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { analyzeAndGeneratePrompt, SEEDANCE_MANDATORY_BLOCKS } from '../services/gemini.js'
import { validateGeminiOutput, formatValidationReport } from '../services/prompt-validator.js'
import { reviewPrompt, reviseGeminiOutput, formatReviewReport, clearImageCache } from '../services/gemini-review.js'
import { saveJob, getJob, listJobs, countJobs, saveVideo } from '../services/db.js'
import { uploadImagesToKie, uploadFileToKie } from '../services/kieai-upload.js'
import { createBatchTasks, getTaskStatus, parseTaskResult } from '../services/kieai.js'
import { getTikTokPlaybackUrl } from '../services/snaptik.js'

// 用 ffprobe 探测视频实际时长（秒，浮点数）
function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) {
        const dur = parseFloat(stdout.trim())
        if (Number.isFinite(dur)) resolve(dur)
        else reject(new Error(`ffprobe duration parse failed: "${stdout}"`))
      } else {
        reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-200)}`))
      }
    })
    proc.on('error', reject)
  })
}

// 用 ffmpeg 截取视频片段（流复制版，速度提升 ~10x）
// 注意：流复制会对齐到最近的关键帧，端点可能略短（不会超长）
// 传入的 endSec 已经留了余量（≤14s），所以实际输出始终 < 15s 满足 Seedance 上限
function ffmpegClipStreamCopy(srcPath, startSec, endSec, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(startSec),       // -ss 在 -i 前 = 快速 seek 到关键帧
      '-i', srcPath,
      '-t', String(endSec - startSec),
      '-c', 'copy',                   // 流复制，不重编码
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outPath,
    ]
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg(stream-copy) exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', reject)
  })
}

// 精确重编码版（兜底用）：当流复制结果异常时回退使用
function ffmpegClipReencode(srcPath, startSec, endSec, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', srcPath,
      '-ss', String(startSec),
      '-t', String(endSec - startSec),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outPath,
    ]
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg(reencode) exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', reject)
  })
}

// 主入口：先尝试流复制，如果失败或结果超长（>15s）则回退到重编码
const SEEDANCE_MAX_CLIP_SECONDS = 15
async function ffmpegClip(srcPath, startSec, endSec, outPath) {
  // 第 1 次尝试：流复制
  await ffmpegClipStreamCopy(srcPath, startSec, endSec, outPath)
  try {
    const actualDur = await ffprobeDuration(outPath)
    if (actualDur < SEEDANCE_MAX_CLIP_SECONDS) {
      console.log(`  [ffmpeg] 流复制成功，实际时长 ${actualDur.toFixed(2)}s < ${SEEDANCE_MAX_CLIP_SECONDS}s ✅`)
      return
    }
    console.warn(`  [ffmpeg] 流复制结果 ${actualDur.toFixed(2)}s ≥ ${SEEDANCE_MAX_CLIP_SECONDS}s，回退到精确重编码`)
  } catch (e) {
    console.warn(`  [ffmpeg] ffprobe 探测失败（${e.message}），保险起见回退到重编码`)
  }
  // 兜底：重编码（确保严格 ≤ endSec - startSec）
  await ffmpegClipReencode(srcPath, startSec, endSec, outPath)
  const finalDur = await ffprobeDuration(outPath).catch(() => null)
  if (finalDur != null) {
    console.log(`  [ffmpeg] 重编码完成，实际时长 ${finalDur.toFixed(2)}s`)
  }
}

// 从 TikTok URL 提取 @用户名（用于后续按达人聚合分析）
function extractTikTokAuthor(url) {
  if (!url) return null
  const m = url.match(/tiktok\.com\/@([\w.\-]+)/)
  return m ? m[1] : null
}

const router = express.Router()

// Multer config - save to local uploads folder temporarily
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
    cb(null, unique + path.extname(file.originalname))
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max per file
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|mp4|mov/
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '')
    if (allowed.test(ext)) cb(null, true)
    else cb(new Error(`File type not allowed: ${file.originalname}`))
  },
})

// Clean up temp files helper
async function cleanupFiles(files) {
  for (const file of files) {
    try { await unlink(file.path) } catch {}
  }
}

// POST /api/generate
router.post('/', upload.fields([
  { name: 'referenceVideo', maxCount: 1 },
  { name: 'productImages', maxCount: 20 },
]), async (req, res) => {
  const allFiles = []
  // 收集本任务用到的产品图 URL，任务结束时精准清理它们的 review 缓存（不影响并发任务）
  const taskImageUrls = []

  try {
    const referenceVideoFile = req.files?.referenceVideo?.[0]
    const productImageFiles = req.files?.productImages || []
    const userDescription = req.body.userDescription || ''
    const userScript = req.body.userScript || ''
    const category = req.body.category || 'general'
    const productInfo = req.body.productInfo ? JSON.parse(req.body.productInfo) : null
    const isSameProduct = req.body.isSameProduct !== '0'
    const tiktokVideoUrl = req.body.tiktokVideoUrl || ''  // TikTok 视频链接（可替代上传视频）
    const batchCount = parseInt(req.body.batchCount) || 1
    const resolution = req.body.resolution || '480p'
    const duration = parseInt(req.body.duration) || 15

    // 产品图：用户上传 + 商品链接抓取的图片合并（不再二选一），由 Gemini 从合集中筛选最好的
    const scrapedImageUrls = productInfo
      ? [...(productInfo.mainImageUrls || []), ...(productInfo.detailImageUrls || [])]
      : []
    // 上传图优先排前面，链接图补充在后，总量上限 20 张避免 prompt 过大
    const maxImages = 20
    const productImageUrls = scrapedImageUrls.slice(0, Math.max(0, maxImages - productImageFiles.length))

    // 视频：本地上传 或 TikTok 链接，二选一
    if (!referenceVideoFile && !tiktokVideoUrl) {
      return res.status(400).json({ error: '请上传参考视频或填写 TikTok 视频链接' })
    }
    if (productImageFiles.length === 0 && productImageUrls.length === 0) {
      return res.status(400).json({ error: '请上传产品图或填写商品链接（用于自动抓取产品图）' })
    }
    const totalImageCount = productImageFiles.length + productImageUrls.length
    console.log(`[generate] 产品图合集：上传 ${productImageFiles.length} + 链接 ${productImageUrls.length} = ${totalImageCount} 张`)

    if (referenceVideoFile) allFiles.push(referenceVideoFile)
    allFiles.push(...productImageFiles)

    // 立即建 jobStore 条目，前端轮询时可以拿到实时步骤
    // 双写：内存（热数据，轮询响应快）+ SQLite（持久化兜底）
    const jobId = `job-${Date.now()}`
    global.jobStore = global.jobStore || {}
    global.jobStore[jobId] = {
      jobId,
      status: 'processing',
      step: 0,
      stepLabel: '上传产品图到 kie.ai',
      tasks: [],
      videos: [],
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      // 元数据：方便后续按产品/参考视频聚合分析
      productId: productInfo?.productId || (req.body.productId ?? null),
      referenceVideoUrl: tiktokVideoUrl || null,
      referenceVideoAuthor: extractTikTokAuthor(tiktokVideoUrl),
      category, isSameProduct, duration, resolution,
      batchCount, userDescription,
    }
    saveJob(global.jobStore[jobId])

    res.json({ jobId, status: 'processing', message: 'Job started successfully' })

    const job = global.jobStore[jobId]
    const setStep = (step, label) => {
      job.step = step
      job.stepLabel = label
      console.log(`[${jobId}] Step ${step}: ${label}`)
      saveJob(job)
    }

    // --- Async processing pipeline ---
    try {
      // Step 0a: 如果是 TikTok 链接，先用 snaptik 解析无水印直链
      let resolvedVideoUrl = null
      if (tiktokVideoUrl) {
        setStep(0, 'Snaptik 解析 TikTok 视频直链')
        resolvedVideoUrl = await getTikTokPlaybackUrl(tiktokVideoUrl)
        if (!resolvedVideoUrl) {
          throw new Error('Snaptik 解析失败，请检查 TikTok 链接或改为直接上传视频文件')
        }
        console.log(`[${jobId}] Snaptik 解析成功: ${resolvedVideoUrl}`)
      }

      // Step 0b: 上传产品图到 kie.ai（只有用户手动上传了图片才需要）
      let kieImageResults = []
      if (productImageFiles.length > 0) {
        setStep(0, `上传产品图到 kie.ai（共 ${productImageFiles.length} 张）`)
        kieImageResults = await uploadImagesToKie(productImageFiles)
        console.log(`[${jobId}] 上传完成`)
      } else {
        console.log(`[${jobId}] 使用商品链接图片，跳过 kie.ai 上传`)
      }

      setStep(1, 'Gemini 分析参考视频 + 筛选图片 + 生成提示词')
      const geminiResult = await analyzeAndGeneratePrompt({
        videoFilePath: referenceVideoFile?.path,
        videoUrl: resolvedVideoUrl,
        imageFiles: productImageFiles.length > 0 ? productImageFiles : null,
        productImageUrls: productImageUrls.length > 0 ? productImageUrls : null,
        imageUrls: kieImageResults,
        userDescription,
        targetDuration: duration,
        category,
        productInfo,
        isSameProduct,
      })
      console.log(`[${jobId}] 类目: ${geminiResult.video_analysis?.product_category}，选中图片: ${geminiResult.selected_image_indices}`)

      // Step 2a: 选中的远程图（来自商品链接）补传到 kie.ai 拿公网 URL
      const remoteToUpload = (geminiResult.selected_images || []).filter(s => s.source === 'remote' && s.sourceUrl)
      if (remoteToUpload.length > 0) {
        setStep(2, `上传选中的 ${remoteToUpload.length} 张商品链接图到 kie.ai`)
        for (const item of remoteToUpload) {
          try {
            const tmpPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
            const dl = await axios.get(item.sourceUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } })
            await writeFile(tmpPath, dl.data)
            const uploadedUrl = await uploadFileToKie(tmpPath, 'product.jpg')
            item.publicUrl = uploadedUrl
            await unlink(tmpPath).catch(() => {})
          } catch (e) {
            console.warn(`[${jobId}] 远程图上传失败（跳过）: ${e.message}`)
          }
        }
      }
      // 重新汇总最终的 reference_image_urls
      const finalReferenceImageUrls = (geminiResult.selected_images || [])
        .map(s => s.publicUrl)
        .filter(Boolean)
      taskImageUrls.push(...finalReferenceImageUrls)
      console.log(`[${jobId}] Seedance 引用图: ${finalReferenceImageUrls.length} 张`)

      // Step 2b: ffmpeg 截取关键片段并上传到 kie.ai 作为 Seedance reference_video
      let referenceVideoUrls = []
      try {
        const segStart = Math.max(0, parseInt(geminiResult.key_segment_start_seconds) || 0)
        let segEnd = parseInt(geminiResult.key_segment_end_seconds)
        if (!segEnd || segEnd <= segStart) segEnd = segStart + 14
        // 限制 ≤ 14 秒（Seedance 上限 15.2，给 keyframe 对齐留余量）
        const MAX_CLIP = 14
        if (segEnd - segStart > MAX_CLIP) segEnd = segStart + MAX_CLIP

        const srcVideoPath = referenceVideoFile?.path || (resolvedVideoUrl ? await (async () => {
          const tmp = path.join(os.tmpdir(), `${uuidv4()}.mp4`)
          const dl = await axios.get(resolvedVideoUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } })
          await writeFile(tmp, dl.data)
          allFiles.push({ path: tmp })
          return tmp
        })() : null)

        if (srcVideoPath) {
          setStep(2, `截取参考视频片段 [${segStart}s-${segEnd}s] 并上传到 kie.ai`)
          const clipPath = path.join(os.tmpdir(), `${uuidv4()}-clip.mp4`)
          await ffmpegClip(srcVideoPath, segStart, segEnd, clipPath)
          const clipUrl = await uploadFileToKie(clipPath, 'reference-clip.mp4')
          referenceVideoUrls = [clipUrl]
          await unlink(clipPath).catch(() => {})
          console.log(`[${jobId}] 参考视频片段已上传: ${clipUrl}`)
        }
      } catch (e) {
        console.warn(`[${jobId}] 参考视频处理失败（跳过 reference_video）: ${e.message}`)
      }

      // 产品图为空时拒绝提交，避免浪费 Seedance 配额
      if (finalReferenceImageUrls.length === 0) {
        throw new Error('reference_image_urls 为空：没有可用的产品图片，请检查商品链接是否有效或重新上传产品图。任务已终止，未消耗 Seedance 配额。')
      }

      // === 程序化校验（零成本，瞬时） ===
      setStep(2, '程序化校验 Gemini 输出')
      const validation = validateGeminiOutput(geminiResult, {
        targetDuration: duration,
        finalReferenceImageUrls,
      })
      console.log(`[${jobId}] ${formatValidationReport(validation)}`)
      if (!validation.pass) {
        const criticals = validation.issues.filter(i => i.severity === 'critical').map(i => `[${i.field}] ${i.problem}`).join('; ')
        throw new Error(`程序化校验未通过，已终止任务（未消耗 Seedance 配额）：${criticals}`)
      }

      // === Gemini 二次评估（拿产品图对照审查 prompt 准确性） ===
      // 流程：评估 → 失败则修订 → 程序化校验修订结果 → 再评估 → 最多 2 次修订
      setStep(2, 'Gemini 二次评估（对照产品图审查 prompt）')
      const MAX_REVISIONS = 2
      let revisionRound = 0
      let lastReview = null

      while (true) {
        // === 评估当前 prompt ===
        let review
        try {
          review = await reviewPrompt({
            prompt: geminiResult.seedance_prompt,
            compressedScript: geminiResult.compressed_script,
            productVisualFeatures: geminiResult.product_visual_features,
            productImageUrls: finalReferenceImageUrls,
            targetDuration: duration,
          })
        } catch (e) {
          console.warn(`[${jobId}] 评估调用异常（跳过评估，使用当前 prompt）: ${e.message}`)
          break
        }
        console.log(`[${jobId}] [评估第 ${revisionRound + 1} 轮] ${formatReviewReport(review)}`)
        lastReview = review
        job.reviewReport = review

        // === 通过 → 退出循环 ===
        if (review.pass) {
          console.log(`[${jobId}] ✅ 二次评估通过（${revisionRound > 0 ? `经过 ${revisionRound} 次修订` : '首次即通过'}）`)
          break
        }

        // === 不通过 → 看是否还能修订 ===
        if (revisionRound >= MAX_REVISIONS) {
          const criticals = review.issues.filter(i => i.severity === 'critical')
          throw new Error(`Gemini 二次评估发现严重问题（已修订 ${MAX_REVISIONS} 次仍未通过）：${criticals.map(i => i.problem).join('; ')}`)
        }

        // === 修订一次 ===
        revisionRound++
        setStep(2, `根据评估反馈修订 prompt（第 ${revisionRound}/${MAX_REVISIONS} 次）`)
        let revised
        try {
          revised = await reviseGeminiOutput({
            originalPrompt: geminiResult.seedance_prompt,
            originalScript: geminiResult.compressed_script,
            originalFeatures: geminiResult.product_visual_features,
            reviewSuggestion: review.suggestion,
            reviewIssues: review.issues.filter(i => i.severity === 'critical'),
            productImageUrls: finalReferenceImageUrls,
            targetDuration: duration,
          })
        } catch (e) {
          console.warn(`[${jobId}] 修订调用异常: ${e.message}，使用上次 prompt 继续`)
          break
        }
        if (!revised || !revised.seedance_prompt) {
          console.warn(`[${jobId}] 修订返回空，使用上次 prompt 继续`)
          break
        }
        geminiResult.seedance_prompt = revised.seedance_prompt
        geminiResult.compressed_script = revised.compressed_script || geminiResult.compressed_script
        geminiResult.product_visual_features = revised.product_visual_features || geminiResult.product_visual_features
        console.log(`[${jobId}] prompt 已修订（第 ${revisionRound} 次），重新跑程序化校验`)

        // 程序化校验：修订后如果还有 critical（如 if/then 没去掉），直接失败，避免再浪费一次评估
        const reval = validateGeminiOutput(geminiResult, { targetDuration: duration, finalReferenceImageUrls })
        if (!reval.pass) {
          const c = reval.issues.filter(i => i.severity === 'critical').map(i => `[${i.field}] ${i.problem}`).join('; ')
          throw new Error(`第 ${revisionRound} 次修订后仍未通过程序化校验（说明 Gemini 没正确执行修订指令）：${c}`)
        }

        // 进入下一轮 while → 重新评估修订后的 prompt
      }

      // 强制注入固定指令块（Gemini 在长 prompt 里会偷偷压缩这些规则，所以由代码硬拼接）
      // 插在 prompt 末尾的 --- 之前；如果没有 ---，直接追加
      const rawPrompt = geminiResult.seedance_prompt || ''

      // Color Lock 兜底：根据 Pass 1 选定的 dominant_color 动态生成块，强制 Seedance 锁定单一颜色
      const dominantColor = geminiResult.dominant_color || geminiResult.product_visual_features?.color
      const colorLockBlock = dominantColor ? `
[COLOR LOCK — HARD CONSTRAINT, applies to every frame]
The product appearing in the video MUST be ${dominantColor} ONLY. Reference images may include other color SKU variants (black, white, nude, etc.) — those are provided ONLY for structural reference (back closure, strap layout, hardware). DO NOT mix colors. The bra worn by the presenter throughout the entire video is ${dominantColor}. If any frame would render the bra in a different color, REGENERATE that frame in ${dominantColor}.
` : ''

      const allBlocks = SEEDANCE_MANDATORY_BLOCKS + (colorLockBlock ? '\n\n' + colorLockBlock.trim() : '')
      const lastDashIdx = rawPrompt.lastIndexOf('\n---')
      const finalPrompt = lastDashIdx > -1
        ? rawPrompt.slice(0, lastDashIdx) + '\n\n' + allBlocks + '\n' + rawPrompt.slice(lastDashIdx)
        : rawPrompt + '\n\n' + allBlocks
      geminiResult.seedance_prompt = finalPrompt
      const blockCount = 6 + (dominantColor ? 1 : 0)
      console.log(`[${jobId}] 已注入 ${blockCount} 个 MANDATORY 指令块${dominantColor ? `（含 COLOR LOCK = ${dominantColor}）` : ''}，prompt 总长 ${finalPrompt.length} 字符`)

      setStep(2, `创建 ${batchCount} 个 Seedance 生成任务`)
      const tasks = await createBatchTasks({
        prompt: finalPrompt,
        referenceImageUrls: finalReferenceImageUrls,
        referenceVideoUrls,
        resolution,
        duration,
        aspectRatio: '9:16',
        count: batchCount,
      })
      console.log(`[${jobId}] 任务已创建:`, tasks.map(t => t.taskId))

      job.status = 'pending'
      job.geminiResult = geminiResult
      job.tasks = tasks
      setStep(3, 'Seedance 生成中，请耐心等待')

    } catch (err) {
      console.error(`[${jobId}] Pipeline error:`, err)
      job.status = 'failed'
      job.error = err.message
      saveJob(job)
    } finally {
      await cleanupFiles(allFiles)
      // 精准清理本任务用过的图片缓存（不影响并发任务）
      try { if (taskImageUrls.length > 0) clearImageCache(taskImageUrls) } catch {}
    }

  } catch (err) {
    await cleanupFiles(allFiles)
    console.error('Generate route error:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    }
  }
})

// GET /api/generate/status/:jobId - poll job status
router.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params  // 供日志使用
  // 双层查找：内存（热数据）→ SQLite（持久化）
  let job = global.jobStore?.[jobId]
  if (!job) {
    job = getJob(jobId)
    if (job) {
      // 从 DB 恢复到内存（这样接下来的轮询又能用热数据）
      global.jobStore = global.jobStore || {}
      global.jobStore[jobId] = job
    }
  }

  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }

  // Poll live status from kie.ai for each pending task
  if (job.tasks && job.status === 'pending') {
    const taskStatuses = await Promise.all(
      job.tasks.map(async (task) => {
        const taskId = task.taskId
        if (!taskId) return { taskId: null, state: 'unknown' }
        try {
          const raw = await getTaskStatus(taskId)
          const parsed = parseTaskResult(raw)

          // 详细轮询日志
          const progressStr = parsed.progress != null ? ` | 进度 ${parsed.progress}%` : ''
          if (parsed.state === 'fail') {
            console.error(`[${jobId}] ❌ 任务失败 ${taskId} | 原因: ${parsed.failMsg}`)
          } else {
            console.log(`[${jobId}] 🔄 轮询 ${taskId} | 状态: ${parsed.state}${progressStr}`)
          }

          return { taskId, ...parsed }
        } catch (e) {
          // 网络抖动不算任务失败，保持 waiting 状态继续下次轮询
          console.warn(`[${jobId}] ⚠️ 轮询网络异常（跳过）${taskId} | ${e.message}`)
          return { taskId, state: 'waiting', failMsg: '' }
        }
      })
    )

    const videos = taskStatuses
      .filter(t => t.state === 'success' && t.videoUrl)
      .map(t => ({ taskId: t.taskId, videoUrl: t.videoUrl }))

    job.videos = videos

    const allDone = taskStatuses.every(t =>
      t.state === 'success' || t.state === 'fail'
    )
    if (allDone) {
      job.status = videos.length > 0 ? 'completed' : 'failed'
      job.completedAt = Date.now()
      if (job.startedAt) job.totalMs = job.completedAt - job.startedAt
      if (videos.length > 0) {
        console.log(`[${jobId}] ✅ 所有任务完成，视频数: ${videos.length}`)
        videos.forEach(v => console.log(`[${jobId}]    🎬 ${v.videoUrl}`))
        // 把每条生成的视频写到 videos 表（便于后续投流数据导入和分析）
        for (const v of videos) {
          try {
            saveVideo({
              videoId: v.taskId,
              jobId: job.jobId,
              videoUrl: v.videoUrl,
              prompt: job.geminiResult?.seedance_prompt,
              compressedScript: job.geminiResult?.compressed_script,
              productVisualFeatures: job.geminiResult?.product_visual_features,
              selectedImageIndices: job.geminiResult?.selected_image_indices,
              selectedImageUrls: job.geminiResult?.selected_image_urls,
              dominantColor: job.geminiResult?.dominant_color,
              reviewScore: job.reviewReport?.score,
              reviewPass: job.reviewReport?.pass,
              reviewIssues: job.reviewReport?.issues,
            })
          } catch (e) {
            console.warn(`[${jobId}] 保存 video 表失败（不阻塞）: ${e.message}`)
          }
        }
      } else {
        console.error(`[${jobId}] ❌ 所有任务均失败`)
      }
      saveJob(job)  // 完成时持久化最终状态
    }

    job.taskStatuses = taskStatuses
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    step: job.step ?? 0,
    stepLabel: job.stepLabel ?? '',
    videos: job.videos || [],
    tasks: (job.taskStatuses || []).map(t => ({
      taskId: t.taskId,
      state: t.state,
      progress: t.progress,
      failMsg: t.failMsg,
    })),
    prompt: job.geminiResult?.seedance_prompt,
    compressedScript: job.geminiResult?.compressed_script,
    selectedImages: job.geminiResult?.selected_image_indices,
    reasoning: job.geminiResult?.reasoning,
    reviewReport: job.reviewReport,
    taskCount: job.tasks?.length || 0,
    error: job.error,
  })
})

// GET /api/generate/jobs?limit=50&offset=0&status=completed - 历史任务列表
router.get('/jobs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const status = req.query.status || null
  try {
    const jobs = listJobs({ limit, offset, status })
    const total = countJobs(status)
    res.json({ total, limit, offset, jobs })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
