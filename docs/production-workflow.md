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

### 单库写会话与评测库 v4 升级

同一物理 SQLite 库同一时刻只允许一个 `TaskSession` 写任务。`synth` 与 `cot` 共用主库的单写 owner；独立评测库使用自己的 owner，不同数据库可并行。写入口在建业务表或恢复运行前取得 owner，每次短同步事务都在同一事务中核验 owner token。争用时返回 `database_busy`；已有协调记录时，错误带任务类型、PID 和取得所有权的时间，SQLite 锁直接阻塞取得所有权时可能只有错误码。只读报告可同时访问。`--allow-active-runs` 仅调整冻结的领域检查，始终保留单写任务约束。

owner 没有 TTL，也不因模型请求耗时长或取消信号到达而过期。先检查原进程，仍存活时等待其完成实际清理；只有同主机旧 PID 明确不存在（`ESRCH`）才自动接管，未知主机或进程状态不明确时仍返回 `database_busy`。模块职责与完整收尾顺序见 [架构与生命周期概览](architecture.md)，存储约束见 [SQLite 统一存储设计](sqlite-design.md)。

新建评测库使用 Schema v4。已有 v3 库可直接只读查询和出报告；写入前执行显式迁移。v1/v2 保留原库，继续使用对应版本工具读取，本轮迁移器只处理 v3→v4。首次升级先停止并停用全部旧版写入口，部署后统一使用新版程序；旧版主库程序没有相同的写会话协议。

```powershell
# 1. 在临时副本执行迁移和完整性核验，业务原库保持 v3
npm run dm -- eval migrate --eval-db data/eval.sqlite --dry-run

# 2. 核查报告后正式迁移；备份目的地必须是尚不存在的文件
npm run dm -- eval migrate --eval-db data/eval.sqlite --backup output/eval/eval-before-v4.sqlite

# 3. 先只读检查套卷与历史结果，再小批恢复已知任务
npm run dm -- eval suites --eval-db data/eval.sqlite
npm run dm -- eval report --eval-db data/eval.sqlite --out output/eval/after-migration.md
```

迁移器先取得源库写会话，使用 SQLite backup API 创建包含已提交 WAL 内容的快照，再在一个事务中新增计划表和 run owner 列、导入 legacy 计划，最后写入 v4 版本。省略 `--backup` 时会在原库旁生成带唯一标识的备份文件；已存在的备份始终保留。`--dry-run` 在临时副本执行同样的事务并清理副本，源库只可能增加最小协调表，不改业务内容或 schema 版本。

JSON 报告包含迁移前后表计数、历史数据摘要、冻结 suite 的 manifest / items 摘要与 sha256、完整性与外键检查，以及 legacy 不完整 / 冲突计划 ID。`legacy_plan_incomplete` 表示缺少可信完整 writer 批次；`checkpoint_invalid` 表示原始输出与已有考题冲突。保留这些记录，检查后显式 rebuild，避免猜测缺失题数。

迁移事务失败时全部回滚，原库保持 v3，错误中列出保留的迁移前备份。提交后若尚无新业务写入，可停止全部访问、另存当前库及其 WAL / SHM 文件，再将迁移前快照与匹配版本程序一起恢复；恢复时保持数据库文件与对应 WAL / SHM 成套处理。已有新增结果时先单独备份新版库，再制定结果导入与回退步骤。迁移器不做自动降级。本轮回归使用临时 SQLite fixture，生产库升级与小批恢复仍按上述步骤执行。

## 2. 日常生产与盲测操作流程

### 第一步：查看当前语料库、三分区与待质检进度（不调模型）

```powershell
npm run dm -- synth status
# 随时列出全部内置任务预设（synth / cot / eval）
npm run dm -- presets
```

输出总视频数（同视频多 P 合并算 1 个）、已处理/未处理视频数、九个 profile 的覆盖率、`train` / `test` / `dpo` 分区进度，以及当前 `maxTurns` 下未完成质检的题数。

