# Agent 分段生成模式设计与落地规划

> 用途：定义“Agent 分段生成模式”与当前传统单段模式的差异、核心逻辑、接口设计、实施步骤与实验标准。
> 核心原则：不是简单把 Seedance 多调用几次，而是先规划结构，再按段生成、按段检查、最后拼接。

## 1. 为什么要做这个模式

当前主流程是：

```text
商品图 + 参考视频
  -> Gemini Pass 1 分析
  -> Gemini Pass 2 写完整 Seedance prompt
  -> 调用 1 次 Seedance
  -> 输出 1 条 13-15s 视频
```

这个模式的优点是链路简单、成本可控，但它有一个天然问题：

```text
同一条 13-15 秒视频里，Seedance 需要同时维持：
- 同一个人
- 同一个产品
- 同一个颜色
- 复杂动作
- 参考视频节奏
- 连续对白
```

变量太多时，模型常见失败表现是：

- 前半段正常，后半段开始漂
- 产品颜色、结构、材质逐渐跑偏
- 手部或身体在某个动作处崩坏
- 参考视频结构在中后段失真
- 整条失败后只能整条重生成，不能局部修复

因此需要一个和传统模式并行的新模式：

```text
Agent 分段生成模式
```

它的目标不是“更复杂”，而是：

- 把一条长视频拆成更稳定的几个可控片段
- 让系统自己决定每段应该生成什么
- 让失败只影响某一段，而不是整条报废
- 在保证产品准确性的前提下，提升结构复刻和视觉稳定性

## 2. 和传统模式的区别

### 传统模式

```text
Reference video + product images
  -> 1 个完整 prompt
  -> 1 次 Seedance
  -> 1 条成片
```

特点：

- 实现简单
- 成本低
- 没有拼接问题
- 但中后段失控时无法局部修复

### Agent 分段模式

```text
Reference video + benchmark analysis + product images
  -> Planner 输出 segment_plan
  -> 每段单独生成
  -> 每段检查 / 失败段重试
  -> ffmpeg 拼接
  -> 最终成片
```

特点：

- 每段负担更轻，稳定性更高
- 可以按段做首帧接力
- 可以局部重试
- 但会新增跨段一致性、音频衔接、拼接自然度问题

结论：

```text
Agent 模式不是替代传统模式，而是作为实验性新模式并行存在。
```

## 3. Seedance 能力假设

当前设计基于 Seedance / kie.ai 提供的以下能力：

- `reference_image_urls`
- `reference_video_urls`
- `first_frame_url`
- `last_frame_url`
- `return_last_frame`

设计含义：

- 第一段可以继续使用“参考图 + 参考视频”的多模态参考模式，优先保证产品准确性与结构复刻
- 后续段使用“上一段最后一帧 -> 下一段首帧”做人物 / 场景接力，同时继续传入商品参考图，避免产品细节在后续段漂移
- 如果未来需要更强的镜头落点控制，可以引入 `last_frame_url` 做首尾帧约束

注意：

```text
严格首尾帧模式和多模态参考模式通常不是完全等价的。
第一版不要试图把所有参数一次性叠满，而是分角色使用。
```

## 4. 模式目标

Agent 分段模式要解决的不是“所有问题”，而是优先解决以下问题：

1. 长视频中后段的人物 / 产品漂移
2. 单次失败导致整条作废
3. 快切 hook 和主体段对模型要求差异太大
4. 参考视频结构虽然分析出来了，但不能逐段执行

第一阶段不追求：

- 自动生成 5-8 段超复杂分镜
- 每段都自动带自然音频
- 高自由度场景切换
- 完全自动化电影级转场

第一阶段追求：

- 两段式稳定跑通
- 段与段能接上
- 失败能局部重试
- 产品准确性不低于当前单段模式

## 5. 第一版推荐结构：两段式 Agent

第一版建议固定为：

```text
Segment 1: hook，约 4-5 秒
Segment 2: body + CTA，约 8-10 秒
Final: 拼成 12-15 秒视频
```

理由：

