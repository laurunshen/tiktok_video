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
  referenceAudioUrls = [],
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
  // 参考音频：统一各分镜口播音色（kie.ai bytedance/seedance-2 支持，最多 3 个、合计 ≤15s）
  if (referenceAudioUrls && referenceAudioUrls.length > 0) {
    input.reference_audio_urls = referenceAudioUrls
  }

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

// kie.ai 图像生成任务（与视频共用 /jobs/createTask）。
// 支持 gpt-image-2 / seedream/5-lite 等：传完整 model 名；有 referenceUrls 即 image-to-image。
// 注意：参考图字段名因模型族而异——gpt-image-2 用 input_urls，seedream 等用 image_urls。
function imageRefField(model) {
  return String(model).startsWith('gpt-image') ? 'input_urls' : 'image_urls'
}

export async function createImageTask({
  model,
  prompt,
  referenceUrls = [],
  aspectRatio = 'auto',
  options = {},   // 透传额外字段，如 { quality: 'basic', nsfw_checker: false }
}) {
  if (!model) throw new Error('createImageTask: model is required')
  const input = { prompt, aspect_ratio: aspectRatio, ...options }
  if (referenceUrls && referenceUrls.length > 0) {
    input[imageRefField(model)] = referenceUrls
  }

  const payload = { model, input }
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

  const taskId = response.data?.data?.taskId
  if (!taskId) throw new Error(`createImageTask failed: ${JSON.stringify(response.data)}`)
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
  let imageUrl = null
  let lastFrameUrl = null

  if (state === 'success' && data.resultJson) {
    try {
      const result = JSON.parse(data.resultJson)
      const firstUrl = result?.resultUrls?.[0] || null
      videoUrl = firstUrl
      // 图像任务的产物 URL 同样落在 resultUrls[0]
      imageUrl = firstUrl || result?.imageUrl || result?.image_url || null
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
    imageUrl,
    lastFrameUrl,
    failMsg: data.failMsg || '',
    costTime: data.costTime || 0,
  }
}

// 通用任务轮询：拿 taskId 轮询到 success/fail 并返回 parseTaskResult 结果。
// 图像任务比视频快，默认 8s 间隔。瞬时异常忽略后继续重试。
export async function waitForTask(taskId, { pollMs = 8000, maxAttempts = 75, onUpdate = null } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const parsed = parseTaskResult(await getTaskStatus(taskId))
      if (onUpdate) await onUpdate(parsed)
      if (parsed.state === 'success' || parsed.state === 'fail') return parsed
    } catch (e) {
      console.warn(`[kieai] 轮询 ${taskId} 异常（重试）: ${e.message}`)
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`task ${taskId} polling timeout`)
}
