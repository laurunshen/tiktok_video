# Agent 分段生成模式设计 v2

> 用途：定义「Agent 分段生成视频」的设计原则、总链路、Planner 输出、质检与拼接策略，作为后续开发的蓝图。
> 一句话：不是把 Seedance 多调几次，而是 **先规划结构 → 每段只干一件事 → 各段并行生成 → 段级质检 → 快切拼接**。

> **修订说明（v1 → v2，2026-05-30）**：v1 早期设计稿有三处已被分步工作流（WorkflowWizard）的实践推翻，v2 予以纠正——
> 1. **连续性**：v1 主打「首帧接力（上段尾帧→下段首帧）」；v2 改为以 **「全局资产锁定」为主**（统一模特定妆照 + 产品图锁人锁货），首帧接力降为可选。
> 2. **架构**：v1 是 **串行**（等上段出完抽尾帧再做下段）；v2 改为 **并行**（预生成各段首帧 → 各段视频同时出），速度翻倍。
> 3. **拼接**：v1 追求「无缝拼接」；v2 放弃这个做不到的目标，**拥抱 jump cut 快切**（本就是 TikTok 语言）。
> 另：手指畸形已从「零容忍」降级（见 `PROJECT_STATUS.md` §7）；段级质检复用现成 `gemini-video-judge`。

---

## 1. 为什么要分段

当前单段主流程：商品图 + 参考视频 → Gemini 分析 → 写一条完整 Seedance prompt → 1 次出整条 13-15s 视频。

它的天然问题：同一条长视频里，模型要同时维持同一个人、同一个产品、同一种颜色、复杂动作、参考节奏、连续对白——变量太多就会：

- 前半段正常，后半段开始漂
- 产品颜色 / 结构 / 材质逐渐跑偏
- 整条失败只能整条重生成，不能局部修复

分段模式要解决的不是「所有问题」，而是优先这四个：

1. 长视频中后段的人物 / 产品漂移 → 每段时长短，变量少
2. 单次失败整条作废 → 失败只影响某一段，可局部重试
3. hook 和主体段难度差异大 → hook 单独拎出来强化（直击「3 秒完播」痛点）
4. 参考结构分析出来了却没法逐段执行 → Planner 按段分配

它不替代单段模式，而是作为并行的另一条路径，单段模式继续作为简单场景和兜底。

---

## 2. v2 的三块基石（和 v1 最大的不同）

整个 v2 建立在三个被实践验证过的原则上：

### 基石 1：连续性靠「全局资产锁定」，不靠首帧接力

- **做法**：先定一套全局资产——一张统一的**模特定妆照**（锁脸/身材/发型）+ 一组**产品图**（锁货），**每一段都喂这同一套资产**。
- **为什么不靠首帧接力**：机器从一张静止首帧续生成时，不知道前一段人在干嘛 → 会有「重新启动」的微卡顿；而且要求上段停在「稳定居中」的画面才好接，反而让 hook 结尾变呆照、显假。
- **好处**：各段构图可以完全不同（正面 / 背面 / 产品特写），人和货始终锁定。首帧接力降为**可选**，只在段内运动控制或 before/after 这类需要时才用。

### 基石 2：各段「并行」生成，不串行

- **做法**：用图像模型把每段的**首帧预生成**出来（秒级、可并行），然后各段视频**同时**调 Seedance，互不等待。
- **为什么**：v1 串行是因为下段要等上段尾帧；一旦改用全局锁定，下段不再依赖上段产物 → 可并行 → 一条视频的出片时间约**减半**。

### 基石 3：段间用「快切」，不追求无缝

- **做法**：接缝处做一个干脆的镜头切换（jump cut）。
- **为什么**：两段分开生成，接缝处肤色 / 光线 / 朝向**一定有轻微跳变，消不掉**。TikTok 本就全是快切，观众习惯；追求无缝是假目标，拥抱快切反而更像真人剪的视频。

---

## 3. 总链路（并行版）