- Seedance 单段太短时收益不明显，反而拼接成本更高
- 多于 2 段会显著提高跨段不一致概率
- hook 与主体本来就是两个不同难度的问题，拆成两段最有业务意义

默认切分逻辑：

- 前 4-5 秒作为吸引注意力的 hook
- 后 8-10 秒承载 demo / proof / CTA
- Segment 1 结尾必须是稳定、居中、产品可见、容易接续的画面
- Segment 2 开头第一秒必须严格延续 Segment 1 尾帧，不允许换人、换房间、换机位或换光线

如果参考视频本身就是一镜到底、动作简单、结构单一，则 Planner 可以回退为：

```text
1 段，不启用 Agent 拆分
```

## 6. Agent 模式总链路

```text
用户提交（商品 + 参考视频 + generationMode=agentic_segments）
  ↓
Phase A: 数据准备
  ├─ 商品图准备
  └─ TikTok 视频解析 / 下载
  ↓
Phase B: Planner
  ├─ 参考视频分析
  ├─ Benchmark Analyzer（可选增强）
  └─ 生成 segment_plan
  ↓
Phase C: Segment 1 渲染
  ├─ 多模态参考模式
  ├─ return_last_frame = true
  └─ 段级质检
  ↓
Phase D: Segment 2 渲染
  ├─ 以上一段 last frame 作为 first_frame
  ├─ 保持全局人物 / 场景 / 产品锁
  └─ 段级质检
  ↓
Phase E: Stitch
  ├─ ffmpeg 拼接
  ├─ 统一导出
  └─ 最终评分
```

## 7. Planner 应该输出什么

Planner 的职责不是写最终 prompt，而是产出一份可执行计划：

```json
{
  "generation_mode": "agentic_segments_v1",
  "total_duration": 14,
  "global_locks": {
    "product_visual_anchor": "xxx",
    "dominant_color": "Warm Beige",
    "presenter_profile": "xxx",
    "scene_profile": "xxx",
    "style_profile": "phone-held warm indoor UGC"
  },
  "segments": [
    {
      "index": 1,
      "role": "hook",
      "duration": 5,
      "seedance_mode": "multimodal_reference",
      "goal": "replicate benchmark opening pattern",
      "product_visibility": "clear",
      "action_policy": "low-risk",
      "return_last_frame": true
    },
    {
      "index": 2,
      "role": "body_cta",
      "duration": 9,
      "seedance_mode": "first_frame_continue",
      "first_frame_source": "segment_1_last_frame",
      "goal": "continue same person/product into demo and CTA",
      "product_visibility": "clear",
      "action_policy": "low-risk"
    }
  ]
}
```

### Planner 必须明确的字段

- `total_duration`
- `global_locks`
- `segments[].duration`
- `segments[].role`
- `segments[].seedance_mode`
- `segments[].goal`
- `segments[].action_policy`

### global_locks 的作用

这是整个 Agent 模式成功的关键。它是每段都必须重复注入的全局约束：

- 同一产品视觉锚点
- 同一主色
- 同一人物描述
- 同一场景描述
- 同一风格描述

换句话说：

```text
Planner 负责决定“拆几段、每段做什么”
global_locks 负责决定“拆开以后仍然看起来像同一条视频”
```

## 8. Segment 切分规则

### 优先切分点

- hook 结束点
- 明确 jump cut
- 叙事角色切换点：hook -> demo -> proof -> CTA
- outfit 变化点
- 产品露出从模糊到清晰的切换点

### 禁止切分点

- 一句话中间
- 一个动作进行到一半
- 手正在接触产品的瞬间
- 快速转身 / 穿脱 / 拉扯动作中间
- 镜头运动最剧烈的瞬间

### 推荐段数规则

```text
1 段：结构很简单，一镜到底，动作风险低
2 段：默认推荐，hook 和主体明显分离
3 段：只有当每段都 >=4 秒、且结构非常清楚时才考虑
>3 段：第一版禁止
```

## 9. 每段的 Seedance 模式选择

### 模式 A：multimodal_reference

输入：

- `reference_image_urls`
- `reference_video_urls`

适用：

- 第一段 hook
- 产品准确性优先
- 参考视频结构复刻优先

