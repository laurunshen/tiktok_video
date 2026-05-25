# TikTok Video Generator

自动化生成 TikTok UGC 带货视频（参考视频风格迁移 + 商品一致性约束 + 异步生成评分）。

详细状态与架构演进见：[docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)

## 功能概览

- 输入：商品链接（爬产品图）+ 参考视频 + 生成参数
- 输出：9:16 竖屏短视频（当前主流程走 Seedance 2 via kie.ai）
- 生成模式：
  - `normal`
  - `before-after`（含 0-2s 快切 hook + 概念助手）
- 前端模块：
  - 生成
  - 产品管理
  - 历史
  - 达人视频
  - 模板库

## 技术栈

- Frontend: React + Vite（默认 `5173`）
- Backend: Node.js + Express（默认 `3001`）
- Database: PostgreSQL（AWS RDS）
- Storage: AWS S3
- AI/Video: Gemini（分析/生成/评审）+ Seedance 2（kie.ai）
- Media tools: `ffmpeg` + `ffprobe`

## 本地开发

### 1. 安装依赖

```bash
# backend
cd backend
npm install

# frontend
cd ../frontend
npm install
```

### 2. 配置环境变量

```bash
cd backend
cp .env.example .env
# 然后按下文补全 .env
```

常用变量（以代码实际读取为准）：

- API
  - `GEMINI_API_KEY`
  - `KIE_TOKEN`
- Backend
  - `PORT=3001`
  - `CALLBACK_BASE_URL`（本地通常用 ngrok）
- AWS / S3
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_STORAGE_BUCKET_NAME`
  - `AWS_S3_REGION_NAME`
  - `USE_S3=TRUE`
- PostgreSQL
  - `DB_HOST`
  - `DB_PORT`
  - `DB_NAME`
  - `DB_USER`
  - `DB_PASSWORD`
- FFmpeg（可选，PATH 不可用时再配）
  - `FFMPEG_PATH`
  - `FFPROBE_PATH`

### 3. 安装 FFmpeg（必需）

后端会调用 `ffmpeg/ffprobe` 做视频片段截取与探测。

- macOS（Homebrew）

```bash
brew install ffmpeg
```

- Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

- Windows（任选其一）

```powershell
winget install Gyan.FFmpeg
```

安装后自检：

```bash
ffmpeg -version
ffprobe -version
```

如果命令不可用，请把可执行文件完整路径写入 `backend/.env`：

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
FFPROBE_PATH=/absolute/path/to/ffprobe
```

Windows 示例：

```env
FFMPEG_PATH=C:\\ffmpeg\\bin\\ffmpeg.exe
FFPROBE_PATH=C:\\ffmpeg\\bin\\ffprobe.exe
```

### 4. 启动服务（必须前后端同时启动）

必须同时启动 Frontend + Backend，缺一不可。

```bash
# 终端 1
cd backend
npm run dev

# 终端 2
cd frontend
npm run dev
```

访问：[http://localhost:5173](http://localhost:5173)

说明：前端会把 `/api` 代理到 `3001`。只开前端会出现接口报错（例如 `Unexpected end of JSON input`）。

### 5. 本地 webhook（如需回调）

kie.ai 回调需要公网地址，本地通常用 ngrok：

```bash
ngrok http 3001
```

把 ngrok 地址填到：

```env
CALLBACK_BASE_URL=https://xxxx.ngrok-free.app
```

## 常见问题排查

### `ffmpeg not found`

原因：

- 系统未安装 `ffmpeg`
- `ffmpeg/ffprobe` 未进入 `PATH`
- 路径配置错误（`FFMPEG_PATH/FFPROBE_PATH`）

排查顺序：

1. 终端执行 `ffmpeg -version`、`ffprobe -version`
2. 若失败，先安装 ffmpeg
3. 仍失败则在 `backend/.env` 显式设置 `FFMPEG_PATH/FFPROBE_PATH`
4. 重启 backend

### 前端请求失败或 JSON 解析错误

优先检查：

1. backend 是否运行在 `3001`
2. frontend 是否运行在 `5173`
3. 两边是否都已启动

## 项目结构

```text
tiktok_video/
├── backend/
│   ├── routes/
│   └── services/
├── frontend/
│   └── src/
└── docs/
    └── PROJECT_STATUS.md
```

## 关键文档

- 项目状态总览：[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)
- 协作约定：[`AGENTS.md`](AGENTS.md)

## 备注

- 本 README 以当前主分支实现为准；更细粒度的策略、模式矩阵、已知问题请以 `docs/PROJECT_STATUS.md` 为准。
