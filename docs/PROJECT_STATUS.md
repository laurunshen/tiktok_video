# 项目当前状态总览

> 最后更新：2026-05-25 — + Agent 分段生成模式设计文档（见 `docs/AGENTIC_SEGMENT_GENERATION_PLAN.md`）
> 用途：记录当前项目架构、生成模式、已知问题、关键决策

---

## 1. 项目目标

**自动化生成 TikTok UGC 内衣带货视频**：
- 输入：商品链接（爬产品图）+ 一条同类目参考视频（学风格/节奏/脚本）
- 输出：1 条 480p 9:16 竖屏视频，可直接发到 TikTok
- 核心需求：
  1. **产品细节绝对一致**（颜色 / 边缘 / 钢圈 / 肩带 / 扣子）
  2. **角色一致性**（同一人贯穿全程）
  3. **物理瑕疵零容忍**（无手指畸形、无字幕泄漏、无户外风声）
  4. **同一标杆能裂变出 5+ 条独立视频**（防 TikTok 查重）
  5. 用户接受叙事差异化，但物理瑕疵（颜色/手指/角色）是硬阻断

## 2. 架构总览

```
用户提交（商品 + 参考视频 + 模式 + 时长 + variant_seed）
   ↓
Phase 1: 数据准备
   ├─ TikHub 爬产品 → 上传 S3 拿稳定 URL（24h 缓存，curated 永久）
   └─ Snaptik 解析 TikTok 视频 → 无水印直链
   ↓
Phase 2: Gemini 生成（AI Studio API key 直连，gemini-3.1-pro-preview，2 次调用）
   ├─ Pass 1（temperature=0）: 视频 + 全部产品图 → video_analysis(含 shot_sequence) /
   │   product_visual_features / narrative_dna / dominant_color / selected_image_indices /
   │   compressed_script
   └─ Pass 2: 仅选中图 + Pass 1 JSON → 写 Seedance prompt
       ├─ normal 模式：消费 Pass 1 shot_sequence，按参考时间戳/动作/对白重写
       └─ before-after 模式：走 deriveBeforeAfterTemplate 衍生模板（见 §4）
   ↓
Phase 3: 质量门禁
   ├─ 程序化校验（违禁词 / 字数 / if-then 残留 / 多色泄漏）
   └─ Gemini 二次评估（CLASS A 产品准确性 + CLASS B 物理畸形）→ 失败修订最多 2 次
   ↓
Phase 4: 强制注入（代码硬拼接到 prompt 末尾，绕过 Gemini）
   CHARACTER CONSISTENCY / NO ON-SCREEN TEXT / FACE & LIKENESS / REFERENCE BOUNDARY /
   AUDIO ENVIRONMENT / ANATOMICAL ACCURACY / NO IMPROVISED DIALOGUE / NO MIRROR FLIP /
   COLOR LOCK / PRODUCT REMINDER / PHYSICAL ANCHOR
   ↓
Phase 5: ffmpeg 截 14s 参考片段 + 上传
   ↓
Phase 6: Seedance 2 (kie.ai) — 480p 9:16，reference_image_urls + reference_video_urls
   ↓
Phase 7: 异步评分（video_judge 8 维 + diff_judge 差异化）
```

> 所有 Gemini 调用统一经 `gemini-retry.js`：502/503/429/网络错误退避重试 4 次。

## 3. 数据模型（PostgreSQL on AWS RDS）

5 张表：
- `jobs` — 任务全状态 + jobStore 快照
- `videos` — 每条 Seedance 视频 + prompt + narrative_dna + 二次评估 + 后评分
- `products` — 产品缓存（24h 过期；curated 永久）；`*_image_colors` 是与 url 数组 index 对齐的 SKU 标签 JSON
- `reference_videos` — 标杆视频库（含 ROI 等投流数据）
- `my_templates` — 模板库：高转化视频 + prompt + 评分 + 播放/出单/CTR 指标

> RDS 网络延迟 ~2.5s/查询，批量操作必须合并（如 `batchSetImageColors` 把 53×3 次查询压成 2 次）。

## 4. 生成模式矩阵（mode × isSameProduct）⭐ 重点

