# 生产操作手册（日常批量生成、CoT 补写、评测与发布）

本手册面向日常使用 `pi-posttrain-loop` 对视频文稿库进行多预设增量出题、多轮问答质检、故障补跑、总训练集导出、脱稿 CoT 补写、对抗/陷阱盲测以及 ModelScope 数据集打包发布的完整操作。

---

## 1. 环境检查与推荐配置

确认根目录 `.env` 已配置（真实密钥不入库）：

```dotenv
LLM_BASE_URL=http://127.0.0.1:3425/v1
LLM_MODEL=auto/deepseek-v4.1-flash
LLM_API_KEY=<你的密钥>
LLM_THINKING_LEVEL=high
LLM_CONTEXT_WINDOW=1048576
LLM_MAX_TOKENS=65536
LLM_TIMEOUT_MS=180000
```

> **经验参数**：
> - `LLM_MAX_TOKENS=65536`：避免 `high` 思考等级下思考过程打满 8K 触发 `length` 截断。
> - `--concurrency` 支持 `1–500`（默认 `10`；本地路由网关承载力足够时可用 `--concurrency 40` 显著加速）。
> - 如需进一步提速，可按角色降档思考等级（不影响未配置的角色）：
>   ```dotenv
>   LLM_ANSWER_THINKING_LEVEL=high
>   LLM_JUDGE_THINKING_LEVEL=low
>   LLM_FOLLOWUP_THINKING_LEVEL=medium
>   LLM_RUBRIC_THINKING_LEVEL=medium
>   ```
> - 候选模型脱稿盲测（`npm run eval -- run`）默认加载 [prompts/eval/candidate-system.md](../prompts/eval/candidate-system.md)，也可通过 `CANDIDATE_LLM_SYSTEM_PROMPT` / `CANDIDATE_LLM_SYSTEM_PROMPT_FILE` 或 CLI `--system-prompt` / `--system-prompt-file` / `--no-system-prompt` 覆盖。

---

## 2. 日常生产与盲测操作流程

### 第一步：查看当前语料库、三分区与待质检进度（不调模型）

```powershell
npm run batch -- --status
```

输出总视频数（同视频多 P 合并算 1 个）、已处理/未处理视频数、`train` / `test` / `dpo` 三个持久化分区的进度，以及当前 `maxTurns` 下未完成质检的题数。

### 第二步：一键增量跑新批次（支持 `standard` / `short` / `trap` 三套预设）

主合成流水线支持三种 `--profile` 预设，由对应 Skill 套装与自主追问 Agent 驱动对话深度与风格（无需机械轮数比例或硬编码篇幅排班）：

- **`standard`（默认）**：中长深挖问答，默认 `--max-turns 3`，按字数与分 P 数动态紧凑封顶 **2–6 题**。
- **`short`**：极短/短答专职 Skill（`skills/short/*`），默认 `--max-turns 2`，覆盖 50–150 字快问与 160–350 字单点短答。
- **`trap`**：陷阱识别与作者口吻拒答专职 Skill（`skills/trap/*`），默认 `--max-turns 2`、单视频默认上限 **3 题**。

```powershell
# 1. standard 预设 + 核心理论课优先（--sort core-first 优先实质多 P 系列课与长篇理论文稿）
npm run batch -- --limit 20 --sort core-first --export output/train-batch.jsonl

# 2. short 预设（极短/短答专职 Skill，默认 2 轮）
npm run batch -- --profile short --limit 20 --shuffle --export output/train-short.jsonl

# 3. trap 预设（陷阱识别与拒答专职 Skill，默认 2 轮、单视频上限 3 题）
npm run batch -- --profile trap --limit 20 --shuffle --export output/train-trap.jsonl

# 如需顺带补跑上一批遗留未质检题，可追加 --include-unjudged：
npm run batch -- --limit 20 --shuffle --include-unjudged --export output/train-batch.jsonl
```

