import 'dotenv/config'
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

const app = express()
const PORT = process.env.PORT || 3001

// Ensure uploads dir exists
await mkdir('./uploads', { recursive: true })

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
