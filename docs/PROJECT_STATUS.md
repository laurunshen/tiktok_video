# 项目当前状态总览

> 最后更新：2026-05-15 — + SKU 概念升级（vocab 约束 / 推荐 / 分页 / 筛选）+ S3 持久化（迁移 23/24）+ 历史页
> 用途：完整记录当前项目架构、问题、决策、待办

---

## 1. 项目目标

**自动化生成 TikTok UGC 内衣带货视频**：
- 输入：商品链接（爬产品图）+ 一条达人标杆视频（参考节奏/风格/脚本）
- 输出：1 条 480p 9:16 竖屏视频，可直接发到 TikTok 账号
- 核心需求：
  1. **产品细节绝对一致**（颜色 / 边缘 / 钢圈 / 肩带 / 扣子）
  2. **角色一致性**（同一人贯穿全程）
  3. **物理瑕疵零容忍**（无手指畸形、无字幕泄漏、无户外风声）
  4. **同一标杆能裂变出 5+ 条独立视频**（防 TikTok 查重）
  5. **每条视频不能千篇一律**（不能只换模特套同一脚本）

## 2. 架构总览

```
用户提交（商品链接 + 标杆视频 + 类目 + 时长 + variant_seed）
   ↓
Phase 1: 数据准备
   ├─ TikHub 爬产品 → 立即上传 kie.ai 拿稳定 URL
   ├─ Snaptik 解析 TikTok 视频 → 拿无水印直链
   └─ 24h 产品缓存（按 productId）
   ↓
Phase 2: AI 生成（Gemini 3.1 Pro on Vertex AI，2 次调用，**Pass 1 锁 temperature=0**）
   ├─ Pass 1: 视频 + 全部产品图 → 提取
   │   ├─ video_analysis (presenter/style/mood/**shot_sequence ← 这个现在是 Pass 2 主输入**)
   │   ├─ product_visual_features (silhouette/edge/color/...)
   │   ├─ narrative_dna {hook_type, tone_register, unique_creative_signature, key_phrases}  ← narrative_structure 已不驱动模板
   │   ├─ key_segment_start/end_seconds
   │   ├─ dominant_color + selected_image_indices（**零异色图，强制全部为 dominant_color**）
   │   └─ compressed_script
   └─ Pass 2: 仅选中图（无视频）+ Pass 1 JSON → 写 Seedance prompt
       ├─ **直接消费 Pass 1 的 shot_sequence**（不再查 10 模板表）：按参考的实际时间戳/动作/对白重写到目标时长
       ├─ ACTION SAFETY 作为后处理规则（不安全动作自动替换为 surface-only 等价）
       └─ 套用 tone_register 对应的 SPEAKING STYLE 模板（8 选 1，软指引）
   ↓
Phase 3: 质量门禁
   ├─ 程序化校验（违禁词 / 字数 / if-then 残留 / 多色泄漏 / 必含字段）
   ├─ Gemini 二次评估（产品图对比 prompt，CLASS A 产品准确性 + CLASS B 物理畸形）
   └─ 失败 → 修订（最多 2 次）
   ↓
Phase 4: 强制注入（代码硬拼接到 prompt 末尾，绕过 Gemini）
   ├─ CHARACTER CONSISTENCY (top priority)
   ├─ NO ON-SCREEN TEXT (top priority)
   ├─ FACE & LIKENESS
   ├─ REFERENCE VIDEO BOUNDARY (含音频/字幕禁令)
   ├─ AUDIO ENVIRONMENT (强制室内安静)
   ├─ ANATOMICAL ACCURACY
   ├─ NO IMPROVISED DIALOGUE
   ├─ NO MIRROR FLIP (anti-shortcut)
   ├─ COLOR LOCK (动态注入 dominant_color)
   ├─ PRODUCT REMINDER (末尾产品锚点摘要)
   └─ **PHYSICAL ANCHOR**（新加：CHARACTER + 5-finger + SURFACE-ONLY + COLOR + NO-MIRROR 一句话总结，prompt 最末尾，attention 权重最高）
   ↓
Phase 5: ffmpeg 截视频片段 + 上传 kie.ai
   ├─ 流复制（30s 内完成）
   └─ 失败 fallback → 重编码（保证 ≤15s 满足 Seedance 上限）
   ↓
Phase 6: Seedance 2 (kie.ai)
   ├─ 480p 9:16 竖屏
   ├─ reference_image_urls = 选中的 5-9 张产品图
   ├─ reference_video_urls = 14 秒标杆片段（不是完整视频，这是缺陷之一）
   └─ 排队 + 生成（5-25 分钟）
   ↓
Phase 7: 异步评分（setImmediate）
   ├─ judgeGeneratedVideo（8 维度评分）
   └─ judgeNarrativeDifferentiation（vs 标杆差异化评分）
```

