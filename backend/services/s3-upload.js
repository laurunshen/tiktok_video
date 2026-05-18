// S3 上传服务：把临时 kie.ai 视频持久化到用户自己的 hypit bucket
// 用 USE_S3=TRUE 控制开关；任何一个 AWS_* 缺失也会自动退化为禁用
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import axios from 'axios'
import { spawn } from 'child_process'
import { writeFile, readFile, unlink, mkdtemp, rmdir } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

const region = process.env.AWS_S3_REGION_NAME || 'us-east-1'
const bucket = process.env.AWS_STORAGE_BUCKET_NAME
const enabled = process.env.USE_S3 === 'TRUE'
  && !!bucket
  && !!process.env.AWS_ACCESS_KEY_ID
  && !!process.env.AWS_SECRET_ACCESS_KEY

const s3 = enabled ? new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}) : null

export const S3_ENABLED = enabled
export const S3_PREFIX = 'tiktok_ai/'
export const S3_BUCKET = bucket
export const S3_REGION = region

// 公网 URL（virtual-hosted style）
function publicUrl(key) {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`
}

// 上传 buffer 到 s3://hypit/tiktok_ai/<filename>，返回公网 URL
// ACL: 'public-read' — 让 <video> 标签能直接拉。如果 bucket 启用了 Block Public Access，
// 这一行会让 PutObject 报 AccessDenied；那时改用 presigned URL（见 getReadableUrl）
export async function uploadBufferToS3(buffer, filename, contentType = 'video/mp4') {
  if (!s3) throw new Error('S3 not configured (check USE_S3 + AWS_* env vars)')
  const key = `${S3_PREFIX}${filename}`
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read',
  }))
  return publicUrl(key)
}

// 远程 URL → 下载 → 上传 S3。filename 不带前缀，仅文件名（如 "abc123.mp4"）
export async function uploadUrlToS3(sourceUrl, filename, contentType = 'video/mp4') {
  if (!s3) throw new Error('S3 not configured')
  const res = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  return uploadBufferToS3(Buffer.from(res.data), filename, contentType)
}

// 从视频 buffer 抽第 1 秒的一帧，缩到 360w，输出 JPG buffer。
// MP4 moov atom 位置不定（faststart 在头部，否则在尾部）→ ffmpeg 需要可 seek 的输入，
// 故走临时文件而非 stdin pipe。
async function extractFirstFramePoster(videoBuffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'poster-'))
  const inPath = path.join(dir, 'in.mp4')
  const outPath = path.join(dir, 'out.jpg')
  try {
    await writeFile(inPath, videoBuffer)
    await new Promise((resolve, reject) => {
      // -ss 在 -i 之前 = 快速 seek（关键帧近似）；1 秒避开可能的黑帧/淡入
      const ff = spawn('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', inPath,
        '-frames:v', '1',
        '-q:v', '5',
        '-vf', 'scale=360:-2',
        outPath,
      ])
      let stderr = ''
      ff.stderr.on('data', d => { stderr += d.toString() })
      ff.on('error', reject)
      ff.on('close', code => code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)))
    })
    return await readFile(outPath)
  } finally {
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
    await rmdir(dir).catch(() => {})
  }
}

// 一次性下载视频 → 上传视频 + 生成并上传 poster JPG。baseName 不含扩展名。
// 视频失败抛错；poster 失败仅 warn 不阻塞（posterUrl 为 null）。
export async function uploadVideoAndPosterFromUrl(sourceUrl, baseName) {
  if (!s3) throw new Error('S3 not configured')
  const res = await axios.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const videoBuffer = Buffer.from(res.data)
  const videoUrl = await uploadBufferToS3(videoBuffer, `${baseName}.mp4`, 'video/mp4')
  let posterUrl = null
  try {
    const posterBuffer = await extractFirstFramePoster(videoBuffer)
    posterUrl = await uploadBufferToS3(posterBuffer, `${baseName}.jpg`, 'image/jpeg')
  } catch (e) {
    console.warn(`[poster] generation failed for ${baseName}: ${e.message}`)
  }
  return { videoUrl, posterUrl }
}

// 从已存在的 S3 视频生成 poster（backfill 用）。返回 posterUrl 或 null。
export async function generatePosterForExistingVideo(videoUrl, baseName) {
  if (!s3) throw new Error('S3 not configured')
  const res = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  const posterBuffer = await extractFirstFramePoster(Buffer.from(res.data))
  return uploadBufferToS3(posterBuffer, `${baseName}.jpg`, 'image/jpeg')
}

// 判断一个 URL 是否已经是本 bucket 的 S3 URL（migration 幂等用）
export function isOurS3Url(url) {
  if (!url || !bucket) return false
  return url.includes(`${bucket}.s3.`) && url.includes(S3_PREFIX)
}
