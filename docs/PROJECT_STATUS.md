# 项目当前状态总览

> 最后更新：2026-05-29 — before-after 模板模式已删除；新增「分步工作流」(WorkflowWizard) A→D；模特库 + 关键帧 + 并行出视频。
> 用途：记录当前项目架构、生成模式、已知问题、关键决策

---

## 1. 项目目标

**自动化生成 TikTok UGC 内衣带货视频**：
- 输入：商品链接（爬产品图）+ 一条同类目参考视频（学风格/节奏/脚本）
- 输出：480p/720p 9:16 竖屏视频，可直接发到 TikTok
- 核心需求：
  1. **产品细节绝对一致**（颜色 / 边缘 / 钢圈 / 肩带 / 扣子）
  2. **角色一致性**（同一人贯穿全程）
  3. **物理瑕疵零容忍**（无手指畸形、无字幕泄漏、无户外风声）
  4. **同一标杆能裂变出 5+ 条独立视频**（防 TikTok 查重）
  5. 用户痛点：**3 秒完播率低** → hook 要强；视频不宜过长（工作流上限 30s）

## 2. 三种生成路径

| 路径 | 入口 | 说明 | 状态 |
|---|---|---|---|
| **single_pass（传统单段）** | 🎬 生成 tab | 1 次 Seedance 直接出整条；reference_image + reference_video 驱动 | ✅ 稳定 |
| **agentic_segments（LLM 智能分镜）** | 🎬 生成 tab 开关 | LLM 把脚本拆 N 段、每段精简 prompt；首段 multimodal_reference + 尾帧链式喂下一段首帧 → 拼接；可选参考音色音频统一各段口播音色 | ✅ 代码完成 |
| **分步工作流（人机协同）** | 🧩 分步工作流 tab | 独立向导，预生成关键帧 → 各段视频**并行**出 → 拼接；每步可人工审核 / AI 辅助 / 自动托管 | ⚙️ 代码完成，未端到端实测 |

> **before-after 模板模式已于 2026-05-28 整体删除**（含 `services/before-after.js`、`routes/before-after.js`、`gemini.js` 的 `deriveBeforeAfterTemplate` + `mode` 参数全链路、前端开关/概念助手/适用性警告）。before/after 这种 hook 现在用「分步工作流的可选尾帧」实现（首帧=before、尾帧=after），更灵活、无需专用支路。`benchmark-analyzer.js` 里 hook_type 枚举的 "before-after" 是参考视频分类项，保留。

## 3. single_pass / agentic_segments 流程（🎬 生成 tab）

```
用户提交（商品 + 参考视频 + generationMode + 时长 + variant_seed [+ 参考音色音频]）
   ↓
Phase 1: 数据准备（TikHub 爬产品→S3；Snaptik 解析 TikTok→无水印直链）
   ↓
Phase 2: Gemini 生成（gemini-3.1-pro-preview，2 次调用）
   ├─ Pass 1（temp=0）: 视频+全部产品图 → video_analysis / product_visual_features /
   │   narrative_dna / dominant_color / selected_image_indices / compressed_script
   └─ Pass 2: 仅选中图 + Pass 1 JSON → 写 Seedance prompt（normal 流程）
   ↓
Phase 3: 质量门禁（程序化校验 + Gemini 二次评估，失败修订≤2 次）
   ↓
Phase 4: 强制注入块（代码硬拼接，绕过 Gemini 压缩）
   ↓
Phase 5: ffmpeg 截 14s 参考片段 + 上传（single_pass / agentic 首段用）
   ↓
Phase 6: Seedance 2 (kie.ai 'bytedance/seedance-2')
   ├─ single_pass：1 次出整条
   └─ agentic_segments：buildAgenticSegmentPlanLLM 出 N 段 → 逐段生成
       （首段 multimodal_reference + returnLastFrame → 尾帧作下一段 first_frame）→ ffmpeg 拼接
   ↓
Phase 7: 异步评分（video_judge 8 维 + diff_judge 差异化）
```

> 所有 Gemini 调用经 `gemini-retry.js`（502/503/429/网络错误退避重试 4 次）。

## 4. 分步工作流（🧩 分步工作流 tab）⭐ 本期重点

**动机**：agentic 串行（等上一段视频出来再抽尾帧）太慢；一条 prompt 塞多分镜模型不专注。
**核心收益**：关键帧用图像模型**预生成**（秒级）→ 各段视频**并行**出（每段用自己的首帧，不互等）。

