# 生产操作手册（日常批量生成与导出）

本手册面向日常使用 `data-maker` 对视频文稿库进行增量出题、多轮问答质检、故障补跑与总训练集导出的完整操作。

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
> - `--concurrency` 支持 `1–100`（默认 `10`；本地路由网关承载力足够时可用 `--concurrency 40` 显著加速）。
> - 如需进一步提速，可按角色降档思考等级（不影响未配置的角色）：
>   ```dotenv
>   LLM_ANSWER_THINKING_LEVEL=high
>   LLM_JUDGE_THINKING_LEVEL=low
>   LLM_FOLLOWUP_THINKING_LEVEL=medium
>   LLM_RUBRIC_THINKING_LEVEL=medium
>   ```

---

## 2. 日常生产与盲测操作流程

### 第一步：查看当前语料库、三分区与待质检进度（不调模型）

```powershell
npm run batch -- --status
```

输出总视频数（同视频多 P 合并算 1 个）、已处理/未处理视频数、`train` / `test` / `dpo` 三个持久化分区的进度，以及当前 `maxTurns` 下未完成质检的题数。

### 第二步：一键增量跑新批次（推荐）

```powershell
# 随机抽 10 个未处理视频：多 P 自适应合并/超长按 P 分块 → 按字数动态题量封顶（3–10 题）→ 10 并发出题 → 1/2/3 轮（30%:50%:20%）与短/中/长篇幅（25%:50%:25%）混合问答质检 → 导出本批 JSONL
npm run batch -- --limit 10 --shuffle --export output/train-batch.jsonl

# 若上一批有中断或遗留题，加 --include-unjudged 一并补跑
npm run batch -- --limit 10 --shuffle --include-unjudged --export output/train-batch.jsonl
```

**内置自动重试与容错策略（默认开启，适用于 `batch` / `judge` / `questions`）**：
- 单次模型调用发生空正文、网络抖动、超时、DSML 串台 / 畸形 JSON 或未触发保存工具时，默认**自动尝试最多 3 次，每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`）。
- 3 次均失败时，保留最后一次原始输出与报错记录到 `model_calls`，并**直接丢弃该题/分块**（不写入 `results`，不影响同批其他题目）。
- 正常的质检返工（`revise`）仍由 `--max-attempts 3` 独立控制，与调用重试互不干扰。

如需单独补跑库里遗留的未质检题（不新抽视频）：

```powershell
npm run judge -- --max-turns 3 --max-attempts 3 --concurrency 10 --only-unjudged --export output/train-retry.jsonl
```

### 第三步：汇总导出总训练集

```powershell
# 全库正式训练样本汇总（默认 --split train，自动排除非正式运行及 test/dpo 分区视频，同题默认取最新 run）
npm run export -- --all-formal --out output/train-all.jsonl --manifest output/train-all-manifest.json

# 正式训练前：固定种子打乱 + 按视频整块切 10% 训练验证集（多 P 分块自动绑定同侧防泄漏）+ 可选注入统一训练 system
npm run export -- --all-formal --out output/train.jsonl --val-out output/val.jsonl --val-ratio 0.1 --shuffle --seed 42 --manifest output/train-manifest.json
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

### 第五步（可选）：脱稿 CoT（`<think>`）逆向补写与导出（`npm run reasoning`）

若目标 SFT 模型为推理/思考模型（如使用 `ms-swift` 训练），可针对 `train` 分区已通过的问答轮次逆向补写第一人称思考骨架：

```powershell
# 查看可补写轮次分布与历史补写运行（不调用模型）
npm run reasoning -- --status

# 30 轮分层试点并输出人工审阅 Markdown 与试点 JSONL
npm run reasoning -- --limit 30 --stratified --seed 42 --review-md output/cot-pilot-review.md --export output/cot-pilot.jsonl --manifest output/cot-pilot-manifest.json

# 全量增量补写（自动跳过已通过质检的轮次，默认导出 reasoning_content + 按轮展开）
npm run reasoning -- --only-missing --concurrency 10 --export output/train-cot.jsonl --manifest output/train-cot-manifest.json

# 离线从指定 reasoning_run 导出（不调用模型）
npm run reasoning -- --export-only --reasoning-run 1 --format reasoning_content --expand-turns --export output/train-cot.jsonl --review-md output/cot-review.md
```

