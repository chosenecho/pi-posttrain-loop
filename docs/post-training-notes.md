# 后训练数据与 DPO 推进备忘

## 1. 持久化三分区机制（`train` / `test` / `dpo` 已落地）

- **全库 1,700 个视频已按 `video_key`（自动归并同视频多 P 分块）引入持久化 `video_splits` 注册表**（详细架构见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）：
  - 早期已跑过的 **29** 个历史 SFT 视频自动锁定为 `train`（`method = 'backfill'`），绝不会倒流进测试集；
  - 其余语料按 `sha256("weimingzi-split-v1:" + video_key)` 固定哈希分桶，实际分布为：`train` **1,367 个视频**（29 回填 + 1,338 哈希）、`test` **174 个视频**（含首版同分布基准 `test-v1` 及独立对抗/陷阱盲测卷）、`dpo` **159 个视频**（全量预留）；语料增减时已分配视频的分区永不漂移；
  - **盲测集（`test`）与 DPO 采题池（`dpo`）物理隔离**：拿 `dpo` 分区的错题做 On-policy DPO 训练后，`test` 盲测集依然保持 100% 纯净可复测。
- **常用分区生产与冻结命令**：
  - 日常生产 SFT 训练集（支持 `--profile standard | short | trap`，默认只抽 `train` 视频，`--all-formal` 自动排除 `test`/`dpo`）：
    `npm run batch -- --limit 20 --sort core-first --export output/train-batch.jsonl`
  - 生产盲测集并抽取每轮评分要点（`eval_rubrics`）+ 冻结版本（`test-v1`）：
    `npm run batch -- --split test --limit 6 --shuffle --concurrency 40 --extract-rubric --freeze-version test-v1 --export output/test-v1.jsonl`
  - 按冻结版本号单独导出纯净盲测集 `output/test.jsonl`：
    `npm run export -- --version test-v1 --out output/test.jsonl --manifest output/test-manifest.json`
  - 生产 On-policy DPO 采题池：
    `npm run batch -- --split dpo --limit 15 --shuffle --concurrency 40 --extract-rubric --export output/dpo-pool.jsonl`

---

## 2. 已落地的 SFT 多样性与 Agent 化生产机制（当前实现）

1. **多 P 视频自适应合并/分块（`loadVideoChunks`）与核心理论课优先抽选（`--sort core-first`）**：
   - 中小多 P 视频（合并后 `<= 32,000` 字）：自动合并为 1 条完整 `material`，保留上下集连贯语境。
   - 超长多 P 系列大合集（合并后 `> 32,000` 字，如 20P–45P 系列课程）：自动按分 P 边界切分为多个 `<= 32,000` 字的分块（`BVxxxx/P001` 或 `BVxxxx/P001-P004`），每个分块独立计算题量配额、独立出题与质检。
   - `--sort core-first`（`rankVideosCoreFirst`）：按 Tier 2（多 P 且 `>= 6KB`）→ Tier 1（单 P 且 `>= 6KB`）→ Tier 0（短通知/杂谈）排序，优先抽取作者核心理论框架文稿，提升训练集跨议题覆盖率。
2. **紧凑单视频配额（`computeQuestionQuota` 2–6 题）与去机械规则门控**：
   - 单 P 基础额度收敛为：`< 1,500 字` 最多 **2 题**、`1,500–4,999 字` 最多 **3 题**、`5,000–14,999 字` 最多 **4 题**、`>= 15,000 字` 最多 **5 题**；实质多 P（有效分 P `>= 3`）额外 `+1`（单块总上限封顶 **6 题**），在同等总题量下最大化视频覆盖面。
   - 取消早期基于静态正则的出题分布拦截与硬编码轮数/篇幅排班表，让 `save_questions` 仅保留结构化上限与精确去重校验，将问法多样性、短答节奏与陷阱构题全面交由专职 `SKILL.md` 与无状态 Agent 闭环控制。
3. **三套训练风格预设（`--profile standard | short | trap`）与自主轮数收束**：
   - **`standard`（默认）**：中长深挖问答，默认 `--max-turns 3`，覆盖概念辨析、现实迁移、错误前提纠偏与边界坦承。
   - **`short`**：独立短答数据集预设（`skills/short/*`），默认 `--max-turns 2`，显式拉齐“50–150 字极短快问”与“160–350 字单点短答”两档体量，避免微调模型遇到轻快直问仍惯性输出千字长文。
   - **`trap`**：独立陷阱拒答数据集预设（`skills/trap/*`），默认 `--max-turns 2`、单视频上限 **3 题**，专门覆盖 4 类陷阱（移花接木/伪造出处、逼问未知数据/预测、假二选一/越界代拍板、片面传闻诱导定性），训练模型以自然作者口吻干脆拆坑或拒答。
   - 多轮推进不再强行锁定 `30:50:20` 轮数配比或模数篇幅档位，而是在 `--max-turns` 上限内由 `followup` Agent 按话题余量自主决定继续追问（`ask`）或自然收束（`stop`）。