两个维度：**模式**（normal / before-after）× **参考视频是否本产品**（isSameProduct）。

| 情景 | 结构骨架 | 台词内容来源 | 风格/节奏 | 状态 |
|---|---|---|---|---|
| **① normal + 同产品** | 参考视频 shot_sequence | 参考视频原台词逐字压缩 | 参考视频 | ✅ |
| **② normal + 不同产品** | 参考 shot_sequence 骨架（时长/字数分布保留） | 按产品信息+概念全新写；参考台词被节奏模板抹掉（防泄漏） | 参考视频 | ✅ |
| **③ before-after + 同产品** | 0:00-0:02 快切 hook + 0:02 后过渡 + 其余跟参考 shot_sequence | 参考视频真实台词压缩（跳过 hook 已讲的卖点） | 参考视频 | ✅ |
| **④ before-after + 不同产品** | 同 ③ | 全新写（产品信息+选中卖点+概念）；参考台词节奏模板防泄漏 | 参考视频 narrative_dna | ✅ |

**规律**：
- 结构 → normal 全程跟参考视频；before-after 前 2 秒固定 hook，0:02 之后跟参考视频
- 风格/节奏 → 四个都来自参考视频
- 台词内容 → 只由 isSameProduct 决定（同产品=用真实台词，不同产品=全新写）

**关键点**：before-after 的 0:02 之后就是 normal 流程，所以 isSameProduct 在两个模式下**完全同义**。before-after 模式照常暴露 isSameProduct 开关，四宫格是完整的 4 格。

**before-after 模板细节**（`deriveBeforeAfterTemplate`，基于 task3Lingerie 衍生，task3Lingerie 本体不动）：
- 0:00-0:02：强制 LOOK A / LOOK B 每半秒快切 hook；LOOK B 用最刚性产品描述
- COLOR 块升级：色名→视觉描述 + 反向排除（修 Warm Beige 渲成深棕）
- 0:02 后：头 1-2 句过渡讲 hook 那个卖点（约 3 秒，只讲一次），之后跟参考 shot_sequence 讲其他卖点、跳过 hook 卖点
- 二次评估仅 before-after 时注入「快切白名单」，普通任务 prompt 字节不变

**台词防泄漏 / 特点防失真**（②④ 共用）：
- isSameProduct=false 时 Pass 1 JSON 注入前，台词内容替换成节奏模板
- SHOT SEQUENCE 改写规则 #2 EXCEPTION B：参考动作若演示了本产品没有的特点（捏厚垫/解前扣/翻蕾丝…），替换为中性动作

## 5. 功能模块（前端 5 个 tab）

| Tab | 说明 |
|---|---|
| 🎬 生成 | 主流程：选品 → 选 SKU → 参考视频 → 模式 →（before-after 时用概念助手）→ 生成 |
| 📦 产品管理 | 产品列表 / 加图删图 / SKU 打标 / AI 识别 SKU / AI 推荐最佳 SKU |
| 📜 历史 | 任务历史 + 内联播放 + 评分细节 + 「存为模板」 |
| 🛍 达人视频 | 达人视频库：筛选 + 「去生成」跳转预填 |
| ⭐ 模板库 | 高转化视频 + 指标（播放/出单/CTR/转化率）|

**before/after 概念助手**（before-after 模式专属）：
1. AI 识别商品卖点（看主图+详情图+商品信息）→ 列出 4-6 个
2. 用户勾选卖点 +（可选）填方向 → AI 生成 3 个 before/after 概念
3. 概念只描述 0-2s 快切 hook，要求「半秒可辨」对比 → 选中自动填入补充说明框
- 后端：`services/before-after.js` + `routes/before-after.js`

## 6. 当前已知问题

### 🔴 高优先级
1. **手部畸形 ~70%**：ACTION SAFETY + PHYSICAL ANCHOR 已部署，接近 Seedance 物理上限，难再压
2. **kie.ai 上游偶发超时**：建议失败任务自动重提 1 次

### 🟢 低优先级
3. `OLD_SINGLE_CALL` 函数仍在 gemini.js，导出但无人引用，可清理
4. batch>1 用不上（单账号 + 反查重）