### 第六步：独立评测库与对抗盲测流水线（`npm run eval`）

用于构建与训练侧双向隔离的对抗测试套卷（`adv-v1`），并在同分布卷（`indist-v1`）与对抗卷上对候选模型执行脱稿盲测与批卷对比（完整设计见 [对抗测试集与独立评测库设计](<eval-probe-pipeline.md>)）：

```powershell
# 1. 初始化独立评测库 data/eval.sqlite 并只读镜像 test-v1 -> indist-v1
npm run eval -- init
npm run eval -- mirror --from-version test-v1 --as indist-v1

# 2. 从主库 test 分区导入未用视频快照并生产 6 类对抗考题（含多轮施压 pressure）
npm run eval -- import --limit 10 --shuffle --seed 42 --exclude-used
npm run eval -- build --videos imported --probes-per-video 8 --concurrency 8 --call-attempts 3

# 3. 难度标定并冻结对抗套卷 adv-v1
npm run eval -- calibrate --run all --concurrency 8 --out output/eval/calibration-report.md
npm run eval -- freeze --name adv-v1 --max-easy-ratio 0.2 --export output/eval/adv-v1.jsonl --manifest-out output/eval/adv-v1.manifest.json

# 4. 运行候选模型脱稿盲测、独立裁判批卷并输出对比报告
npm run eval -- run --suite adv-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --history-mode gold
npm run eval -- grade --run latest --concurrency 8
npm run eval -- report --suites indist-v1,adv-v1 --candidates base,sft-v1 --out output/eval/report.md
npm run eval -- compare --baseline base --target sft-v1 --suites indist-v1,adv-v1 --out output/eval/compare-base-vs-sft.md
```

---

## 3. 运行中监控与故障处理

- **只读查看实时进度**（WAL 模式下随时可安全只读查询 [data/data-maker.sqlite](<../data/data-maker.sqlite>)）：
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
  - 使用 `npm run judge -- --max-turns 3 --only-unjudged`（可搭配 `--split test --extract-rubric`）或 `npm run batch -- --include-unjudged` 即可只补跑中断/报错题，绝不重复消耗已通过题的额度。

---

## 4. 调优各角色 Agent 的 Skill

修改任意 Skill 后**无需改代码**，下次运行自动生效并记录新的 SHA-256 快照到 `runs.skills_json`（或 `reasoning_runs.skills_json`）：

- 出题标准：[skills/question-design/SKILL.md](<../skills/question-design/SKILL.md>)
- 多轮强追问策略：[skills/followup-strategy/SKILL.md](<../skills/followup-strategy/SKILL.md>)
- 回答风格（自然对话体、去 AI 腔、禁加粗与夸奖起手）：[skills/answer-style/SKILL.md](<../skills/answer-style/SKILL.md>)
- 质检标准（忠实作者框架优先、多轮防复读）：[skills/quality-judge/SKILL.md](<../skills/quality-judge/SKILL.md>)
- 盲测评分要点提炼标准（`stance` / `keyPoints` / `forbidden` / `mustNotHallucinate`）：[skills/eval-rubric/SKILL.md](<../skills/eval-rubric/SKILL.md>)
- CoT 脱稿思考补写标准（第一人称内省、留白不剧透）：[skills/reasoning-writer/SKILL.md](<../skills/reasoning-writer/SKILL.md>)
- CoT 补写质检标准（拦提纲剧透、旁观套话与假内耗）：[skills/reasoning-judge/SKILL.md](<../skills/reasoning-judge/SKILL.md>)

修改任何 Skill 或代码后，建议跑一次 `npm run check` 确保格式校验与全部测试通过。
