// 媒体（图片 / 短视频片段）上传服务 — 直传到我们自己的 S3 bucket（hypit/tiktok_ai/）
// 旧版本走 kie.ai tempfile.redpandaai.co，3-7 天后 404 — 已废弃（见 kieai-upload.js git 历史）
// 仍保留 prepareImage 的 resize/compress 是因为 Seedance 也有边长上下限和体积偏好（不是 kie 的限制）
import { createReadStream, statSync, readFileSync } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import sharp from 'sharp'
import { uploadBufferToS3 } from './s3-upload.js'

// Seedance 单边上限 6000px，留 500 安全缓冲
const MAX_SIDE = 5500
// Seedance 单边下限 300px
const MIN_SIDE = 300
// 单张图片文件大小上限：2MB（超了就降质量；非 S3 限制，是给 Seedance 抓取留余地）
const MAX_FILE_BYTES = 2 * 1024 * 1024
// 像素总数软上限 36M（kie 历史遗留约束，对 S3 无所谓，但 Seedance 处理超大图也慢）
const MAX_PIXELS = 36_000_000
// 最大并发上传数
const CONCURRENCY = 4

const EXT_CONTENT_TYPE = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

// 图片压缩：先限像素，再限文件大小。返回 { buffer, useOriginal }
async function prepareImage(filePath) {
  const image = sharp(filePath)
  const meta = await image.metadata()
  const pixels = meta.width * meta.height
  const originalSize = statSync(filePath).size

  let pipeline = sharp(filePath)
  let resized = false

  if (meta.width < MIN_SIDE || meta.height < MIN_SIDE) {
    throw new Error(`图片尺寸过小 ${meta.width}x${meta.height}（单边需 ≥ ${MIN_SIDE}px）`)
  }

  const sideScale = Math.min(1, MAX_SIDE / Math.max(meta.width, meta.height))
  const pixelScale = pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1
  const scale = Math.min(sideScale, pixelScale)
  if (scale < 1) {
    const newW = Math.floor(meta.width * scale)
    const newH = Math.floor(meta.height * scale)
    console.log(`  [compress] 像素缩放 ${meta.width}x${meta.height} → ${newW}x${newH}`)
    pipeline = pipeline.resize(newW, newH)
    resized = true
  }

  let buffer = await pipeline.jpeg({ quality: 85 }).toBuffer()

  if (buffer.length > MAX_FILE_BYTES) {
    for (const q of [75, 65, 55]) {
      buffer = await sharp(buffer).jpeg({ quality: q }).toBuffer()
      console.log(`  [compress] 质量降至 ${q}，大小 ${(buffer.length / 1024).toFixed(0)} KB`)
      if (buffer.length <= MAX_FILE_BYTES) break
    }
  }

  const needsProcessing = resized || originalSize > MAX_FILE_BYTES
  if (!needsProcessing && buffer.length >= originalSize) {
    return { buffer: null, useOriginal: true }
  }

  console.log(`  [compress] 最终 ${(buffer.length / 1024).toFixed(0)} KB（原 ${(originalSize / 1024).toFixed(0)} KB）`)
  return { buffer, useOriginal: false }
}

// 上传单个媒体文件（图片或视频片段）到 S3，失败重试多次
// 图片：会先 prepareImage 缩放/压缩；视频/其他：直接读 buffer 上传
async function uploadWithRetry(filePath, originalName, retries = 3) {
  const ext = path.extname(originalName).toLowerCase()
  const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)

  let buffer
  let uploadExt = ext

  if (isImage) {
    const prepared = await prepareImage(filePath)
    if (prepared.useOriginal) {
      buffer = readFileSync(filePath)
    } else {
      buffer = prepared.buffer
      uploadExt = '.jpg'  // prepareImage 总是输出 jpeg
    }
  } else {
    buffer = readFileSync(filePath)
  }

  const contentType = EXT_CONTENT_TYPE[uploadExt] || 'application/octet-stream'
  const fileName = `${uuidv4()}${uploadExt}`

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await uploadBufferToS3(buffer, fileName, contentType)
    } catch (err) {
      if (attempt < retries) {
        const delayMs = 3000 * (attempt + 1)
        console.warn(`  [s3 upload] 第 ${attempt + 1} 次失败，${Math.round(delayMs / 1000)}s 后重试: ${err.message}`)
        await new Promise(r => setTimeout(r, delayMs))
      } else {
        throw err
      }
    }
  }
}

// 单文件上传（图片或视频片段）
export async function uploadMediaFile(filePath, originalName) {
  return uploadWithRetry(filePath, originalName)
}

// 批量上传，最多 CONCURRENCY 个并发
export async function uploadMediaFiles(files) {
  const results = new Array(files.length)
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (file, batchIdx) => {
        const index = i + batchIdx
        const url = await uploadWithRetry(file.path, file.originalname)
        console.log(`  [s3 upload] ${index + 1}/${files.length} ✅ ${(statSync(file.path).size / 1024).toFixed(0)}KB → ${url.split('/').pop()}`)
        return { index, url, originalname: file.originalname }
      })
    )
    batchResults.forEach(r => { results[r.index] = r })
  }
  return results
}

// ===== 缩略图流水线 =====
// 产品图展示场景：原图（用于 Seedance / 大图查看）+ 400px thumb（用于前端 grid）
// 仅供 routes/product.js 的爬虫 / 用户上传两条路径用；视频片段、生成期 transient 图不走这条

const THUMB_MAX_SIDE = 400  // 长边，cover-fit
const THUMB_QUALITY = 80

// 输入：原图文件路径；输出：thumb 的 Buffer（始终 jpeg）
async function generateThumb(filePath) {
  const buf = await sharp(filePath)
    .rotate()  // 尊重 EXIF orientation
    .resize(THUMB_MAX_SIDE, THUMB_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer()
  return buf
}

// 同时上传原图 + thumb，返回 { url, thumbUrl }。thumb 上传失败不阻塞原图（thumbUrl=null fallback）
export async function uploadMediaFileWithThumb(filePath, originalName) {
  const url = await uploadWithRetry(filePath, originalName)
  let thumbUrl = null
  try {
    const thumbBuf = await generateThumb(filePath)
    // thumb 文件名 = 原图 uuid + _thumb.jpg（从 url 反推 uuid 较脆弱，所以另起一个 uuid）
    const thumbName = `${uuidv4()}_thumb.jpg`
    thumbUrl = await uploadBufferToS3(thumbBuf, thumbName, 'image/jpeg')
  } catch (e) {
    console.warn(`  [thumb] 生成/上传失败（fallback 用原图）: ${e.message}`)
  }
  return { url, thumbUrl }
}

// 批量版，CONCURRENCY 并发，返回 [{ index, url, thumbUrl, originalname }, ...]
export async function uploadMediaFilesWithThumb(files) {
  const results = new Array(files.length)
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (file, batchIdx) => {
        const index = i + batchIdx
        const { url, thumbUrl } = await uploadMediaFileWithThumb(file.path, file.originalname)
        console.log(`  [s3 upload+thumb] ${index + 1}/${files.length} ✅ ${url.split('/').pop()}`)
        return { index, url, thumbUrl, originalname: file.originalname }
      })
    )
    batchResults.forEach(r => { results[r.index] = r })
  }
  return results
}