**内置自动重试与容错策略（默认开启，适用于 `batch` / `judge` / `questions` / `reasoning` / `eval`）**：
- 单次模型调用发生空正文、网络抖动、超时、DSML 串台 / 畸形 JSON 或未触发保存工具时，默认**自动尝试最多 3 次，每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`）。
- 3 次均失败时，保留最后一次原始输出与报错记录到 `model_calls`，并**直接丢弃该题/分块**（不写入 `results`，不影响同批其他题目）。
- 正常的质检返工（`revise`）仍由 `--max-attempts 3` 独立控制，与调用重试互不干扰。

如需单独补跑库里遗留的未质检题（不新抽视频）：

```powershell
npm run judge -- --profile standard --max-turns 3 --max-attempts 3 --concurrency 10 --only-unjudged --export output/train-retry.jsonl
```

### 第三步：汇总导出总训练集

```powershell
# 全库正式训练样本汇总（默认 --split train，自动排除非正式运行及 test/dpo 分区视频，同题默认取最新 run；--timestamp 自动附加本地时间戳）
npm run export -- --all-formal --timestamp --out output/train-all.jsonl --manifest output/train-all-manifest.json

# 正式训练前：固定种子打乱 + 按视频整块切 10% 训练验证集（多 P 分块自动绑定同侧防泄漏）+ 可选注入统一训练 system
npm run export -- --all-formal --out output/train.jsonl --val-out output/val.jsonl --val-ratio 0.1 --shuffle --seed 42 --timestamp --manifest output/train-manifest.json
```

### 第四步：独立生产并冻结盲测集（`test`）与 DPO 采题池（`dpo`）

语料库全部 1,700 个视频已按 `video_key` 的 SHA-256 哈希持久化划分为 `train`（1,367 个，含 29 个历史回填）、`test`（174 个）、`dpo`（159 个）三个物理隔离分区（完整设计与 `test-v1` 基准明细见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）：

```powershell
# 1. 从 test 分区抽视频出题 + 多轮问答质检 + 抽取每轮结构化评分要点（eval_rubrics）+ 固化版本 test-v1
npm run batch -- --split test --limit 6 --shuffle --concurrency 40 --extract-rubric --freeze-version test-v1 --export output/test-v1.jsonl

# 2. 随时按冻结版本号单独导出为纯净盲测集与审计清单（不受后续批次影响）
npm run export -- --version test-v1 --out output/test.jsonl --manifest output/test-manifest.json

# 3. 从 dpo 分区独立生产 On-policy DPO 采题池（不污染 test 盲测集）
npm run batch -- --split dpo --limit 15 --shuffle --concurrency 40 --extract-rubric --export output/dpo-pool.jsonl
```

### 第五步：脱稿 CoT（`<think>`）逆向补写与导出（`npm run reasoning`）

若目标 SFT 模型为推理/思考模型（如使用 `ms-swift 4.6.0` 训练 Qwen 思考模型），可针对 `train` 分区已通过的问答轮次（支持 `standard` 与 `short` 来源预设）在无原稿前提下逆向补写第一人称思考骨架：

```powershell
# 查看可补写轮次分布（按 profile / tier / turnNo）与历史补写运行（不调用模型）
npm run reasoning -- --status

# 30 轮分层试点（按 profile × tier × turnNo 跨视频均衡抽样）并输出人工审阅稿与试点 JSONL
npm run reasoning -- --limit 30 --stratified --seed 42 --concurrency 10 --review-md output/cot-pilot-review.md --export output/cot-pilot.jsonl --manifest output/cot-pilot-manifest.json

# 全量增量补写（自动跳过已通过质检的轮次；支持 --profile standard|short 与 --tier short,medium,long 过滤）
npm run reasoning -- --only-missing --concurrency 10 --export output/train-cot.jsonl --val-out output/val-cot.jsonl --val-ratio 0.05 --shuffle --seed 42 --manifest output/train-cot-manifest.json

