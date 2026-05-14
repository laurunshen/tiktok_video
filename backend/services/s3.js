import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFile } from 'fs/promises'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
})

// 上传单个文件，返回公开URL
export async function uploadFileToS3(filePath, originalName) {
  const ext = path.extname(originalName)
  const key = `video-gen/${uuidv4()}${ext}`
  const fileBuffer = await readFile(filePath)

  const contentTypeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
  }
  const contentType = contentTypeMap[ext.toLowerCase()] || 'application/octet-stream'

  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  }))

  // 返回公开URL（需要S3 bucket设置为public read）
  const url = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`
  return url
}

// 批量上传图片，返回 { originalIndex, url } 数组
export async function uploadImagesToS3(files) {
  const results = await Promise.all(
    files.map(async (file, index) => {
      const url = await uploadFileToS3(file.path, file.originalname)
      return { index, url, originalname: file.originalname }
    })
  )
  return results
}
