import express from 'express'
import multer from 'multer'
import path from 'path'
import os from 'os'
import axios from 'axios'
import { spawn } from 'child_process'
import { unlink, writeFile } from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { analyzeAndGeneratePrompt } from '../services/gemini.js'
import { buildAgenticSegmentPlanLLM, summarizeSegmentPlan } from '../services/agentic-planner.js'
import { buildAgenticSegmentPrompt } from '../services/agentic-prompt-builder.js'
import { uploadMediaFiles, uploadMediaFile } from '../services/media-upload.js'
import { getTikTokPlaybackUrl } from '../services/snaptik.js'
import { createImageTask, createVideoTask, waitForTask } from '../services/kieai.js'
import { stitchSegments } from '../services/agentic-stitcher.js'
import { aiReviewSegment } from '../services/workflow-ai.js'
import { listModels, getModel, generateModelLibrary, MODEL_PROFILES } from '../services/model-library.js'
import { saveJob, getJob } from '../services/db.js'

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-image-to-image'

const router = express.Router()

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
    cb(null, unique + path.extname(file.originalname))
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|mp4|mov|mp3|wav|m4a|aac/
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '')
    if (allowed.test(ext)) cb(null, true)
    else cb(new Error(`File type not allowed: ${file.originalname}`))
  },
})

function getStore() {
  global.jobStore = global.jobStore || {}
  return global.jobStore
}

async function loadWorkflow(id) {
  const store = getStore()
  if (store[id]) return store[id]
  const fromDb = await getJob(id)
  if (fromDb) store[id] = fromDb
  return fromDb
}

function persist(wf) {
  getStore()[wf.jobId] = wf
  saveJob(wf).catch(e => console.warn('[workflow] saveJob error:', e.message))
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath])
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      const dur = parseFloat(out.trim())
      if (code === 0 && Number.isFinite(dur)) resolve(dur)
      else reject(new Error(`ffprobe exit ${code}: ${err.slice(-160)}`))
    })
    proc.on('error', reject)
  })
}

// auto 时长：跟随参考视频实际时长，clamp 到 [8,30]；拿不到则回退 15s
const MAX_WORKFLOW_DURATION = 30
async function detectRefDuration({ referenceVideoFile, resolvedVideoUrl }) {
  let tmp = null
  try {
    let p = referenceVideoFile?.path
    if (!p && resolvedVideoUrl) {
      tmp = path.join(os.tmpdir(), `${uuidv4()}-refdur.mp4`)
      const dl = await axios.get(resolvedVideoUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } })
      await writeFile(tmp, dl.data)
      p = tmp
    }
    if (!p) return 15
    const dur = await ffprobeDuration(p)
    return Math.min(Math.max(Math.round(dur), 8), MAX_WORKFLOW_DURATION)
  } catch (e) {
    console.warn('[workflow] 量参考视频时长失败，用默认 15s:', e.message)
    return 15
  } finally {
    if (tmp) await unlink(tmp).catch(() => {})
  }
}