## 3. 数据模型（SQLite）

`backend/data/jobs.db`

- `jobs` — 任务全状态 + 完整 jobStore 快照
- `videos` — 每条 Seedance 视频 + 完整 prompt + Pass 1 narrative_dna + 二次评估 + 视频后评分（video_judge / diff_judge）
- `products` — 产品缓存。普通爬虫产品 24h 过期；用户在管理页加图后 `is_curated=1` 永不过期；`user_image_urls` 是用户手动上传到 kie.ai 的稳定 URL 数组；`main_image_colors / detail_image_colors / user_image_colors` 是与对应 url 数组 index 对齐的 **SKU 标签** JSON 数组（早期叫 color，现概念升级为 SKU；值仍是字符串，列名保持兼容）；推荐用产品 `variants[0].values` 作为 SKU 词表
- `reference_videos` — 标杆视频库（已导入 46 条去重，目标产品 1731302299031802096 有 15 条 ROI > 5 的标杆）

## 4. 已实现且验证有效的能力

| 能力 | 状态 | 测试视频证据 |
|---|---|---|
| Color Lock 动态锁定单一 SKU | ✅ | 多次跑 Warm Beige 全程一致 |
| Character Consistency（同一人）| ✅ | 解决了"两个人"问题 |
| 字幕零泄漏 | ✅ | 多次满分 |
| 户外风声消除 | ✅ | 加 AUDIO ENVIRONMENT 后室内 |
| 头发遮挡防御 | ✅ | 强制扎发 |
| Surface-only 手部动作 | ✅ | 大部分通过，但仍有偶发畸形 |
| Anti-mirror-flip | ✅ | 真转身而非镜像 |
| Pass 1 Silhouette/Edge_finish 修复 | ✅ | 产品名营销词不再误识别 |
| 24h 产品缓存 | ✅ | 重复商品瞬时返回 |
| 二次评估自动修订（最多 2 次）| ✅ | 大部分 critical 在评估阶段拦下 |
| 7 个 MANDATORY 强制注入块 | ✅ | 代码硬拼接，Gemini 不能压缩 |
| 多 variant 并行生成 | ✅ | 5 条 12 分钟 |
| ~~方案 C: narrative_dna 提取 + 10 模板~~ | ⛔ 已废弃 | 模板挤压所有参考成相似结构，套路化严重 |
| **方案 D: shot_sequence 直接驱动（新）** | ✅ 阶段 4 已验证 | diff_judge 平均 2.86（低=高保真），verdict 反复出现 "verbatim phrasing / identical structure"，参考节奏忠实复刻 |
| Pass 1 temperature=0 | ✅ 阶段 4 已验证 | 同标杆 5 variant 之间 product_visual_features 完全一致；但同时暴露了 Pass 1 的字段矛盾 bug（见下文）|
| 选图零异色 | ✅ 阶段 4 已验证 | 7 条 verdict 零提及颜色漂移，product_accuracy 平均 7.14（基线 ~6）|
| 物理首尾呼应 PHYSICAL ANCHOR | ✅ 阶段 4 已验证 | character_consistency 8.57（基线 ~5），no_text_leakage 满分，audio 9.29 |
| diff_judge 用 snaptik 直链 | ✅ 阶段 4 已验证 | 7 条全部成功评分（基线 0%）|
| **产品管理页面**（2026-05-15 晚） | ✅ 已完成 | 前端新 tab + ProductManager 组件；后端 6 个新 API；列表/重命名/上传图/删图/删产品；is_curated 永久缓存；端到端测试通过 |
| **产品管理 tab 内新增产品入口** | ✅ 已完成 | 直接在管理页贴 TikTok Shop URL 或纯 productId 抓取，按 productId 自动去重（缓存命中直接返回） |
| **图按 SKU 颜色分类 + 生成时过滤** | ✅ 已完成 | DB +3 列；后端 PATCH /image-color + POST /bulk-tag；前端缩略图加 color badge + 点击弹小菜单 + 每 section 批量打标；生成页选完缓存产品后再选 SKU 颜色，自动过滤 productInfo 提交。零异色防御从 AI 推理升级为用户显式 ground truth |
| **SKU 概念升级（vocab 约束 + 推荐 + 分页 + 筛选）** | ✅ 已完成 | 后端 GET /sku-options（产品 variants[0] 词表）+ GET /recommend-sku（Gemini 评估 top-3 SKU 选最佳）；AI 识别现在用词表约束（不再自由发明色名）；前端产品图分页 24/页 + 顶部 SKU chip 过滤条；生成页加 "🌟 AI 推荐"按钮直接选中推荐 SKU。点击下拉用原生 select，零误触（之前 popup bug 已修） |
| **S3 持久化 + 历史页面** | ✅ 已完成 | backend/services/s3-upload.js (PUT with public-read ACL)；migrate-kie-to-s3.js 一次性脚本（23/24 视频已迁，1 条网络中断）；generate.js 内嵌自动上传新视频到 S3；GET /api/generate/jobs 升级为列出 videos + S3 URL + 评分；前端 📜 历史 tab：状态筛选 + 卡片列表 + 点击展开 video 内联播放 + 完整评分维度 + prompt 折叠 |

