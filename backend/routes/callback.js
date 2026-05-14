import express from 'express'

const router = express.Router()

// POST /api/callback/:jobId - kie.ai calls this when video is ready
router.post('/:jobId', (req, res) => {
  const { jobId } = req.params
  const payload = req.body

  console.log(`[Callback] Received for job ${jobId}:`, JSON.stringify(payload, null, 2))

  const job = global.jobStore?.[jobId]
  if (!job) {
    console.warn(`[Callback] Unknown jobId: ${jobId}`)
    return res.json({ ok: true })
  }

  // Extract video URL from callback payload
  const videoUrl =
    payload?.data?.output?.videoUrl ||
    payload?.data?.videoUrl ||
    payload?.output?.videoUrl ||
    payload?.videoUrl

  const taskId =
    payload?.data?.taskId ||
    payload?.taskId

  const status =
    payload?.data?.status ||
    payload?.status

  if (videoUrl) {
    job.videos = job.videos || []
    const exists = job.videos.find(v => v.taskId === taskId)
    if (!exists) {
      job.videos.push({ taskId, videoUrl, receivedAt: new Date().toISOString() })
    }
  }

  // Check if all tasks are done
  const totalTasks = job.tasks?.length || 1
  if (job.videos?.length >= totalTasks || status === 'failed') {
    job.status = job.videos?.length > 0 ? 'completed' : 'failed'
  }

  res.json({ ok: true })
})

export default router