`status` 用 `readOnly: true` 打开现有主库，不建库、不恢复遗留运行，也不写 `video_splits`。库文件尚未存在时会报告打开错误并保持路径不存在。分区统计保留已登记分区；尚未登记的历史已处理视频预测为 `train`，其他视频按固定哈希预测。`pendingSplitSyncVideos` 是语料目录与历史已处理视频中尚待登记的视频去重数；之后的生成/同步写流程才会持久化分区。因此该字段大于零时，报告中的分区进度包含预测值。

### 第二步：一键增量跑新批次（九种 profile）

`--profile` 选择角色 Skill 与工具策略，`--preset train-<profile>` 额外选择 `train` 分区和 `--sort core-first`；九个训练预设均不默认打乱。显式参数覆盖预设字段，改用 `--shuffle` 时不要同时指定 `--sort core-first`。

| profile / 训练预设 | 用途 | 默认最多对话轮 | 默认单视频题数上限 |
| --- | --- | --- | --- |
| `standard` / `train-standard` | 历史兼容的综合深挖问答 | 3 | 未设固定覆盖值，由出题策略决定 |
| `short` / `train-short` | 短答，Easy 档组成 | 2 | 未设固定覆盖值 |
| `medium` / `train-medium` | 中等长度，Easy 档组成 | 2 | 未设固定覆盖值 |
| `long` / `train-long` | 长答，Medium 档组成 | 3 | 未设固定覆盖值 |
| `xlong` / `train-xlong` | 超长深挖，Hard 档组成 | 3 | 未设固定覆盖值 |
| `trap` / `train-trap` | 陷阱识别与作者口吻拒答 | 2 | 2 |
| `search` / `train-search` | 搜索考证后作答，始终挂载搜索工具 | 2 | 2 |
| `todo` / `train-todo` | 用 `todo` 拆解长流程，按需搜索 | 2 | 2 |
| `clarify` / `train-clarify` | 用 `question` / `questionnaire` 澄清，再由隔离用户模拟器回应 | 2 | 2 |

轮数是上限，追问角色可提前结束对话。`--max-questions` 可显式覆盖单视频题数上限。默认 Skill 配置下，除 `standard` 外的 profile 默认启用搜索；`todo/clarify` 同时挂载各自专用工具。具体默认值以 [profiles.ts](../src/synth/profiles.ts)、[presets.ts](../src/synth/presets.ts) 与 [plan.ts](../src/synth/plan.ts) 为准。

```powershell
# 1. standard 预设 + 核心理论课优先
npm run dm -- synth run --preset train-standard --limit 20 --export output/train-batch.jsonl

# 2. short 预设（极短/短答专职 Skill，默认 2 轮）
npm run dm -- synth run --preset train-short --limit 20 --export output/train-short.jsonl

# 3. trap 预设（陷阱识别与拒答专职 Skill，默认 2 轮、单视频上限 2 题）
npm run dm -- synth run --preset train-trap --limit 20 --export output/train-trap.jsonl

# 4. 工具专项（按需要分别执行）
npm run dm -- synth run --preset train-search --limit 20 --export output/train-search.jsonl
npm run dm -- synth run --preset train-todo --limit 20 --export output/train-todo.jsonl
npm run dm -- synth run --preset train-clarify --limit 20 --export output/train-clarify.jsonl

# 如需顺带补跑上一批遗留未质检题，可追加 --include-unjudged：
npm run dm -- synth run --preset train-standard --limit 20 --shuffle --include-unjudged --export output/train-batch.jsonl
```

如需依次覆盖同一语料池的八套训练 profile，可执行 `npm run dm -- synth suite --limit 20`；默认顺序是 `short,medium,long,xlong,trap,search,todo,clarify`，不包含历史兼容的 `standard`。`--profiles easy` 展开为 `short,medium`，`medium` 展开为 `long`，`hard` 展开为 `xlong,trap`；也可传逗号分隔列表。`--limit` 对每个 profile 分别生效，按各 profile 的已处理记录增量选稿。

