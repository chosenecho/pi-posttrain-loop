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
>   ```
> - 候选模型脱稿盲测（`npm run dm -- eval evaluate`）默认加载 [prompts/eval/candidate-system.md](../prompts/eval/candidate-system.md)，也可通过 `CANDIDATE_LLM_SYSTEM_PROMPT` / `CANDIDATE_LLM_SYSTEM_PROMPT_FILE` 或 CLI `--system-prompt` / `--system-prompt-file` / `--no-system-prompt` 覆盖。

---

### 模型服务地址与密钥的绑定

角色配置仅在 API 根地址一致时继承主密钥。协议、主机、端口、路径中的任一项改变，都需要显式设置该角色的专用密钥；主机大小写、默认端口与末尾斜杠会先归一化。`REASONING_*`、`REASONING_JUDGE_*`、`EVAL_LLM_*` 和候选模型均遵循此规则，配置错误会在请求前报告变量名。

```dotenv
# 同服务：省略专用密钥即可继承 LLM_API_KEY
REASONING_BASE_URL=http://127.0.0.1:3425/v1

# 独立服务：使用该服务自己的密钥
EVAL_LLM_BASE_URL=https://grader.example.com/v1
EVAL_LLM_API_KEY=<评测服务密钥>

# 本地无认证服务：显式填写占位值，避免继承主密钥
CANDIDATE_LLM_BASE_URL=http://127.0.0.1:8000/v1
CANDIDATE_LLM_API_KEY=EMPTY
```

候选模型的 `EMPTY` 或显式空密钥会省略 `Authorization`；Pi 角色可用 `EMPTY` 作为无认证服务的占位密钥。模型客户端不自动跟随 HTTP 重定向，避免将输入或认证头转发到配置之外的接口。更换 API 路径也需要重配密钥，例如同一网关下从 `/v1` 切换到 `/other/v1`。模型名称、思考等级等非敏感参数继续按原规则回退。评测出题与批卷使用 `EVAL_LLM_*`，难度标定的裸答模型继续使用 `LLM_*`。

## 2. 日常生产与盲测操作流程

### 第一步：查看当前语料库、三分区与待质检进度（不调模型）

```powershell
npm run dm -- synth status
# 随时列出全部内置任务预设（synth / cot / eval）
npm run dm -- presets
```

输出总视频数（同视频多 P 合并算 1 个）、已处理/未处理视频数、`train` / `test` / `dpo` 三个持久化分区的进度，以及当前 `maxTurns` 下未完成质检的题数。

### 第二步：一键增量跑新批次（支持 `standard` / `short` / `trap` 三套预设）

主合成流水线支持三种 `--profile` 预设（及对应一键 `--preset`），由专职 Skill 套装与自主追问 Agent 驱动对话深度与风格：

- **`train-standard`（`--profile standard`）**：中长深挖问答，默认 `--sort core-first --max-turns 3`，按字数与分 P 数动态紧凑封顶 **2–6 题**。
- **`train-short`（`--profile short`）**：极短/短答专职 Skill（`skills/short/*`），默认 `--shuffle --max-turns 2`，覆盖 50–150 字快问与 160–350 字单点短答。
- **`train-trap`（`--profile trap`）**：陷阱识别与作者口吻拒答专职 Skill（`skills/trap/*`），默认 `--shuffle --max-turns 2 --max-questions 3`。

```powershell
# 1. standard 预设 + 核心理论课优先
npm run dm -- synth run --preset train-standard --limit 20 --export output/train-batch.jsonl

# 2. short 预设（极短/短答专职 Skill，默认 2 轮）
npm run dm -- synth run --preset train-short --limit 20 --export output/train-short.jsonl

# 3. trap 预设（陷阱识别与拒答专职 Skill，默认 2 轮、单视频上限 3 题）
npm run dm -- synth run --preset train-trap --limit 20 --export output/train-trap.jsonl

# 如需顺带补跑上一批遗留未质检题，可追加 --include-unjudged：
npm run dm -- synth run --preset train-standard --limit 20 --shuffle --include-unjudged --export output/train-batch.jsonl
```

**内置自动重试与容错策略（默认开启，适用于 `synth` / `cot` / `eval`）**：
- 单次模型调用发生空正文、网络抖动、超时、DSML 串台 / 畸形 JSON 或未触发保存工具时，默认**自动尝试最多 3 次，每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`）。
- 3 次均失败时，保留最后一次原始输出与报错记录到 `model_calls`，并**直接丢弃该题/分块**（不写入 `results`，不影响同批其他题目）。
- 正常的质检返工（`revise`）仍由 `--max-attempts 4` 独立控制，与调用重试互不干扰。

如需单独补跑库里遗留的未质检题（不新抽视频）：

```powershell
npm run dm -- synth judge --profile standard --max-turns 3 --max-attempts 4 --concurrency 10 --only-unjudged --export output/train-retry.jsonl
```

### 第三步：汇总导出总训练集

```powershell
# 全库正式训练样本汇总（内置 train-all 预设：默认 --split train + --all-formal + --timestamp）
npm run dm -- synth export --preset train-all --out output/train-all.jsonl --manifest output/train-all-manifest.json

# 正式训练前：内置 train-val 预设（固定种子打乱 + 按视频整块切 10% 验证集 + 时间戳）
npm run dm -- synth export --preset train-val --out output/train.jsonl --val-out output/val.jsonl --manifest output/train-manifest.json
```

### 第四步：生产 DPO 采题池（`dpo`）

语料库视频已按 `video_key` 的 SHA-256 哈希持久化划分为 `train`（约 80%）、`test`（约 10%，仅供独立评测流水线 `eval make` 只读使用，`synth` 命令禁止对 `test` 生产）、`dpo`（约 10%）三个物理隔离分区（分区算法见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）：

```powershell
# 从 dpo 分区独立生产 On-policy DPO 采题池（与 train / test 物理隔离）
npm run dm -- synth run --preset dpo-pool --limit 15 --concurrency 40 --export output/dpo-pool.jsonl
```

### 第五步：脱稿 CoT（`<think>`）逆向补写与导出（`npm run dm -- cot`）

若目标 SFT 模型为推理/思考模型（如使用 `ms-swift 4.6.0` 训练 Qwen 思考模型），可针对 `train` 分区已通过的问答轮次（支持 `standard` 与 `short` 来源预设）在无原稿前提下逆向补写第一人称思考骨架：

```powershell
# 查看可补写轮次分布（按 profile / tier / turnNo）与历史补写运行（不调用模型）
npm run dm -- cot status

# 30 轮分层试点（内置 pilot 预设）并输出人工审阅稿与试点 JSONL
npm run dm -- cot backfill --preset pilot --review-md output/cot-pilot-review.md --export output/cot-pilot.jsonl --manifest output/cot-pilot-manifest.json

# 全量增量补写（内置 full 预设，自动跳过已通过轮次；支持 --profile standard|short 与 --tier short,medium,long 过滤）
npm run dm -- cot backfill --preset full --export output/train-cot.jsonl --val-out output/val-cot.jsonl --val-ratio 0.05 --shuffle --seed 42 --manifest output/train-cot-manifest.json

# 离线从指定 reasoning_run 导出（默认 inline + 按轮展开适配 ms-swift 4.6.0；直调 HF 可选 --format reasoning_content）
npm run dm -- cot export --preset train-cot --reasoning-run 2 --out output/train-cot.jsonl --review-md output/cot-review.md
```

> **安全阀参数**：程序层仅拦截明显工程故障（空正文、硬泄漏词、`<think>`/Markdown/列表格式脏污、超长安全上限 `--max-chars 800`、连续极端照抄 `--max-verbatim-run 36`），语气自然度、去摘要化与逻辑边界由 `reasoning-judge` 主导裁决。

### 第六步：独立评测库与盲测流水线（`npm run dm -- eval`）

所有评测集均在独立的 `data/eval.sqlite`（Schema v3，12 表，5 类统一题型）中生产、标定、冻结与盲测（完整设计见 [独立评测库设计](<eval-probe-pipeline.md>)）：

```powershell
# 1. 一键造卷（导入 test 分区 → 出题核验+评分卡 → 裸答难度标定 → 冻结套卷；可断点续跑）
npm run dm -- eval make --suite eval-v1 --max-probes 5 --max-easy-ratio 0.2 --export output/eval/eval-v1.jsonl --manifest-out output/eval/eval-v1.manifest.json

# 查看库状态与已冻结套卷，或抽检考题
npm run dm -- eval suites
npm run dm -- eval inspect --sample 10 --out output/eval/inspect.md

# 2. 一键串联候选模型脱稿盲测 + 整体语义批卷 + 出报告（默认 gold 历史，可选 --history-mode self）
npm run dm -- eval evaluate --suite eval-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --api-key EMPTY --out output/eval/sft-v1.md
npm run dm -- eval report --suites eval-v1 --candidates base,sft-v1 --out output/eval/report.md
npm run dm -- eval compare --baseline base --target sft-v1 --suites eval-v1 --out output/eval/compare-base-vs-sft.md
```

### 第七步（可选）：数据集校验脱敏与 ModelScope 打包发布

仓库提供 [scripts/publish_modelscope.py](../scripts/publish_modelscope.py)，完成 JSONL/schema 校验、清单路径整理、Dataset Card 与校验和生成。`prepare`、`upload --dry-run` 和正式上传共用发布检查：扫描全部正文与清单，只允许九个正式文件；额外文件、链接、凭据、本机路径及未审阅个人信息都会在远端操作前阻断。正式上传只将复验后的九文件临时副本交给 SDK，源目录的缓存和其它文件不会被上传。

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

### 发布检查命中后的处理

诊断格式为相对文件、行号、字段路径和命中类别，省略原值。先在本地核查对应记录，删除或脱敏真实凭据与非公开个人信息，再重新 `prepare` 和 `upload --dry-run`。扫描覆盖常见凭据、显式配置的密钥、邮箱、中国手机号及通过日期和校验位检查的中国身份证候选；仍需结合数据来源做人工审阅。

确需保留的公开联系信息可使用发布目录之外的审阅记录，例如 `output/privacy-review.json`，在 `prepare` 与每次 `upload` 时均传入 `--privacy-review output/privacy-review.json`：

```json
{
  "version": 1,
  "approvals": [
    {
      "file": "data/cot_sft/train.jsonl",
      "line": 1,
      "field": "$.messages[0].content",
      "category": "email",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "reason": "经核实为原文刻意公开的联系信息，保留以维持语义"
    }
  ]
}
```

示例中的全零指纹需替换为实际字段的 SHA-256：对完整解码字符串的 UTF-8 字节计算，包含空格与换行，使用小写十六进制；数字值使用其规范十进制文本。JSONL 使用记录行号，普通 JSON 使用 `line: 1`，说明文档使用物理行号及 `field: "$"`。审阅仅适用于 `email`、`cn_mobile`、`cn_id`，理由至少八个字符。对应字段的内容或位置改变都会使原审阅失效；凭据和本机路径始终阻断。审阅记录应留在本地审计范围，九文件上传清单中没有审阅文件。

`--dry-run` 只读且不创建远端仓库；正式上传会重新验证 schema、清单数据哈希及七条 `SHA256SUMS`，手工修改发布文件后应从源数据重新准备发布包。

## 3. 运行中监控与故障处理

普通运行日志与错误字段只保留受控错误类型、HTTP 状态及调用编号，模型正文和上游错误正文不再拼入进度消息。排查时用调用编号关联数据库追溯记录。SQLite 的材料、输入消息、`output_text`、`raw_output` 等追溯字段仍可能包含完整原稿、问答和推理；数据库、备份及导出的追溯文件应仅向相应操作人员开放，并按需要清理留存。代码修复不会清除已有历史记录中的正文。

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
  ```
- **进程意外中断（如断电 / Ctrl+C）**：
  - 已通过的题目已原子提交进 `results`，不会丢失；
  - 下次启动任何命令会自动把遗留的 `running` 标记为 `interrupted`；
  - 使用 `npm run dm -- synth judge --max-turns 3 --only-unjudged`（可搭配 `--profile`）或 `npm run dm -- synth run --include-unjudged` 即可只补跑中断/报错题，绝不重复消耗已通过题的额度；
  - 在独立评测库中，重新执行 `npm run dm -- eval make --suite <name>` 会自动跳过已导入、已出题与已标定的条目断点续跑；若存在运行中的 `probe_runs`，冻结守卫会主动拦截以防冻结半成品。

---

## 4. 调优各角色 Agent 的 Skill

修改任意 Skill 后**无需改代码**，下次运行自动生效并记录新的 SHA-256 快照到 `runs.skills_json`（或 `reasoning_runs.skills_json` / `probe_runs.skills_json`）：

- **主数据合成（`standard` 默认）**：[question-design](<../skills/question-design/SKILL.md>) · [followup-strategy](<../skills/followup-strategy/SKILL.md>) · [answer-style](<../skills/answer-style/SKILL.md>) · [quality-judge](<../skills/quality-judge/SKILL.md>)
- **短答预设（`short`）**：[short/question-design](<../skills/short/question-design/SKILL.md>) · [short/followup-strategy](<../skills/short/followup-strategy/SKILL.md>) · [short/answer-style](<../skills/short/answer-style/SKILL.md>) · [short/quality-judge](<../skills/short/quality-judge/SKILL.md>)
- **陷阱拒答预设（`trap`）**：[trap/question-design](<../skills/trap/question-design/SKILL.md>) · [trap/followup-strategy](<../skills/trap/followup-strategy/SKILL.md>) · [trap/answer-style](<../skills/trap/answer-style/SKILL.md>) · [trap/quality-judge](<../skills/trap/quality-judge/SKILL.md>)
- **脱稿 CoT 补写**：[reasoning-writer](<../skills/reasoning-writer/SKILL.md>) · [reasoning-judge](<../skills/reasoning-judge/SKILL.md>)
- **独立评测（5 类统一题型）**：`skills/eval/*/SKILL.md`（共 6 份）

修改任何 Skill 或代码后，建议跑一次 `npm run check` 确保格式校验与全部测试通过。