// 分析阶段：复用 analyzeAndGeneratePrompt + buildAgenticSegmentPlanLLM 产出可审核的分段脚本。
// 注意：精简版每段 prompt（buildAgenticSegmentPrompt）已自带安全块，所以这里无需注入大 prompt 块，
// 也不需要参考视频切片（本工作流靠预生成首帧，不用 seedance reference_video）。
async function runWorkflowAnalyze(wf, { referenceVideoFile, productImageFiles, resolvedVideoUrl, productImageUrls, productInfo }) {
  wf.step = 1
  wf.stepLabel = '上传产品图'
  persist(wf)
  const kieImageResults = productImageFiles.length > 0 ? await uploadMediaFiles(productImageFiles) : []

  wf.step = 2
  wf.stepLabel = 'Gemini 分析参考视频 + 生成分段脚本'
  persist(wf)
  const geminiResult = await analyzeAndGeneratePrompt({
    videoFilePath: referenceVideoFile?.path,
    videoUrl: resolvedVideoUrl,
    imageFiles: productImageFiles.length > 0 ? productImageFiles : null,
    productImageUrls: productImageUrls.length > 0 ? productImageUrls : null,
    imageUrls: kieImageResults,
    userDescription: wf.userDescription,
    targetDuration: wf.duration,
    category: wf.category,
    productInfo,
    isSameProduct: wf.isSameProduct,
    variantSeed: wf.variantSeed,
  })

  const plan = await buildAgenticSegmentPlanLLM({ targetDuration: wf.duration, geminiResult, maxDuration: wf.maxDuration || MAX_WORKFLOW_DURATION })

  const referenceImageUrls = geminiResult.selected_image_urls?.length
    ? geminiResult.selected_image_urls
    : (geminiResult.selected_images || []).map(s => s.publicUrl || s.sourceUrl).filter(Boolean)

  wf.geminiResult = geminiResult
  wf.globalLocks = plan.globalLocks
  wf.referenceImageUrls = referenceImageUrls
  wf.planSummary = summarizeSegmentPlan(plan)
  wf.segments = plan.segments.map(seg => ({
    index: seg.index,
    role: seg.role,
    duration: seg.duration,
    focus: seg.focus || '',
    seedanceMode: seg.seedanceMode,
    script: seg.scriptExcerpt || '',
    videoPrompt: buildAgenticSegmentPrompt({ basePrompt: geminiResult.seedance_prompt, segment: seg, plan }),
    imagePrompt: '',
    hasModel: true,
    keyframeUrl: '', keyframeTaskId: null, keyframeState: 'pending',
    // 可选尾帧（默认关，按需开；用于段内运动控制 / before-after 这种 hook）
    useLastFrame: false,
    lastFramePrompt: '',
    lastFrameUrl: '', lastFrameTaskId: null, lastFrameState: 'idle',
    videoUrl: '', videoTaskId: null, videoState: 'pending',
    stepMode: 'manual',
  }))

  wf.status = 'await_scripts'
  wf.step = 3
  wf.stepLabel = '待审核分段脚本'
  persist(wf)
  console.log(`[${wf.jobId}] 工作流分析完成：${wf.segments.length} 段，策略 ${plan.strategy}`)
}