```text
用户提交（商品 + 参考视频 + generationMode=agentic_segments + 时长）
  ↓
Phase A 数据准备
  ├─ 商品图准备（爬图 → S3）
  └─ 参考视频解析 / 下载（量实际时长）
  ↓
Phase B Planner
  ├─ 消费 Gemini 分析（+ 可选 Benchmark Analyzer 结构化输出）
  └─ 产出 segment_plan（含 global_locks + 每段精简 prompt）
  ↓
Phase C 预生成各段首帧（图像模型，秒级，并行）
  └─ 参考图 = [模特定妆照, 产品图]，按各段构图出首帧
  ↓
Phase D 各段视频【并行】生成
  └─ 每段：自己的首帧 + 全局锁 prompt + 参考音色锚点
  ↓
Phase E 段级质检（复用 gemini-video-judge）
  ├─ hook 段：出 N 条挑最好 1 条
  └─ 其他段：硬门禁不过 → 重试；反复失败 → 兜底
  ↓
Phase F 快切拼接（ffmpeg 统一分辨率/帧率/SAR）→ 上传 → 异步评分
```

> 这套原则，分步工作流（WorkflowWizard）已先行落地大部分；老的 `agentic_segments` 串行支路应按此向并行演进，或与工作流融合。

---

## 4. Planner 输出什么

Planner 不写最终成片 prompt，只产出一份可执行计划：

```json
{
  "generation_mode": "agentic_segments_v2",
  "total_duration": 14,
  "global_locks": {
    "presenter_anchor": "统一模特定妆照的身份描述",
    "product_visual_anchor": "产品视觉锚点",
    "dominant_color": "Warm Beige",
    "scene_profile": "warm indoor bedroom",
    "style_profile": "phone-held UGC, natural light"
  },
  "segments": [
    {
      "index": 1, "role": "hook", "duration": 4,
      "focus": "单点：用一句话钩子+产品入镜",
      "script_excerpt": "本段台词",
      "segment_prompt": "只关于本段的精简 seedance prompt",
      "candidates": 3
    },
    {
      "index": 2, "role": "body_cta", "duration": 10,
      "focus": "单点：演示卖点 + 收尾 CTA",
      "script_excerpt": "本段台词",
      "segment_prompt": "只关于本段的精简 seedance prompt",
      "candidates": 1
    }
  ]
}
```

### 段数规则（统一口径）

```text
1 段：参考视频一镜到底、动作简单 → 不拆，回退单段
2 段：默认推荐（hook 与主体天然分离）
3-4 段：仅当总时长足够、每段 ≥5s、且结构非常清晰时
> 4 段：禁止（拼接点过多、收益递减）
```

> ✅ **已对齐**：`agentic-planner.js` 的 `maxSegments` 已收敛到 **4**（`floor(totalDuration/5)` 且 ≤4），与本方案一致。

### hook 时长跟随参考

不要写死 5 秒。读 Benchmark Analyzer / 参考视频的实际 hook 边界，clamp 到 **[3, 6]** 秒。参考视频 hook 只有 2-3 秒时，硬塞 5 秒会注水。

### global_locks 是成败关键

它是每段都要重复注入的全局约束：同一人物、同一产品锚点、同一主色、同一场景、同一风格。

```text
Planner 决定「拆几段、每段做什么」
global_locks 决定「拆开后仍像同一条视频」
```

---

## 5. 每段 prompt 策略

一段一个精简 prompt，每段两层信息：

- **层 1 全局锁**：presenter / product anchor / color / scene / style（每段重复注入）
- **层 2 本段目标**：role（hook/demo/cta）、本段时长、本段单一动作、本段台词、本段产品露出要求

段 prompt 优先级：

```text
产品准确性 > 人物连续性 > 低风险动作 > 参考结构 > 创意变化
```

关键纪律：每段**只聚焦一件事**，不要把多个卖点塞进一段；不要在段 prompt 里写整片时间线或别段内容（稀释模型注意力，这是分段的意义所在）。

---

## 6. 段级质检与重试（复用现成 judge）

**不要另起炉灶**——直接复用 `gemini-video-judge.js` 的相关维度给每段打分，按损失分三层处理：

