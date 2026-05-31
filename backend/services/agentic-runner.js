import path from 'path'
import os from 'os'
import axios from 'axios'
import { writeFile } from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import { saveJob } from './db.js'
import { S3_ENABLED, generatePosterForExistingVideo } from './s3-upload.js'
import { uploadMediaFile } from './media-upload.js'
import { createImageTask, createVideoTask, getTaskStatus, parseTaskResult, waitForTask } from './kieai.js'
import { buildAgenticSegmentPlanLLM, summarizeSegmentPlan } from './agentic-planner.js'
import { buildAgenticSegmentPrompt } from './agentic-prompt-builder.js'
import { extractLastFrame, stitchSegments } from './agentic-stitcher.js'
import { listModels } from './model-library.js'

const AGENTIC_IMAGE_MODEL = 'gpt-image-2-image-to-image'

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

function withVoiceAnchor(prompt, referenceAudioUrl) {
  if (!referenceAudioUrl) return prompt
  return `${prompt}\n\n[VOICE ANCHOR]\nThe presenter speaks with the EXACT voice timbre, gender, age, and accent of the provided reference audio. Keep this same voice identity across every segment of the video; never switch to a different-sounding speaker.`
}

function buildAgenticKeyframePrompt({ segment, plan, model }) {
  const locks = plan?.globalLocks || {}
  const lockBits = [
    locks.dominantColor ? `product color: ${locks.dominantColor}` : '',
    locks.silhouette ? `silhouette: ${locks.silhouette}` : '',
    locks.structure ? `structure: ${locks.structure}` : '',
    locks.fabricVisual ? `fabric look: ${locks.fabricVisual}` : '',
    locks.distinguishingDetails ? `details: ${locks.distinguishingDetails}` : '',
  ].filter(Boolean).join('; ')

  return [
    `Opening FIRST frame for segment ${segment.index}/${plan.segments.length} of a vertical 9:16 handheld UGC TikTok product video.`,
    `The presenter is the exact same woman from the FIRST reference image: ${model?.presenter || 'keep her face, hair, body identity, age, and styling identical'}.`,
    'She is wearing or naturally presenting the exact product from the other reference image(s); match the product color, silhouette, cup shape, band/edge finish, fabric texture, strap placement, and fit exactly.',
    segment.focus ? `This frame sets up only this segment focus: ${segment.focus}.` : `This frame sets up the ${segment.role} segment.`,
    lockBits ? `Locked product attributes: ${lockBits}.` : '',
    'Natural indoor lighting, realistic authentic phone-video look, handheld framing, no glamour retouching. Single person only. No text, no captions, no watermark.',
  ].filter(Boolean).join(' ')
}

async function chooseAgenticModel() {
  const models = await listModels()
  if (!models.length) return null
  return models[Math.floor(Math.random() * models.length)]
}

async function generateAgenticKeyframe({ jobId, segment, plan, model, referenceImageUrls, allFiles }) {
  const refs = [model.imageUrl, ...(referenceImageUrls || []).slice(0, 2)].filter(Boolean)
  const prompt = buildAgenticKeyframePrompt({ segment, plan, model })
  const { taskId } = await createImageTask({
    model: AGENTIC_IMAGE_MODEL,
    prompt,
    referenceUrls: refs,
    aspectRatio: '9:16',
  })
  console.log(`[${jobId}] Agent 首帧任务 segment=${segment.index} task=${taskId}`)

  const result = await waitForTask(taskId, { pollMs: 6000, maxAttempts: 100 })
  if (result.state !== 'success' || !result.imageUrl) {
    throw new Error(result.failMsg || `第 ${segment.index} 段首帧生成失败`)
  }

  const framePath = path.join(os.tmpdir(), `${uuidv4()}-agent-keyframe-${segment.index}.png`)
  await downloadFileToPath(result.imageUrl, framePath)
  allFiles.push({ path: framePath })
  const keyframeUrl = await uploadMediaFile(framePath, `agent-keyframe-${segment.index}.png`)
  return { segmentIndex: segment.index, taskId, keyframeUrl, prompt }
}

function toSerialHandoffPlan(plan) {
  return {
    ...plan,
    generationMode: 'agentic_segments_v1',
    strategy: `${plan.strategy || 'unknown'}_serial_handoff_fallback`,
    segments: (plan.segments || []).map((segment, i, segments) => {
      const isFirst = i === 0
      const isLast = i === segments.length - 1
      return {
        ...segment,
        seedanceMode: isFirst ? 'multimodal_reference' : 'first_frame_continue',
        returnLastFrame: !isLast,
        firstFrameSource: isFirst ? undefined : `segment_${i}_last_frame`,
      }
    }),
  }
}

