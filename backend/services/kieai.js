import axios from 'axios'

const KIE_BASE = 'https://api.kie.ai/api/v1'

// 创建单个视频生成任务
export async function createVideoTask({
  prompt,
  referenceImageUrls = [],
  referenceVideoUrls = [],
  resolution = '480p',
  duration = 15,
  aspectRatio = '9:16',
}) {
  // kie.ai Seedance 最大支持 15 秒
  const clampedDuration = Math.min(Math.max(Math.round(duration), 5), 15)

  const input = {
    prompt,
    reference_image_urls: referenceImageUrls,
    return_last_frame: false,
    generate_audio: true,
    resolution,
    aspect_ratio: aspectRatio,
    duration: clampedDuration,
    web_search: false,
  }
  if (referenceVideoUrls && referenceVideoUrls.length > 0) {
    input.reference_video_urls = referenceVideoUrls
  }

  const payload = {
    model: 'bytedance/seedance-2',
    input,
  }


  const response = await axios.post(`${KIE_BASE}/jobs/createTask`, payload, {
    headers: {
      Authorization: `Bearer ${process.env.KIE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })

  // response: { code, msg, data: { taskId, ... } }
  const taskId = response.data?.data?.taskId
  if (!taskId) throw new Error(`createTask failed: ${JSON.stringify(response.data)}`)
  return { taskId, raw: response.data }
}

// 查询任务状态（轮询）
export async function getTaskStatus(taskId) {
  const response = await axios.get(`${KIE_BASE}/jobs/recordInfo`, {
    params: { taskId },
    headers: {
      Authorization: `Bearer ${process.env.KIE_TOKEN}`,
    },
  })
  return response.data
}

// 批量创建任务（最多5个并发）
export async function createBatchTasks({
  prompt,
  referenceImageUrls,
  referenceVideoUrls = [],
  resolution = '480p',
  duration = 15,
  aspectRatio = '9:16',
  count = 1,
}) {
  const batchCount = Math.min(count, 5)
  const tasks = []

  for (let i = 0; i < batchCount; i++) {
    const task = await createVideoTask({
      prompt,
      referenceImageUrls,
      referenceVideoUrls,
      resolution,
      duration,
      aspectRatio,
    })
    tasks.push({ taskIndex: i + 1, ...task })
    // 避免瞬间并发太多请求
    if (i < batchCount - 1) await new Promise(r => setTimeout(r, 500))
  }

  return tasks
}

// 从 recordInfo response 里提取标准化状态和视频 URL
export function parseTaskResult(raw) {
  const data = raw?.data || {}
  const state = data.state || ''
  let videoUrl = null

  if (state === 'success' && data.resultJson) {
    try {
      const result = JSON.parse(data.resultJson)
      videoUrl = result?.resultUrls?.[0] || null
    } catch {}
  }

  return {
    state,          // waiting | queuing | generating | success | fail
    progress: data.progress ?? null,
    videoUrl,
    failMsg: data.failMsg || '',
    costTime: data.costTime || 0,
  }
}