优点：

- 继承当前主流程能力
- 最适合第一段建立产品与风格基准

### 模式 B：first_frame_continue

输入：

- `first_frame_url`
- 同一组 `reference_image_urls`
- 可选弱参考视频

适用：

- 第二段延续同一人物 / 同一产品
- 连续性优先

优点：

- 更容易保持跨段连贯
- 后续段可以只重试当前段

### 模式 C：first_last_frame

输入：

- `first_frame_url`
- `last_frame_url`

适用：

- 需要强控制结尾落点时
- 未来高级版本可用

第一版建议：

```text
不作为默认路径，只保留接口兼容。
```

## 10. Prompt 生成策略

Agent 模式不要复用“整条视频一个 prompt”的思路，而应改成：

```text
一段一个 prompt
```

但每段 prompt 都必须包含两层信息：

### 层 1：全局固定锁

- PRODUCT VISUAL ANCHOR
- COLOR LOCK
- CHARACTER CONSISTENCY
- SCENE PROFILE
- STYLE PROFILE

### 层 2：该段独有目标

- 该段 role：hook / demo / CTA
- 该段时长
- 该段动作
- 该段对白
- 该段产品露出要求
- 该段风险替换规则

段 prompt 的优先级应当是：

```text
产品准确性 > 人物连续性 > 低风险动作 > 参考结构 > 创意变化
```

## 11. last frame 接力机制

这是 Agent 模式和普通多段生成最大的区别。

### Segment 1

- 使用 `return_last_frame = true`
- 如果上游接口直接返回最后一帧 URL，优先使用
- 如果接口不直接返回，使用 ffmpeg 从生成视频末尾抽帧并上传 S3

### Segment 2

- 将上一段的最后一帧作为 `first_frame_url`
- 使用相同 `global_locks`
- 尽量避免段首就是复杂动作

原则：

```text
段与段之间不是“独立短视频拼起来”
而是“上一段最后一帧驱动下一段继续往下演”
```

## 12. 段级检查与重试

Agent 模式真正的收益之一，是允许只重试失败段。

每段生成后先做段级检查：

- 人物是否连续
- 产品颜色是否正确
- 产品结构是否明显跑偏
- 该段关键露出是否清楚
- 是否出现复杂手部崩坏

### 重试策略

第一版建议每段最多重试 1 次：

```text
第 1 次失败：
  优先改动作，不改产品锚点
  优先减少手部 / 转身 / 拉扯

第 2 次还失败：
  判定该段失败，整条任务失败
```

这样可以避免 Agent 模式把成本无限拉高。

## 13. 音频策略

第一版建议：

```text
generate_audio = false
```

理由：

- 每段单独生成音频后再拼接，最容易出现断句、语气跳变、房间音不一致
- 第一版更应该先验证画面结构、产品准确性、人物连续性

因此：

- Agent v1 先做静音视觉段拼接
- 统一 voiceover / TTS 放到后续阶段

## 14. 后端模块拆分建议

建议新增三个服务，而不是把所有逻辑堆进 `generate.js`：

### `backend/services/agentic-planner.js`

职责：

- 消费参考视频分析结果
- 可选消费 Benchmark Analyzer 输出
- 产出 `segment_plan`

### `backend/services/segment-renderer.js`

职责：

- 按 segment_plan 逐段调用 Seedance
- 处理 `first_frame_url / last_frame_url / return_last_frame`
- 处理段级重试

### `backend/services/video-stitcher.js`

职责：

- 抽最后一帧
- 拼接片段
- 导出最终视频
- 上传 S3

### `backend/routes/generate.js`

职责：

- 只做模式分流

```text
single_pass -> 现有传统模式
agentic_segments -> Agent 新模式
```

## 15. 前端产品形态建议

第一版建议在生成页新增一个明确开关：

```text
生成模式：
- 传统单段
- Agent 分段实验
```

Agent 模式下可展示：

- 计划总时长
- 计划段数
- 每段 role
- 每段时长
- 当前渲染到第几段
- 每段 taskId
- 拼接结果

不要一开始就暴露太多复杂配置，先让用户感知：