## 5. 当前已知问题（阶段 4 烟测后更新）

### 🔴 高优先级 — 阶段 4 暴露的新瓶颈
1. ~~**Pass 1 字段内部矛盾**~~ → **已修（2026-05-15 晚）3 层防御部署**：
   - Pass 1 prompt 加 CROSS-CHECK 段（gemini.js:864），明确列出 3 条禁止组合，告诉 Gemini "trust edge_finish, adjust construction"
   - prompt-validator.js 加程序化检查：seamless+stitched / lace+laser 两种组合直接打 critical，触发 Pass 2 修订
   - gemini-review.js 修订指令补一条：明确说"construction ↔ edge_finish 矛盾时改 construction"
   - 8/8 单元测试通过（涵盖 seamless+laser、lace+folded 等正负样本）
   - 待验证：下一轮跑同标杆同 variant，看 2/10 失败率是否归零
2. **手部畸形仍 ~70%**（5/7 verdict 提及）
   - ACTION SAFETY + PHYSICAL ANCHOR 已部署，但 Seedance 在小型 3D 交叉物（fingers + thin straps）上有物理上限
   - 当前 anatomical_correctness 平均 4.57，难以仅靠 prompt 工程进一步提升
   - 评估：接近模型上限，建议暂不再压
3. **kie.ai 上游偶发超时**（阶段 4 命中率 1/10）
   - Seedance 任务返回 "The upstream API service timed out and no results were returned, please try again."
   - 建议：失败任务自动重提 1 次的兜底

