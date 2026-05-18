// 显式从本文件所在目录加载 .env，避免依赖启动时的 CWD。
// 必须作为 server.js 第一个 import（side-effect）—— ES 模块 import 是 hoisted，
// 这样其它模块（gemini.js 等）evaluated 之前 process.env 已就绪。
import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') })
