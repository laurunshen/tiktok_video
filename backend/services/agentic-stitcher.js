import { spawn } from 'child_process'

export function extractLastFrame(videoPath, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-sseof', '-0.2',
      '-i', videoPath,
      '-update', '1',
      '-frames:v', '1',
      outPath,
    ])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg extractLastFrame exit ${code}: ${stderr.slice(-400)}`))
    })
    proc.on('error', reject)
  })
}

// 竖屏 9:16 目标分辨率。支持 '480p'/'720p'/'1080p' 预设或 'WxH' 字符串，
// 默认 480x854，避免之前写死 480 把 720p/1080p 降级。
function resolveDimensions(resolution = '480p') {
  const presets = { '480p': [480, 854], '720p': [720, 1280], '1080p': [1080, 1920] }
  if (presets[resolution]) return { w: presets[resolution][0], h: presets[resolution][1] }
  const m = String(resolution).match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/)
  if (m) {
    const a = parseInt(m[1], 10)
    const b = parseInt(m[2], 10)
    return a <= b ? { w: a, h: b } : { w: b, h: a } // 竖屏：宽 < 高
  }
  return { w: 480, h: 854 }
}

export function stitchSegments(segmentPaths, outPath, { resolution = '480p', withAudio = true } = {}) {
  return new Promise((resolve, reject) => {
    const { w, h } = resolveDimensions(resolution)
    const n = segmentPaths.length
    const inputArgs = segmentPaths.flatMap(filePath => ['-i', filePath])

    const vPrep = segmentPaths
      .map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`)
      .join(';')

    let filter
    let mapArgs
    let codecArgs
    if (withAudio) {
      const aPrep = segmentPaths
        .map((_, i) => `[${i}:a]aresample=async=1:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`)
        .join(';')
      const concatInputs = segmentPaths.map((_, i) => `[v${i}][a${i}]`).join('')
      filter = `${vPrep};${aPrep};${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`
      mapArgs = ['-map', '[vout]', '-map', '[aout]']
      codecArgs = ['-c:a', 'aac', '-b:a', '128k']
    } else {
      const concatInputs = segmentPaths.map((_, i) => `[v${i}]`).join('')
      filter = `${vPrep};${concatInputs}concat=n=${n}:v=1:a=0[vout]`
      mapArgs = ['-map', '[vout]']
      codecArgs = []
    }

    const proc = spawn('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filter,
      ...mapArgs,
      '-movflags', '+faststart',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      ...codecArgs,
      outPath,
    ])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg stitchSegments exit ${code}: ${stderr.slice(-400)}`))
    })
    proc.on('error', reject)
  })
}
