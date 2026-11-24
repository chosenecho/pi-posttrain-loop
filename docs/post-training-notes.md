# 后训练数据与 DPO 推进备忘

## 1. 持久化三分区机制（`train` / `test` / `dpo` 已落地）

- **全库 1,700 个视频已按 `video_key`（自动归并同视频多 P 分块）引入持久化 `video_splits` 注册表**（详细架构见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）：
  - 早期已跑过的 **29** 个历史 SFT 视频自动锁定为 `train`（`method = 'backfill'`），绝不会倒流进测试集；
  - 其余语料按 `sha256("weimingzi-split-v1:" + video_key)` 固定哈希分桶，实际分布为：`train` **1,367 个视频**（29 回填 + 1,338 哈希，已产 **163 条**正式训练样本）、`test` **174 个视频**（已产 **38 条 / 71 轮**并冻结为 `test-v1`，71 轮 `eval_rubrics` 全量抽取）、`dpo` **159 个视频**（全量预留）；语料增减时已分配视频的分区永不漂移；
  - **盲测集（`test`）与 DPO 采题池（`dpo`）物理隔离**：拿 `dpo` 分区的错题做 On-policy DPO 训练后，`test` 盲测集依然保持 100% 纯净可复测。
- **常用分区生产与冻结命令**：
  - 日常生产 SFT 训练集（默认只抽 `train` 视频，`--all-formal` 自动排除 `test`/`dpo`）：
    `npm run batch -- --limit 10 --shuffle --export output/train-batch.jsonl`
  - 生产盲测集并抽取每轮评分要点（`eval_rubrics`）+ 冻结版本（`test-v1`）：
    `npm run batch -- --split test --limit 6 --shuffle --concurrency 40 --extract-rubric --freeze-version test-v1 --export output/test-v1.jsonl`
  - 按冻结版本号单独导出纯净盲测集 `output/test.jsonl`：
    `npm run export -- --version test-v1 --out output/test.jsonl --manifest output/test-manifest.json`
  - 生产 On-policy DPO 采题池：
    `npm run batch -- --split dpo --limit 15 --shuffle --concurrency 40 --extract-rubric --export output/dpo-pool.jsonl`

---

## 2. 已落地的 SFT 多样性与配额控制机制

1. **多 P 视频自适应合并/分块（`loadVideoChunks`）**：
   - 中小多 P 视频（合并后 `<= 32,000` 字）：自动合并为 1 条完整 `material`，保留上下集连贯语境。
   - 超长多 P 系列大合集（合并后 `> 32,000` 字，如 20P–45P 系列课程）：自动按分 P 边界切分为多个 `<= 32,000` 字的分块（`BVxxxx/P001` 或 `BVxxxx/P001-P004`），每个分块独立计算题量配额、独立出题与质检，既不爆上下文也不漏掉后期分 P。
2. **单视频/分块动态出题上限（`computeQuestionQuota` + 保存工具硬封顶）**：
   - 单 P 基础额度：`< 2,500 字` 最多 **3 题**、`2,500–7,999 字` 最多 **5 题**、`8,000–19,999 字` 最多 **7 题**、`>= 20,000 字` 最多 **9 题**。
   - 多 P 实质内容加成：仅当 `partCount > 1` 且平均每 P 有实质篇幅（按 `floor(charCount / 2000)` 折算有效分 P 数）时，最多额外 +3 题（单块总上限封顶 **10 题**），防止碎切片合集虚增题量。
3. **单视频内按比例分配对话轮数（默认 `1轮 30% : 2轮 50% : 3轮 20%`）**：
   - `batch-cli` 与 `judge-cli` 默认 `--max-turns 3`，按 `[2, 1, 2, 3, 2, 1, 2, 3, 1, 2]` 低差异序列为同视频内的题目分配目标轮数（可用 `--fixed-turns` 切换回固定轮数）。
4. **按轮次分配回答篇幅档位（默认 `short 25% : medium 50% : long 25%`）**：
   - 按 `["medium", "short", "medium", "long"]` 循环并随 `turnNo` 轮转（保证同一条多轮对话相邻两轮不会连续出现 `long` 或 `short`）：
     - `short`：**150–350 字**（快刀斩乱麻，超过 420 字 Judge 判 `revise` 要求精简）
     - `medium`：**400–750 字**（常规主力篇幅，上限 900 字）
     - `long`：**800–1,300 字**（深度多层拆解）