**内置自动重试与容错策略（默认开启，适用于 `synth` / `cot` / `eval`）**：
- 单次模型调用发生空正文、网络抖动、超时、DSML 串台 / 畸形 JSON 或未触发保存工具时，默认**自动尝试最多 3 次，每次间隔 3 秒**（`--call-attempts 3 --retry-delay-ms 3000`）。
- 调用重试耗尽后，`synth` / `cot` 按各自失败状态保留追溯；评测造题保留失败 slot、已通过轮次和检查点，后续恢复继续。任务取消会停止派发与重试，并等待已启动工作收尾。
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

普通问答导出为 `{"messages":[...]}`。工具样本可额外带顶层 `tools`，消息中包含对应 `assistant.tool_calls` / `tool` 回执；导出层从通过回答的成功 `ToolStep` 构造训练轨迹。`tool_attempt_audit` 中的失败、限额、取消或参数错误仅用于审计，不会作为训练工具步骤导出。工具 Schema 泛化、负例声明和确定性种子由 [export-policy.ts](../src/synth/export-policy.ts) 管理，数据库只加载候选记录。

### 第四步：生产 DPO 采题池（`dpo`）

语料库视频已按 `video_key` 的 SHA-256 哈希持久化划分为 `train`（约 80%）、`test`（约 10%，仅供独立评测流水线 `eval make` 只读使用，`synth` 命令禁止对 `test` 生产）、`dpo`（约 10%）三个物理隔离分区（分区算法见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）：

```powershell
# 从 dpo 分区独立生产 On-policy DPO 采题池（与 train / test 物理隔离）
npm run dm -- synth run --preset dpo-pool --limit 15 --concurrency 40 --export output/dpo-pool.jsonl
```

### 第五步：脱稿 CoT（`<think>`）逆向补写与导出（`npm run dm -- cot`）

若目标 SFT 模型为推理/思考模型（如使用 `ms-swift 4.6.0` 训练 Qwen 思考模型），可针对 `train` 分区已通过的问答轮次在无原稿前提下逆向补写第一人称思考骨架。`--profile` 支持 `all`（默认）或九个主合成来源 profile 中的一项：

```powershell
# 查看可补写轮次分布（按 profile / tier / turnNo）与历史补写运行（不调用模型）
npm run dm -- cot status

# 30 轮分层试点（内置 pilot 预设）并输出人工审阅稿与试点 JSONL
npm run dm -- cot backfill --preset pilot --review-md output/cot-pilot-review.md --export output/cot-pilot.jsonl --manifest output/cot-pilot-manifest.json

# 全量增量补写（full 预设跳过已通过轮次；可用 --profile long 或 --tier short,medium,long 过滤）
npm run dm -- cot backfill --preset full --export output/train-cot.jsonl --val-out output/val-cot.jsonl --val-ratio 0.05 --shuffle --seed 42 --manifest output/train-cot-manifest.json

# 离线从指定 reasoning_run 导出（默认 inline + 按轮展开适配 ms-swift 4.6.0；直调 HF 可选 --format reasoning_content）
npm run dm -- cot export --preset train-cot --reasoning-run 2 --out output/train-cot.jsonl --review-md output/cot-review.md
```

> **规则检查参数**：程序层检查空正文、硬泄漏词、`<think>`/Markdown/列表格式、字数硬上限（默认 `--max-chars 1500`）及连续照抄（默认 `--max-verbatim-run 36`）；需要收紧时可显式传 `--max-chars 800`。语气自然度、去摘要化与逻辑边界由 `reasoning-judge` 主导裁决。

### 第六步：独立评测库与盲测流水线（`npm run dm -- eval`）

