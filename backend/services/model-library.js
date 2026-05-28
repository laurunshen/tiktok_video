import axios from 'axios'
import path from 'path'
import os from 'os'
import { writeFile, unlink, readFile, mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { createImageTask, waitForTask, getTaskStatus } from './kieai.js'
import { uploadMediaFile } from './media-upload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const LIB_PATH = path.join(DATA_DIR, 'model-library.json')

// 美国市场内衣/塑形品类的模特画像（扩展自 VARIANT_RECIPES 的 5 种到 10 种，覆盖主流人群）。
// 这些是"纯身份形象"——脸/身材/发型，穿中性基础内衣；产品在各段首帧再叠加。
export const MODEL_PROFILES = [
  { id: 'latina-curvy', label: 'Latina · Curvy', presenter: 'Hispanic/Latina woman, mid-20s, olive to warm tan skin tone, dark brown wavy hair, warm facial features with a soft natural smile, naturally curvy body' },
  { id: 'allamerican-white', label: 'All-American White · Slim', presenter: 'Caucasian woman, mid-20s, fair skin with light freckles, medium-length dirty blonde hair, soft oval face, slim-to-average body' },
  { id: 'plus-size', label: 'Plus-Size · Curvy', presenter: 'Caucasian/mixed woman, mid-to-late 20s, fair skin, medium brown hair pulled back, full round face, plus-size curvy body type (US size 14-16)' },
  { id: 'mixed-black-athletic', label: 'Light Black/Mixed · Athletic', presenter: 'Light-skinned Black or mixed-race woman, mid-20s, warm caramel skin tone, natural curly hair in a high puff, defined cheekbones, slim athletic body' },
  { id: 'brunette-girlnextdoor', label: 'Girl-Next-Door Brunette · Slim', presenter: 'Caucasian/mixed-race woman, early-to-mid 20s, fair-to-light tan skin, dark brown straight long hair in a low ponytail, friendly approachable face, slim body' },
  { id: 'asian-american', label: 'Asian-American · Slim', presenter: 'East-Asian American woman, mid-20s, light skin, long straight black hair, delicate features with a gentle smile, slim petite body' },
  { id: 'deep-skin-black', label: 'Deep-Skin Black · Average', presenter: 'Black woman, mid-20s, rich deep brown skin tone, natural coily hair worn out in a rounded shape, full lips and high cheekbones, average curvy body' },
  { id: 'mature-blonde', label: 'Mature · Fit Blonde (late 30s)', presenter: 'Caucasian woman, late 30s to early 40s, sun-kissed fair skin, shoulder-length blonde hair, confident mature face with light natural lines, fit toned body' },
  { id: 'south-asian-petite', label: 'South-Asian · Petite', presenter: 'South-Asian (Indian) woman, mid-20s, warm brown skin, long dark wavy hair, expressive eyes, petite slim frame' },
  { id: 'fitness-athletic', label: 'Fitness · Toned', presenter: 'Caucasian/Latina mixed woman, mid-20s, tan skin, brown hair in a high ponytail, sporty fresh-faced look, toned muscular athletic body with visible fitness' },
]

function buildModelIdentityPrompt(profile) {
  return [
    `Photorealistic half-body portrait of ${profile.presenter}.`,
    'She wears a simple plain neutral-color bra with NO logos and NO text, standing facing the camera in a relaxed natural pose, hands relaxed at her sides.',
    'Clean evenly-lit plain light-grey studio background. Natural soft lighting, realistic skin texture, authentic look (NOT glamour, NOT heavily retouched, NOT airbrushed).',
    'Front-facing, head and upper body clearly visible, neutral expression with a faint friendly smile.',
    'This image is a CHARACTER IDENTITY REFERENCE — keep the face, hair, body type unambiguous and consistent.',
    'Single person only. No text, no watermark, no on-screen captions, no graphic overlays.',
  ].join(' ')
}

async function readLib() {
  try {
    const raw = await readFile(LIB_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { models: [], updatedAt: null }
  }
}

async function writeLib(lib) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(LIB_PATH, JSON.stringify(lib, null, 2))
}

export async function listModels() {
  return (await readLib()).models
}

export async function getModel(id) {
  return (await readLib()).models.find(m => m.id === id) || null
}

async function downloadToTmp(url) {
  const tmp = path.join(os.tmpdir(), `${uuidv4()}-model.png`)
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  await writeFile(tmp, res.data)
  return tmp
}

// 生成一个画像的定妆照（text-to-image），返回 { id, label, imageUrl } 或抛错
async function generateOne(profile, imageModel) {
  const { taskId } = await createImageTask({
    model: imageModel,
    prompt: buildModelIdentityPrompt(profile),
    aspectRatio: '2:3',
  })
  console.log(`[model-library] ${profile.id}: 提交任务 ${taskId}`)
  const result = await waitForTask(taskId, { pollMs: 6000, maxAttempts: 60 })
  console.log(`[model-library] ${profile.id}: 轮询结束 state=${result.state} imageUrl=${result.imageUrl ? 'OK' : 'MISSING'}${result.failMsg ? ' fail=' + result.failMsg : ''}`)
  if (result.state !== 'success' || !result.imageUrl) {
    // 拿不到图时 dump 原始返回，确认图像任务的返回结构（可能和视频不同）
    try {
      const raw = await getTaskStatus(taskId)
      console.log(`[model-library] ${profile.id}: 原始返回 ${JSON.stringify(raw).slice(0, 600)}`)
    } catch {}
    throw new Error(result.failMsg || `模特 ${profile.id} 生成失败（state=${result.state}）`)
  }
  let tmp = null
  try {
    tmp = await downloadToTmp(result.imageUrl)
    const s3Url = await uploadMediaFile(tmp, `model-${profile.id}.png`)
    console.log(`[model-library] ${profile.id}: 已上传 S3`)
    return { id: profile.id, label: profile.label, presenter: profile.presenter, imageUrl: s3Url }
  } catch (e) {
    console.log(`[model-library] ${profile.id}: 下载/上传失败 ${e.message}`)
    throw e
  } finally {
    if (tmp) await unlink(tmp).catch(() => {})
  }
}

// 预生成模特库（一次性，管理用）。only=[id,...] 可只生成指定画像（补/重生成）。
export async function generateModelLibrary({ imageModel = 'gpt-image-2-text-to-image', only = null, force = false, onProgress = null } = {}) {
  const lib = await readLib()
  const byId = new Map(lib.models.map(m => [m.id, m]))
  // 默认只补缺失（断点续生成，避免重复已有 + 被重启打断后可继续）；force=true 才全量重生成
  let profiles
  if (only?.length) profiles = MODEL_PROFILES.filter(p => only.includes(p.id))
  else if (force) profiles = MODEL_PROFILES
  else profiles = MODEL_PROFILES.filter(p => !byId.get(p.id)?.imageUrl)
  if (profiles.length === 0) return MODEL_PROFILES.map(p => byId.get(p.id)).filter(Boolean)

  // 串行写锁：并行生成时每个完成都落盘（前端增量可见），但写操作排队，避免互相覆盖
  let writeChain = Promise.resolve()
  const flush = () => {
    const snapshot = { models: MODEL_PROFILES.map(p => byId.get(p.id)).filter(Boolean), updatedAt: Date.now() }
    writeChain = writeChain.then(() => writeLib(snapshot)).catch(e => console.warn('[model-library] 落盘失败:', e.message))
    return writeChain
  }

  // 并行生成所有画像（每个独立提交+轮询），不再一个个串行等
  await Promise.all(profiles.map(async profile => {
    try {
      if (onProgress) onProgress({ id: profile.id, state: 'generating' })
      const model = await generateOne(profile, imageModel)
      byId.set(model.id, model)
      await flush()
      if (onProgress) onProgress({ id: profile.id, state: 'done', imageUrl: model.imageUrl })
    } catch (e) {
      console.warn(`[model-library] ${profile.id} 生成失败: ${e.message}`)
      if (onProgress) onProgress({ id: profile.id, state: 'failed', error: e.message })
    }
  }))
  await writeChain

  return MODEL_PROFILES.map(p => byId.get(p.id)).filter(Boolean)
}