async function finalizeAgenticVideo({ jobId, finalPrompt, segmentArtifacts, resolution, allFiles, setStep }) {
  let finalVideoPath = segmentArtifacts[0].localVideoPath
  if (segmentArtifacts.length > 1) {
    setStep(3, '拼接 Agent 分段视频')
    finalVideoPath = path.join(os.tmpdir(), `${uuidv4()}-agent-final.mp4`)
    await stitchSegments(segmentArtifacts.map(segment => segment.localVideoPath), finalVideoPath, { resolution, withAudio: true })
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
    taskId: `${jobId}-agent-final`,
    videoUrl: finalVideoUrl,
    posterUrl,
    prompt: finalPrompt,
  }
}

async function runAgenticGenerationSerial({
  job,
  jobId,
  plan,
  finalPrompt,
  referenceImageUrls,
  referenceVideoUrls,
  referenceAudioUrl = '',
  resolution,
  allFiles,
  setStep,
}) {
  const serialPlan = toSerialHandoffPlan(plan)
  job.agentPlan = serialPlan
  job.agentPlanSummary = summarizeSegmentPlan(serialPlan)
  job.agentExecution = 'serial_handoff_fallback'
  job.tasks = []
  job.taskStatuses = serialPlan.segments.map(segment => ({
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

  for (const segment of serialPlan.segments) {
    const taskIndex = segment.index - 1
    setStep(3, `Agent 兜底串行生成第 ${segment.index}/${serialPlan.segments.length} 段（${segment.role}）`)

    const segmentPrompt = withVoiceAnchor(buildAgenticSegmentPrompt({
      basePrompt: finalPrompt,
      segment,
      plan: serialPlan,
    }), referenceAudioUrl)

    const task = await createVideoTask({
      prompt: segmentPrompt,
      referenceImageUrls: segment.seedanceMode === 'multimodal_reference' ? referenceImageUrls : [],
      referenceVideoUrls: segment.seedanceMode === 'multimodal_reference' ? referenceVideoUrls : [],
      referenceAudioUrls: referenceAudioUrl ? [referenceAudioUrl] : [],
      firstFrameUrl: segment.seedanceMode === 'first_frame_continue' ? firstFrameUrl : '',
      resolution,
      duration: segment.duration,
      aspectRatio: '9:16',
      returnLastFrame: !!segment.returnLastFrame,
      generateAudio: true,
    })

    job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: 'queuing', progress: 0, failMsg: '' }
    job.tasks[taskIndex] = { taskId: task.taskId, segmentIndex: segment.index, role: segment.role, seedanceMode: segment.seedanceMode, prompt: segmentPrompt, duration: segment.duration }
    await saveJob(job)

    const parsed = await waitForTaskCompletion({
      jobId,
      taskId: task.taskId,
      onUpdate: async (status) => {
        job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: status.state, progress: status.progress ?? null, failMsg: status.failMsg || '' }
        await saveJob(job)
      },
    })

    if (parsed.state !== 'success' || !parsed.videoUrl) throw new Error(parsed.failMsg || `第 ${segment.index} 段生成失败`)

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

    segmentArtifacts.push({ index: segment.index, role: segment.role, taskId: task.taskId, prompt: segmentPrompt, rawVideoUrl: parsed.videoUrl, localVideoPath: segmentVideoPath, handoffFrameUrl })

    job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: 'success', progress: 100, failMsg: '' }
    job.agentSegments = segmentArtifacts.map(artifact => ({ index: artifact.index, role: artifact.role, taskId: artifact.taskId, videoUrl: artifact.rawVideoUrl, handoffFrameUrl: artifact.handoffFrameUrl }))
    await saveJob(job)
  }

  return {
    plan: serialPlan,
    segmentArtifacts,
    finalVideo: await finalizeAgenticVideo({ jobId, finalPrompt, segmentArtifacts, resolution, allFiles, setStep }),
  }
}

