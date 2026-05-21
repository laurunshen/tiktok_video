// Gemini 调用统一重试封装。
// 502/503/429/500 和网络错误都是瞬时故障，退避后重试，避免一次抽风就整个任务失败。

/**
 * @param {object} genai - GoogleGenAI 实例
 * @param {object} req - 传给 genai.models.generateContent 的请求体
 * @param {{ label?: string, maxAttempts?: number }} opts
 */
export async function generateContentWithRetry(genai, req, { label = 'Gemini', maxAttempts = 4 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await genai.models.generateContent(req)
    } catch (e) {
      lastErr = e
      const msg = String(e?.message || e)
      const transient =
        /\b(502|503|429|500)\b/.test(msg) ||
        /ECONNRESET|ETIMEDOUT|fetch failed|terminated|Bad Gateway|overloaded|UNAVAILABLE|deadline/i.test(msg)
      if (!transient || attempt === maxAttempts) break
      const waitMs = 1500 * attempt
      console.warn(`  [${label}] 第 ${attempt} 次失败（瞬时错误），${waitMs}ms 后重试: ${msg.slice(0, 120)}`)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  throw lastErr
}
