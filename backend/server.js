import './load-env.js'  // 必须第一个 import，给 process.env 灌入 .env

// 给所有 console.log/warn/error 前缀加 HH:MM:SS.mmm 时间戳。
// 排查"哪一步慢"必备 —— 多行 message 只在第一行加前缀，可视化对齐。
for (const lvl of ['log', 'warn', 'error']) {
  const orig = console[lvl].bind(console)
  console[lvl] = (...args) => {
    const d = new Date()
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    orig(`[${ts}]`, ...args)
  }
}

// 延长 undici 默认超时（@google/genai 用原生 fetch，默认 headersTimeout 5分钟会切断 Gemini 长请求）
import { Agent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new Agent({
  headersTimeout: 900_000,    // 15分钟
  bodyTimeout: 900_000,       // 15分钟
  connectTimeout: 60_000,     // 1分钟
}))
import express from 'express'
import cors from 'cors'
import { mkdir } from 'fs/promises'
import generateRouter from './routes/generate.js'
import callbackRouter from './routes/callback.js'
import productRouter from './routes/product.js'
import { initDb } from './services/db.js'

const app = express()
const PORT = process.env.PORT || 3001

// Ensure uploads dir exists
await mkdir('./uploads', { recursive: true })

// 初始化数据库（建表 + 迁移 + 清僵尸 job）
await initDb()

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json())

app.use('/api/generate', generateRouter)
app.use('/api/callback', callbackRouter)
app.use('/api/product', productRouter)

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/api/health`)
})