```text
这是“实验模式”，系统会分两段生成并拼接。
```

## 16. 数据落库建议

为了做 A/B 和回溯，建议新增两层记录：

### jobs 级别

- `generation_mode`: `single_pass | agentic_segments_v1`
- `segment_plan_json`
- `segment_count`
- `stitched_video_url`

### segment 级别

建议新增 `video_segments` 表：

```sql
video_segments (
  segment_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  role TEXT,
  seedance_mode TEXT,
  duration_seconds INTEGER,
  prompt TEXT,
  first_frame_url TEXT,
  last_frame_url TEXT,
  video_url TEXT,
  status TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
)
```

这样后续可以明确回答：

- 哪一段最容易失败
- 是 hook 难，还是 demo 难
- first-frame 接力到底有没有帮助

## 17. 三个实施路标

建议只规划 3 个路标，避免把 Agent 模式拆成过多阶段后失焦。每个路标都必须能独立交付一个可验证结果。

### 路标 1：两段式最小闭环

- 明确 `generationMode` 新枚举
- 扩展 `kieai.js` 支持首帧 / 尾帧 / 返回尾帧参数
- 定义 `segment_plan` JSON schema
- Planner 固定输出 2 段
- Segment 1 用 `multimodal_reference`
- Segment 2 用 `first_frame_continue`
- ffmpeg 拼接输出最终视频
- 前端展示 Agent 任务状态

目标：

```text
先跑通 Agent 分段生成，不追求最优。
```

验收：

- 可以从前端选择 `agentic_segments`
- 可以生成第 1 段和第 2 段
- 第 2 段可以使用第 1 段尾帧接力
- 最终可以拼接并返回 1 条完整视频

### 路标 2：段级质量闭环

- 对每段做基础质量检查
- 失败段允许重试 1 次
- 历史页可查看每段视频和最终拼接视频
- 记录每段的 `role / duration / prompt / status / retry_count`
- 建立“失败定位到 segment”的排查能力

目标：

```text
让 Agent 模式不只是能生成，还能知道哪一段失败、为什么失败、是否值得重试。
```

验收：

- 任意一段失败时，不需要整条从头排查
- 至少能区分 hook 失败、body_cta 失败、拼接失败
- 前端能看到段级任务状态和最终成片状态

### 路标 3：Benchmark 驱动的智能 Planner

- 用 `shot_list / replicable_template / risks` 增强 Planner
- 自动判断切分点和动作风险
- 根据参考视频结构动态决定 1 段 / 2 段 / 少量 3 段
- 首尾帧能力用于更强的镜头落点控制
- 拼接后统一加 voiceover / TTS，控制整条音频连续性

目标：

```text
从固定两段式，升级为真正由标杆分析结果驱动的 Agent 决策。
```

验收：

- Planner 明确引用 Benchmark Analyzer 的结构化输出
- 简单参考视频可以回退单段
- 标准 UGC 可以稳定两段
- 只有结构非常清晰且每段时长足够时才允许三段
- 音频策略不会破坏最终成片连贯性

## 18. 成功标准

Agent 模式不是看“更高级”，而是看业务指标是否更稳。

建议第一阶段成功门槛：

```text
Agent 模式成片成功率 >= 传统模式
Agent 模式 product_accuracy 不低于传统模式
Agent 模式 reference_structure_match 平均提升 >= 0.5 分
Agent 模式 hook 清晰度明显提升
至少 50% 的失败任务可以定位到具体 segment，而不是整条原因不明
```

如果出现以下情况，则不算成功：

- 产品准确性显著下降
- 段与段人物差异很大
- 拼接感过重
- 成本提升太多但收益不明显

## 19. 一句话原则

Agent 模式的本质不是“多次调模型”，而是：

```text
把一条长视频拆成几个更容易生成、更容易检查、更容易重试的可执行片段，
再通过全局锁和首帧接力把它们重新组织成一条完整视频。
```

如果未来这条路跑通，Benchmark Analyzer 就不再只是“生成前的分析报告”，而会成为：

```text
整个 Agent 视频系统的大脑。
```