async function runAgenticGenerationParallel({
  job,
  jobId,
  plan,
  finalPrompt,
  referenceImageUrls,
  referenceAudioUrl = '',
  resolution,
  allFiles,
  setStep,
}) {
  const model = await chooseAgenticModel()
  if (!model?.imageUrl) throw new Error('模特库为空，无法执行 Agent v2 并行关键帧模式')

  job.agentPlan = plan
  job.agentPlanSummary = summarizeSegmentPlan(plan)
  job.agentExecution = 'parallel_keyframes_v2'
  job.agentModel = { id: model.id, label: model.label, imageUrl: model.imageUrl }
  job.tasks = []
  job.taskStatuses = plan.segments.map(segment => ({
    taskId: null,
    state: 'waiting_keyframe',
    progress: 0,
    failMsg: '',
    segmentIndex: segment.index,
    role: segment.role,
  }))
  await saveJob(job)

  setStep(3, 'Agent v2 并行生成各段首帧')
  const keyframes = await Promise.all(plan.segments.map(async segment => {
    const taskIndex = segment.index - 1
    try {
      const keyframe = await generateAgenticKeyframe({ jobId, segment, plan, model, referenceImageUrls, allFiles })
      job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], state: 'keyframe_success', progress: 0, failMsg: '' }
      job.agentKeyframes = [...(job.agentKeyframes || []).filter(k => k.segmentIndex !== segment.index), keyframe].sort((a, b) => a.segmentIndex - b.segmentIndex)
      await saveJob(job)
      return keyframe
    } catch (e) {
      job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], state: 'keyframe_failed', failMsg: e.message }
      await saveJob(job)
      throw e
    }
  }))
  const keyframeByIndex = new Map(keyframes.map(k => [k.segmentIndex, k.keyframeUrl]))

  setStep(3, 'Agent v2 各段并行生成视频')
  const segmentArtifacts = await Promise.all(plan.segments.map(async segment => {
    const taskIndex = segment.index - 1
    const segmentPrompt = withVoiceAnchor(buildAgenticSegmentPrompt({ basePrompt: finalPrompt, segment, plan }), referenceAudioUrl)
    const task = await createVideoTask({
      prompt: segmentPrompt,
      referenceImageUrls: referenceImageUrls.slice(0, 2),
      referenceAudioUrls: referenceAudioUrl ? [referenceAudioUrl] : [],
      firstFrameUrl: keyframeByIndex.get(segment.index) || '',
      resolution,
      duration: segment.duration,
      aspectRatio: '9:16',
      returnLastFrame: false,
      generateAudio: true,
    })

    job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: 'queuing', progress: 0, failMsg: '' }
    job.tasks[taskIndex] = { taskId: task.taskId, segmentIndex: segment.index, role: segment.role, seedanceMode: segment.seedanceMode, prompt: segmentPrompt, duration: segment.duration, keyframeUrl: keyframeByIndex.get(segment.index) || '' }
    await saveJob(job)

    const parsed = await waitForTaskCompletion({
      jobId,
      taskId: task.taskId,
      onUpdate: async (status) => {
        job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: status.state, progress: status.progress ?? null, failMsg: status.failMsg || '' }
        await saveJob(job)
      },
    })
    if (parsed.state !== 'success' || !parsed.videoUrl) throw new Error(parsed.failMsg || `第 ${segment.index} 段生成失败`)

    const segmentVideoPath = path.join(os.tmpdir(), `${uuidv4()}-agent-segment-${segment.index}.mp4`)
    await downloadFileToPath(parsed.videoUrl, segmentVideoPath)
    allFiles.push({ path: segmentVideoPath })
    const artifact = {
      index: segment.index,
      role: segment.role,
      taskId: task.taskId,
      prompt: segmentPrompt,
      rawVideoUrl: parsed.videoUrl,
      localVideoPath: segmentVideoPath,
      keyframeUrl: keyframeByIndex.get(segment.index) || '',
    }
    job.taskStatuses[taskIndex] = { ...job.taskStatuses[taskIndex], taskId: task.taskId, state: 'success', progress: 100, failMsg: '' }
    job.agentSegments = [...(job.agentSegments || []).filter(s => s.index !== segment.index), {
      index: artifact.index,
      role: artifact.role,
      taskId: artifact.taskId,
      videoUrl: artifact.rawVideoUrl,
      keyframeUrl: artifact.keyframeUrl,
    }].sort((a, b) => a.index - b.index)
    await saveJob(job)
    return artifact
  }))

  segmentArtifacts.sort((a, b) => a.index - b.index)
  return {
    plan,
    segmentArtifacts,
    finalVideo: await finalizeAgenticVideo({ jobId, finalPrompt, segmentArtifacts, resolution, allFiles, setStep }),
  }
}

export async function runAgenticGeneration({
  job,
  jobId,
  geminiResult,
  finalPrompt,
  referenceImageUrls,
  referenceVideoUrls,
  referenceAudioUrl = '',
  resolution,
  duration,
  allFiles,
  setStep,
}) {
  const plan = await buildAgenticSegmentPlanLLM({
    targetDuration: duration,
    geminiResult,
  })

  job.agentPlan = plan
  job.agentPlanSummary = summarizeSegmentPlan(plan)
  console.log(`[${jobId}] Agent 分镜计划:`, JSON.stringify(job.agentPlanSummary))
  await saveJob(job)

  if (plan.segments.length <= 1 || plan.strategy === 'single_segment_fallback') {
    return runAgenticGenerationSerial({ job, jobId, plan, finalPrompt, referenceImageUrls, referenceVideoUrls, referenceAudioUrl, resolution, allFiles, setStep })
  }

  try {
    return await runAgenticGenerationParallel({ job, jobId, plan, finalPrompt, referenceImageUrls, referenceAudioUrl, resolution, allFiles, setStep })
  } catch (e) {
    console.warn(`[${jobId}] Agent v2 并行模式失败，回退串行尾帧接力: ${e.message}`)
    job.agentParallelError = e.message
    await saveJob(job)
    return runAgenticGenerationSerial({ job, jobId, plan, finalPrompt, referenceImageUrls, referenceVideoUrls, referenceAudioUrl, resolution, allFiles, setStep })
  }
}