### ✅ 已解决（阶段 4 验证）
4. ~~颜色不一致~~ → 7 条 verdict 零提及，product_accuracy 平均 7.14
5. ~~角色不连续~~ → character_consistency 平均 8.57（基线 ~5），7 条里只 1 条提到小毛病（中段冒出手表）
6. ~~镜面反射诡异~~ → 7 条 verdict 零提及
7. ~~千篇一律~~ → shot_sequence 直接驱动起效，diff_judge 评语反复出现"verbatim phrasing / identical structure"
8. ~~diff_judge 全部失败~~ → 7 条全部成功评分
9. ~~prompt 长度膨胀~~ → 净瘦身 ~700 字符

### 🟢 低优先级 — 工程
10. **batch>1 用不上**：用户单账号 + TikTok 反查重，多版本生成只能用 1 条
11. **OLD_SINGLE_CALL 函数仍存在 gemini.js**：导出但无人引用，可清理
12. **rejudge-smoke.js 是临时脚本**：已成功用于阶段 4 失败的 video_judge 重跑（VPN 中断恢复）。可保留作为通用 re-judge 工具

### ⚠️ 待观察
13. **diff_judge 低分被算法解读为"克隆"**：阶段 4 多条 dup_risk = 0-2，但用户的核心目标本来就是"忠实复刻参考脚本"。需要观察实际发到 TikTok 后是否真的被算法判重——variant_recipe 应该让 presenter 差异化足够，但同标杆 5 variant 的 dup_risk 分布 (0/0/2/6/8) 表明 variant 间差异化不均匀
14. **shot_sequence 提取质量是单点风险**：阶段 4 没遇到 shot_sequence 质量问题，但缺少 fallback。建议加 prompt-validator 检查字段长度/格式

## 6. 关键设计决策（来自 N 轮迭代）

| 决策 | 理由 |
|---|---|
| Pass 拆 1+2 | Pass 1 大 payload 慢推理 + Pass 2 小 payload 快撰写，质量↑ |
| 7 个块代码硬注入 | Gemini 在长 prompt 里会偷偷压缩规则，必须代码绕过 |
| 二次评估只拦 2 类 critical（产品准确性 + 物理畸形）| 之前太严格陷入打地鼠循环 |
| 标杆视频库 + 前端推荐 | 让用户从已知高 ROI 视频选参考，不用大海捞针 |
| variant_seed 1-5（5 美式模特类型）| 单标杆裂变防 TikTok 查重 |
| ~~方案 C: narrative_dna + 10 SHOT SEQUENCE 模板~~ | 已废弃：10 模板把所有参考挤压成相似结构，套路化反而恶化 |
| **方案 D: shot_sequence 直接驱动**（新） | Pass 1 的 shot_sequence 比 narrative_structure 标签信息量大 10 倍。Pass 2 直接消费它，保留原参考的节奏/动作/对白时间分布。模板从"主路径"降级为"fallback"|
| **Pass 1 锁 temperature=0** | DNA 自飘是 5 variant 之间不可控的根因，锁死后 shot_sequence 可复现 |
| **选图零异色（废"最多 1 张"）** | 视觉优先模型只要看见异色图就有概率渲染，斩断种子比事后约束有效 |
| **PHYSICAL ANCHOR 放 prompt 最末尾** | LLM/视频模型对末尾几句的 attention 权重最高 |
| **不换视频模型** | Seedance 2 是当前 image-to-video+audio 唯一能用的，Sora 2/Veo 3 不支持参考图 |

## 7. 商业经济学

- 每条 Seedance：¥12
- 每条 Gemini 全程（Pass 1+2+review+judge+diff）：~¥1-2
- **每条视频成本约 ¥13-14**
- 用户场景：单账号每天发 1-2 条
- 标杆视频库：15 条 × 5 variant = 75 条原创素材 ≈ 单产品发 2-3 个月

## 8. 完整生成视频清单（按时间倒序）

### 阶段 4 烟测（方案 D 首次验证：2 标杆 × 5 variant = 10 jobs，7 成 3 败）

**配置**：B2 @laauurreenn44（同 阶段 3）+ izzy186k（ROI 29166，泛化新标杆）× variant_seed 1-5

