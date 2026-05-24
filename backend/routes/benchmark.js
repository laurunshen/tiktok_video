import express from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { extractBenchmarkFrames, cleanupFrameDir } from '../services/video-frames.js'
import { analyzeBenchmarkVideo } from '../services/benchmark-analyzer.js'

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
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (['.mp4', '.mov', '.m4v', '.webm'].includes(ext)) cb(null, true)
    else cb(new Error(`File type not allowed: ${file.originalname}`))
  },
})

router.post('/analyze', upload.single('benchmarkVideo'), async (req, res) => {
  const videoFile = req.file
  let frameDir = null

  try {
    if (!videoFile) return res.status(400).json({ error: 'Please upload benchmarkVideo' })

    const frameResult = await extractBenchmarkFrames(videoFile.path, {
      baseFps: Number(req.body.baseFps) || 4,
      hookFps: Number(req.body.hookFps) || 6,
      hookDuration: Number(req.body.hookDuration) || 3,
      width: Number(req.body.width) || 512,
      maxFrames: Number(req.body.maxFrames) || 80,
      sceneThreshold: Number(req.body.sceneThreshold) || 0.3,
    })
    frameDir = frameResult.dir

    const analysis = await analyzeBenchmarkVideo({
      videoPath: videoFile.path,
      frames: frameResult.frames,
      frameStats: frameResult.stats,
      duration: frameResult.duration,
      sourceName: videoFile.originalname,
    })

    res.json({
      ok: true,
      video: {
        originalName: videoFile.originalname,
        size: videoFile.size,
        duration: frameResult.duration,
      },
      extraction: {
        frameCount: frameResult.frames.length,
        stats: frameResult.stats,
        frameTimeline: analysis.frameTimeline,
      },
      transcript: analysis.transcript,
      template: analysis.template,
      validation: analysis.validation,
    })
  } catch (err) {
    console.error('[benchmark] analyze error:', err)
    res.status(500).json({ error: err.message })
  } finally {
    if (frameDir) await cleanupFrameDir(frameDir)
    if (videoFile?.path) await unlink(videoFile.path).catch(() => {})
  }
})

export default router