# 离线从指定 reasoning_run 导出（默认 --format inline 内联 <think> 适配 ms-swift 4.6.0；直调 HF 可选 --format reasoning_content）
npm run reasoning -- --export-only --reasoning-run 2 --format inline --expand-turns --export output/train-cot.jsonl --review-md output/cot-review.md
```

> **安全阀参数**：程序层仅拦截明显工程故障（空正文、硬泄漏词、`<think>`/Markdown/列表格式脏污、超长安全上限 `--max-chars 800`、连续极端照抄 `--max-verbatim 36`），语气自然度、去摘要化与逻辑边界由 `reasoning-judge` 主导裁决。

### 第六步：独立评测库与对抗 / 陷阱盲测流水线（`npm run eval`）

用于构建与训练侧双向隔离的综合对抗卷（`--profile adversarial`，6 类题型）与陷阱拒答卷（`--profile trap`，4 类题型），并在同分布卷、对抗卷与陷阱卷上对候选模型执行脱稿盲测与整体语义批卷对比（完整设计见 [对抗与陷阱评测库设计](<eval-probe-pipeline.md>)）：

```powershell
# 1. 初始化独立评测库 data/eval.sqlite 并只读镜像 test-v1 -> indist-v1
npm run eval -- init
npm run eval -- mirror --from-version test-v1 --as indist-v1

# 2. 从主库 test 分区只读导入未用视频快照，按预设运行 Agent Loop v3（默认内置裸答回流，可用 --no-bare-check 关闭）
npm run eval -- import --limit 10 --shuffle --seed 42 --exclude-used
npm run eval -- build --profile adversarial --videos imported --probes-per-video 6 --concurrency 8 --call-attempts 3
npm run eval -- build --profile trap --videos imported --probes-per-video 3 --concurrency 8 --call-attempts 3

# 3. 通用模型无原稿裸答难度标定（支持 --only-uncalibrated / --profile / --report-only）并按预设冻结套卷
npm run eval -- calibrate --run all --only-uncalibrated --concurrency 8 --out output/eval/calibration-report.md
npm run eval -- freeze --name adv-main-v1 --profile adversarial --max-easy-ratio 0.2 --export output/eval/adv-main-v1.jsonl --manifest-out output/eval/adv-main-v1.manifest.json
npm run eval -- freeze --name trap-main-v1 --profile trap --max-easy-ratio 0.2 --export output/eval/trap-main-v1.jsonl --manifest-out output/eval/trap-main-v1.manifest.json

# 4. 运行候选模型脱稿盲测（默认注入 prompts/eval/candidate-system.md）、整体语义批卷并输出对比报告
npm run eval -- run --suite adv-main-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --history-mode gold
npm run eval -- grade --run latest --concurrency 8
npm run eval -- report --suites indist-v1,adv-main-v1,trap-main-v1 --candidates base,sft-v1 --out output/eval/report.md
npm run eval -- compare --baseline base --target sft-v1 --suites indist-v1,adv-main-v1,trap-main-v1 --out output/eval/compare-base-vs-sft.md
```

### 第七步（可选）：数据集校验脱敏与 ModelScope 打包发布

仓库提供 [scripts/publish_modelscope.py](../scripts/publish_modelscope.py)，自动完成 JSONL 合法性与 schema 校验、清理清单中的本机绝对路径泄漏、生成 `README.md` Dataset Card 与 `SHA256SUMS.txt`，并上传至 ModelScope 数据集仓库：

```powershell
# 1. 校验源文件并组装发布目录（默认 output/modelscope-release/）
python scripts/publish_modelscope.py prepare `
  --release-dir output/modelscope-release `
  --repo-id <namespace>/<dataset-name> `
  --cot-train output/train-cot-train.jsonl `
  --cot-val output/train-cot-val.jsonl `
  --cot-manifest output/train-cot-manifest.json `
  --eval-adv output/eval/adv-main-v1.jsonl `
  --eval-adv-manifest output/eval/adv-main-v1.manifest.json `
  --eval-trap output/eval/trap-main-v1.jsonl `
  --eval-trap-manifest output/eval/trap-main-v1.manifest.json

# 2. 先本地干跑核查文件清单与体积，确认无误后再设置 MODELSCOPE_API_TOKEN 正式上传
python scripts/publish_modelscope.py upload --repo-id <namespace>/<dataset-name> --release-dir output/modelscope-release --dry-run
python scripts/publish_modelscope.py upload --repo-id <namespace>/<dataset-name> --release-dir output/modelscope-release --create
```

