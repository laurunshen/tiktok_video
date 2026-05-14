import axios from 'axios'

const TIKHUB_API_KEY = 'jLENGegc5UayyV+YNqaF+Q6LJhDSZqs90T7/oxjebuCXm2q6e3GKdSu9Kw=='
const TIKHUB_BASE = 'https://api.tikhub.io'
const MAX_RETRIES = 2

// 从 TikTok URL 中提取 aweme_id
function extractAwemeId(url) {
  const match = url.match(/\/video\/(\d+)/)
  return match ? match[1] : null
}

/**
 * 获取 TikTok 无水印视频播放直链（通过 TikHub API）
 * @param {string} videoUrl - TikTok 视频链接
 * @returns {string|null} 无水印播放直链，失败返回 null
 */
export async function getTikTokPlaybackUrl(videoUrl) {
  if (!videoUrl || !videoUrl.includes('tiktok.com')) {
    console.error('  [tikhub video] URL 格式不正确:', videoUrl)
    return null
  }

  const awemeId = extractAwemeId(videoUrl)
  if (!awemeId) {
    console.error('  [tikhub video] 无法提取 video ID:', videoUrl)
    return null
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  [tikhub video] 第 ${attempt} 次解析 video_id=${awemeId}`)
      const res = await axios.get(`${TIKHUB_BASE}/api/v1/tiktok/app/v3/fetch_one_video`, {
        params: { aweme_id: awemeId, url: videoUrl },
        headers: { Authorization: `Bearer ${TIKHUB_API_KEY}` },
        timeout: 30000,
      })

      if (res.data?.code !== 200) {
        console.warn(`  [tikhub video] 第 ${attempt} 次返回 code=${res.data?.code}`)
        continue
      }

      const aweme = res.data?.data?.aweme_detail
      // 按优先级取播放地址
      const playUrl =
        aweme?.video?.play_addr?.url_list?.[0] ||
        aweme?.video?.download_addr?.url_list?.[0] ||
        aweme?.video?.bit_rate?.[0]?.play_addr?.url_list?.[0]

      if (!playUrl) {
        console.warn(`  [tikhub video] 第 ${attempt} 次未找到播放地址`)
        continue
      }

      console.log(`  [tikhub video] ✅ 解析成功`)
      return playUrl

    } catch (err) {
      const status = err.response?.status
      console.warn(`  [tikhub video] 第 ${attempt} 次异常 (${status || err.message})`)
      if (status === 400 && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 3000))
      } else if (attempt >= MAX_RETRIES) {
        break
      }
    }
  }

  console.error('  [tikhub video] 所有重试均失败')
  return null
}
