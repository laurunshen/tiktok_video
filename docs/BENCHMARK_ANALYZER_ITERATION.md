# Benchmark Analyzer 迭代说明

> 用途：定义“视频关键元素解析提取”这个原子能力如何评估、闭环、迭代。
> 核心原则：不要只判断解析报告写得像不像，而要判断它是否让最终生成视频变得更好。

## 1. 模块定位

Benchmark Analyzer 的目标不是做一个泛泛的视频总结器，而是从高 ROI / 高质量参考视频中提取可复用的生成结构。

当前能力链路：

```text
标杆视频
  -> 抽帧 + ASR + Gemini 视频理解
  -> timeline / shot_list / replicable_template / prompt_recipe
  -> 供后续 Seedance prompt 生成或人工分析使用
```

该模块应该回答的问题：

- 这个视频为什么能作为标杆？
- 哪些结构可以复用到另一个产品？
- 哪些动作、镜头、产品露出方式对生成模型友好？
- 哪些复杂动作或视觉细节会导致 AI 生成失败？
- 提取结果是否能稳定提升生成视频质量？

## 2. 为什么需要数据闭环

只人工看解析结果，会得到主观判断：

```text
解析报告看起来不错。
```

但业务真正关心的是：

```text
使用这个解析结果后，生成视频是否更像标杆、更清楚展示产品、更少跑偏、更有投放价值？
```

因此评测闭环必须覆盖完整链路：

```text
标杆视频
  -> 视频解析器
  -> 结构化模板 / shot_list / prompt_recipe
  -> 生成系统
  -> 生成视频
  -> 人工/模型评价
  -> 失败标签
  -> 反向修改解析 prompt / schema / 抽帧策略 / 生成接入方式
```

如果解析结果没有进入生成链路，或者生成结果没有被评价，就不能证明这个原子能力是高质量的。

## 3. 最小可行闭环

第一阶段不要做复杂平台，先做 10-20 条视频的小样本闭环。

### Step 1: 准备标杆样本

选择 10-20 条高 ROI / 高 GMV / 人工认为质量高的视频，尽量覆盖不同类型：

- talking head
- voiceover only
- silent product showcase
- before-after
- try-on / mirror demo
- product close-up

每条样本至少记录：

```json
{
  "benchmark_video_id": "xxx",
  "video_url": "xxx",
  "category": "lingerie",
  "reason_selected": "ROI > 3 / GMV > 5000 / manual selected",
  "duration_seconds": 15
}
```

### Step 2: 跑 Benchmark Analyzer

对每条视频运行当前解析器，保存完整输出：

- transcript
- frameTimeline
- template.timeline
- template.shot_list
- template.replicable_template
- template.prompt_recipe
- template.risks
- template.scorecard
- validation

每次保存时记录版本信息：

```json
{
  "analyzer_version": "benchmark_analyzer_v1",
  "model": "gemini-3.1-pro-preview",
  "frame_strategy": "smart_info_sampling_v1",
  "prompt_version": "2026-05-25"
}
```

### Step 3: 用解析结果生成视频

同一批产品和参考视频，做 A/B 对照：

```text
A 组：不使用 Benchmark Analyzer 输出，按当前主流程生成
B 组：使用 Benchmark Analyzer 输出的 shot_list / replicable_template / prompt_recipe 辅助生成
```

目标不是一次性证明所有东西，而是判断：

- B 组是否更像参考视频结构？
- B 组是否更容易保留产品露出方式？
- B 组是否减少无效镜头和复杂动作？
- B 组是否提升商业表达清晰度？

### Step 4: 评价生成结果

每条生成视频用 1-5 分打分。

| 指标 | 说明 |
|---|---|
| reference_structure_match | 是否保留参考视频的镜头结构、节奏、叙事顺序 |
| product_accuracy | 产品颜色、材质、边缘、肩带、扣子、钢圈等是否准确 |
| product_visibility | 产品是否在关键时刻清楚露出 |
| visual_stability | 是否有手部畸形、身体扭曲、镜头崩坏、角色不一致 |
| commercial_clarity | 用户是否能快速理解卖点和购买理由 |
| ai_replicability | 这个结构是否适合继续批量生成，而不是只适合单条视频 |

建议评分标准：

```text
1 = 明显失败
2 = 多数问题，勉强可看
3 = 基本可用，但有明显改进空间
4 = 较好，可以进入人工筛选
5 = 很好，接近可投放/可复用
```

### Step 5: 给失败原因打标签

低分视频必须打失败标签，避免只留下“感觉不好”。

推荐标签：

```text
wrong_product_color
wrong_product_texture
wrong_product_structure
missing_product_closeup
weak_hook
wrong_shot_sequence
bad_motion
complex_hand_action
body_deformation
face_identity_drift
scene_mismatch
script_not_aligned
template_too_generic
prompt_recipe_not_actionable
```

失败标签的作用是反推应该改哪里：

| 失败标签 | 优先检查 |
|---|---|
| wrong_product_color / texture / structure | 产品视觉属性约束不足，需增强 product attribute extraction |
| missing_product_closeup | shot_list / prompt_recipe 未强制关键产品镜头 |
| weak_hook | hook_type / timeline 角色识别不准，需加强前 3 秒解析 |
| wrong_shot_sequence | 时间线切分或抽帧策略不足 |
| bad_motion / complex_hand_action | risks 提取不足，需更严格标记高风险动作 |
| template_too_generic | replicable_template 太抽象，需改 schema 和 prompt |
| prompt_recipe_not_actionable | prompt_recipe 无法直接转 Seedance prompt，需增加可执行镜头语言 |

