import { getTaskStatus, parseTaskResult } from './kieai.js'
import { listRecoverableJobs, saveJob, saveVideo, updateVideoDiffJudge, updateVideoJudge } from './db.js'
import { S3_ENABLED, isOurS3Url, uploadVideoAndPosterFromUrl } from './s3-upload.js'
import { judgeGeneratedVideo, judgeNarrativeDifferentiation } from './gemini-video-judge.js'

const POLL_INTERVAL_MS = 15000
const MAX_JOBS_PER_TICK = 20

const activeRecoveries = new Set()
const queuedJudges = new Set()

function taskIdOf(task) {
  return typeof task === 'string' ? task : task?.taskId
}

function mergeTaskMetadata(task, parsed) {
  return {
    ...task,
    taskId: taskIdOf(task),
    ...parsed,
  }
}

function buildVideoRows(successTasks) {
  return successTasks.map(task => ({
    taskId: task.taskId,
    videoUrl: task.videoUrl,
    posterUrl: task.posterUrl ?? null,
  }))
}

async function persistVideosForJob(jobId, job, videos) {
  for (const video of videos) {
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
  }
}

function queueVideoJudges(jobId, job, videos) {
  const queueKey = `${jobId}:${videos.map(v => v.taskId).join(',')}`
  if (queuedJudges.has(queueKey)) return
  queuedJudges.add(queueKey)

  setImmediate(async () => {
    for (const video of videos) {
      try {
        console.log(`[${jobId}] 🔍 恢复器调用 Gemini 评分视频 ${video.taskId}...`)
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

async function persistStableVideoUrls(jobId, successTasks) {
  if (!S3_ENABLED) return successTasks

  for (const task of successTasks) {
    if (!task.videoUrl || isOurS3Url(task.videoUrl)) continue
    try {
      const { videoUrl, posterUrl } = await uploadVideoAndPosterFromUrl(task.videoUrl, task.taskId)
      task.videoUrl = videoUrl
      task.posterUrl = posterUrl
      console.log(`[${jobId}] ☁️ 恢复器 S3 上传成功 ${task.taskId}: ${videoUrl}${posterUrl ? ' + poster' : ''}`)
    } catch (e) {
      console.warn(`[${jobId}] ☁️ 恢复器 S3 上传失败（保留 kie URL）${task.taskId}: ${e.message}`)
    }
  }
  return successTasks
}

async function pollRecoverableSeedanceJobUnlocked(job, { source = 'recovery' } = {}) {
  const jobId = job.jobId
  if (!jobId || !Array.isArray(job.tasks) || job.tasks.length === 0) return job
  if ((job.generationMode || 'single_pass') === 'agentic_segments') return job

  const taskStatuses = await Promise.all(job.tasks.map(async (task) => {
    const taskId = taskIdOf(task)
    if (!taskId) return mergeTaskMetadata(task, { state: 'unknown', failMsg: '' })
    try {
      const parsed = parseTaskResult(await getTaskStatus(taskId))
      const progressStr = parsed.progress != null ? ` | 进度 ${parsed.progress}%` : ''
      if (parsed.state === 'fail') {
        console.error(`[${jobId}] ❌ ${source} 轮询失败 ${taskId} | 原因: ${parsed.failMsg}`)
      } else {
        console.log(`[${jobId}] 🔄 ${source} 轮询 ${taskId} | 状态: ${parsed.state}${progressStr}`)
      }
      return mergeTaskMetadata(task, parsed)
    } catch (e) {
      console.warn(`[${jobId}] ⚠️ ${source} 轮询网络异常（跳过）${taskId} | ${e.message}`)
      return mergeTaskMetadata(task, { state: 'waiting', failMsg: '' })
    }
  }))

  const successTasks = await persistStableVideoUrls(
    jobId,
    taskStatuses.filter(task => task.state === 'success' && task.videoUrl)
  )

  job.status = 'pending'
  job.step = 3
  job.stepLabel = job.stepLabel || 'Seedance 生成中，请耐心等待'
  job.taskStatuses = taskStatuses
  job.videos = buildVideoRows(successTasks)

  const allDone = taskStatuses.every(task => task.state === 'success' || task.state === 'fail')
  if (allDone) {
    job.status = job.videos.length > 0 ? 'completed' : 'failed'
    job.completedAt = job.completedAt || Date.now()
    if (job.startedAt) job.totalMs = job.completedAt - job.startedAt

    if (job.videos.length > 0) {
      await persistVideosForJob(jobId, job, job.videos)
      queueVideoJudges(jobId, job, job.videos)
      console.log(`[${jobId}] ✅ 恢复器完成 Seedance job，视频数: ${job.videos.length}`)
    } else {
      const failMsgs = taskStatuses
        .filter(task => task.state === 'fail' && task.failMsg)
        .map((task, i) => `[task ${task.taskId?.slice(-8) || i}] ${task.failMsg}`)
      job.error = failMsgs.length > 0
        ? `Seedance 任务失败：${failMsgs.join(' | ')}`
        : (job.error || 'Seedance 所有任务未产出视频（无 failMsg，可能上游超时被静默吞）')
      console.error(`[${jobId}] ❌ 恢复器确认所有 Seedance task 均失败`)
    }
  }

  await saveJob(job)
  global.jobStore = global.jobStore || {}
  global.jobStore[jobId] = job
  return job
}

export async function pollRecoverableSeedanceJob(job, { source = 'recovery' } = {}) {
  const jobId = job?.jobId
  if (!jobId) return job
  if (activeRecoveries.has(jobId)) return global.jobStore?.[jobId] || job

  activeRecoveries.add(jobId)
  try {
    return await pollRecoverableSeedanceJobUnlocked(job, { source })
  } finally {
    activeRecoveries.delete(jobId)
  }
}

export function startJobRecoveryLoop() {
  const tick = async () => {
    let jobs = []
    try {
      jobs = await listRecoverableJobs({ limit: MAX_JOBS_PER_TICK })
    } catch (e) {
      console.warn(`[recovery] 扫描 pending job 失败: ${e.message}`)
      return
    }

    for (const job of jobs) {
      if (!job?.jobId) continue
      pollRecoverableSeedanceJob(job, { source: 'recovery' })
        .catch(e => console.warn(`[${job.jobId}] 恢复器执行失败: ${e.message}`))
    }
  }

  tick().catch(e => console.warn(`[recovery] 初始恢复失败: ${e.message}`))
  const timer = setInterval(tick, POLL_INTERVAL_MS)
  timer.unref?.()
  console.log(`[recovery] Seedance job 恢复器已启动（${POLL_INTERVAL_MS / 1000}s interval）`)
  return timer
}
