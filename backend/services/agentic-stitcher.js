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

export function stitchSegments(segmentPaths, outPath) {
  return new Promise((resolve, reject) => {
    const inputArgs = segmentPaths.flatMap(filePath => ['-i', filePath])
    const prepared = segmentPaths
      .map((_, index) => `[${index}:v]scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`)
      .join(';')
    const inputs = segmentPaths.map((_, index) => `[v${index}]`).join('')
    const filter = `${prepared};${inputs}concat=n=${segmentPaths.length}:v=1:a=0[vout]`
    const proc = spawn('ffmpeg', [
      '-y',
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[vout]',
      '-movflags', '+faststart',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
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
