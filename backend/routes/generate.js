import express from 'express'
import multer from 'multer'
import path from 'path'
import os from 'os'
import { unlink, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import axios from 'axios'
import { analyzeAndGeneratePrompt, SEEDANCE_MANDATORY_BLOCKS, VARIANT_RECIPES } from '../services/gemini.js'
import { validateGeminiOutput, formatValidationReport } from '../services/prompt-validator.js'
import { reviewPrompt, reviseGeminiOutput, formatReviewReport, clearImageCache } from '../services/gemini-review.js'
import { saveJob, getJob, listJobs, countJobs, countJobsByProduct, saveVideo, updateVideoJudge, updateVideoDiffJudge, updateVideoUrl, getVideosByJob, markVideoPublished } from '../services/db.js'
import { S3_ENABLED, uploadUrlToS3, uploadVideoAndPosterFromUrl, generatePosterForExistingVideo } from '../services/s3-upload.js'
import { judgeGeneratedVideo, judgeNarrativeDifferentiation } from '../services/gemini-video-judge.js'
import { uploadMediaFiles, uploadMediaFile } from '../services/media-upload.js'
import { createBatchTasks, createVideoTask, getTaskStatus, parseTaskResult } from '../services/kieai.js'
import { getTikTokPlaybackUrl } from '../services/snaptik.js'
import { buildAgenticSegmentPlan, summarizeSegmentPlan } from '../services/agentic-planner.js'
import { buildAgenticSegmentPrompt } from '../services/agentic-prompt-builder.js'
import { extractLastFrame, stitchSegments } from '../services/agentic-stitcher.js'

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function downloadFileToPath(sourceUrl, outPath) {
  const response = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  await writeFile(outPath, response.data)
}

async function persistVideosForJob(jobId, job, videos) {
  for (const video of videos) {
    try {
      await saveVideo({
        videoId: video.taskId,
        jobId,
        videoUrl: video.videoUrl,
        posterUrl: video.posterUrl,
        prompt: video.prompt || job.geminiResult?.seedance_prompt,
        compressedScript: job.geminiResult?.compressed_script,
        productVisualFeatures: job.geminiResult?.product_visual_features,
        selectedImageIndices: job.geminiResult?.selected_image_indices,
        selectedImageUrls: job.geminiResult?.selected_image_urls,
        dominantColor: job.geminiResult?.dominant_color,
        reviewScore: job.reviewReport?.score,
        reviewPass: job.reviewReport?.pass,
        reviewIssues: job.reviewReport?.issues,
        narrativeDna: job.geminiResult?.narrative_dna,
      })
    } catch (e) {
      console.warn(`[${jobId}] 保存 video 表失败（不阻塞）: ${e.message}`)
    }
  }
}

function queueVideoJudges(jobId, job, videos) {
  setImmediate(async () => {
    for (const video of videos) {
      try {
        console.log(`[${jobId}] 🔍 调用 Gemini 评分视频 ${video.taskId}...`)
        const judge = await judgeGeneratedVideo({
          generatedVideoUrl: video.videoUrl,
          productInfo: job.geminiResult?.product_visual_features,
          prompt: video.prompt || job.geminiResult?.seedance_prompt,
          referenceImageUrls: job.geminiResult?.selected_image_urls || [],
        })
        if (judge) {
          await updateVideoJudge(video.taskId, judge)
          console.log(`[${jobId}] ✅ 视频评分完成：${judge.overall}/10 — ${judge.verdict}`)
        }
        const benchmarkUrl = job.resolvedReferenceVideoUrl || job.referenceVideoUrl
        if (benchmarkUrl) {
          console.log(`[${jobId}] 🔍 与标杆视频对比差异化（用 ${job.resolvedReferenceVideoUrl ? 'snaptik 直链' : 'raw URL'}）...`)
          try {
            const diff = await judgeNarrativeDifferentiation({
              generatedVideoUrl: video.videoUrl,
              benchmarkVideoUrl: benchmarkUrl,
            })
            if (diff) {
              await updateVideoDiffJudge(video.taskId, diff)
              console.log(`[${jobId}] ✅ 差异化评分：${diff.overall_differentiation}/10 — ${diff.verdict}`)
            }
          } catch (e) {
            console.warn(`[${jobId}] 差异化评分失败（跳过）: ${e.message}`)
          }
        }
      } catch (e) {
        console.warn(`[${jobId}] 视频评分失败（跳过）: ${e.message}`)
      }
    }
  })
}

async function waitForTaskCompletion({ jobId, taskId, onUpdate, pollMs = 15000, maxAttempts = 80 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await getTaskStatus(taskId)
      const parsed = parseTaskResult(raw)
      if (onUpdate) await onUpdate(parsed)
      if (parsed.state === 'success' || parsed.state === 'fail') return parsed
    } catch (e) {
      console.warn(`[${jobId}] Agent 轮询异常（继续重试）${taskId}: ${e.message}`)
    }
    await sleep(pollMs)
  }
  throw new Error(`任务 ${taskId} 轮询超时`)
}