**汇总评分**（基线对比 阶段 3 平均）
| 指标 | 基线 | 阶段 4 | Δ |
|---|---|---|---|
| video_judge 平均 overall | 5.8 | **6.14** | +6% |
| product_accuracy | ~6 | **7.14** | +19% ✅ |
| character_consistency | ~5 | **8.57** | +71% ✅✅ |
| anatomical_correctness | ~3-4 | 4.57 | 持平（Seedance 上限）|
| audio_quality | ~7 | **9.29** | +33% ✅ |
| no_text_leakage | ~9 | **10.0** | 满分 ✅ |
| narrative_creativity | ~5 | 4.43 | 略降（因忠实复刻参考脚本）|
| diff_judge 成功率 | 0% | **100%** | 修复 ✅ |
| diff_judge 平均 | n/a | 2.86 | 越低=越接近参考=用户要的 ✅ |

**单条结果**（diff 越低=越接近参考；dup_risk 越高=TikTok 越不容易判重）

| 视频 | overall | char | anat | diff | dup_risk | 链接 |
|---|---|---|---|---|---|---|
| B2 v1 | 5 | 8 | 3 | 3 | 8 | https://tempfile.aiquickdraw.com/seedance/1778821725494-1ejqwyht7g5k.mp4 |
| **B2 v2** | **7** | **10** | 6 | 0 | 0 | https://tempfile.aiquickdraw.com/seedance/1778821817575-8pjh3n3iql5.mp4 ⭐ |
| B2 v3 | — | — | — | — | — | ❌ Pass 2 评估失败（construction vs edge_finish 矛盾）|
| **B2 v4** | **7** | 9 | 5 | 3 | 6 | https://tempfile.aiquickdraw.com/seedance/1778821600713-j3vd2ki52cm.mp4 |
| B2 v5 | 6 | 7 | 5 | 1 | 2 | https://tempfile.aiquickdraw.com/seedance/1778821465475-om491xqe0i.mp4 |
| izzy v1 | — | — | — | — | — | ❌ Pass 2 评估失败（construction vs edge_finish 矛盾）|
| izzy v2 | — | — | — | — | — | ❌ kie.ai 上游超时 |
| izzy v3 | 5 | 8 | 3 | 6 | 9 | https://tempfile.aiquickdraw.com/seedance/1778821727050-0ot4a6uqt3f.mp4 |
| izzy v4 | 6 | 9 | 5 | 5 | 8 | https://tempfile.aiquickdraw.com/seedance/1778821806555-d649p1g8xaq.mp4 |
| **izzy v5** | **7** | 9 | 5 | 2 | 2 | https://tempfile.aiquickdraw.com/seedance/1778821812766-yg8t44rrwko.mp4 ⭐ |

**关键 verdict 摘录**（说明哪些瑕疵仍存在）：
- "obvious AI hand glitches" / "anatomical errors in the hands"（5/7 提及，最常见的剩余瑕疵）
- "smartwatch magically appearing mid-video"（B2 v5 唯一一次角色不连续）
- "verbatim phrasing" / "identical script structure"（多条，说明 shot_sequence 复刻成功）

### 阶段 3 测试（5 条不同标杆，使用方案 C narrative_dna + 10 模板）

| 标杆 | 视频链接 | review | video_judge | 主要问题 |
|---|---|---|---|---|
| B1 @the.beauty.bond (ROI 51) | https://tempfile.aiquickdraw.com/seedance/1778789019612-c26fkyq9uha.mp4 | 9 | 6.0 | 手指畸形、narrative 平庸 |
| B2 @laauurreenn44 (ROI 15) | https://tempfile.aiquickdraw.com/seedance/1778788952341-y81k7go82z.mp4 | 9 | 5.0 | 颜色中段切换、角色不连续 |
| B3 @angymillionvibes (ROI 4) | https://tempfile.aiquickdraw.com/seedance/1778789019468-ncas0tw7ro.mp4 | 9 | 5.0 | 角色不连续、手部 AI 痕迹 |
| B4 @hannahosburn4 (ROI 3) | https://tempfile.aiquickdraw.com/seedance/1778789280195-6xab9tcw9dv.mp4 | 8 | 8.0 | 唯一一个技术上稳的，但仍套路化 |
| B5 @shopwithgraciegirl (ROI 3) | https://tempfile.aiquickdraw.com/seedance/1778789136541-gflvpcdgr5.mp4 | 9 | 5.0 | 镜面诡异、手部畸形 |