// POST /api/workflow — 启动工作流（multipart），异步跑分析，立即返回 workflowId
router.post('/', upload.fields([
  { name: 'referenceVideo', maxCount: 1 },
  { name: 'productImages', maxCount: 20 },
]), async (req, res) => {
  try {
    const referenceVideoFile = req.files?.referenceVideo?.[0]
    const productImageFiles = req.files?.productImages || []
    const tiktokVideoUrl = req.body.tiktokVideoUrl || ''
    const productInfo = req.body.productInfo ? JSON.parse(req.body.productInfo) : null
    const userDescription = req.body.userDescription || ''
    const category = req.body.category || 'general'
    const isSameProduct = req.body.isSameProduct !== '0'
    // duration: 'auto'（或空）= 由模型按参考视频时长决定；数字 = 用户指定（优先），clamp [5,30]
    const rawDuration = req.body.duration
    const userDuration = (rawDuration && rawDuration !== 'auto')
      ? Math.min(Math.max(parseInt(rawDuration) || 0, 5), MAX_WORKFLOW_DURATION)
      : null
    const resolution = req.body.resolution || '480p'
    const reqSeed = req.body.variantSeed ? parseInt(req.body.variantSeed) : null
    const variantSeed = (reqSeed && reqSeed >= 1 && reqSeed <= 5) ? reqSeed : (1 + Math.floor(Math.random() * 5))

    const scrapedImageUrls = productInfo
      ? [...(productInfo.mainImageUrls || []), ...(productInfo.detailImageUrls || [])]
      : []
    const productImageUrls = scrapedImageUrls.slice(0, Math.max(0, 20 - productImageFiles.length))

    if (!referenceVideoFile && !tiktokVideoUrl) {
      return res.status(400).json({ error: '请上传参考视频或填写 TikTok 视频链接' })
    }
    if (productImageFiles.length === 0 && productImageUrls.length === 0) {
      return res.status(400).json({ error: '请上传产品图或填写商品链接' })
    }

    const workflowId = `wf-${Date.now()}`
    const wf = {
      jobId: workflowId,
      type: 'workflow',
      status: 'analyzing',
      step: 0,
      stepLabel: '准备分析',
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      category, resolution, isSameProduct, variantSeed, userDescription,
      userDuration,                  // null = auto（跟随参考视频）
      duration: userDuration,        // 最终采用的总时长，auto 时在分析阶段量参考视频后填
      maxDuration: MAX_WORKFLOW_DURATION,
      productId: productInfo?.productId || (req.body.productId ?? null),
      referenceVideoUrl: tiktokVideoUrl || null,
      auto: false,
      referenceImageUrls: [],
      segments: [],
      geminiResult: null,
      globalLocks: null,
      error: null,
    }
    persist(wf)
    res.json({ workflowId, status: 'analyzing' })

    // 异步分析
    ;(async () => {
      try {
        let resolvedVideoUrl = null
        if (tiktokVideoUrl) {
          wf.step = 0; wf.stepLabel = 'Snaptik 解析 TikTok 链接'; persist(wf)
          resolvedVideoUrl = await getTikTokPlaybackUrl(tiktokVideoUrl)
          if (!resolvedVideoUrl) throw new Error('Snaptik 解析失败，请检查链接或改为上传视频文件')
        }
        // 时长：用户指定优先，否则跟随参考视频实际时长（≤30s）
        if (!wf.userDuration) {
          wf.step = 1; wf.stepLabel = '按参考视频确定时长'; persist(wf)
          wf.duration = await detectRefDuration({ referenceVideoFile, resolvedVideoUrl })
          console.log(`[${workflowId}] auto 时长 = ${wf.duration}s`)
        }
        await runWorkflowAnalyze(wf, { referenceVideoFile, productImageFiles, resolvedVideoUrl, productImageUrls, productInfo })
      } catch (e) {
        console.error(`[${workflowId}] 工作流分析失败:`, e)
        wf.status = 'failed'
        wf.error = e.message
        persist(wf)
      } finally {
        const tmp = [referenceVideoFile, ...productImageFiles].filter(Boolean)
        for (const f of tmp) { try { await unlink(f.path) } catch {} }
      }
    })()
  } catch (err) {
    console.error('[workflow] 启动失败:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workflow/models — 模特库列表（必须在 /:id 之前注册，否则被当成 id）
router.get('/models', async (req, res) => {
  res.json({ models: await listModels(), profiles: MODEL_PROFILES.map(p => ({ id: p.id, label: p.label })) })
})

// POST /api/workflow/models/generate — 预生成模特库（管理用，异步）
router.post('/models/generate', express.json(), async (req, res) => {
  const imageModel = req.body.imageModel || 'gpt-image-2-text-to-image'
  const only = Array.isArray(req.body.only) ? req.body.only : null
  const force = req.body.force === true
  res.json({ started: true })
  generateModelLibrary({ imageModel, only, force }).catch(e => console.error('[workflow] 模特库生成失败:', e.message))
})

// GET /api/workflow/:id — 轮询状态
router.get('/:id', async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  res.json(wf)
})

// POST /api/workflow/:id/scripts — 提交编辑后的分段脚本 / 确认推进
router.post('/:id/scripts', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  if (wf.status !== 'await_scripts') {
    return res.status(409).json({ error: `当前状态 ${wf.status} 不可编辑脚本` })
  }

  const edits = Array.isArray(req.body.segments) ? req.body.segments : []
  for (const e of edits) {
    const seg = wf.segments.find(s => s.index === e.index)
    if (seg && typeof e.script === 'string') seg.script = e.script
  }

  if (req.body.confirm) {
    wf.status = 'await_model'
    wf.step = 4
    wf.stepLabel = '待选择模特'
  }
  persist(wf)
  res.json(wf)
})

// 构造某段首帧/尾帧的图像提示词（image-to-image）：用模特图+产品图作参考。
// frame='first' 描述开场画面；frame='last' 描述收尾画面（before/after hook 时即 "after" 状态）。
function buildKeyframePrompt(segment, wf, frame = 'first') {
  const locks = wf.globalLocks || {}
  const lockBits = [
    locks.dominantColor ? `product color: ${locks.dominantColor}` : '',
    locks.silhouette ? `silhouette: ${locks.silhouette}` : '',
    locks.distinguishingDetails ? `details: ${locks.distinguishingDetails}` : '',
  ].filter(Boolean).join('; ')
  const isLast = frame === 'last'
  const which = isLast
    ? `${segment.focus ? `End state of this segment: ${segment.focus}.` : 'The final held pose of this segment.'} (For a before/after hook, this is the "after" state.)`
    : (segment.focus ? `This frame sets up: ${segment.focus}.` : `Segment role: ${segment.role}.`)
  return [
    `${isLast ? 'Closing FINAL' : 'Opening FIRST'} frame of a vertical 9:16 handheld UGC TikTok video.`,
    segment.hasModel
      ? 'The presenter is the exact woman from the FIRST reference image — keep her face, hair and body identity identical. She is wearing the product shown in the other reference image(s); match the product color, silhouette and details exactly.'
      : 'Feature the product from the reference image(s); match its color, silhouette and details exactly.',
    which,
    lockBits ? `Locked product attributes — ${lockBits}.` : '',
    'Natural indoor lighting, realistic authentic phone-video look (not glamour, not retouched). Single person, framed for vertical 9:16. No text, no captions, no watermark.',
  ].filter(Boolean).join(' ')
}

// 为单段生成首帧或尾帧：image-to-image，参考图 = [模特图, 产品图...]
async function generateSegmentKeyframe(seg, wf, imageModel, frame = 'first') {
  const isLast = frame === 'last'
  const refs = []
  if (seg.hasModel && wf.modelImageUrl) refs.push(wf.modelImageUrl)
  refs.push(...(wf.referenceImageUrls || []).slice(0, 2))
  const promptField = isLast ? 'lastFramePrompt' : 'imagePrompt'
  const prompt = seg[promptField] || buildKeyframePrompt(seg, wf, frame)
  seg[promptField] = prompt

  const { taskId } = await createImageTask({
    model: imageModel || DEFAULT_IMAGE_MODEL,
    prompt,
    referenceUrls: refs,
    aspectRatio: '9:16',
  })
  if (isLast) seg.lastFrameTaskId = taskId; else seg.keyframeTaskId = taskId
  const result = await waitForTask(taskId, { pollMs: 6000, maxAttempts: 60 })
  if (result.state !== 'success' || !result.imageUrl) {
    throw new Error(result.failMsg || `第 ${seg.index} 段${isLast ? '尾' : '首'}帧生成失败`)
  }
  let tmp = null
  try {
    tmp = path.join(os.tmpdir(), `${uuidv4()}-${isLast ? 'lf' : 'kf'}-${seg.index}.png`)
    const dl = await axios.get(result.imageUrl, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } })
    await writeFile(tmp, dl.data)
    const url = await uploadMediaFile(tmp, `wf-${isLast ? 'lastframe' : 'keyframe'}-${seg.index}.png`)
    if (isLast) { seg.lastFrameUrl = url; seg.lastFrameState = 'success' }
    else { seg.keyframeUrl = url; seg.keyframeState = 'success' }
  } finally {
    if (tmp) await unlink(tmp).catch(() => {})
  }
}