async function runAgenticGeneration({
  job,
  jobId,
  geminiResult,
  finalPrompt,
  referenceImageUrls,
  referenceVideoUrls,
  resolution,
  duration,
  allFiles,
  setStep,
}) {
  const plan = buildAgenticSegmentPlan({
    targetDuration: duration,
    compressedScript: geminiResult.compressed_script,
    productVisualFeatures: geminiResult.product_visual_features,
    dominantColor: geminiResult.dominant_color,
  })

  job.agentPlan = plan
  job.agentPlanSummary = summarizeSegmentPlan(plan)
  job.tasks = []
  job.taskStatuses = plan.segments.map(segment => ({
    taskId: null,
    state: 'waiting',
    progress: 0,
    failMsg: '',
    segmentIndex: segment.index,
    role: segment.role,
  }))
  await saveJob(job)

  const segmentArtifacts = []
  let firstFrameUrl = ''

  for (const segment of plan.segments) {
    const taskIndex = segment.index - 1
    setStep(3, `Agent 生成第 ${segment.index}/${plan.segments.length} 段（${segment.role}）`)

    const segmentPrompt = buildAgenticSegmentPrompt({
      basePrompt: finalPrompt,
      segment,
      plan,
    })

    const task = await createVideoTask({
      prompt: segmentPrompt,
      referenceImageUrls,
      referenceVideoUrls: segment.seedanceMode === 'multimodal_reference' ? referenceVideoUrls : [],
      firstFrameUrl: segment.seedanceMode === 'first_frame_continue' ? firstFrameUrl : '',
      resolution,
      duration: segment.duration,
      aspectRatio: '9:16',
      returnLastFrame: !!segment.returnLastFrame,
      generateAudio: plan.segments.length === 1,
    })

    job.taskStatuses[taskIndex] = {
      ...job.taskStatuses[taskIndex],
      taskId: task.taskId,
      state: 'queuing',
      progress: 0,
      failMsg: '',
    }
    job.tasks[taskIndex] = {
      taskId: task.taskId,
      segmentIndex: segment.index,
      role: segment.role,
      seedanceMode: segment.seedanceMode,
      prompt: segmentPrompt,
      duration: segment.duration,
    }
    await saveJob(job)

    const parsed = await waitForTaskCompletion({
      jobId,
      taskId: task.taskId,
      onUpdate: async (status) => {
        job.taskStatuses[taskIndex] = {
          ...job.taskStatuses[taskIndex],
          taskId: task.taskId,
          state: status.state,
          progress: status.progress ?? null,
          failMsg: status.failMsg || '',
        }
        await saveJob(job)
      },
    })

    if (parsed.state !== 'success' || !parsed.videoUrl) {
      throw new Error(parsed.failMsg || `第 ${segment.index} 段生成失败`)
    }

    const segmentVideoPath = path.join(os.tmpdir(), `${uuidv4()}-agent-segment-${segment.index}.mp4`)
    await downloadFileToPath(parsed.videoUrl, segmentVideoPath)
    allFiles.push({ path: segmentVideoPath })

    let handoffFrameUrl = ''
    if (segment.returnLastFrame) {
      handoffFrameUrl = parsed.lastFrameUrl || ''
      if (!handoffFrameUrl) {
        const framePath = path.join(os.tmpdir(), `${uuidv4()}-agent-segment-${segment.index}-last.jpg`)
        await extractLastFrame(segmentVideoPath, framePath)
        allFiles.push({ path: framePath })
        handoffFrameUrl = await uploadMediaFile(framePath, `agent-segment-${segment.index}-last.jpg`)
      }
      firstFrameUrl = handoffFrameUrl
    }

    segmentArtifacts.push({
      index: segment.index,
      role: segment.role,
      taskId: task.taskId,
      prompt: segmentPrompt,
      rawVideoUrl: parsed.videoUrl,
      localVideoPath: segmentVideoPath,
      handoffFrameUrl,
    })

    job.taskStatuses[taskIndex] = {
      ...job.taskStatuses[taskIndex],
      taskId: task.taskId,
      state: 'success',
      progress: 100,
      failMsg: '',
    }
    job.agentSegments = segmentArtifacts.map(artifact => ({
      index: artifact.index,
      role: artifact.role,
      taskId: artifact.taskId,
      videoUrl: artifact.rawVideoUrl,
      handoffFrameUrl: artifact.handoffFrameUrl,
    }))
    await saveJob(job)
  }

  let finalVideoPath = segmentArtifacts[0].localVideoPath
  if (segmentArtifacts.length > 1) {
    setStep(3, '拼接 Agent 分段视频')
    finalVideoPath = path.join(os.tmpdir(), `${uuidv4()}-agent-final.mp4`)
    await stitchSegments(segmentArtifacts.map(segment => segment.localVideoPath), finalVideoPath)
    allFiles.push({ path: finalVideoPath })
  }

  const finalVideoUrl = await uploadMediaFile(finalVideoPath, `${jobId}-agent-final.mp4`)
  let posterUrl = null
  if (S3_ENABLED) {
    try {
      posterUrl = await generatePosterForExistingVideo(finalVideoUrl, `${jobId}-agent-final`)
    } catch (e) {
      console.warn(`[${jobId}] Agent 最终视频 poster 生成失败（跳过）: ${e.message}`)
    }
  }

  return {
    plan,
    segmentArtifacts,
    finalVideo: {
      taskId: `${jobId}-agent-final`,
      videoUrl: finalVideoUrl,
      posterUrl,
      prompt: finalPrompt,
    },
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
    const mode = req.body.mode === 'before-after' ? 'before-after' : 'normal'  // before-after 模板模式
    const generationMode = req.body.generationMode === 'agentic_segments' ? 'agentic_segments' : 'single_pass'
    // isSameProduct 在 normal 和 before-after 模式下同义：before-after 后半段就是 normal 流程，
    // 同产品=用参考视频真实台词，不同产品=台词全新写
    const isSameProduct = req.body.isSameProduct !== '0'
    const tiktokVideoUrl = req.body.tiktokVideoUrl || ''  // TikTok 视频链接（可替代上传视频）
    const batchCount = parseInt(req.body.batchCount) || 1
    const resolution = req.body.resolution || '480p'
    const duration = parseInt(req.body.duration) || 15
    const skipReferenceVideo = req.body.skipReferenceVideo === '1'  // A/B 测试用：跳过 Seedance reference_video（Gemini 仍照常分析）
    // variantSeed: 1-5 选不同的模特+场景配方，用于同一标杆视频的裂变（避免 TikTok 查重）
    // 关键：variantSeed 也是人脸防泄漏的开关——空值会让 presenter 描述太泛，
    // Seedance 直接抄参考视频的脸。所以 null 时自动随机选 1-5，永远不让 generic 配方上场。
    const reqSeed = req.body.variantSeed ? parseInt(req.body.variantSeed) : null
    const variantSeed = (reqSeed && reqSeed >= 1 && reqSeed <= 5)
      ? reqSeed
      : (1 + Math.floor(Math.random() * 5))
    if (!reqSeed) console.log(`[generate] variantSeed 未指定，自动随机选 ${variantSeed}`)

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
      batchCount, userDescription, variantSeed, generationMode,
    }
    saveJob(global.jobStore[jobId]).catch(e => console.warn('[DB] saveJob error:', e.message))

    res.json({ jobId, status: 'processing', message: 'Job started successfully' })

    const job = global.jobStore[jobId]
    const setStep = (step, label) => {
      job.step = step
      job.stepLabel = label
      console.log(`[${jobId}] Step ${step}: ${label}`)
      saveJob(job).catch(e => console.warn('[DB] setStep error:', e.message))
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
        // 把直链存到 job 上，供后续 diff_judge 使用（Gemini 下不动 TikTok 原链）
        job.resolvedReferenceVideoUrl = resolvedVideoUrl
        saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))
      }

      // Step 0b: 上传产品图到 S3（只有用户手动上传了图片才需要；URL 持久不过期）
      let kieImageResults = []
      if (productImageFiles.length > 0) {
        setStep(0, `上传产品图到 S3（共 ${productImageFiles.length} 张）`)
        kieImageResults = await uploadMediaFiles(productImageFiles)
        console.log(`[${jobId}] 上传完成`)
      } else {
        console.log(`[${jobId}] 使用商品链接图片，跳过上传`)
      }

      setStep(1, generationMode === 'agentic_segments'
        ? 'Gemini 分析参考视频 + 筛选图片 + 生成 Agent 基础提示词'
        : 'Gemini 分析参考视频 + 筛选图片 + 生成提示词')
      console.log(`[${jobId}] variantSeed=${variantSeed ?? '无'}`)
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
        variantSeed,
        mode,
      })
      console.log(`[${jobId}] 类目: ${geminiResult.video_analysis?.product_category}，选中图片: ${geminiResult.selected_image_indices}`)

      // Step 2a: 选中的远程图（来自商品链接）补传到 kie.ai 拿公网 URL
      const remoteToUpload = (geminiResult.selected_images || []).filter(s => s.source === 'remote' && s.sourceUrl)
      if (remoteToUpload.length > 0) {
        setStep(2, `上传选中的 ${remoteToUpload.length} 张商品链接图到 S3`)
        for (const item of remoteToUpload) {
          let tmpPath = null
          try {
            tmpPath = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
            const dl = await axios.get(item.sourceUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } })
            await writeFile(tmpPath, dl.data)
            const uploadedUrl = await uploadMediaFile(tmpPath, 'product.jpg')
            item.publicUrl = uploadedUrl
          } catch (e) {
            item.publicUrl = item.sourceUrl
            item.publicUrlFallback = 'source_url'
            console.warn(`[${jobId}] 远程图上传 S3 失败，回退用原始商品图 URL: ${e.message}`)
          } finally {
            if (tmpPath) await unlink(tmpPath).catch(() => {})
          }
        }
      }
      // 重新汇总最终的 reference_image_urls
      const finalReferenceImageUrls = (geminiResult.selected_images || [])
        .map(s => s.publicUrl || s.sourceUrl)
        .filter(Boolean)
      taskImageUrls.push(...finalReferenceImageUrls)
      console.log(`[${jobId}] Seedance 引用图: ${finalReferenceImageUrls.length} 张`)

      // Step 2b: ffmpeg 截取关键片段并上传到 kie.ai 作为 Seedance reference_video
      let referenceVideoUrls = []
      if (skipReferenceVideo) {
        console.log(`[${jobId}] skipReferenceVideo=1，跳过 Seedance reference_video 上传（A/B 测试模式）`)
      } else try {
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
          setStep(2, `截取参考视频片段 [${segStart}s-${segEnd}s] 并上传到 S3`)
          const clipPath = path.join(os.tmpdir(), `${uuidv4()}-clip.mp4`)
          try {
            await ffmpegClip(srcVideoPath, segStart, segEnd, clipPath)
            const clipUrl = await uploadMediaFile(clipPath, 'reference-clip.mp4')
            referenceVideoUrls = [clipUrl]
            console.log(`[${jobId}] 参考视频片段已上传: ${clipUrl}`)
          } finally {
            await unlink(clipPath).catch(() => {})
          }
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
            mode,
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

      const dominantColor = geminiResult.dominant_color || geminiResult.product_visual_features?.color
      const features = geminiResult.product_visual_features || {}

      // Color Lock 兜底：根据 Pass 1 选定的 dominant_color 动态生成块，强制 Seedance 锁定单一颜色
      const colorLockBlock = dominantColor
        ? `[COLOR LOCK] Bra is ${dominantColor} in EVERY frame. Reference images of other colors are structure-only — DO NOT render those colors.`
        : ''

      // 产品锚点末尾摘要
      const featuresSummary = features.silhouette || features.color || features.edge_finish ? `[PRODUCT REMINDER — repeat of the visual anchor at top, do NOT ignore]
The bra in the video has: ${features.silhouette || ''}${features.structure ? ', ' + features.structure : ''}${features.edge_finish ? ', ' + features.edge_finish : ''}${features.fabric_visual ? ', ' + features.fabric_visual : ''}${features.color ? ', color: ' + features.color : ''}.${features.distinguishing_details ? ' Distinguishing: ' + features.distinguishing_details + '.' : ''}` : ''

      // 物理约束末尾锚点
      const physicalAnchorBlock = `[PHYSICAL ANCHOR — final reminder of the non-negotiable physical rules]
ONE PERSON across the entire video — same face, hair, makeup, body in every frame. Hands have exactly 5 fingers in natural positions; if a hand cannot render cleanly, keep it out of frame. SURFACE-ONLY contact with the product (no fingers slipping under fabric, no pulling/pinching thin straps). Bra is ${dominantColor || 'the single dominant color'} in EVERY frame. NO mirror-flip transitions.`

      const allBlocks = [SEEDANCE_MANDATORY_BLOCKS, colorLockBlock, featuresSummary, physicalAnchorBlock].filter(Boolean).join('\n\n')
      const lastDashIdx = rawPrompt.lastIndexOf('\n---')
      const finalPrompt = lastDashIdx > -1
        ? rawPrompt.slice(0, lastDashIdx) + '\n\n' + allBlocks + '\n' + rawPrompt.slice(lastDashIdx)
        : rawPrompt + '\n\n' + allBlocks
      geminiResult.seedance_prompt = finalPrompt
      const blockCount = 8 + (dominantColor ? 1 : 0) + (featuresSummary ? 1 : 0) + 1
      console.log(`[${jobId}] 已注入 ${blockCount} 个块${dominantColor ? `（含 COLOR LOCK = ${dominantColor}）` : ''}，prompt 总长 ${finalPrompt.length} 字符`)

      job.geminiResult = geminiResult
      job.referenceVideoUrls = referenceVideoUrls   // 持久化，供 retry-kie 复用

      if (generationMode === 'agentic_segments') {
        setStep(2, 'Agent Planner 生成分段计划')
        const agentResult = await runAgenticGeneration({
          job,
          jobId,
          geminiResult,
          finalPrompt,
          referenceImageUrls: finalReferenceImageUrls,
          referenceVideoUrls,
          resolution,
          duration,
          allFiles,
          setStep,
        })

        job.status = 'completed'
        job.completedAt = Date.now()
        if (job.startedAt) job.totalMs = job.completedAt - job.startedAt
        job.videos = [agentResult.finalVideo]
        await persistVideosForJob(job.jobId, job, job.videos)
        queueVideoJudges(jobId, job, job.videos)
        console.log(`[${jobId}] ✅ Agent 模式完成，最终视频: ${agentResult.finalVideo.videoUrl}`)
        await saveJob(job)
      } else {
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
        job.tasks = tasks
        setStep(3, 'Seedance 生成中，请耐心等待')
      }

    } catch (err) {
      console.error(`[${jobId}] Pipeline error:`, err)
      job.status = 'failed'
      job.error = err.message
      saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))
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

