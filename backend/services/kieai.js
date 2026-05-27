import axios from 'axios'

const KIE_BASE = 'https://api.kie.ai/api/v1'
const KIE_REQUEST_TIMEOUT_MS = 60000

function formatKieError(err) {
  const status = err?.response?.status
  const statusText = err?.response?.statusText
  const apiMsg = err?.response?.data?.msg || err?.response?.data?.message || err?.response?.data?.error
  const networkMsg = err?.message || err?.code || 'unknown network error'

  if (status) {
    return `Kie API ${status}${statusText ? ` ${statusText}` : ''}${apiMsg ? `: ${apiMsg}` : ''}`
  }
  return `Kie network error: ${networkMsg}`
}

// 创建单个视频生成任务
export async function createVideoTask({
  prompt,
  referenceImageUrls = [],
  referenceVideoUrls = [],
  firstFrameUrl = '',
  lastFrameUrl = '',
  resolution = '480p',
  duration = 15,
  aspectRatio = '9:16',
  returnLastFrame = false,
  generateAudio = true,
}) {
  // kie.ai Seedance 支持 4-15 秒
  const clampedDuration = Math.min(Math.max(Math.round(duration), 4), 15)

  const input = {
    prompt,
    return_last_frame: returnLastFrame,
    generate_audio: generateAudio,
    resolution,
    aspect_ratio: aspectRatio,
    duration: clampedDuration,
    web_search: false,
  }
  if (firstFrameUrl) input.first_frame_url = firstFrameUrl
  if (lastFrameUrl) input.last_frame_url = lastFrameUrl
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    input.reference_image_urls = referenceImageUrls
  }
  if (referenceVideoUrls && referenceVideoUrls.length > 0) {
    input.reference_video_urls = referenceVideoUrls
  }
  if (firstFrameUrl) input.first_frame_url = firstFrameUrl
  if (lastFrameUrl) input.last_frame_url = lastFrameUrl

  const payload = {
    model: 'bytedance/seedance-2',
    input,
  }


  let response
  try {
    response = await axios.post(`${KIE_BASE}/jobs/createTask`, payload, {
      timeout: KIE_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${process.env.KIE_TOKEN}`,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    throw new Error(formatKieError(err))
  }

  // response: { code, msg, data: { taskId, ... } }
  const taskId = response.data?.data?.taskId
  if (!taskId) throw new Error(`createTask failed: ${JSON.stringify(response.data)}`)
  return { taskId, raw: response.data }
}

// 查询任务状态（轮询）
export async function getTaskStatus(taskId) {
  let response
  try {
    response = await axios.get(`${KIE_BASE}/jobs/recordInfo`, {
      timeout: KIE_REQUEST_TIMEOUT_MS,
      params: { taskId },
      headers: {
        Authorization: `Bearer ${process.env.KIE_TOKEN}`,
      },
    })
  } catch (err) {
    throw new Error(formatKieError(err))
  }
  return response.data
}

// 批量创建任务（最多5个并发）
export async function createBatchTasks({
  prompt,
  referenceImageUrls,
  referenceVideoUrls = [],
  firstFrameUrl = '',
  lastFrameUrl = '',
  resolution = '480p',
  duration = 15,
  aspectRatio = '9:16',
  count = 1,
  returnLastFrame = false,
  generateAudio = true,
}) {
  const batchCount = Math.min(count, 5)
  const tasks = []

  for (let i = 0; i < batchCount; i++) {
    const task = await createVideoTask({
      prompt,
      referenceImageUrls,
      referenceVideoUrls,
      firstFrameUrl,
      lastFrameUrl,
      resolution,
      duration,
      aspectRatio,
      returnLastFrame,
      generateAudio,
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
  let lastFrameUrl = null

  if (state === 'success' && data.resultJson) {
    try {
      const result = JSON.parse(data.resultJson)
      videoUrl = result?.resultUrls?.[0] || null
      lastFrameUrl =
        result?.lastFrameUrl ||
        result?.last_frame_url ||
        result?.imageUrl ||
        result?.image_url ||
        null
    } catch {}
  }

  return {
    state,          // waiting | queuing | generating | success | fail
    progress: data.progress ?? null,
    videoUrl,
    lastFrameUrl,
    failMsg: data.failMsg || '',
    costTime: data.costTime || 0,
  }
}