// 选模特（库里挑 or 随机），写入 wf；不存在则抛错
async function selectModelForWorkflow(wf, modelId, imageModel) {
  const models = await listModels()
  if (models.length === 0) throw new Error('模特库为空，请先在模特库生成形象')
  let chosen
  if (modelId === 'random' || !modelId) chosen = models[Math.floor(Math.random() * models.length)]
  else {
    chosen = models.find(m => m.id === modelId)
    if (!chosen) throw new Error('指定模特不存在')
  }
  wf.modelId = chosen.id
  wf.modelImageUrl = chosen.imageUrl
  wf.imageModel = imageModel || DEFAULT_IMAGE_MODEL
  return chosen
}

// 并行生成各段首帧（全局资产锁定：每段独立用[模特图,产品图]）→ await_keyframes
async function runKeyframeGeneration(wf) {
  wf.status = 'generating_keyframes'
  wf.step = 5
  wf.stepLabel = '生成各段首帧'
  for (const seg of wf.segments) { seg.keyframeState = 'generating'; seg.keyframeUrl = '' }
  persist(wf)
  await Promise.all(wf.segments.map(seg =>
    generateSegmentKeyframe(seg, wf, wf.imageModel)
      .catch(e => { seg.keyframeState = 'failed'; seg.keyframeError = e.message; console.warn(`[${wf.jobId}] ${e.message}`) })
  ))
  wf.status = 'await_keyframes'
  wf.step = 6
  wf.stepLabel = '待审核首帧'
  persist(wf)
}