// POST /api/generate/retry-kie/:jobId - 只重建 kie 任务（geminiResult 已有，跳过 Gemini 阶段）
router.post('/retry-kie/:jobId', async (req, res) => {
  const { jobId } = req.params
  let job = global.jobStore?.[jobId]
  if (!job) {
    job = await getJob(jobId)
    if (job) { global.jobStore = global.jobStore || {}; global.jobStore[jobId] = job }
  }
  if (!job) return res.status(404).json({ error: 'Job not found' })
  if (job.generationMode === 'agentic_segments') {
    return res.status(400).json({ error: 'Agent 分段任务暂不支持 retry-kie，请使用完整流程重试' })
  }
  if (!job.geminiResult?.seedance_prompt) return res.status(400).json({ error: '没有 geminiResult，请整体重试' })
  if (!job.tasks?.length) return res.status(400).json({ error: '没有 kie 任务记录，请整体重试' })

  const referenceImageUrls = (job.geminiResult.selected_images || []).map(s => s.publicUrl).filter(Boolean)
  const referenceVideoUrls = job.referenceVideoUrls || []
  const count = job.tasks.length

  // 立即响应，异步重建任务（前端继续轮询同一 jobId）
  job.status = 'pending'
  job.error = null
  job.taskStatuses = []
  job.videos = []
  job.step = 3
  job.stepLabel = `重试 kie — 创建 ${count} 个 Seedance 任务`
  saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))
  res.json({ jobId, status: 'pending' })

  try {
    const tasks = await createBatchTasks({
      prompt: job.geminiResult.seedance_prompt,
      referenceImageUrls,
      referenceVideoUrls,
      resolution: job.resolution || '1080x1920',
      duration: job.duration || '5',
      aspectRatio: '9:16',
      count,
    })
    console.log(`[${jobId}] ♻️ retry-kie 成功，新任务:`, tasks.map(t => t.taskId))
    job.tasks = tasks
    job.stepLabel = 'Seedance 生成中，请耐心等待'
    saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))
  } catch (err) {
    console.error(`[${jobId}] retry-kie 失败:`, err)
    job.status = 'failed'
    job.error = `重试 kie 失败：${err.message}`
    saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))
  }
})