**状态机**（复用 job 持久化，`full_data` JSON blob；workflowId 作 jobId，`type:'workflow'`，无需改表）：
```
analyzing → await_scripts → await_model → generating_keyframes →
await_keyframes → await_prompts → generating_videos → completed（任意步可 failed）
```

**步骤 / UI**：
1. **分析**：选产品（+ SKU 颜色筛选，防串色）+ 参考视频/TikTok 链接 + 时长 → `analyzeAndGeneratePrompt` + `buildAgenticSegmentPlanLLM` 出分段脚本
2. **审核脚本**：各段可编辑；「🤖 AI 看看」判断+建议+改写，可采纳
3. **选模特**：从模特库挑一个 / 随机
4. **各段首帧**：image-to-image，参考图 = [模特定妆照, 产品图]；可审核/改提示词/重生成；**每段可选开尾帧**（默认关，用于 before/after 或段内运动控制）
5. **审核视频提示词**：各段可编辑 + AI 辅助
6. **并行出视频 + 拼接**：每段 `createVideoTask`（first_frame +可选 last_frame）并行 → `stitchSegments` 拼接成片

**时长**：默认「自动」= 跟随参考视频实际时长（ffprobe，clamp [8,30]，TikTok 下载后量、失败回退 15）；用户可指定 8/10/15/20/25/30，**用户优先**。单段 ≤15s，更长靠多段相加（≤30s）。

**模特库**（`services/model-library.js`，存 `data/model-library.json`）：
- 10 个美国市场画像（扩展自 `VARIANT_RECIPES`）；gpt-image-2 **text-to-image** 预生成**纯身份定妆照**（脸/身材/发型，中性内衣），产品在各段首帧再叠加
- 预生成默认**只补缺失**（断点续生成）；`force` 才全量重生成
- 顶部「🎭 模特库」常驻入口，可预生成/查看/随机

**连贯性策略**：**全局资产锁定**（模特定妆照 + 产品图）而非链式首帧 —— 各段构图可完全不同（背面/正面/产品特写），模特和产品始终锁定。

**AI 辅助 / 自动托管**：每步可让 AI 判断+建议+改写（`services/workflow-ai.js` `aiReviewSegment`）；或「从这步起自动托管」`driveAutopilot` 一路跑到成片。

## 5. 数据模型（PostgreSQL on AWS RDS）

5 张表（同前）：`jobs`（任务全状态 + jobStore 快照，工作流也存这里）/ `videos` / `products`（`*_image_colors` 是与 url index 对齐的 SKU 标签）/ `reference_videos` / `my_templates`。
- **模特库不在 DB**：存 `backend/data/model-library.json`。
- RDS ~2.5s/查询，批量操作必须合并。

## 6. 当前已知问题

### 🔴 高优先级 / 运维
1. **nodemon 监听 .json → 后台任务被杀**：nodemon 默认 `watch *.* ext js,mjs,cjs,json`。模特库每生成一个就写 `data/model-library.json` → 触发后端重启 → 杀掉其余并行任务（kie 那边照常完成，但我们丢结果）。**现规避：后端用 plain `node server.js` 跑（无文件监听）**。代价：改后端代码需手动重启 node。`nodemon.json`（watch 白名单）已建但似乎未被读取，存疑。
2. **手部畸形 ~70%**：接近 Seedance 物理上限。
3. **kie.ai 上游偶发超时**：失败任务建议自动重提。

### ⚠️ 待观察 / 待办
4. 图像生成偶尔很慢（实测 deep-skin-black 用了 5.5min，差点触 `waitForTask` 6min 上限）→ 建议把模特库/首帧的 `maxAttempts` 调大（如 100=10min）。
5. **分步工作流尚未端到端实测**（到出片）：已验证图像链路（提交→轮询→下载→S3，格式 `resultJson.resultUrls[0]` 对图像也成立）+ 模特库 10/10 生成成功；脚本→首帧→出视频整链待真实跑一遍。
6. 工作流暂无音色统一（agentic_segments 有 reference_audio，工作流未接）。
7. `OLD_SINGLE_CALL` 死函数可清理；model-library.js 里加了诊断 console.log 可后续精简。

## 7. 关键设计决策