---

## 3. 运行中监控与故障处理

- **只读查看实时进度**（WAL 模式下随时可安全只读查询 `data/data-maker.sqlite`）：
  ```sql
  -- 查看最近一次运行各状态分布
  SELECT status, COUNT(*) AS count
  FROM run_items
  WHERE run_id = (SELECT MAX(id) FROM runs WHERE kind = 'answer_judge')
  GROUP BY status;

  -- 查看失败题目的具体报错与原始输出
  SELECT i.question_id, c.role, c.error, substr(c.output_text, 1, 200) AS preview
  FROM run_items i
  JOIN turns t ON t.run_item_id = i.id
  JOIN model_calls c ON c.turn_id = t.id
  WHERE i.run_id = :run_id AND c.status = 'error';

  -- 查看已冻结的测试集版本及评分要点抽取量
  SELECT name, split, sample_count, video_count, created_at FROM test_set_versions ORDER BY id;
  SELECT COUNT(*) AS rubric_turns FROM eval_rubrics;
  ```
- **进程意外中断（如断电 / Ctrl+C）**：
  - 已通过的题目已原子提交进 `results`，不会丢失；
  - 下次启动任何命令会自动把遗留的 `running` 标记为 `interrupted`；
  - 使用 `npm run judge -- --max-turns 3 --only-unjudged`（可搭配 `--profile` / `--split test --extract-rubric`）或 `npm run batch -- --include-unjudged` 即可只补跑中断/报错题，绝不重复消耗已通过题的额度；
  - 在独立评测库中，若仍有 `running` 状态的 `probe_runs`，`eval freeze` 会主动拦截以防冻结半成品（恢复后自动放行，极端场景可用 `--allow-active-runs` 显式覆写）。

---

## 4. 调优各角色 Agent 的 Skill

修改任意 Skill 后**无需改代码**，下次运行自动生效并记录新的 SHA-256 快照到 `runs.skills_json`（或 `reasoning_runs.skills_json` / `probe_runs.skills_json`）：

- **主数据合成（`standard` 默认）**：[question-design](<../skills/question-design/SKILL.md>) · [followup-strategy](<../skills/followup-strategy/SKILL.md>) · [answer-style](<../skills/answer-style/SKILL.md>) · [quality-judge](<../skills/quality-judge/SKILL.md>) · [eval-rubric](<../skills/eval-rubric/SKILL.md>)
- **短答预设（`short`）**：[short/question-design](<../skills/short/question-design/SKILL.md>) · [short/followup-strategy](<../skills/short/followup-strategy/SKILL.md>) · [short/answer-style](<../skills/short/answer-style/SKILL.md>) · [short/quality-judge](<../skills/short/quality-judge/SKILL.md>)
- **陷阱拒答预设（`trap`）**：[trap/question-design](<../skills/trap/question-design/SKILL.md>) · [trap/followup-strategy](<../skills/trap/followup-strategy/SKILL.md>) · [trap/answer-style](<../skills/trap/answer-style/SKILL.md>) · [trap/quality-judge](<../skills/trap/quality-judge/SKILL.md>)
- **脱稿 CoT 补写**：[reasoning-writer](<../skills/reasoning-writer/SKILL.md>) · [reasoning-judge](<../skills/reasoning-judge/SKILL.md>)
- **独立评测（`adversarial` 与 `eval/trap`）**：`skills/eval/*/SKILL.md` 与 `skills/eval/trap/*/SKILL.md`

修改任何 Skill 或代码后，建议跑一次 `npm run check` 确保格式校验与全部测试通过。