5. **单次模型调用自动重试与失败丢弃（`src/retry.ts`）**：
   - `batch` / `judge` / `questions` / `reasoning` 对所有角色（`question` / `answer` / `judge` / `followup` / `rubric` / `reasoning-writer` / `reasoning-judge`）默认启用 **最多尝试 3 次、每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`），覆盖空正文、网络超时、DSML 串台 / 畸形 JSON 等偶发异常；3 次均失败则记录最后错误与原始输出并直接丢弃该题，不阻塞批处理。
6. **脱稿 CoT（`<think>`）逆向补写流水线（`npm run reasoning`）**：
   - 针对 `train` 分区已通过质检的每一轮问答，在不提供原始材料的前提下逆向补写作者开口前的第一人称思考骨架（`short` 80–160 字 / `medium` 120–230 字 / `long` 180–340 字）；
   - 经确定性规则校验（防元数据泄漏、防 Markdown 列表八股、长度比 `<= 0.8`、8-gram 重合率 `<= 0.25`、连续照抄 `<= 18` 字）+ `reasoning-judge` 语义质检双关过滤；
   - 支持导出 `ms-swift` 的 `reasoning_content`（默认）或 `<think>` 内联格式，并默认按轮展开（`--expand-turns`，历史轮纯正文、仅末轮带 CoT，适配 `ms-swift --loss_scale last_round`）。

---

## 3. 整体后训练路线（SFT → On-policy DPO → 按需评估 CPT/RAG）

1. **阶段 1：SFT（当前核心）**
   - 持续使用 `data-maker` 生产 `train` 分区高质量单轮 + 多轮对话样本（并按需通过 `npm run reasoning` 补写 CoT），训练时按 10%–20% 混入通用对话数据防灾难性遗忘。
   - 保留 `data/data-maker.sqlite` 中的全部过程记录（`attempts` 里会自动沉淀 `revise → pass` 记录，留作后续 DPO 补充素材）。
   - 训练完成后，先在冻结的 **`test` 分区盲测集（`test-v1`，`output/test.jsonl`）** 上结合 `eval_rubrics` 验收首轮 SFT 效果。

2. **阶段 2：SFT 训完后做 On-policy DPO（错题本纠偏）**
   - **准备独立 DPO 模拟考卷（严禁使用 `test` 分区）**：使用物理隔离的 **`dpo` 分区**（`npm run batch -- --split dpo --extract-rubric`），这些题目既有强模型通过质检的标准答案（`chosen`），也配套了每轮的 `eval_rubrics` 结构化评分卡。
   - **让 SFT v1 脱稿裸答**：不提供原始 `material`，直接输入问题（多轮题输入前轮 `chosen` 历史 + 本轮追问），让 SFT v1 正常作答。
   - **批卷筛选 `rejected`**：
     - 结合 `quality-judge` 与该轮 `eval_rubrics`（`stance` / `keyPoints` / `forbidden` / `mustNotHallucinate`）核查观点一致性、立场方向与幻觉；
     - 答得好的题只统计通过率，不硬当负样本；
     - 翻车的回答作为 `rejected`，配对库里对应的强模型 `pass` 回答作为 `chosen`。
   - **注意防长度偏差**：过滤掉 `chosen` 与 `rejected` 长度悬殊（如差 2 倍以上）且差距仅源于篇幅的样本。
   - **合并训练与盲测复检**：可将 On-policy 错题对与 SQLite 里现成的 `revise → pass` 偏好对合并，凑齐 500–2,000 对跑一轮 LoRA-DPO（低学习率，如 `5e-6`，`beta=0.1`，1–2 epoch）；训练完成后回到从未参与训练的冻结 `test-v1` 盲测集做前后对比。

3. **阶段 3：CPT 暂缓，按实测效果再决定**
   - 原始视频转写稿含大量口癖与 ASR 噪声，现阶段不做 CPT。
   - 仅当 SFT + DPO 实测后仍普遍出现“风格像但核心观点/冷门概念记不住”且不采用 RAG 方案时，再考虑：先清洗原稿去口癖与纠错 → 混入 1:1～1:3 通用高质量中文语料 → 低学习率 LoRA 轻量 CPT → 再接 SFT + DPO。