## 4. 评估解析器本身

除了看最终生成结果，也需要单独评估解析质量。

建议对每条视频人工抽查以下维度：

| 维度 | 评分 | 说明 |
|---|---|---|
| timeline_accuracy | 1-5 | 时间段划分是否合理 |
| shot_action_accuracy | 1-5 | 镜头类型和动作是否识别正确 |
| product_visibility_accuracy | 1-5 | 产品露出状态是否判断正确 |
| transcript_alignment | 1-5 | spoken_line 是否和 ASR 时间对齐 |
| replicable_template_quality | 1-5 | 是否提取出可复用结构，而不是泛泛总结 |
| risk_detection_quality | 1-5 | 是否识别出 AI 生成高风险点 |
| prompt_recipe_quality | 1-5 | 是否能直接帮助生成 prompt |

注意：解析器本身高分不等于业务有效。最终仍要以下游生成结果为准。

## 5. 一条实验记录应该长什么样

建议每一次闭环实验保存一条结构化记录：

```json
{
  "experiment_id": "bench_eval_2026_05_25_001",
  "benchmark_video_id": "bv_001",
  "product_id": "prod_001",
  "analyzer_version": "benchmark_analyzer_v1",
  "generation_prompt_version": "seedance_prompt_v3",
  "model": {
    "analyzer": "gemini-3.1-pro-preview",
    "video_generation": "seedance-2"
  },
  "parsed_template_summary": {
    "hook_type": "problem-solution",
    "shot_count": 6,
    "motion_complexity": "medium"
  },
  "generated_video_url": "xxx",
  "human_scores": {
    "reference_structure_match": 4,
    "product_accuracy": 2,
    "product_visibility": 3,
    "visual_stability": 4,
    "commercial_clarity": 3,
    "ai_replicability": 4
  },
  "failure_tags": [
    "wrong_product_texture",
    "missing_product_closeup"
  ],
  "review_notes": "结构像参考视频，但产品从 seamless bra 变成 lace bra，关键 close-up 不够。",
  "iteration_decision": "Add must_preserve_product_attributes and must_avoid_visual_errors to analyzer schema."
}
```

## 6. 迭代决策规则

每轮跑完 10-20 条视频后，不要逐条凭感觉修改。先看失败标签分布。

### 情况 A: 产品细节错误最多

现象：

```text
wrong_product_color / wrong_product_texture / wrong_product_structure 高频出现
```

迭代方向：

- 增加 product visual attributes schema
- 强制输出 must_preserve_product_attributes
- 强制输出 must_avoid_visual_errors
- 在生成 prompt 中加入 PRODUCT VISUAL ANCHOR
- 生成后抽帧做产品属性复查

### 情况 B: 结构不像参考视频

现象：

```text
wrong_shot_sequence / weak_hook / script_not_aligned 高频出现
```

迭代方向：

- 增强 timeline 和 shot_list 的时间戳要求
- 前 3 秒 hook 提高抽帧密度
- 要求每个 shot 输出 role、action、camera、spoken_line、product_visibility
- 将 shot_list 更直接地接入主生成流程

### 情况 C: 模板太泛

现象：

```text
template_too_generic / prompt_recipe_not_actionable 高频出现
```

迭代方向：

- 限制空泛词，例如 high quality、engaging、authentic
- 要求 prompt_recipe 输出 Seedance 可执行镜头语言
- 每条 replication rule 必须包含 timestamp evidence
- 增加 negative examples，说明什么叫不可执行模板

### 情况 D: 动作导致生成崩坏

现象：

```text
bad_motion / complex_hand_action / body_deformation 高频出现
```

迭代方向：

- risks 中必须标记复杂手部、快速转身、穿脱、拉扯、镜前动作
- 为每个高风险动作输出 safer_alternative_action
- 生成 prompt 中替换高风险动作，而不是照搬参考视频

## 7. 成功标准

第一阶段目标不是追求完美，而是证明该原子能力有稳定收益。

建议设定以下门槛：

```text
解析结构有效率 >= 80%
B 组 reference_structure_match 比 A 组平均高 >= 0.5 分
B 组 commercial_clarity 比 A 组平均高 >= 0.3 分
B 组没有显著降低 product_accuracy
template_too_generic 标签占比 < 20%
```

如果使用 Benchmark Analyzer 后结构更像参考，但产品准确度下降，则不能算成功。对当前业务来说，产品准确性是硬约束。

## 8. 后续产品化方向

当手工闭环跑通后，可以逐步产品化：

1. 新增 benchmark analysis runs 表，保存每次解析输出和版本。
2. 新增 generation evaluation 表，保存生成结果评分和失败标签。
3. 在前端标杆分析页增加“用于生成实验”按钮。
4. 在历史页支持对生成视频打分和打失败标签。
5. 增加按 analyzer_version 聚合的质量报表。
6. 将高分解析模板沉淀到模板库，低分样本进入 regression set。

## 9. 一句话原则

Benchmark Analyzer 的质量，不由解析报告本身决定，而由它能否稳定提升最终生成视频决定。

真正的数据闭环是：

```text
解析结果必须进入生成；生成结果必须被评价；评价结果必须反过来改解析器。
```