所有评测集均在独立的 `data/eval.sqlite`（Schema v4，含计划 / slot / 执行关联和写会话协调表，5 类统一题型）中生产、标定、冻结与盲测（完整设计见 [独立评测库设计](<eval-probe-pipeline.md>)）。已有 v3 库先按前述步骤迁移：

```powershell
# 1. 一键造卷（导入 test 分区 → 出题核验+评分卡 → 裸答难度标定 → 冻结套卷；可断点续跑）
npm run dm -- eval make --suite eval-v1 --max-probes 5 --max-easy-ratio 0.2 --export output/eval/eval-v1.jsonl --manifest-out output/eval/eval-v1.manifest.json

# 查看库状态与已冻结套卷，或抽检考题
npm run dm -- eval suites
npm run dm -- eval inspect --sample 10 --out output/eval/inspect.md

# 使用旧计划的规格恢复造题；42 为待恢复计划的 origin run ID 示例
npm run dm -- eval make --suite eval-v1 --resume-build 42
# 按最新一次执行关联抽检，包括本次复用的旧 probe
npm run dm -- eval inspect --execution-run latest --out output/eval/latest-execution.md

# 2. 一键串联候选模型脱稿盲测 + 整体语义批卷 + 出报告（默认 gold 历史，可选 --history-mode self）
npm run dm -- eval evaluate --suite eval-v1 --candidate sft-v1 --model my-sft --base-url http://127.0.0.1:8000/v1 --api-key EMPTY --out output/eval/sft-v1.md
npm run dm -- eval report --suites eval-v1 --candidates base,sft-v1 --out output/eval/report.md
npm run dm -- eval compare --baseline base --target sft-v1 --suites eval-v1 --out output/eval/compare-base-vs-sft.md
```

默认造题从最新 generation 的未完成 slot 继续，复用 accepted / rejected / dropped 终态与已保存轮次；完整 writer 批次先持久化，再处理第一题。计划配置冲突时报 `build_config_conflict`，`--resume-build` 使用原始模型、提示词和预算；历史快照缺失时报 `build_snapshot_missing`。`--rebuild` 创建新 generation，保留旧题与审计记录。`inspect --run` 按 probe 的最初创建 run 筛选，`--execution-run` 按本次执行关联筛选，两者含义不同。

技术失败或不完整 legacy 计划使 make 返回 `partial=true` 和非零退出码，默认暂停标定与冻结；检查并恢复后重跑。确需冻结已完成子集时使用 `--allow-partial-build`，仍仅选择完整 accepted 题，并在 manifest 记录遗漏原因；`--allow-active-runs` 保留单写任务约束。