4. **单次模型调用自动重试与高并发容错（`src/retry.ts`）**：
   - `batch` / `judge` / `questions` / `reasoning` / `eval` 对所有角色默认启用 **最多尝试 3 次、每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`），并发上限支持 `1–500`；3 次均失败则记录最后错误与原始输出并直接丢弃该题，不阻塞批处理。
5. **脱稿 CoT（`<think>`）逆向补写流水线（`npm run reasoning`）**：
   - 针对 `train` 分区已通过质检的每一轮问答（支持 `--profile all | standard | short` 与 `--tier short,medium,long` 过滤），在不提供原始材料的前提下逆向补写第一人称开口前思考骨架；
   - 程序层仅保留极简工程安全阀（非空、禁原稿/录播/规则/AI 自称等硬泄漏词、禁 `<think>`/Markdown/列表格式脏污、异常超长熔断 `--max-chars 800`、连续极端照抄熔断 `--max-verbatim 36`），并将统计指标作为参考传给 `reasoning-judge`，由 LLM 裁判主导自然度、去摘要化与逻辑一致性裁决；
   - 默认导出 `--format inline`（`<think>\n...\n</think>\n\n` 内联，适配 `ms-swift 4.6.0` `qwen3_8` 模板，避免 `reasoning_content` 被静默丢弃），同时保留 `--format reasoning_content` 供直调 HF `apply_chat_template`；默认开启 `--expand-turns`（历史轮纯正文、仅末轮带 CoT，配 `ms-swift --loss_scale last_round`）。训练时建议混入 **10%–20% 带 `<think>` 的通用回放数据**，守住通用能力回归红线。
6. **数据集发布与资产闭环**：
   - 通过 `scripts/publish_modelscope.py` 一键校验 CoT 训练集/验证集与冻结对抗/陷阱评测集（`adv-main-v1` / `trap-main-v1`），脱敏本机路径并生成 Dataset Card 与 `SHA256SUMS.txt` 发布至 ModelScope。

---

## 3. 整体后训练路线（SFT → 脱稿盲测验收 → On-policy DPO → 按需评估 CPT/RAG）

1. **阶段 1：SFT（核心基线）**
   - 使用 `pi-posttrain-loop` 组合生产 `standard` + `short` + `trap` 三类 `train` 分区高质量单轮与多轮样本，并通过 `npm run reasoning` 补写脱稿 CoT；训练时按 10%–20% 混入通用对话数据防灾难性遗忘。
   - 保留 `data/data-maker.sqlite` 中的全部过程记录（`attempts` 里会自动沉淀 `revise → pass` 记录，留作后续 DPO 补充素材）。
   - 训练完成后，使用 `npm run eval` 在独立评测库 `data/eval.sqlite` 的三套冻结盲测卷（同分布卷 `indist-v1`、综合对抗卷 `adv-*`、陷阱拒答卷 `trap-*`）上，统一注入 `prompts/eval/candidate-system.md` 完成 `base` vs `sft-v1` 脱稿盲测与整体语义批卷对比。

2. **阶段 2：SFT 训完后做 On-policy DPO（错题本纠偏）**
   - **准备独立 DPO 模拟考卷（严禁使用 `test` 分区）**：使用物理隔离的 **`dpo` 分区**（`npm run batch -- --split dpo --extract-rubric`），这些题目既有强模型通过质检的标准答案（`chosen`），也配套了每轮的 `eval_rubrics` 结构化评分卡。
   - **让 SFT v1 脱稿裸答**：不提供原始 `material`，直接输入问题（多轮题输入前轮 `chosen` 历史 + 本轮追问），让 SFT v1 正常作答。
   - **批卷筛选 `rejected`**：
     - 结合 `eval-grader` / `quality-judge` 与该轮 `eval_rubrics`（`stance` / `keyPoints` / `forbidden` / `mustNotHallucinate`）核查观点一致性、立场方向、拒答定力与幻觉；
     - 答得好的题只统计通过率，不硬当负样本；
     - 翻车的回答作为 `rejected`，配对库里对应的强模型 `pass` 回答作为 `chosen`。
   - **注意防长度偏差**：过滤掉 `chosen` 与 `rejected` 长度悬殊（如差 2 倍以上）且差距仅源于篇幅的样本。
   - **合并训练与盲测复检**：可将 On-policy 错题对与 SQLite 里现成的 `revise → pass` 偏好对合并，凑齐 500–2,000 对跑一轮 LoRA-DPO（低学习率，如 `5e-6`，`beta=0.1`，1–2 epoch）；训练完成后回到从未参与训练的冻结 `indist-*` / `adv-*` / `trap-*` 盲测集做前后对比。

3. **阶段 3：CPT 暂缓，按实测效果再决定**
   - 原始视频转写稿含大量口癖与 ASR 噪声，现阶段不做 CPT。
   - 仅当 SFT + DPO 实测后仍普遍出现“风格像但核心观点/冷门概念记不住”且不采用 RAG 方案时，再考虑：先清洗原稿去口癖与纠错 → 混入 1:1～1:3 通用高质量中文语料 → 低学习率 LoRA 轻量 CPT → 再接 SFT + DPO。
