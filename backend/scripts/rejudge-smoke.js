// 重新跑 video_judge + diff_judge 用于本次烟测，不重新生成 Seedance 视频
import '../load-env.js'
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000, connectTimeout: 60_000 }))

import { judgeGeneratedVideo, judgeNarrativeDifferentiation } from '../services/gemini-video-judge.js'
import { updateVideoJudge, updateVideoDiffJudge, getVideosByJob, getJob } from '../services/db.js'

const JOB_IDS = [
  'job-1778820572489', 'job-1778820577507', 'job-1778820587525', 'job-1778820592533',
  'job-1778820607560', 'job-1778820612570', 'job-1778820617584',
]

for (const jobId of JOB_IDS) {
  const videos = getVideosByJob(jobId)
  if (!videos || videos.length === 0) {
    console.log(`[${jobId}] no videos in DB, skip`)
    continue
  }
  const v = videos[0]
  const job = getJob(jobId)
  const benchmarkUrl = job?.resolvedReferenceVideoUrl || job?.referenceVideoUrl
  const productInfo = job?.geminiResult?.product_visual_features

  // 1) video_judge
  try {
    console.log(`[${jobId}] 🔍 video_judge…`)
    const judge = await judgeGeneratedVideo({
      generatedVideoUrl: v.video_url,
      productInfo,
      prompt: job?.geminiResult?.seedance_prompt,
      referenceImageUrls: job?.geminiResult?.selected_image_urls || [],
    })
    if (judge) {
      updateVideoJudge(v.video_id, judge)
      console.log(`[${jobId}] ✅ overall=${judge.overall} — ${judge.verdict}`)
    } else {
      console.warn(`[${jobId}] ⚠️ judge returned null`)
    }
  } catch (e) {
    console.error(`[${jobId}] ❌ video_judge err: ${e.message}`)
  }

  // 2) diff_judge（如果有标杆 URL）
  if (benchmarkUrl) {
    try {
      console.log(`[${jobId}] 🔍 diff_judge vs ${benchmarkUrl.slice(0, 80)}…`)
      const diff = await judgeNarrativeDifferentiation({
        generatedVideoUrl: v.video_url,
        benchmarkVideoUrl: benchmarkUrl,
      })
      if (diff) {
        updateVideoDiffJudge(v.video_id, diff)
        console.log(`[${jobId}] ✅ diff overall=${diff.overall_differentiation} — ${diff.verdict}`)
      } else {
        console.warn(`[${jobId}] ⚠️ diff returned null`)
      }
    } catch (e) {
      console.error(`[${jobId}] ❌ diff_judge err: ${e.message}`)
    }
  }
}

console.log('\nDONE')
process.exit(0)