### 阶段 2 基线（同样 narrative_dna 机制，单跑）

| 标杆 | 视频链接 | review | video_judge | 关键评分 |
|---|---|---|---|---|
| @nathaliarestrepod | https://tempfile.aiquickdraw.com/seedance/1778788120598-4j3ews1n4ws.mp4 | 9 | 7.0 | narrative_creativity=5, share_worthiness=4 |

### 之前历史成功视频（黄金参照）

| 时间 | 视频 | 评估 | 用户反馈 |
|---|---|---|---|
| 早 | https://tempfile.aiquickdraw.com/seedance/1778776766502-2gljnwm6lmk.mp4 | 9 | "教科书级别毕业作品" |
| 早 | https://tempfile.aiquickdraw.com/seedance/1778773009884-6pe0rq3d2io.mp4 | 10 | "跨越式进步" |

## 9. 用户对当前方案的核心反馈（关键！）

> "5 条视频质量都还不错，确实出现了一些瑕疵（颜色不一致、手指变形等），你不是应该去在提示词限制这些事情就好了吗"

**翻译**：用户**接受叙事上的差异化**（方案 C 在叙事多样性上有效），**但不能接受物理瑕疵**。

**意味着**：
- 方案 C 的方向是对的，不是死路
- 我之前误判"应该回退到 A-B-A-B"
- **真正要做的是修复物理约束被叙事模板稀释的问题**

## 10. 当前正在做 / 下一步

### 已完成（架构改动 → 阶段 4 烟测验证）
1. ✅ Pass 1 锁 temperature=0
2. ✅ 选图零异色
3. ✅ Pass 2 重构：shot_sequence 直接驱动，删 10 模板查表
4. ✅ OUTFIT 改为参考驱动（不再强制 A-B-A-B）
5. ✅ NARRATIVE DNA LOCK 段更新
6. ✅ PHYSICAL ANCHOR 末尾块
7. ✅ diff_judge 用 snaptik 直链
8. ✅ 阶段 4 烟测：2 标杆 × 5 variant，7 成 3 败，video_judge 6.14（+6%），character 8.57（+71%）

### 下一步（按 ROI 排序）
1. ~~修 Pass 1 字段交叉验证~~ → **已完成 2026-05-15 晚**：3 层防御部署 + 8/8 单元测试通过
2. ~~产品管理页面~~ → **已完成 2026-05-15 晚**：用户可在 UI 上给产品加自定义图，下次直接选产品跳过爬虫，curated 永不过期
2b. ~~图按 SKU 颜色分类~~ → **已完成 2026-05-15 晚**：每张图可打颜色标签（Warm Beige/Black/White/Nude Pink/Brown/Red/自定义），生成时选 SKU 颜色只用该颜色的图。零异色防御从 AI 推理升级为显式 ground truth
3. **跑 1-2 条验证 Pass 1 修复有效**（成本 ~¥28）
   - 同标杆 B2 + variant 1（之前会触发矛盾的组合），看现在能不能成功完成
4. **kie.ai 上游超时自动重提**（1 小时工程）
   - 失败的 Seedance 任务自动重提 1 次
5. **不修手部畸形**（接近 Seedance 上限，硬压可能让 narrative 退步）
6. **观察实际 TikTok 反查重表现**（用 B2 v2 + izzy v5 这两条 ⭐ 实战发布，看是否被算法判重）