// GET /api/generate/status/:jobId - poll job status
router.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params  // 供日志使用
  // 双层查找：内存（热数据）→ SQLite（持久化）
  let job = global.jobStore?.[jobId]
  if (!job) {
    job = await getJob(jobId)
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

    const successTasks = taskStatuses.filter(t => t.state === 'success' && t.videoUrl)

    // S3 自动持久化：把 kie tempfile URL 上传到我们自己的 S3，替换 videoUrl
    // 同时生成首帧 poster JPG（历史页缩略图用，省 100× 流量）
    // 失败不阻塞，会保留原 kie URL；poster 失败 posterUrl=null（前端 fallback 到 video tag）
    if (S3_ENABLED) {
      for (const t of successTasks) {
        if (t.videoUrl && !t.videoUrl.includes('hypit.s3.')) {
          try {
            const { videoUrl, posterUrl } = await uploadVideoAndPosterFromUrl(t.videoUrl, t.taskId)
            console.log(`[${jobId}] ☁️ S3 上传成功 ${t.taskId}: ${videoUrl}${posterUrl ? ' + poster' : ''}`)
            t.videoUrl = videoUrl
            t.posterUrl = posterUrl
          } catch (e) {
            console.warn(`[${jobId}] ☁️ S3 上传失败（保留 kie URL）${t.taskId}: ${e.message}`)
          }
        }
      }
    }

    const videos = successTasks.map(t => ({ taskId: t.taskId, videoUrl: t.videoUrl, posterUrl: t.posterUrl ?? null }))

    job.videos = videos

    // 关键：先更新到 job 上再 saveJob，否则持久化的 taskStatuses 是上次轮询的旧值
    // —— 历史上所有失败 job 的 failMsg 都是因此被丢的（taskStatuses 只剩创建快照的 waiting）
    job.taskStatuses = taskStatuses

    const allDone = taskStatuses.every(t =>
      t.state === 'success' || t.state === 'fail'
    )
    if (allDone) {
      job.status = videos.length > 0 ? 'completed' : 'failed'
      job.completedAt = Date.now()
      if (job.startedAt) job.totalMs = job.completedAt - job.startedAt
      // 失败时把每个 task 的 failMsg 拼成 error_message，便于历史页一眼看到原因
      if (videos.length === 0) {
        const failMsgs = taskStatuses
          .filter(t => t.state === 'fail' && t.failMsg)
          .map((t, i) => `[task ${t.taskId?.slice(-8) || i}] ${t.failMsg}`)
        if (failMsgs.length > 0) {
          job.error = `Seedance 任务失败：${failMsgs.join(' | ')}`
        } else if (!job.error) {
          job.error = 'Seedance 所有任务未产出视频（无 failMsg，可能上游超时被静默吞）'
        }
      }
      if (videos.length > 0) {
        console.log(`[${jobId}] ✅ 所有任务完成，视频数: ${videos.length}`)
        videos.forEach(v => console.log(`[${jobId}]    🎬 ${v.videoUrl}`))
        await persistVideosForJob(job.jobId, job, videos)
        queueVideoJudges(jobId, job, videos)
      } else {
        console.error(`[${jobId}] ❌ 所有任务均失败`)
      }
      saveJob(job).catch(e => console.warn('[DB] saveJob error:', e.message))  // 完成时持久化最终状态
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
      role: t.role,
      segmentIndex: t.segmentIndex,
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
    generationMode: job.generationMode || 'single_pass',
    retryKieSupported: (job.generationMode || 'single_pass') !== 'agentic_segments' && (job.tasks?.length || 0) > 0,
    error: job.error,
  })
})