| 层级 | 判据（judge 维度） | 不过时动作 |
|---|---|---|
| 🔴 硬门禁（废片） | `no_text_leakage`（字幕泄漏）、`product_accuracy`（串色/串货）、`audio_quality`（风声） | **必重做 / 不交付** |
| 🟡 商业门禁 | `hook_strength`（前3秒抓注意力，**需新增维度**）、防查重 | hook 段：**出 N 条挑最好**；不过则重做 |
| ⚪ 软指标 | `natural_ugc_feel`、`anatomical_correctness`（手指，**已降级**） | 只记录；手指仅产品特写时人工扫一眼 |

### hook 段「出 N 条挑一条」

hook 最重要、最该多生成。Planner 给 hook 段 `candidates: 3`，并行出 3 条，用 `hook_strength` + `product_accuracy` 选最好的 1 条；其他段默认 `candidates: 1`。这是性价比最高的一处投入。

### 重试与兜底（别"整条报废"）

```text
某段失败：重试 1 次（优先改动作、减手部/转身/拉扯，不动产品锚点）
重试仍失败：不要判整条任务死 →
  - 该段降级用更保守的静态构图重出，或
  - 整条 fallback 回 single_pass 出一条保底
```

目标：分段是为了更稳，不能因为多了拼接环节反而更脆。**永远有一条逃生通道。**

---

## 7. 音频策略：参考音色锚点

v1 建议「先静音、后期统一配音」。实践已有更好解法，v2 采用：

- 各段 `generate_audio = true`，并传入**同一段参考音频**作为音色锚点（`reference_audio_urls`），让各段口播的音色 / 性别 / 年龄 / 口音一致。
- prompt 里加 `[VOICE ANCHOR]` 指令强化「全程同一个人声」。

这样省掉「先静音再配音」的二次工序，且跨段音色统一。（断句 / 语气在快切点的自然度仍需观察，必要时再回退统一 TTS。）

---

## 8. 拼接：拥抱快切

- **删除「无缝」目标。** 接缝处用干脆的 jump cut。
- ffmpeg 拼接前统一各段：分辨率（按 9:16 预设）、`fps=30`、`setsar=1`、`format=yuv420p`，避免参数不一致导致拼接报错或跳帧。
- 带音轨拼接时各段音频 `aresample` 对齐采样率 / 声道再 concat。

（以上 `agentic-stitcher.js` 已实现，保持即可。）

---

## 9. 数据落库

为做 A/B 和失败回溯，建议记录到段级：

```text
jobs 级：generation_mode / segment_plan_json / segment_count / stitched_video_url
段 级：segment_index / role / seedance_mode / duration / prompt /
       video_url / judge_scores / status / retry_count / candidate_count
```

第一版可先复用 job 的 `full_data` JSON blob 存（工作流已这么做，免改表）；当要正经做「哪段最容易失败 / hook 难还是 demo 难」的统计分析时，再升级为结构化 `video_segments` 表。

---

## 10. 成功标准（技术 + 商业）

v1 的标准全是技术指标，缺商业 KPI。v2 两者都要：

**技术门槛**

```text
成片成功率 ≥ 单段模式
product_accuracy 不低于单段模式
人物跨段一致（同一张脸）
≥ 50% 的失败任务能定位到具体 segment
```

**商业门槛（真正决定生意）**

```text
hook 前 3 秒「抓注意力」得分（hook_strength）明显高于单段
  └─ 发布后回填真实「3 秒完播率」校准这个门槛（见 PROJECT_STATUS.md 商业 KPI 门禁）
同一标杆能裂变 5+ 条、防查重得分达标
```

不算成功的情况：产品准确性下降、段间人物差异大、成本涨太多但收益不明显。

---

## 11. 一句话原则

```text
把一条长视频拆成几个更容易生成、更容易检查、更容易重试的片段，
用「全局资产锁定」保证它们像同一个人同一件货，
各段并行出、快切拼接，再用现成 judge 把关、hook 多挑一条。
```

如果这条路跑通，Benchmark Analyzer 就不只是「生成前的分析报告」，而会成为驱动 Planner 决策的大脑。