### 阶段 4 之后的实验预算
- 已用：17 条（阶段 1-3 共 7 条 + 阶段 4 共 10 条）
- 剩余：~3 条 buffer
- 建议：先用剩余 buffer 验证 Pass 1 修复，再申请下一批预算

### 阶段 4 验证指标 vs 目标
| 指标 | 阶段 3 基线 | 阶段 4 实测 | 目标 | 状态 |
|---|---|---|---|---|
| 颜色漂移出现率 | 80% | **0%**（0/7）| < 20% | ✅ 超目标 |
| 手指畸形出现率 | 80% | 71%（5/7）| < 40% | ❌ 未达，接近 Seedance 上限 |
| 角色不连续出现率 | 60% | **14%**（1/7）| < 20% | ✅ 超目标 |
| 参考节奏复刻度 | 2（套路感强）| **高**（diff 2.86，verdict 反复提"identical structure"）| 4+ | ✅ 达成 |
| video_judge 平均 | 5.8 | 6.14 | 7.5+ | ⚠️ 未达，被手部畸形拖累 |
| diff_judge 成功率 | 0% | **100%** | > 80% | ✅ 达成 |

## 11. 关键文件位置

| 文件 | 作用 |
|---|---|
| `backend/services/gemini.js` | Pass 1 + Pass 2 + 7 个 MANDATORY 块 |
| `backend/services/gemini-review.js` | 二次评估 + 修订 |
| `backend/services/gemini-video-judge.js` | 视频后评分（judge + diff_judge）|
| `backend/services/prompt-validator.js` | 程序化校验 |
| `backend/services/db.js` | SQLite + 4 张表 |
| `backend/routes/generate.js` | 主流程编排 |
| `backend/routes/product.js` | 商品爬取 + 标杆视频 API + 产品管理 8 个 API（list / cache/:id / 增删图 / 重命名 / 删除 / **PATCH image-color / POST bulk-tag**）|
| `frontend/src/ProductManager.jsx` | 产品管理页（新增产品 + 左列表 + 右详情 + 每图 SKU badge + 批量打标 + 拖拽上传带色 + SKU 过滤 chip + 分页 + AI 推荐最佳 SKU）|
| `frontend/src/HistoryView.jsx` | 历史 tab（状态过滤 + 卡片列表 + 展开内联视频 + 评分细节） |
| `backend/services/s3-upload.js` | S3 持久化（hypit bucket / tiktok_ai 前缀 / public-read ACL）|
| `backend/services/gemini-color-tagger.js` | AI 识别 SKU（词表约束 + recommendBestSku top-3 评估）|
| `backend/scripts/migrate-kie-to-s3.js` | 一次性 kie tempfile → S3 迁移（已跑 23/24）|
| `backend/scripts/import-benchmark-videos.js` | Excel → 标杆视频库 |
| `backend/scripts/overnight-report.js` | 整夜实验报告生成 |
| `backend/scripts/rejudge-smoke.js` | 失败的 video_judge / diff_judge 重跑工具（不重新生成视频，零 Seedance 成本，阶段 4 VPN 中断后用过）|
| `frontend/src/App.jsx` | 单页应用 + 标杆视频选择器 |

## 12. Git 提交历史（最近 8 个）

```
5ece5bb feat: narrative DNA extraction + 10 dynamic shot sequence templates  ← 方案 C
4b0975a feat: variant recipes for benchmark video reuse (anti-duplicate)
6d635a7 fix: Pass 1 silhouette + edge_finish recurring errors
eaeac50 fix: prevent mirror-flip shortcut in second LOOK B shot
6256a82 fix: drastically slim prompt + add image-color filtering + tail anchor
0c5c4da fix: enforce character consistency to prevent two-person split
c9b1a8d fix: prevent text leakage, slideshow effect, and outdoor audio
b4a963f fix: prevent color leak and Seedance boomerang loop
```

## 13. 一个需要明白的根本事实

