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
import { reviewPrompt, reviseGeminiOutput, formatReviewReport } from '../services/gemini-review.js'
import { uploadImagesToKie, uploadFileToKie } from '../services/kieai-upload.js'
import { createBatchTasks, getTaskStatus, parseTaskResult } from '../services/kieai.js'
import { getTikTokPlaybackUrl } from '../services/snaptik.js'

// 用 ffmpeg 截取视频片段
function ffmpegClip(srcPath, startSec, endSec, outPath) {
  return new Promise((resolve, reject) => {
    // 精确切片：先 -i 再 -ss / -t 配合重编码，避免 keyframe 对齐误差导致片段超长
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
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`))
    })
    proc.on('error', reject)
  })
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
    const jobId = `job-${Date.now()}`
    global.jobStore = global.jobStore || {}
    global.jobStore[jobId] = {
      jobId,
      status: 'processing',
      step: 0,        // 0=上传图片 1=Gemini分析 2=创建任务 3=Seedance生成中
      stepLabel: '上传产品图到 kie.ai',
      tasks: [],
      videos: [],
      createdAt: new Date().toISOString(),
    }

    res.json({ jobId, status: 'processing', message: 'Job started successfully' })

    const job = global.jobStore[jobId]
    const setStep = (step, label) => {
      job.step = step
      job.stepLabel = label
      console.log(`[${jobId}] Step ${step}: ${label}`)
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
      setStep(2, 'Gemini 二次评估（对照产品图审查 prompt）')
      let reviewAttempt = 0
      const MAX_REVISIONS = 1
      while (reviewAttempt <= MAX_REVISIONS) {
        try {
          const review = await reviewPrompt({
            prompt: geminiResult.seedance_prompt,
            compressedScript: geminiResult.compressed_script,
            productVisualFeatures: geminiResult.product_visual_features,
            productImageUrls: finalReferenceImageUrls,
            targetDuration: duration,
          })
          console.log(`[${jobId}] ${formatReviewReport(review)}`)
          job.reviewReport = review

          if (review.pass) break

          // 不通过且还有重试机会 → 让 Gemini 修订一次
          if (reviewAttempt < MAX_REVISIONS) {
            setStep(2, `根据评估反馈修订 prompt（第 ${reviewAttempt + 1} 次）`)
            const revised = await reviseGeminiOutput({
              originalPrompt: geminiResult.seedance_prompt,
              originalScript: geminiResult.compressed_script,
              originalFeatures: geminiResult.product_visual_features,
              reviewSuggestion: review.suggestion,
              reviewIssues: review.issues.filter(i => i.severity === 'critical'),
              productImageUrls: finalReferenceImageUrls,
              targetDuration: duration,
            })
            if (revised) {
              geminiResult.seedance_prompt = revised.seedance_prompt || geminiResult.seedance_prompt
              geminiResult.compressed_script = revised.compressed_script || geminiResult.compressed_script
              geminiResult.product_visual_features = revised.product_visual_features || geminiResult.product_visual_features
              console.log(`[${jobId}] prompt 已修订，重新校验`)
              // 修订后再跑一次程序化校验
              const reval = validateGeminiOutput(geminiResult, { targetDuration: duration, finalReferenceImageUrls })
              if (!reval.pass) {
                const c = reval.issues.filter(i => i.severity === 'critical').map(i => `[${i.field}] ${i.problem}`).join('; ')
                throw new Error(`修订后仍未通过程序化校验：${c}`)
              }
            } else {
              console.warn(`[${jobId}] 修订失败，使用原 prompt 继续`)
              break
            }
          } else {
            // 评估失败但已用完重试次数 → 看 critical 严重程度决定是否硬失败
            const criticals = review.issues.filter(i => i.severity === 'critical')
            if (criticals.length > 0) {
              throw new Error(`Gemini 二次评估发现严重问题（已重试 ${MAX_REVISIONS} 次仍未通过）：${criticals.map(i => i.problem).join('; ')}`)
            }
            break
          }
        } catch (e) {
          // 评估服务本身出错（网络/超时）不应阻塞主流程
          if (e.message.includes('未通过') || e.message.includes('严重问题')) throw e
          console.warn(`[${jobId}] 评估调用异常（跳过评估，使用原 prompt）: ${e.message}`)
          break
        }
        reviewAttempt++
      }

      // 强制注入固定指令块（Gemini 在长 prompt 里会偷偷压缩这些规则，所以由代码硬拼接）
      // 插在 prompt 末尾的 --- 之前；如果没有 ---，直接追加
      const rawPrompt = geminiResult.seedance_prompt || ''
      const lastDashIdx = rawPrompt.lastIndexOf('\n---')
      const finalPrompt = lastDashIdx > -1
        ? rawPrompt.slice(0, lastDashIdx) + '\n\n' + SEEDANCE_MANDATORY_BLOCKS + '\n' + rawPrompt.slice(lastDashIdx)
        : rawPrompt + '\n\n' + SEEDANCE_MANDATORY_BLOCKS
      geminiResult.seedance_prompt = finalPrompt
      console.log(`[${jobId}] 已注入 6 个 MANDATORY 指令块（FACE/REFERENCE/ANATOMICAL/NO-TEXT/NO-IMPROV/BODY-ATTACHMENT），prompt 总长 ${finalPrompt.length} 字符`)

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
    } finally {
      await cleanupFiles(allFiles)
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
  const job = global.jobStore?.[jobId]
  
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
      if (videos.length > 0) {
        console.log(`[${jobId}] ✅ 所有任务完成，视频数: ${videos.length}`)
        videos.forEach(v => console.log(`[${jobId}]    🎬 ${v.videoUrl}`))
      } else {
        console.error(`[${jobId}] ❌ 所有任务均失败`)
      }
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

export default router