// POST /api/workflow/:id/model — 选模特（或随机）→ 异步生成各段首帧
router.post('/:id/model', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  if (wf.status !== 'await_model' && wf.status !== 'await_keyframes') {
    return res.status(409).json({ error: `当前状态 ${wf.status} 不可选择模特` })
  }
  try {
    await selectModelForWorkflow(wf, req.body.modelId, req.body.imageModel)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  persist(wf)
  res.json({ status: 'generating_keyframes', modelId: wf.modelId })
  runKeyframeGeneration(wf).catch(e => console.error(`[${wf.jobId}] 首帧生成异常:`, e.message))
})

// POST /api/workflow/:id/keyframes/regenerate — 重生成某段首帧（可改图像提示词/模型）
router.post('/:id/keyframes/regenerate', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  const seg = wf.segments.find(s => s.index === Number(req.body.segmentIndex))
  if (!seg) return res.status(400).json({ error: 'segment not found' })
  if (typeof req.body.imagePrompt === 'string' && req.body.imagePrompt.trim()) seg.imagePrompt = req.body.imagePrompt.trim()
  const imageModel = req.body.imageModel || wf.imageModel || DEFAULT_IMAGE_MODEL
  seg.keyframeState = 'generating'
  persist(wf)
  res.json({ status: 'generating', segmentIndex: seg.index })
  ;(async () => {
    try { await generateSegmentKeyframe(seg, wf, imageModel) }
    catch (e) { seg.keyframeState = 'failed'; seg.keyframeError = e.message }
    persist(wf)
  })()
})

// POST /api/workflow/:id/keyframes/last — 开启/重生成/关闭某段的可选尾帧
// body: { segmentIndex, enable=true, imagePrompt?, imageModel? }
router.post('/:id/keyframes/last', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  const seg = wf.segments.find(s => s.index === Number(req.body.segmentIndex))
  if (!seg) return res.status(400).json({ error: 'segment not found' })

  if (req.body.enable === false) {
    seg.useLastFrame = false
    seg.lastFrameUrl = ''
    seg.lastFrameState = 'idle'
    persist(wf)
    return res.json({ status: 'disabled', segmentIndex: seg.index })
  }

  seg.useLastFrame = true
  if (typeof req.body.imagePrompt === 'string' && req.body.imagePrompt.trim()) seg.lastFramePrompt = req.body.imagePrompt.trim()
  const imageModel = req.body.imageModel || wf.imageModel || DEFAULT_IMAGE_MODEL
  seg.lastFrameState = 'generating'
  persist(wf)
  res.json({ status: 'generating', segmentIndex: seg.index })
  ;(async () => {
    try { await generateSegmentKeyframe(seg, wf, imageModel, 'last') }
    catch (e) { seg.lastFrameState = 'failed'; seg.lastFrameError = e.message; console.warn(`[${wf.jobId}] ${e.message}`) }
    persist(wf)
  })()
})