**Seedance 2 是当前能用的最强 image-to-video+audio 模型**：
- Sora 2 / Veo 3 不支持参考图
- Kling 不如 Seedance
- **没有更强的模型可换** — 用户已经在用上限

**这意味着**：
- "千篇一律" 部分是 Seedance 的物理上限决定的（A-B-A-B 是它最稳的执行模式）
- "物理瑕疵" 部分可以靠 prompt 强化解决（不能完全消除，但能降低频率）
- 我们的 prompt 工程已经接近 Seedance 能稳定吃下的复杂度上限

## 14. 给 Seedance 的参考视频是不完整的（关键缺陷）

我们截的是 14 秒片段（不是完整视频），所以 Seedance 看到的"参考"本身就是不完整的——它只能学到片段里的节奏，全片的叙事弧无法借鉴。这是物理约束（Seedance 上限 15.2 秒）决定的，无法改变。

---

**当前光标位置**：S3 迁移完成 + 历史页 + SKU vocab/分页/AI 推荐全部落地。代码未 commit。下一动作 = 实战跑一条新视频，验证 SKU 词表 + AI 推荐 + S3 自动上传 + 历史 tab 端到端联通。

## 15. 这一轮的核心架构判断（要点）

之前的方案 C（10 模板）犯了一个根本错误：**它把信息丰富的 Pass 1 shot_sequence（带时间戳+动作+原话）压缩成一个 narrative_structure 类别标签，然后用这个标签去查 10 个通用模板**——这一步信息损失 90%。

新架构（方案 D）：
```
参考视频
  ↓ Pass 1
  shot_sequence: "[00:00-00:03] she walks into bedroom holding bra, says...
                  [00:03-00:08] sits on bed, points to seam, says...
                  ..."  ← 直接喂给 Pass 2
  ↓ Pass 2
  按 ACTION SAFETY 后处理 + 时长缩放 → 最终 SHOT SEQUENCE
```

**核心洞察**：参考视频的"带货风格、节奏、动作、脚本" 4 个维度，其实都已经被 Pass 1 的 shot_sequence 字段一次性捕获了——只是之前 Pass 2 没用它。

物理质量靠 3 重防御：
1. 源头（选图零异色）切断颜色漂移种子 — **阶段 4 验证：颜色漂移率 80%→0%**
2. 中间（ACTION SAFETY 作为 SHOT SEQUENCE 重写过滤规则）防止不安全动作进入 prompt — **阶段 4 部分有效：手部畸形 80%→71%，但已接近 Seedance 上限**
3. 末尾（PHYSICAL ANCHOR 一句话总结）压在 attention 最高的位置 — **阶段 4 验证：character_consistency 5→8.57，角色不连续率 60%→14%**

## 16. 阶段 4 烟测的工程教训（要记住的坑）

1. **VPN 必须长期稳定**：阶段 4 中途 VPN 掉了一次，导致所有 video_judge 异步调用 fetch failed。Vertex AI 走 VPN，kie.ai 不走，tempfile（kie 的）也不走——所以视频生成可以完成，但评分会全挂。**未来加：评分失败自动重试 + VPN 健康检查 endpoint**
2. **gcloud ADC 凭证会过期**：阶段 4 第一次重跑时报 `invalid_grant / invalid_rapt`，需要 `gcloud auth application-default login`。**未来加：backend 启动时检测 ADC 凭证有效性**
3. **temperature=0 是把双刃剑**：让 5 variant 复现性变好，但也把 Pass 1 的字段矛盾 bug 固化了——之前不同 temperature 采样可能偶尔避开矛盾，现在每次都撞同一个坑
4. **rm 已被打开的日志文件 = 看不见日志**：阶段 4 期间 `rm /tmp/backend.log` 后老 node 进程仍写入已删除的 inode，导致丢失中间过程的日志。**未来：用 `> /tmp/backend.log` 截断而不是 rm**
5. **批量提交 staggered 5s 没问题**：10 个 job 间隔 5s 提交，Gemini Pass 1 并发跑得动，Seedance 排队也正常
