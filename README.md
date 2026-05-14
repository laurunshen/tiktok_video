# AI Video Generator

## 本地运行

### 1. 克隆 & 安装依赖

```bash
# 后端
cd backend
npm install

# 前端
cd ../frontend
npm install
```

### 2. 配置环境变量

```bash
cd backend
cp .env.example .env
# 编辑 .env，填入所有 API Key
```

`.env` 需要填写：
- `ANTHROPIC_API_KEY` — https://console.anthropic.com
- `GEMINI_API_KEY` — https://aistudio.google.com
- `KIE_TOKEN` — kie.ai 控制台
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `S3_BUCKET_NAME`
- `CALLBACK_BASE_URL` — 本地测试用 ngrok（见下方）

### 3. S3 Bucket 配置

Bucket 需要允许公开读取，在 AWS Console 里：
- Permissions → Block public access → 全部关闭
- Bucket Policy 添加：

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
  }]
}
```

### 4. 本地 Webhook（ngrok）

kie.ai 需要回调一个公网地址，本地用 ngrok 转发：

```bash
# 安装 ngrok: https://ngrok.com/download
ngrok http 3001
# 得到类似: https://abc123.ngrok.io
# 把这个地址填入 .env 的 CALLBACK_BASE_URL
```

> 注：ngrok 每次重启地址会变，重启后需要更新 .env

### 5. 启动

```bash
# 终端 1 - 后端
cd backend
npm run dev

# 终端 2 - 前端
cd frontend
npm run dev
```

打开 http://localhost:5173

---

## 部署到 AWS EC2

```bash
# 1. 上传代码
scp -r ./video-gen ubuntu@your-ec2-ip:~/

# 2. 安装 Node.js (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 安装 PM2
sudo npm install -g pm2

# 4. 后端
cd ~/video-gen/backend
npm install
cp .env.example .env  # 填入生产环境变量
# CALLBACK_BASE_URL 改为 EC2 公网 IP 或域名

# 5. 前端 build
cd ~/video-gen/frontend
npm install
npm run build
# 将 dist/ 用 nginx 托管

# 6. 启动后端
cd ~/video-gen/backend
pm2 start server.js --name video-gen-backend
pm2 save
pm2 startup
```

---

## 工作流说明

1. 用户上传参考视频 + 产品图片 + 自定义描述
2. Gemini 2.0 Flash 分析参考视频（脚本、模特风格、拍摄风格）
3. 图片 + 视频上传到 S3 获取公开 URL
4. Claude Sonnet 筛选最佳图片，压缩脚本到15秒，生成 Seedance2 提示词
5. 批量提交到 kie.ai（最多5个并发）
6. 前端每8秒轮询状态，视频完成后展示