// GET /api/generate/variants - 返回所有 variant 配方供前端展示
router.get('/variants', (req, res) => {
  const variants = Object.entries(VARIANT_RECIPES).map(([seed, recipe]) => ({
    seed: parseInt(seed),
    label: recipe.label,
    presenter: recipe.presenter,
    scene: recipe.scene,
  }))
  res.json({ count: variants.length, variants })
})

// GET /api/generate/jobs?limit=50&offset=0&status=completed&productId=xxx - 历史任务列表
// 每条 job 附带：videos 简要（taskId / video_url / 评分）便于历史页直接展示
router.get('/jobs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const rawStatus = req.query.status || null
  const published = rawStatus === 'published'
  // 未发布 = 已完成且没有任何已发布 video（自动隐含 status=completed）
  const unpublished = rawStatus === 'unpublished'
  const status = (published || unpublished) ? (unpublished ? 'completed' : null) : rawStatus
  const sortBy = req.query.sortBy === 'quality' ? 'quality' : 'time'
  const productId = req.query.productId || null
  try {
    const jobs = await listJobs({ limit, offset, status, sortBy, published, unpublished, productId })
    const total = await countJobs(status, published, unpublished, productId)
    // 补 videos 摘要
    const enriched = await Promise.all(jobs.map(async j => {
      const vids = await getVideosByJob(j.job_id) || []
      return {
        ...j,
        videos: vids.map(v => ({
          videoId: v.video_id,
          videoUrl: v.video_url,
          posterUrl: v.poster_url,
          videoJudgeOverall: v.video_judge_overall,
          diffJudgeOverall: v.diff_judge_overall,
          reviewScore: v.review_score,
          isPublished: !!v.is_published,
          tiktokVideoId: v.tiktok_video_id,
        })),
      }
    }))
    res.json({ total, limit, offset, jobs: enriched })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/generate/job-product-counts — 按 product_id 聚合 job 数（历史页下拉显示用）
// 返回 { counts: { <product_id>: <count> } }；未关联产品的 job 不计入
router.get('/job-product-counts', async (req, res) => {
  try {
    const rows = await countJobsByProduct()
    const counts = {}
    for (const r of rows) counts[r.product_id] = parseInt(r.c, 10)
    res.json({ counts })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /api/generate/videos/:videoId/published — 标记某条视频已发布到 TikTok
// body: { tiktokInput: <URL 或 纯 video_id> | null, isPublished?: boolean }
// 若传 tiktokInput，自动从 URL 提取数字 id；若 isPublished 缺省则按是否有 input 决定
router.patch('/videos/:videoId/published', express.json(), async (req, res) => {
  const { videoId } = req.params
  const { tiktokInput, isPublished } = req.body
  let tiktokVideoId = null
  if (tiktokInput && typeof tiktokInput === 'string') {
    const trimmed = tiktokInput.trim()
    // 纯数字
    if (/^\d+$/.test(trimmed)) {
      tiktokVideoId = trimmed
    } else {
      // URL 形式：/video/123... 或 /v/123...
      const m = trimmed.match(/\/(?:video|v)\/(\d+)/)
      if (m) tiktokVideoId = m[1]
      else return res.status(400).json({ error: '无法从输入中提取 TikTok video id（请贴 URL 或纯数字 id）' })
    }
  }
  const flag = isPublished == null ? (tiktokVideoId != null) : !!isPublished
  const ok = await markVideoPublished(videoId, tiktokVideoId, flag)
  if (!ok) return res.status(404).json({ error: 'Video not found' })
  res.json({ ok: true, videoId, tiktokVideoId, isPublished: flag })
})

// GET /api/generate/jobs/:jobId - 单条 job 完整详情（含 videos + prompt + 全评分）
router.get('/jobs/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    const videos = await getVideosByJob(req.params.jobId) || []
    res.json({
      job,
      videos: videos.map(v => ({
        videoId: v.video_id,
        videoUrl: v.video_url,
        posterUrl: v.poster_url,
        prompt: v.prompt,
        compressedScript: v.compressed_script,
        reviewScore: v.review_score,
        reviewPass: v.review_pass,
        reviewIssues: v.review_issues ? JSON.parse(v.review_issues) : null,
        revisionCount: v.revision_count,
        videoJudgeOverall: v.video_judge_overall,
        videoJudgeScores: v.video_judge_scores ? JSON.parse(v.video_judge_scores) : null,
        videoJudgeIssues: v.video_judge_issues ? JSON.parse(v.video_judge_issues) : null,
        videoJudgeVerdict: v.video_judge_verdict,
        diffJudgeOverall: v.diff_judge_overall,
        diffJudgeScores: v.diff_judge_scores ? JSON.parse(v.diff_judge_scores) : null,
        diffJudgeVerdict: v.diff_judge_verdict,
        isPublished: !!v.is_published,
        tiktokVideoId: v.tiktok_video_id,
        createdAt: v.created_at,
      })),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
