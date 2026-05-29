import { existsSync, readdirSync } from 'fs'
import path from 'path'

function findInWingetPackage(exeName) {
  if (process.platform !== 'win32') return null
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(base)) return null

  for (const packageDir of readdirSync(base, { withFileTypes: true })) {
    if (!packageDir.isDirectory()) continue
    if (!/Gyan\.FFmpeg|FFmpeg/i.test(packageDir.name)) continue

    const packagePath = path.join(base, packageDir.name)
    const buildDirs = readdirSync(packagePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(packagePath, d.name))

    for (const buildDir of buildDirs) {
      const candidate = path.join(buildDir, 'bin', exeName)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function resolveExecutable(exeName, envVarName) {
  const envPath = process.env[envVarName]
  if (envPath && existsSync(envPath)) return envPath

  const wingetPath = findInWingetPackage(exeName)
  if (wingetPath) return wingetPath

  return exeName
}

export function resolveFfmpegPath() {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return resolveExecutable(exeName, 'FFMPEG_PATH')
}

export function resolveFfprobePath() {
  const exeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return resolveExecutable(exeName, 'FFPROBE_PATH')
}

export function ffmpegInstallHint() {
  if (process.platform === 'win32') {
    return 'ffmpeg not found. Install ffmpeg and make sure ffmpeg.exe is available in PATH, or set FFMPEG_PATH/FFPROBE_PATH in backend/.env to the full exe paths.'
  }
  return 'ffmpeg not found. Install ffmpeg and make sure ffmpeg/ffprobe are available in PATH, or set FFMPEG_PATH/FFPROBE_PATH in backend/.env to full binary paths.'
}