// POST /api/workflow/:id/keyframes/confirm — 确认首帧 → 进入提示词审核
router.post('/:id/keyframes/confirm', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  if (wf.status !== 'await_keyframes') return res.status(409).json({ error: `当前状态 ${wf.status} 不可确认首帧` })
  wf.status = 'await_prompts'
  wf.step = 7
  wf.stepLabel = '待审核视频提示词'
  persist(wf)
  res.json(wf)
})

// 为单段生成视频：首帧（+可选尾帧）驱动，seedance 生成后下载到本地供拼接
async function generateSegmentVideo(seg, wf) {
  const { taskId } = await createVideoTask({
    prompt: seg.videoPrompt,
    referenceImageUrls: (wf.referenceImageUrls || []).slice(0, 2),
    firstFrameUrl: seg.keyframeUrl || '',
    lastFrameUrl: (seg.useLastFrame && seg.lastFrameUrl) ? seg.lastFrameUrl : '',
    resolution: wf.resolution,
    duration: seg.duration,
    aspectRatio: '9:16',
    returnLastFrame: false,
    generateAudio: true,
  })
  seg.videoTaskId = taskId
  const result = await waitForTask(taskId, { pollMs: 15000, maxAttempts: 80 })
  if (result.state !== 'success' || !result.videoUrl) {
    throw new Error(result.failMsg || `第 ${seg.index} 段视频生成失败`)
  }
  const tmp = path.join(os.tmpdir(), `${uuidv4()}-wf-seg-${seg.index}.mp4`)
  const dl = await axios.get(result.videoUrl, { responseType: 'arraybuffer', timeout: 180000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  await writeFile(tmp, dl.data)
  seg.localVideoPath = tmp
  seg.rawVideoUrl = result.videoUrl
  seg.videoState = 'success'
}

// 各段并行出视频 + 拼接成片 → completed（失败则抛错，由调用方处理状态）
async function runVideoGeneration(wf) {
  wf.status = 'generating_videos'
  wf.step = 8
  wf.stepLabel = '各段并行生成视频'
  for (const seg of wf.segments) { seg.videoState = 'generating'; seg.videoUrl = '' }
  persist(wf)
  const created = []
  try {
    // 各段并行（不互相等待 —— 首帧已预生成，这是速度收益所在）
    await Promise.all(wf.segments.map(async seg => {
      try { await generateSegmentVideo(seg, wf); persist(wf) }
      catch (e) { seg.videoState = 'failed'; seg.videoError = e.message; persist(wf); console.warn(`[${wf.jobId}] ${e.message}`) }
    }))

    const allOk = wf.segments.every(s => s.videoState === 'success' && s.localVideoPath)
    if (!allOk) throw new Error('部分分段视频生成失败，未拼接')

    wf.stepLabel = '拼接成片'
    persist(wf)
    let finalPath
    if (wf.segments.length === 1) {
      finalPath = wf.segments[0].localVideoPath
    } else {
      finalPath = path.join(os.tmpdir(), `${uuidv4()}-wf-final.mp4`)
      created.push(finalPath)
      await stitchSegments(wf.segments.map(s => s.localVideoPath), finalPath, { resolution: wf.resolution, withAudio: true })
    }
    wf.finalVideoUrl = await uploadMediaFile(finalPath, `${wf.jobId}-final.mp4`)
    wf.status = 'completed'
    wf.step = 9
    wf.stepLabel = '完成'
    wf.completedAt = Date.now()
    persist(wf)
    console.log(`[${wf.jobId}] ✅ 工作流完成：${wf.finalVideoUrl}`)
  } catch (e) {
    wf.status = 'failed'
    wf.error = e.message
    persist(wf)
    throw e
  } finally {
    for (const seg of wf.segments) { if (seg.localVideoPath) await unlink(seg.localVideoPath).catch(() => {}) }
    for (const p of created) await unlink(p).catch(() => {})
  }
}

// POST /api/workflow/:id/prompts — 编辑视频提示词 / 确认 → 并行出视频 → 拼接成片
router.post('/:id/prompts', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  if (wf.status !== 'await_prompts') return res.status(409).json({ error: `当前状态 ${wf.status} 不可编辑提示词` })

  const edits = Array.isArray(req.body.segments) ? req.body.segments : []
  for (const e of edits) {
    const seg = wf.segments.find(s => s.index === e.index)
    if (seg && typeof e.videoPrompt === 'string') seg.videoPrompt = e.videoPrompt
  }

  if (!req.body.confirm) { persist(wf); return res.json(wf) }  // 仅保存草稿

  wf.status = 'generating_videos'
  wf.step = 8
  wf.stepLabel = '各段并行生成视频'
  persist(wf)
  res.json({ status: wf.status })
  runVideoGeneration(wf).catch(e => console.error(`[${wf.jobId}] 出视频异常:`, e.message))
})

// 自动托管：从当前 gate 一路推进到成片（确认脚本→随机模特+首帧→确认首帧→确认提示词→出视频+拼接）
async function driveAutopilot(wf) {
  if (wf.status === 'await_scripts') {
    wf.status = 'await_model'; wf.step = 4; wf.stepLabel = '待选择模特'; persist(wf)
  }
  if (wf.status === 'await_model') {
    await selectModelForWorkflow(wf, 'random', wf.imageModel)
    persist(wf)
    await runKeyframeGeneration(wf)   // → await_keyframes
  }
  if (wf.status === 'await_keyframes') {
    wf.status = 'await_prompts'; wf.step = 7; wf.stepLabel = '待审核视频提示词'; persist(wf)
  }
  if (wf.status === 'await_prompts') {
    await runVideoGeneration(wf)       // → completed
  }
}

// POST /api/workflow/:id/autopilot — 从当前步起交给 AI 自动跑完剩余流程
router.post('/:id/autopilot', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  const gated = ['await_scripts', 'await_model', 'await_keyframes', 'await_prompts']
  if (!gated.includes(wf.status)) return res.status(409).json({ error: `当前状态 ${wf.status} 不可托管` })
  wf.auto = true
  persist(wf)
  res.json({ status: 'autopilot', from: wf.status })
  driveAutopilot(wf).catch(e => {
    wf.status = 'failed'; wf.error = e.message; persist(wf)
    console.error(`[${wf.jobId}] autopilot 失败:`, e.message)
  })
})

// POST /api/workflow/:id/ai-assist — AI 审核某段脚本/视频提示词，返回建议+改写（不自动套用）
router.post('/:id/ai-assist', express.json(), async (req, res) => {
  const wf = await loadWorkflow(req.params.id)
  if (!wf) return res.status(404).json({ error: 'workflow not found' })
  const seg = wf.segments.find(s => s.index === Number(req.body.segmentIndex))
  if (!seg) return res.status(400).json({ error: 'segment not found' })
  const step = req.body.step === 'script' ? 'script' : 'videoPrompt'
  try {
    const result = await aiReviewSegment({ step, segment: seg, wf })
    res.json({ segmentIndex: seg.index, step, ...result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