| 决策 | 理由 |
|---|---|
| 删除 before-after 模板支路 | 用「可选尾帧」通用实现 before/after，免专用支路污染主流程 |
| 分步工作流预生成关键帧 | 各段视频可并行出，解决串行抽帧慢；并在花视频额度前层层人工把关 |
| 连贯性用全局资产锁定（非链式首帧） | 各段构图不同（背面/产品特写时链式首帧无意义），靠统一模特图+产品图锁人/锁货 |
| 模特库纯身份形象 + 预生成复用 | 跨产品复用，挑选零等待；产品在各段首帧叠加 |
| 时长自动跟随参考视频（用户可覆盖） | 贴合"仿这条视频"，又尊重用户；3 秒完播痛点 → 上限 30s |
| 每段精简 prompt（agentic/工作流） | 一条大 prompt 塞多分镜模型不专注 |
| Pass 拆 1+2 / 强制注入块 / Pass1 temp=0 / 全链路重试 / 不换视频模型 | （同前，沿用）|

## 8. 关键文件位置

| 文件 | 作用 |
|---|---|
| `backend/services/gemini.js` | Pass 1 + Pass 2 + 强制注入块 + VARIANT_RECIPES（before-after 已移除）|
| `backend/services/agentic-planner.js` | `buildAgenticSegmentPlanLLM`（LLM 分镜，maxDuration 可配）+ 规则版兜底 |
| `backend/services/agentic-prompt-builder.js` | 每段精简 prompt（slim）+ 旧版兜底 |
| `backend/services/agentic-stitcher.js` | 抽尾帧 + ffmpeg 拼接（支持音轨 a=1 + 按 resolution）|
| `backend/services/model-library.js` | 模特库：10 画像 + 预生成（断点续）+ list/get |
| `backend/services/workflow-ai.js` | 工作流 AI 辅助：审核脚本/提示词，返回 建议+改写 |
| `backend/services/kieai.js` | `createVideoTask` + `createImageTask`（gpt-image-2 用 input_urls / seedream 用 image_urls）+ `parseTaskResult`(含 imageUrl) + `waitForTask` |
| `backend/services/gemini-review.js` / `gemini-video-judge.js` | 二次评估 / 后评分（mode 参数已移除）|
| `backend/routes/generate.js` | single_pass / agentic_segments 编排 |
| `backend/routes/workflow.js` | 分步工作流全部端点 + 状态机 + 并行出视频/拼接 |
| `backend/nodemon.json` | watch 白名单（存疑未生效；当前用 plain node 规避）|
| `frontend/src/App.jsx` | 单页 + tabs（🧩 分步工作流 已接入；before-after 已移除）|
| `frontend/src/WorkflowWizard.jsx` | 分步工作流向导页（模特库/产品+SKU/脚本/首尾帧/提示词/出片/AI辅助/托管）|
| `frontend/src/{ProductManager,HistoryView,AffiliateVideos,MyTemplates,BenchmarkAnalyzer}.jsx` | 其余 tab |

## 9. 前端 Tab

🎬 生成（single_pass / agentic_segments 开关）· 🧩 分步工作流 · 📦 产品管理 · 📜 历史 · 🛍 达人视频 · ⭐ 模板库 · 标杆分析

## 10. kie.ai 图像 API（gpt-image-2 / seedream）

- 同 `/jobs/createTask` 端点；createTask 响应 `{code,msg,data:{taskId}}`（同视频）
- text-to-image：`input{prompt,aspect_ratio[,quality,nsfw_checker]}`
- image-to-image：参考图字段 **gpt-image-2 用 `input_urls`、seedream 用 `image_urls`**
- 结果轮询 recordInfo：`data.state='success'` + `data.resultJson` → `resultUrls[0]`（图像/视频通用）

## 11. 商业经济学

- 每条 Seedance ¥12 + Gemini ~¥1-2 ≈ **¥13-14/条**；分步工作流另加图像生成（模特库一次性 + 每段首帧/可选尾帧）
- 用户场景：单账号每天发 1-2 条

## 12. Git / 提交状态

⚠️ **本期改动（before-after 删除 + agentic 升级 + 分步工作流 A→D + 模特库 + SKU + nodemon 规避）尚未提交 git**。最近已提交历史：
```
008f4d1 Skip S3 re-upload for product images already on hypit S3
5e09b82 docs
076f7f1 Add experimental agentic segment generation mode
c6af0b5 视频解析能力
```

## 13. 根本事实

- **Seedance 2 是当前唯一可用的支持参考图的 image-to-video+audio 模型**，已在用上限
- 物理瑕疵可靠 prompt 降频但无法消除；手部畸形接近模型上限
- 分步工作流的真正提速来自"预生成首帧 → 视频并行"，而非更快的单次生成
