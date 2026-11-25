# pi-posttrain-loop

[![Node.js >= 22.19.0](https://img.shields.io/badge/node-%3E%3D22.19.0-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![ModelScope Dataset](https://img.shields.io/badge/ModelScope_Dataset-vmz--sft--cot--eval-624aff)](https://www.modelscope.cn/datasets/chosenecho/vmz-sft-cot-eval)
[![ModelScope Model](https://img.shields.io/badge/ModelScope_Model-qwen3.8--27b--ep1.5--fp8-624aff)](https://www.modelscope.cn/models/chosenecho/qwen3.8-27b-sft-cot-vmz-r2-ep15-fp8)

`pi-posttrain-loop` 是一个基于内置 `node:sqlite` 与无状态 Pi Agent 循环的模型后训练（SFT / CoT / DPO）数据合成与脱稿对抗评测 CLI。它围绕作者原始文稿完成**多预设（`standard` / `short` / `trap`）多轮问答合成与盲审返工**、**无原稿第一人称思考链（CoT）逆向补写**，以及**物理隔离的对抗/陷阱考题（Probe）盲测、难度标定与整体语义批卷**。领域核心概念见 [术语表（GLOSSARY.md）](GLOSSARY.md)，开源协议为 [MIT](LICENSE)。

> **公开产出（ModelScope）**：
> - **数据集（SFT / CoT 训练集与评测集）**：[chosenecho/vmz-sft-cot-eval](https://www.modelscope.cn/datasets/chosenecho/vmz-sft-cot-eval)
> - **模型权重（ep1.5 Checkpoint，FP8）**：[chosenecho/qwen3.8-27b-sft-cot-vmz-r2-ep15-fp8](https://www.modelscope.cn/models/chosenecho/qwen3.8-27b-sft-cot-vmz-r2-ep15-fp8)

---

## 1. 30 秒离线试跑

环境要求：**Node.js >= 22.19.0**（使用内置 `node:sqlite`，无 C++ 原生编译依赖）、npm。

```powershell
npm install
npm run demo
```

`demo` 使用内置固定材料与确定性判断脚本，不调用外部 API、不需要配置密钥，结果写入独立的 `output/demo.sqlite`：

```text
完成：通过 2，跳过 1，耗尽 0，错误 0
```

其中 2 条全部对话轮通过质检的样本写入 `results` 表（自动标记 `training_enabled: false` 防污染正式训练集），第 3 题演示 `drop` 淘汰分支，仅保留在过程表 `run_items` / `attempts` 中。

---

## 2. 为什么不用单次 Prompt 脚本？（设计取舍与边界）

常见的后训练数据脚本通常用单轮 Prompt 直接把文稿转成 `.jsonl` 文件。一旦进入多轮迭代（SFT → CoT 补写 → On-policy DPO → 跨版本盲测），零散 JSONL 文件会迅速遇到四个棘手问题，`pi-posttrain-loop` 针对它们做了专门的架构取舍：

1. **统一 SQLite 真相源，数据库触发器物理防泄漏**（[ADR 0001](docs/adr/0001-unified-sqlite-over-jsonl-files.md)）
   所有视频按归一化 `video_key` 持久化锁定为 `train`（约 80%）、`test`（约 10%）、`dpo`（约 10%）三分区，同一多 P 视频的所有分块强制同区。`video_splits` 表与 `results` 表均挂载不可变触发器；只有 `live` 模式、`train` 分区且全员 `status: ready` 的运行才允许导出为 SFT 训练集，从根源上杜绝盲测题或半截废案混入训练集。
2. **13 个角色全员无状态 Pi Agent + Skill 白名单隔离**（[ADR 0002](docs/adr/0002-isolated-pi-agents-per-role.md)）
   每次模型调用均启动全新的独立 Pi Agent，不共享隐式会话历史。作答角色（`answer`）看不到质检评分细则（`quality-judge`）；第 $N$ 次返工重答时仅传入最新一版草稿与精简修改意见，不携带历史废案；多轮长度、收束时机与风格分工完全交由按预设切换的专属 Skill 与自主追问 Agent 驱动，不再堆砌脆弱的静态正则与机械配比；每次运行的系统提示词与 Skill SHA-256 指纹完整快照入库。
3. **脱稿逆向补写 CoT，杜绝“看稿找答案”与“正文浓缩摘要”式思维链**（[ADR 0003](docs/adr/0003-blind-cot-backfill-without-source-material.md)）
   在有稿问答阶段直接生成 `<think>` 会导致思考链充满“原文第二段提到……”的摘抄痕迹，而把 `<think>` 写成答案缩写则会诱发模型在正文两段草草收尾。`npm run reasoning` 在不提供 `material` 的前提下，仅凭问题、前序对话与已通过回答逆向生成第一人称开口前思考骨架；程序层仅保留极简工程安全阀（非空、禁原稿/录播/规则等硬泄漏词、禁 `<think>`/Markdown/列表格式脏污、异常超长熔断 `<= 800` 字、连续照抄熔断 `< 36` 字），将自然度、去摘要化与边界一致性交由 `reasoning-judge` 主导裁决。
4. **训练与评测双库、双 Skill 物理隔离**（[ADR 0004](docs/adr/0004-physically-isolated-eval-database-and-skills.md)）
   独立评测库 `data/eval.sqlite`（Schema v2，16 张表）仅以只读方式从主库拉取 `test` 分区文稿快照，使用专属的 `skills/eval/*` 与 `skills/eval/trap/*` 运行 **Agent Loop v3**（自主规划题量与题型、语义去重、内置无原稿裸答对抗回流），生产 6 类对抗考题（`adversarial`）与 4 类陷阱拒答题（`trap`）。运行时守卫（[src/eval-guard.ts](src/eval-guard.ts)、[src/eval/eval-prompts.ts](src/eval/eval-prompts.ts)）禁止训练与评测互读对方 Skill；套卷冻结时自动执行并发运行态守卫、`split = 'test'` 复核、难度占比控制与训练集 2-gram Jaccard 相似度审计；批卷采用 v3 整体语义打分（Substantive Score 与 Style 严格解耦）。

> [!IMPORTANT]
> **明确不做的事（Non-goals）**：
> - **不内置模型训练器**：本工具负责合成、评测与数据集打包工程，导出的严格单行 JSONL 直接交由 `ms-swift` 或 `LLaMA-Factory` 执行 SFT / DPO 训练。
> - **不内置 ASR 转写或网页爬虫**：输入需为清洗后的 Markdown 文稿目录或 JSONL 材料（仓库附带标准库清洗脚本 [export_weimingzi.py](scripts/weimingzi/export_weimingzi.py)）。
> - **不是通用 PDF 拖拽切块问答面板**：内置 28 份 Skill 针对“鲜明作者人设、深度理论辨析、短答快问与陷阱拒答”深度定制；若迁移至其他领域，需替换 `skills/*/SKILL.md` 中的领域规范。

---

## 3. 架构与三条核心流水线

```mermaid
flowchart LR
  Corpus["语料目录 (Markdown / 多P视频)"] --> Splits["持久化三分区 (video_splits)"]
  Splits -->|"train (80%)"| MainLoop["主合成流水线 (standard / short / trap · Question → Answer ⇄ Judge / Followup)"]
  Splits -->|"test (10%) / dpo (10%)"| RubricLoop["盲测/DPO基线 (+ Eval Rubric 抽取 & test-v1 冻结)"]
  MainLoop -->|"已通过 Results (无 Material)"| CoTLoop["脱稿 CoT 补写 (Reasoning Writer ⇄ 安全阀 + LLM Judge)"]
  CoTLoop --> SwiftJSONL["ms-swift CoT JSONL (inline / reasoning_content)"]
  Splits -->|"test 分区只读导入"| EvalLoop["独立评测库 (data/eval.sqlite · Agent Loop v3 · adversarial 6类 / trap 4类)"]
  EvalLoop --> Freeze["裸答难度标定 & 套卷冻结 (indist / adv / trap)"]
  Freeze --> Grade["候选模型脱稿盲测 & 整体语义批卷对比"]
  SwiftJSONL --> Publish["ModelScope 数据集打包发布 (publish_modelscope.py)"]
  Freeze --> Publish
```

1. **主数据合成流水线**（`data/data-maker.sqlite`，14 张表）：多 P 视频自适应合并/超长按分 P 切块 → `--sort core-first` 核心理论课优先或 `--shuffle` 抽选 → 按字数动态紧凑配额（2–6 题）出题 → 支持 `--profile standard | short | trap` 三套专职 Skill 预设，由 `followup` Agent 自主决定继续追问或收束 → 可选抽取结构化评分要点（`eval_rubrics`）→ 按需导出严格单行训练 JSONL（支持 `--timestamp`、按视频整块切验证集与 `--manifest`）。
2. **脱稿 CoT 逆向补写流水线**（`npm run reasoning`）：支持按 `--profile all|standard|short` 与 `--tier short,medium,long` 过滤、分层均衡抽样（`--limit N --stratified`）或增量补齐（`--only-missing`）→ 无原稿逆向生成第一人称思考骨架 → 极简工程安全阀 + `reasoning-judge` 双关过滤 → 默认导出 `ms-swift 4.6.0` 所需的 `--format inline`（`<think>...</think>` 内联；也支持 `--format reasoning_content` 直调 HF `apply_chat_template`），默认 `--expand-turns` 按轮展开（历史轮纯正文，仅末轮带 CoT，配 `--loss_scale last_round`）。
3. **独立对抗与陷阱评测流水线**（`data/eval.sqlite`，Schema v2，16 张表，`npm run eval`）：支持 `--profile adversarial`（6 类实战对抗题）与 `--profile trap`（4 类陷阱拒答题，`expectedBehavior = refuse`）两套独立评测体系；`ProbeWriter` 自主规划单篇 0–N 题（允许非实质文稿跳过）→ `ProbeCritic` 语义审题与去重 → 内置无原稿通用模型裸答试考回流（`bare_check` → `revise`）→ `ReferenceGenerator ⇄ ReferenceVerifier` 原稿核验（`pressure` 2–3 轮 / `trap` 1–2 轮由 `Adversary` 动态施压）→ `RubricExtractorV2` → 通用模型裸答难度标定（`easy`/`medium`/`hard`）→ 套卷冻结（`indist-*` / `adv-*` / `trap-*`）→ 候选模型脱稿作答（默认注入 [prompts/eval/candidate-system.md](prompts/eval/candidate-system.md)）、v3 整体语义批卷与跨模型对比报告。

---

## 4. 配置模型环境（`.env`）

复制 [.env.example](.env.example) 为本地 `.env`（已被 `.gitignore` 排除，凭据永不入库）：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

填写 OpenAI Chat Completions 兼容接口参数：

```dotenv
LLM_BASE_URL=https://YOUR_API_HOST/v1
LLM_MODEL=YOUR_MODEL_ID
LLM_API_KEY=YOUR_API_KEY
LLM_THINKING_LEVEL=high
LLM_CONTEXT_WINDOW=1048576
LLM_MAX_TOKENS=65536
LLM_TIMEOUT_MS=180000
```

支持按流水线或按角色细粒度覆盖模型、思考强度与候选系统提示词（未设置时自动继承 `LLM_*`）：

| 作用域 | 可选环境变量 | 用途 |
| --- | --- | --- |
| 主流水线角色思考强度 | `LLM_{QUESTION,ANSWER,JUDGE,FOLLOWUP,RUBRIC}_THINKING_LEVEL` | 按角色设为 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| CoT 补写角色 | `REASONING_{BASE_URL,MODEL,API_KEY,THINKING_LEVEL,MAX_TOKENS,TIMEOUT_MS}` | 独立指定 `reasoning-writer` 模型 |
| CoT 质检角色 | `REASONING_JUDGE_{BASE_URL,MODEL,API_KEY,THINKING_LEVEL,TIMEOUT_MS}` | 独立指定 `reasoning-judge` 模型（未设时回退 `REASONING_*` → `LLM_*`） |
| 独立对抗评测角色 | `EVAL_LLM_{BASE_URL,MODEL,API_KEY,THINKING_LEVEL,TIMEOUT_MS}` | 独立指定评测出题、核验、裸答标定与批卷裁判模型 |
| 被测候选模型 | `CANDIDATE_LLM_{BASE_URL,MODEL,API_KEY,MAX_TOKENS,TIMEOUT_MS}` | `npm run eval -- run` 脱稿盲测时的默认候选模型接口 |
| 候选模型系统提示词 | `CANDIDATE_LLM_SYSTEM_PROMPT` / `CANDIDATE_LLM_SYSTEM_PROMPT_FILE` | 覆盖 `eval run` 默认加载的 `prompts/eval/candidate-system.md`（可用 `--no-system-prompt` 关闭） |

---

## 5. 常用命令速查

完整的日常生产、实时进度排查 SQL 与故障恢复手册见 [生产操作手册（docs/production-workflow.md）](docs/production-workflow.md)。

### 5.1 主数据合成与三分区导出（`npm run batch` / `export`）

```powershell
# 查看语料库 train / test / dpo 三分区进度与待质检题数（离线，不调用模型）
npm run batch -- --status

# 生产 standard（中长深挖，默认 3 轮）、short（极短/短答，默认 2 轮）、trap（陷阱拒答，默认 2 轮/单视频上限 3 题）训练样本
npm run batch -- --limit 20 --sort core-first --export output/train-batch.jsonl
npm run batch -- --profile short --limit 20 --shuffle --export output/train-short.jsonl
npm run batch -- --profile trap --limit 20 --shuffle --export output/train-trap.jsonl

# 生产 test 分区同分布盲测集 + 抽取每轮结构化评分卡 (--extract-rubric) + 冻结不可变版本 test-v1
npm run batch -- --split test --limit 10 --shuffle --extract-rubric --freeze-version test-v1 --export output/test-v1.jsonl

# 生产 dpo 分区 On-policy 采题池（与 test 分区物理隔离）
npm run batch -- --split dpo --limit 10 --shuffle --extract-rubric --export output/dpo-pool.jsonl

# 汇总导出全库所有正式 train 样本，按整视频切出 10% 验证集 + 时间戳 + 审计清单
npm run export -- --all-formal --dedup latest --shuffle --seed 42 --timestamp --out output/train.jsonl --val-out output/val.jsonl --val-ratio 0.1 --manifest output/manifest.json
```

也可分步调用 [src/question-cli.ts](src/question-cli.ts)（`npm run questions`）、[src/judge-cli.ts](src/judge-cli.ts)（`npm run judge -- --only-unjudged [--profile standard|short|trap]`）或单文件组合入口 [src/cli.ts](src/cli.ts)（`npm start`）。

### 5.2 脱稿 CoT 思考链逆向补写（`npm run reasoning`）

```powershell
# 查看已通过问答轮次（按 standard/short 风格与 short/medium/long 档位统计）与历史补写运行
npm run reasoning -- --status

# 30 轮分层试点（按 profile × tier × turnNo 均衡抽样），并发补写 + 双重质检 + 导出 inline JSONL 与人工审阅稿
npm run reasoning -- --limit 30 --stratified --seed 42 --concurrency 10 --export output/cot-pilot.jsonl --review-md output/cot-pilot-review.md --manifest output/cot-pilot-manifest.json

# 全量增量补写剩余未通过轮次（支持按 --profile standard|short 或 --tier long 过滤）
npm run reasoning -- --only-missing --concurrency 10 --export output/train-cot.jsonl --val-out output/val-cot.jsonl --val-ratio 0.05 --shuffle --seed 42 --manifest output/train-cot-manifest.json

# 离线从指定 reasoning_run 导出（默认 --format inline 适配 ms-swift 4.6.0；直调 HF 可选 --format reasoning_content）
npm run reasoning -- --export-only --reasoning-run 2 --format inline --expand-turns --export output/train-cot.jsonl --review-md output/cot-review.md
```

### 5.3 独立评测库与对抗 / 陷阱盲测流水线（`npm run eval`）

```powershell
# 1. 初始化独立评测库 data/eval.sqlite，并将主库 test-v1 只读镜像为同分布基准卷 indist-v1
npm run eval -- init
npm run eval -- mirror --from-version test-v1 --as indist-v1

# 2. 从主库 test 分区只读导入未用视频快照，并运行 Agent Loop v3（默认内置裸答回流，可选 --no-bare-check）
npm run eval -- import --limit 10 --shuffle --seed 42 --exclude-used
npm run eval -- build --profile adversarial --videos imported --probes-per-video 6 --concurrency 8 --call-attempts 3
npm run eval -- build --profile trap --videos imported --probes-per-video 3 --concurrency 8 --call-attempts 3

# 3. 通用模型无原稿裸答难度标定（easy / medium / hard）并按 profile 冻结不可变套卷
npm run eval -- calibrate --run all --only-uncalibrated --concurrency 8 --out output/eval/calibration-report.md
npm run eval -- freeze --name adv-main-v1 --profile adversarial --max-easy-ratio 0.2 --export output/eval/adv-main-v1.jsonl --manifest-out output/eval/adv-main-v1.manifest.json
npm run eval -- freeze --name trap-main-v1 --profile trap --max-easy-ratio 0.2 --export output/eval/trap-main-v1.jsonl --manifest-out output/eval/trap-main-v1.manifest.json

# 4. 对候选模型执行脱稿盲测（默认加载 prompts/eval/candidate-system.md）、整体语义批卷与跨模型对比报告
npm run eval -- run --suite adv-main-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --history-mode gold
npm run eval -- grade --run latest --concurrency 8
npm run eval -- compare --baseline base --target sft-v1 --suites indist-v1,adv-main-v1,trap-main-v1 --out output/eval/compare-base-vs-sft.md
```

### 5.4 上游清洗、旧库迁移与 ModelScope 数据集发布

本项目基于上述流水线产出的公开资源：
- **训练集与评测集**：[ModelScope · chosenecho/vmz-sft-cot-eval](https://www.modelscope.cn/datasets/chosenecho/vmz-sft-cot-eval)
- **微调模型权重（ep1.5 Checkpoint，FP8）**：[ModelScope · chosenecho/qwen3.8-27b-sft-cot-vmz-r2-ep15-fp8](https://www.modelscope.cn/models/chosenecho/qwen3.8-27b-sft-cot-vmz-r2-ep15-fp8)

```powershell
# 从上游只读文稿仓无损清洗并按 BV 号导出 Markdown 语料目录（Python 3.12+ 标准库）
python scripts/weimingzi/export_weimingzi.py --source data/weimingzi-source --output data/weimingzi-semantic

# 将早期原型库与试跑目录幂等迁移至 data/data-maker.sqlite
npm run migrate

# 校验、脱敏并打包 CoT 训练集与冻结评测集（生成 Dataset Card 与 SHA256SUMS.txt），按需发布到 ModelScope
python scripts/publish_modelscope.py prepare --release-dir output/modelscope-release --repo-id <namespace>/<dataset>
python scripts/publish_modelscope.py upload --repo-id <namespace>/<dataset> --release-dir output/modelscope-release --dry-run
```

---

## 6. 13 角色提示词与多预设 Skill 矩阵

所有角色均遵循“系统提示词定协议 + 独立 Skill 定策略/风格/标准”。仓库内置 **28 份 `SKILL.md`**（全部为 `status: ready`），按业务线与风格预设（`standard` / `short` / `trap` / `eval` / `eval/trap`）通过双向白名单守卫强制隔离：

| 流水线 | 角色 | 系统提示词 | 默认 Skill（`status: ready`） | 风格预设变体 Skill | 注入标签 |
| --- | --- | --- | --- | --- | --- |
| 主数据与盲测基线 | 出题 `question` | [prompts/question.md](prompts/question.md) / [prompts/question-generator.md](prompts/question-generator.md) | [skills/question-design/SKILL.md](skills/question-design/SKILL.md) | [short](skills/short/question-design/SKILL.md) · [trap](skills/trap/question-design/SKILL.md) | `<question-design>` |
| 主数据与盲测基线 | 追问 `followup` | [prompts/followup.md](prompts/followup.md) | [skills/followup-strategy/SKILL.md](skills/followup-strategy/SKILL.md) | [short](skills/short/followup-strategy/SKILL.md) · [trap](skills/trap/followup-strategy/SKILL.md) | `<followup-strategy>` |
| 主数据与评测共享 | 回答 `answer` | [prompts/answer.md](prompts/answer.md) | [skills/answer-style/SKILL.md](skills/answer-style/SKILL.md) | [short](skills/short/answer-style/SKILL.md) · [trap](skills/trap/answer-style/SKILL.md) | `<answer-style>` |
| 主数据与盲测基线 | 质检 `judge` | [prompts/judge.md](prompts/judge.md) | [skills/quality-judge/SKILL.md](skills/quality-judge/SKILL.md) | [short](skills/short/quality-judge/SKILL.md) · [trap](skills/trap/quality-judge/SKILL.md) | `<judging-skill>` |
| 主数据与盲测基线 | 要点 `rubric` | [prompts/rubric.md](prompts/rubric.md) | [skills/eval-rubric/SKILL.md](skills/eval-rubric/SKILL.md) | — | `<eval-rubric>` |
| 脱稿 CoT 逆向补写 | 思考补写 `reasoning-writer` | [prompts/reasoning-writer.md](prompts/reasoning-writer.md) | [skills/reasoning-writer/SKILL.md](skills/reasoning-writer/SKILL.md) | — | `<reasoning-writer>` |
| 脱稿 CoT 逆向补写 | 思考质检 `reasoning-judge` | [prompts/reasoning-judge.md](prompts/reasoning-judge.md) | [skills/reasoning-judge/SKILL.md](skills/reasoning-judge/SKILL.md) | — | `<reasoning-judge>` |
| 独立对抗/陷阱评测 | 对抗出题 `probe-writer` | [prompts/eval/probe-writer.md](prompts/eval/probe-writer.md) | [skills/eval/probe-design/SKILL.md](skills/eval/probe-design/SKILL.md) | [eval/trap](skills/eval/trap/probe-design/SKILL.md) | `<probe-design>` |
| 独立对抗/陷阱评测 | 考题审题 `probe-critic` | [prompts/eval/probe-critic.md](prompts/eval/probe-critic.md) | [skills/eval/probe-critic/SKILL.md](skills/eval/probe-critic/SKILL.md) | [eval/trap](skills/eval/trap/probe-critic/SKILL.md) | `<probe-critic>` |
| 独立对抗/陷阱评测 | 参考回答 `reference` | [prompts/eval/reference.md](prompts/eval/reference.md) | [skills/answer-style/SKILL.md](skills/answer-style/SKILL.md) + [skills/eval/probe-answer/SKILL.md](skills/eval/probe-answer/SKILL.md) | [eval/trap](skills/eval/trap/probe-answer/SKILL.md)（独立不混用 `answer-style`） | `<answer-style>` + `<probe-answer>` |
| 独立对抗/陷阱评测 | 原稿核验 `verifier` | [prompts/eval/verifier.md](prompts/eval/verifier.md) | [skills/eval/reference-verifier/SKILL.md](skills/eval/reference-verifier/SKILL.md) | [eval/trap](skills/eval/trap/reference-verifier/SKILL.md) | `<reference-verifier>` |
| 独立对抗/陷阱评测 | 多轮施压 `adversary` | [prompts/eval/adversary.md](prompts/eval/adversary.md) | [skills/eval/adversary-tactics/SKILL.md](skills/eval/adversary-tactics/SKILL.md) | [eval/trap](skills/eval/trap/adversary-tactics/SKILL.md) | `<adversary-tactics>` |
| 独立对抗/陷阱评测 | 评分卡 v2 `rubric-v2` | [prompts/eval/rubric-v2.md](prompts/eval/rubric-v2.md) | [skills/eval/eval-rubric-v2/SKILL.md](skills/eval/eval-rubric-v2/SKILL.md) | [eval/trap](skills/eval/trap/eval-rubric-v2/SKILL.md) | `<eval-rubric-v2>` |
| 独立对抗/陷阱评测 | 盲测批卷 `eval-grader` | [prompts/eval/grader.md](prompts/eval/grader.md) | [skills/eval/eval-grader/SKILL.md](skills/eval/eval-grader/SKILL.md) | — | `<eval-grader>` |

另外，评测侧包含两份无 Skill 纯协议提示词：[prompts/eval/bare-answer.md](prompts/eval/bare-answer.md)（裸答标定与构建期试考）与 [prompts/eval/candidate-system.md](prompts/eval/candidate-system.md)（候选模型脱稿盲测默认人设提示词）。

---

## 7. 项目状态、验证与文档地图

**当前状态**：`v0.1.0`（活跃维护）。主库 14 张表、独立评测库 16 张表（Schema v2）与上述三条核心流水线均已全量落地并通过自动化回归测试。

```powershell
# 运行 TypeScript 类型检查 + 124 项单元与集成测试
npm run check

# 运行 Python 语料无损清洗脚本的 20 项单元测试
python -m unittest discover -s scripts/weimingzi
```

### 文档地图

- **领域模型与架构决策（Domain Model & ADRs）**
  - [GLOSSARY.md](GLOSSARY.md)：领域通用语言（语料与分区、问答合成与质检、脱稿思考补写、对抗与陷阱盲测）。
  - [ADR 0001](docs/adr/0001-unified-sqlite-over-jsonl-files.md)：统一 SQLite 真相源与 JSONL 按需导出投影。
  - [ADR 0002](docs/adr/0002-isolated-pi-agents-per-role.md)：每角色独立无状态 Pi Agent 与 Skill 白名单隔离。
  - [ADR 0003](docs/adr/0003-blind-cot-backfill-without-source-material.md)：脱稿逆向补写 CoT 与极简工程安全阀校验。
  - [ADR 0004](docs/adr/0004-physically-isolated-eval-database-and-skills.md)：独立评测库 `data/eval.sqlite` 与训练侧双向物理隔离。
- **架构与设计规范**
  - [SQLite 统一存储设计（docs/sqlite-design.md）](docs/sqlite-design.md)：主库 14 表 DDL、触发器不变量、事务恢复与 JSONL 导出规范。
  - [测试集与评测流水线设计（docs/test-and-eval-pipeline.md）](docs/test-and-eval-pipeline.md)：`train` / `test` / `dpo` 持久化三分区、`eval_rubrics` 与 `test-v1` 基线。
  - [对抗与陷阱评测库设计（docs/eval-probe-pipeline.md）](docs/eval-probe-pipeline.md)：`data/eval.sqlite` 16 表（Schema v2）、`adversarial` 6 类 + `trap` 4 类 Agent Loop v3、内置裸答回流、难度标定、套卷冻结与整体语义批卷对比。
- **日常操作与调研备忘**
  - [生产操作手册（docs/production-workflow.md）](docs/production-workflow.md)：多预设批量生产、进度排查 SQL、增量补跑、CoT 补写、对抗/陷阱盲测与 ModelScope 打包发布手册。
  - [后训练推进备忘（docs/post-training-notes.md）](docs/post-training-notes.md)：SFT 多预设与多样性策略、CoT 规格与 On-policy DPO 路线。
  - [Pi Agent 循环调研](docs/research/pi-agent-loop.md) · [同类数据合成项目对比](docs/research/related-data-generation-projects.md) · [早期单表原型归档](docs/question-database.md)。

---

## 8. 开源协议

本项目基于 [MIT License](LICENSE) 开源。