候选盲测的新 run 将模型、endpoint、采样参数、系统提示词、历史模式与有序 item ID 保存为带 hash 的不可变规格。`--resume-run` 省略的参数沿用旧值，显式冲突在远端调用和旧状态变更前报 `resume_config_conflict`；同一 endpoint 的凭据轮换、超时和并发可以调整。缺少完整历史规格的旧 run 只供查询和报告，继续评测用 `--parent-run <旧run ID>` 创建关联新 run；新 run 独立计分，原 predictions 保留。

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
- **取消与超时**：Ctrl+C / 任务取消会停止派发，取消 HTTP、工具排队、活跃搜索子进程与重试等待。致命 worker 错误会中止其他 worker，并保留原始首个错误。收尾顺序固定为：停止派发 → abort 活跃工作 → 等所有已启动 promise、Pi Agent 与子进程实际结束（drain，期间补齐工具审计终态）→ 写入本次运行最终状态 → 释放 owner → 关闭连接。drain 期间运行可仍显示 `running`，owner 仍有效；已通过结果保持原样，取消后的迟到输出不会成为新训练结果。`model_timeout` 表示本次调用到时，清理后可按既有次数重试；`operation_aborted` 表示整项任务取消，不继续派发或重试。`adapter_cleanup_failed` 会直接终止批次，不再重试。自行注入且忽略 signal 的适配器可能拖延收尾，程序会继续持有 owner，停止等待不等于外部工作已终止。
- **工具审计**：按 `model_call_id` 查询 `tool_attempt_audit`，用 `(attempt_id, batch_id, tool_call_id)` 区分同一次业务调用内的重试与并行工具批次。`attempt_id` 在此处是 runner 调用 UUID，与回答返工表 `attempts.id` 含义不同。审计保存 `attempted` 及后续 `succeeded/failed/limit_reached/cancelled/invalid_arguments` 状态；取消后的清理仍可补写终态，重复 `attempted` 不覆盖已保存终态。该表的参数、思考与回执相关内容同样纳入本地追溯数据的访问和留存管理。
- **进程意外退出后恢复**：已提交的结果、评测通过轮次和标定保留。后继写任务先取得 owner；仅在同主机旧 PID 明确不存在时接管，再恢复旧 owner 或 legacy orphan 的遗留运行。只读命令不恢复状态，未知主机或仍存活 PID 返回 `database_busy`。
- **补跑**：主库使用 `npm run dm -- synth judge --max-turns 3 --only-unjudged`（可搭配 `--profile`）或 `npm run dm -- synth run --include-unjudged`。评测使用相同 make 参数，或 `--resume-build <originRunId>` 明确沿用原始规格；完整计划、通过轮次与 reference 检查点继续复用。未完成、冲突或完整性未知的计划会暂停默认冻结，保留原始题目和审计记录。

---

## 4. 调优各角色 Agent 的 Skill

修改任意 Skill 后**无需改代码**，下次运行自动生效并记录新的 SHA-256 快照到 `runs.skills_json`（或 `reasoning_runs.skills_json` / `probe_runs.skills_json`）：

- **主数据合成（`standard` 默认）**：[question-design](<../skills/question-design/SKILL.md>) · [followup-strategy](<../skills/followup-strategy/SKILL.md>) · [answer-style](<../skills/answer-style/SKILL.md>) · [quality-judge](<../skills/quality-judge/SKILL.md>)
- **短答预设（`short`）**：[short/question-design](<../skills/short/question-design/SKILL.md>) · [short/followup-strategy](<../skills/short/followup-strategy/SKILL.md>) · [short/answer-style](<../skills/short/answer-style/SKILL.md>) · [short/quality-judge](<../skills/short/quality-judge/SKILL.md>)
- **陷阱拒答预设（`trap`）**：[trap/question-design](<../skills/trap/question-design/SKILL.md>) · [trap/followup-strategy](<../skills/trap/followup-strategy/SKILL.md>) · [trap/answer-style](<../skills/trap/answer-style/SKILL.md>) · [trap/quality-judge](<../skills/trap/quality-judge/SKILL.md>)
- **其余篇幅与工具预设**：`medium`、`long`、`xlong`、`search`、`todo`、`clarify` 均从各自 `skills/<profile>/` 下加载 `question-design` / `followup-strategy` / `answer-style` / `quality-judge`，路径由 [profiles.ts](../src/synth/profiles.ts) 统一登记。
- **脱稿 CoT 补写**：[reasoning-writer](<../skills/reasoning-writer/SKILL.md>) · [reasoning-judge](<../skills/reasoning-judge/SKILL.md>)
- **独立评测（5 类统一题型）**：`skills/eval/*/SKILL.md`（共 6 份）

修改任何 Skill 或代码后，建议跑一次 `npm run check`：依次执行 TypeScript 类型检查、TypeScript 测试和 Python 测试。F1–F5 本轮本地回归记录为：`tsc --noEmit` 通过；TypeScript 共 278 项，277 通过、0 失败、1 跳过；Python 两组分别为 20 通过，以及 21 通过、1 跳过（共 42 项）。Windows 无符号链接权限的 `EPERM` 分支明确跳过，远端 CI 尚未运行。这些记录来自本轮临时 fixture 验证，不代表已执行生产库迁移。