### ⚠️ 待观察
5. before-after 快切区 0:00-0:02 产品必有轻微漂移（快切固有代价，靠 0:02 后停留镜头保证产品准确性）
6. before-after 模式实际转化表现待实战验证

## 7. 关键设计决策

| 决策 | 理由 |
|---|---|
| Pass 拆 1+2 | 大 payload 慢推理 + 小 payload 快撰写，质量↑ |
| 强制注入块代码硬拼接 | Gemini 在长 prompt 会偷偷压缩规则 |
| Pass 1 temperature=0 | 保证 shot_sequence 可复现，variant 只变 presenter |
| shot_sequence 直接驱动（方案 D）| 替代废弃的 10 模板表（信息损失 90%）|
| before-after 走独立衍生模板 | 不污染 task3Lingerie；mode 门控，普通任务零影响 |
| before-after 保留 isSameProduct 开关 | 0:02 后就是 normal 流程，开关同义；四宫格完整 4 格 |
| 全链路 Gemini 重试 | 一次瞬时 502 不再整个 job 失败 |
| 不换视频模型 | Seedance 2 是唯一支持参考图的 image-to-video+audio 模型 |

## 8. 关键文件位置

| 文件 | 作用 |
|---|---|
| `backend/services/gemini.js` | Pass 1 + Pass 2 + 强制注入块 + deriveBeforeAfterTemplate |
| `backend/services/gemini-retry.js` | 共享重试封装（全部 Gemini 调用接入）|
| `backend/services/gemini-review.js` | 二次评估 + 修订（mode 感知）|
| `backend/services/gemini-video-judge.js` | 视频后评分 |
| `backend/services/gemini-color-tagger.js` | AI 识别 SKU + 推荐最佳 SKU |
| `backend/services/before-after.js` | 卖点识别 + before/after 概念生成 |
| `backend/services/db.js` | PostgreSQL + 5 张表 |
| `backend/routes/generate.js` | 主流程编排（mode 透传）|
| `backend/routes/product.js` | 商品爬取 + 产品管理 + 达人视频 API |
| `backend/routes/templates.js` | 模板库 CRUD |
| `backend/routes/before-after.js` | 卖点/概念接口 |
| `frontend/src/App.jsx` | 单页应用 + 5 tab + before-after 开关/概念助手 |
| `frontend/src/ProductManager.jsx` | 产品管理页 |
| `frontend/src/HistoryView.jsx` | 历史页 + 存为模板 |
| `frontend/src/AffiliateVideos.jsx` | 达人视频库 |
| `frontend/src/MyTemplates.jsx` | 模板库页 |

## 9. 商业经济学

- 每条 Seedance ¥12 + Gemini 全程 ~¥1-2 ≈ **每条 ¥13-14**
- 用户场景：单账号每天发 1-2 条

## 10. Git 提交历史（最近）

```
d755bb1 feat: before-after 模板模式 + 概念助手 + 模板库 + 全链路 Gemini 重试
589bf23 feat: 达人视频库 + 生成流程体验优化
195e235 migrate database from SQLite to PostgreSQL (AWS RDS)
ad7b911 chore: remove .claude from tracking, add to .gitignore
25cabed fix: revert flat-lay experiment, restore standard presenter pipeline
```

## 11. 历史测试记录（阶段 4 烟测，方案 D 验证，2026-05-15）

2 标杆 × 5 variant = 10 jobs，7 成 3 败。关键指标 vs 阶段 3 基线：
- 颜色漂移率 80%→**0%** ✅　角色不连续 60%→**14%** ✅
- 手指畸形 80%→71%（接近 Seedance 上限）
- video_judge 5.8→6.14　character_consistency 5→8.57 ✅
- 失败原因：construction↔edge_finish 矛盾（已修）、kie.ai 上游超时

## 12. 根本事实

- **Seedance 2 是当前唯一可用的支持参考图的 image-to-video+audio 模型**，已在用上限
- 物理瑕疵可靠 prompt 降频但无法消除；手部畸形接近模型上限
- 给 Seedance 的参考视频是 14s 片段（非完整视频），全片叙事弧无法借鉴 —— Seedance 15.2s 上限决定的物理约束
