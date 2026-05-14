import axios from 'axios'
import { createReadStream, statSync } from 'fs'
import { writeFile, unlink } from 'fs/promises'
import path from 'path'
import os from 'os'
import FormData from 'form-data'
import { v4 as uuidv4 } from 'uuid'
import sharp from 'sharp'

const KIE_UPLOAD_BASE = 'https://kieai.redpandaai.co'

// kie.ai 像素上限：3600万
const MAX_PIXELS = 36_000_000
// 单张图片文件大小上限：2MB（超了就压缩质量）
const MAX_FILE_BYTES = 2 * 1024 * 1024
// 最大并发上传数
const CONCURRENCY = 2

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

// 图片压缩：先限像素，再限文件大小
async function prepareImage(filePath) {
  const image = sharp(filePath)
  const meta = await image.metadata()
  const pixels = meta.width * meta.height
  const originalSize = statSync(filePath).size

  let pipeline = sharp(filePath)
  let resized = false

  // 1. 像素超限 → 等比缩小
  if (pixels > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / pixels)
    const newW = Math.floor(meta.width * scale)
    const newH = Math.floor(meta.height * scale)
    console.log(`  [compress] 像素缩放 ${meta.width}x${meta.height} → ${newW}x${newH}`)
    pipeline = pipeline.resize(newW, newH)
    resized = true
  }

  // 2. 转 JPEG，先用 quality:85 试一次
  let buffer = await pipeline.jpeg({ quality: 85 }).toBuffer()

  // 3. 文件大小还超 → 逐步降质量
  if (buffer.length > MAX_FILE_BYTES) {
    for (const q of [75, 65, 55]) {
      buffer = await sharp(buffer).jpeg({ quality: q }).toBuffer()
      console.log(`  [compress] 质量降至 ${q}，大小 ${(buffer.length / 1024).toFixed(0)} KB`)
      if (buffer.length <= MAX_FILE_BYTES) break
    }
  }

  const needsProcessing = resized || originalSize > MAX_FILE_BYTES
  if (!needsProcessing && buffer.length >= originalSize) {
    // 压缩后反而更大（原本已是小图），直接用原文件
    return { buffer: null, useOriginal: true }
  }

  console.log(`  [compress] 最终 ${(buffer.length / 1024).toFixed(0)} KB（原 ${(originalSize / 1024).toFixed(0)} KB）`)
  return { buffer, useOriginal: false }
}

// 上传单个文件，失败自动重试一次
async function uploadWithRetry(filePath, originalName, retries = 1) {
  const ext = path.extname(originalName).toLowerCase()
  const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)

  let uploadPath = filePath
  let uploadExt = ext
  let tmpFile = null

  if (isImage) {
    const { buffer, useOriginal } = await prepareImage(filePath)
    if (!useOriginal) {
      tmpFile = path.join(os.tmpdir(), `${uuidv4()}.jpg`)
      await writeFile(tmpFile, buffer)
      uploadPath = tmpFile
      uploadExt = '.jpg'
    }
  }

  const mimeType = MIME_MAP[uploadExt] || 'application/octet-stream'
  const fileName = `${uuidv4()}${uploadExt}`
  const fileSize = statSync(uploadPath).size

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const form = new FormData()
      form.append('file', createReadStream(uploadPath), {
        filename: `${path.basename(originalName, ext)}${uploadExt}`,
        contentType: mimeType,
        knownLength: fileSize,
      })
      form.append('uploadPath', 'images/user-uploads')
      form.append('fileName', fileName)

      const response = await axios.post(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, form, {
        headers: {
          Authorization: `Bearer ${process.env.KIE_TOKEN}`,
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000, // 120s 超时（kie.ai 上传接口较慢）
      })

      const url =
        response.data?.data?.downloadUrl ||
        response.data?.data?.url ||
        response.data?.data?.fileUrl ||
        response.data?.url

      if (!url) throw new Error(`kie.ai upload failed: ${JSON.stringify(response.data)}`)
      return url

    } catch (err) {
      if (attempt < retries) {
        console.warn(`  [kie upload] 第 ${attempt + 1} 次失败，5s 后重试: ${err.message}`)
        await new Promise(r => setTimeout(r, 5000))
      } else {
        throw err
      }
    }
  }
}

export async function uploadFileToKie(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase()
  let tmpFile = null
  try {
    return await uploadWithRetry(filePath, originalName)
  } finally {
    if (tmpFile) await unlink(tmpFile).catch(() => {})
  }
}

// 限流并发批量上传，每次最多 CONCURRENCY 个
export async function uploadImagesToKie(files) {
  const results = new Array(files.length)

  // 分批执行
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (file, batchIdx) => {
        const index = i + batchIdx
        const url = await uploadWithRetry(file.path, file.originalname)
        console.log(`  [kie upload] ${index + 1}/${files.length} ✅ ${(statSync(file.path).size / 1024).toFixed(0)}KB → ${url.split('/').pop()}`)
        return { index, url, originalname: file.originalname }
      })
    )
    batchResults.forEach(r => { results[r.index] = r })
  }

  return results
}
