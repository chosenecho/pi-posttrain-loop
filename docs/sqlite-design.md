# SQLite 统一存储设计

本文说明当前主库存储边界、事务与导出约束，并保留最初 JSONL 试跑迁移的背景。模块与取消收尾顺序见 [架构与生命周期概览](architecture.md)，日常命令见 [生产操作手册](production-workflow.md)。

## 1. 先统一语义

- **results 只包含全部对话轮均通过质检的最终样本。** 最初单轮试跑（`database-trial-CkXhqo`）的迁移验收基线为 11 条，详见第 7 节；该数字不是当前库容量。
- 历史试跑全部 12 题的处理结局是 `run_items`（outcomes），属于过程数据，不是 results。
- 严格区分 **对话轮（Turn）** 与 **尝试/返工轮（Attempt）**：
  - **对话轮（Turn）**：训练对话中的一对 `user` + `assistant`。单轮样本即 `max_turns = 1`（1 个对话轮）；多轮样本逐轮推进并逐轮质检，单轮是 `turn_no = 1` 的特例。
  - **尝试轮（Attempt）**：针对某一个对话轮的回答-质检返工次数（`attempt_no = 1..max_attempts`）。
- **整条样本原子通过规则**：多轮对话若在第 2 轮或之后发生 `drop` / `exhausted` / `error`，则整条 `run_item` 标记为对应非通过状态，**不进入 `results`**；前面已通过的对话轮保留在过程表中供审计，但不降级混入 `results`。
- 原文是生成依据，不默认拼入训练问答；默认训练导出为单行 JSONL `{"messages": [...]}`，可选在导出层统一注入训练 `system` 提示词。
- “通过”与“正式训练导出”分开：无 Skill 运行也能产出 results，但其验收范围仅为当时的系统提示词要求。不得因为改名就扩大质量保证。

历史试跑产物 [results](<../output/database-trial-CkXhqo/results.jsonl>)（11 条通过问答）与
[outcomes](<../output/database-trial-CkXhqo/outcomes.jsonl>)（全部 12 题过程记录）已完成迁移验证；
所有业务入口已收敛至统一单入口 [src/cli/index.ts](<../src/cli/index.ts>)（`npm run dm -- synth | cot | eval`），统一落盘到 SQLite，不再以 `candidates.jsonl` 等 JSONL 文件作为主存储。

## 2. 当前主库结构与历史边界

主库默认位于 `data/data-maker.sqlite`。早期单表问题库 `data/questions.sqlite` 保留作只读来源和备份，不原地改写。本文按职责列出表，不将历史“11 表”或某次生产快照的表数当作当前固定 schema；扩展表随相应写入口初始化，SQLite 也可能维护内部表。

- **核心合成业务**（由 [DataMakerStore facade](../src/synth/store/index.ts) 及其 repositories 管理）：`materials`、`runs`、`questions`、`run_items`、`turns`、`attempts`、`model_calls`、`results`。
- **工具轨迹与运行审计**：`attempt_tool_steps` 保存成功工具步骤的训练投影；`tool_attempt_audit` 保存工具调用尝试与终态，两者职责分开。
- **分区注册**：`video_splits` 由 store 与 [splits.ts](../src/synth/splits.ts) 管理；只读统计不创建登记记录。
- **写任务协调**：共享 [TaskSession](../src/shared/task-store.ts) 管理 `runtime_task_lock`，并向运行表补充 `owner_token`。
- **CoT 逆向补写扩展**：由 [ReasoningStore](../src/reasoning/store.ts) 管理 `reasoning_runs`、`reasoning_traces`，与 synth 使用同一物理主库 owner。

评测域已迁入独立 `data/eval.sqlite`，当前 schema 见 [独立评测库设计](eval-probe-pipeline.md)。原主库的 `test_set_versions` / `eval_rubrics` / `eval_model_calls` 属于旧设计，当前 DataMakerStore 写入口取得 owner 后会执行退役清理；`readOnly` 打开不执行建表、迁移或清理。下文保留旧结构用于理解历史迁移，不将其描述为当前主库业务表。

### materials：材料版本

- `id INTEGER PRIMARY KEY`
- `video_id TEXT NOT NULL`：例如 `BV1Dt4y1Y7S2/P001`，表示来源，不作为内容版本主键。
- `content TEXT NOT NULL`：原文（统一换行符为 LF），只按版本存一次。
- `sha256 TEXT NOT NULL`：按统一换行后的实际正文计算的 64 位 SHA-256。
- `source_path TEXT`：导入时的位置，仅作溯源；运行无需依赖这个路径继续存在。
- `created_at TEXT NOT NULL`：UTC 时间。
- `UNIQUE(video_id, sha256)`。

同一来源正文修改后新增材料行，不覆盖旧版本。运行中的问题和回答始终指向当时版本。

### runs：运行及配置快照

- `id INTEGER PRIMARY KEY`。
- `kind TEXT NOT NULL`：`question_generation` / `answer_judge`。
- `status TEXT NOT NULL`：`running` / `completed` / `interrupted` / `error`。
- `started_at TEXT NOT NULL`、`finished_at TEXT`。
- `max_attempts INTEGER NOT NULL`：1–10，每个对话轮的最多尝试次数（包含首次回答）。
- `max_turns INTEGER NOT NULL DEFAULT 1`：1–20，每条样本的目标对话轮上限；单轮问答固定为 `1`。
- `config_json TEXT NOT NULL`：模型 ID、base URL、thinking level、context window、输出上限、超时、大方向及评审范围；不含凭据。
- `prompts_json TEXT NOT NULL`：本次运行使用的各角色完整系统提示词；出题运行保存 `question`，问答运行保存 `answer` / `judge` / 可选 `followup`，只存一份快照。
- `skills_json TEXT NOT NULL`：本次加载的 Skill 名称、状态、完整正文与指纹；无 Skill 为 `[]`。
- `export_policy_json TEXT NOT NULL`：例如正式训练运行的 `{"format":"messages_jsonl","training_enabled":true}`；`dpo` 使用 `training_enabled:false` 并按 Skill 就绪状态设置 `eval_enabled`。旧 `test` 主库运行保留历史策略，当前 synth 入口不再生产 `test`。该字段表示导出策略，不决定 result 是否存在。
- `import_key TEXT UNIQUE`：历史运行导入时的稳定标识，重复导入不生成第二份运行。
- `error TEXT`。
- `owner_token TEXT`：写入口取得 TaskSession 后为运行记录保存 owner；旧记录可为空，供后继 writer 区分遗留运行与自身运行。

运行配置在打开写 store 前解析为不可变执行计划；改提示词或模型后创建新运行。密钥仍在环境配置中，不进入库。

### questions：起始问题

- `id INTEGER PRIMARY KEY`：首次迁移保留旧问题 ID（1–12）。
- `material_id INTEGER NOT NULL REFERENCES materials(id)`。
- `question TEXT NOT NULL`。
- `generation_run_id INTEGER REFERENCES runs(id)`：问题生成来源；旧数据未知时为空，不虚构历史。
- `question_mode TEXT NOT NULL DEFAULT 'direct'`：`direct` / `todo_plan` / `clarify_question`。
- `task_spec_json TEXT`：可选任务元数据对象；例如规划阶段、缺失槽位、隐藏用户设定，按角色筛选后使用，不整体发送给 Answer。
- `created_at TEXT NOT NULL`。
- `UNIQUE(material_id, question)`：同一版本精确去重，不做语义去重。

保存后不原地改问题或替换材料关联；修订形成新问题，保证历史可复现。

### run_items：每条样本的处理结局（outcomes）

- `id INTEGER PRIMARY KEY`。
- `run_id INTEGER NOT NULL REFERENCES runs(id)`。
- `question_id INTEGER NOT NULL REFERENCES questions(id)`：该样本第 1 对话轮的起始问题。
- `status TEXT NOT NULL`：`pending` / `running` / `pass` / `drop` / `exhausted` / `error` / `interrupted`。
- `started_at TEXT`、`finished_at TEXT`、`error TEXT`。
- `UNIQUE(run_id, question_id)`。

每次回答质检运行先创建待处理列表。12 道题就是 12 条 `run_items`，不论是否通过。运行中断时，已通过结果保留，未完成条目可明确识别，不伪装成 `completed`。

### turns：对话轮次（统一单轮与多轮）

- `id INTEGER PRIMARY KEY`。
- `run_item_id INTEGER NOT NULL REFERENCES run_items(id)`。
- `turn_no INTEGER NOT NULL`：从 1 开始，且不超过 `runs.max_turns`。
- `user_content TEXT`：
  - `turn_no = 1` 时必须为 `NULL`（用户提问直接来源于 `questions.question`，不重复存储也不产生漂移）；
  - `turn_no > 1` 时必须为非空字符串（由追问/反例角色生成的后续用户输入）。
- `status TEXT NOT NULL`：`running` / `pass` / `drop` / `exhausted` / `error` / `interrupted`。
- `passed_attempt_id INTEGER UNIQUE REFERENCES attempts(id)`：仅当本对话轮 `status = 'pass'` 时指向本轮最终通过的 `attempt`，否则必须为 `NULL`。
- `started_at TEXT NOT NULL`、`finished_at TEXT`、`error TEXT`。
- `UNIQUE(run_item_id, turn_no)`。

单轮样本每条 `run_item` 有 1 条 `turn_no = 1` 记录；多轮样本逐轮递增 `turn_no = 1, 2, ...`。后续对话轮可直接引用前面已通过对话轮的 `passed_attempt_id` 构造上下文。

### attempts：单个对话轮内的完整回答与结构化评审

- `id INTEGER PRIMARY KEY`。
- `turn_id INTEGER NOT NULL REFERENCES turns(id)`。
- `attempt_no INTEGER NOT NULL`：从 1 开始，且不超过 `runs.max_attempts`。
- `status TEXT NOT NULL`：`running` / `completed` / `error` / `interrupted`。
- `answer TEXT`：本版完整回答；回答调用失败时可为空。
- `decision TEXT`：`pass` / `revise` / `drop`；评审未完成或无效时为空。
- `issues_json TEXT`：结构化问题列表（`pass` 时必须为 `[]`）。
- `feedback TEXT`：本轮评审给出的修改意见，返工只传此字段，不传 `issues`。
- `started_at TEXT NOT NULL`、`finished_at TEXT`、`error TEXT`。
- `UNIQUE(turn_id, attempt_no)`。

一次尝试一条，保留每版回答。判断输出解析失败时不伪造 `decision`；原始输出留在 `model_calls`。返工输入可通过同一对话轮上一条 `attempt` 的 `answer`/`feedback` 还原。

### model_calls：业务角色调用轨迹

- `id INTEGER PRIMARY KEY`。
- `run_id INTEGER NOT NULL REFERENCES runs(id)`。
- `turn_id INTEGER REFERENCES turns(id)`：`followup` / `answer` / `judge` 必填，`question` 为空。
- `attempt_id INTEGER REFERENCES attempts(id)`：`answer` / `judge` 必填，`question` / `followup` 为空。
- `material_id INTEGER REFERENCES materials(id)`：`question` 必填，其余角色为空（由 `turn → run_item → question` 定位材料）。
- `role TEXT NOT NULL`：`question` / `followup` / `answer` / `judge`。
- `status TEXT NOT NULL`：`running` / `completed` / `error` / `interrupted`。
- `input_refs_json TEXT NOT NULL`：实际输入字段及引用，见第 4 节；不重复复制整篇原文。
- `output_text TEXT`：模型原始输出，不覆盖；畸形 JSON、截断内容也保留。
- `error TEXT`、`started_at TEXT NOT NULL`、`finished_at TEXT`。
- 唯一约束（部分唯一索引）：
  - `UNIQUE(attempt_id, role) WHERE attempt_id IS NOT NULL`（每个回答返工尝试、每个角色只有一条业务调用记录；其内部可按调用重试预算多次请求，不等于一次 HTTP 请求）；
  - `UNIQUE(turn_id, role) WHERE role = 'followup'`（在某个已通过对话轮之后生成下一轮用户追问时，绑定到上一对话轮 `turn_id`，避免追问失败或决定结束时遗留空对话轮）。

库内触发器验证：`turn_id` 必须属于同一个 `run_id`，`attempt_id` 必须属于同一个 `turn_id`。

`output_text` 保存该业务调用留存的原始输出，与解析后 answer/评审存在有限重复；它不是每次 HTTP 重试的独立完整日志。完整原文、系统提示词不在每次调用中重复存储。

### attempt_tool_steps 与 tool_attempt_audit：训练工具步骤和运行审计

- `attempt_tool_steps.attempt_id INTEGER REFERENCES attempts(id)`，以 `UNIQUE(attempt_id, step_no)` 保存顺序工具步骤：`tool_name`、`arguments_json`、`tool_output`、可选 `pre_call_thought` 与 `created_at`。runner 只将成功调用投影为 `ToolStep`；导出时再从已通过回答对应的步骤构造工具消息。
- `tool_attempt_audit.model_call_id INTEGER REFERENCES model_calls(id)`，以 `UNIQUE(model_call_id, attempt_id, batch_id, tool_call_id)` 持久化调用尝试。此处 `attempt_id` 是每次 runner 调用的 UUID，区别于回答返工表的整数 `attempts.id`；`batch_id` 区分同次 runner 调用中的工具批次，`tool_call_id` 保留提供方调用 ID。
- 审计 `status` 包含 `attempted`、`succeeded`、`failed`、`limit_reached`、`cancelled`、`invalid_arguments`，`payload_json` 保存参数、原始顺序 `sourceIndex`、可选调用前思考、耗时和受控错误码，另有创建/更新时间。先记录 `attempted`，执行或清理后 upsert 终态；重复 `attempted` 不会把已保存终态降回进行中。
- 审计回调是运行时元数据，不序列化给模型。调用失败、重试、取消与限额命中仍保留审计；取消 drain 期间可以补写终态。审计写入失败会中止当前调用并等待清理，保留原始存储错误。
- `tool_attempt_audit` 从不直接参与训练投影；失败、限额、取消、参数错误不成为训练工具步骤。审计与成功训练步骤分别由 [tool-audit-repo.ts](../src/synth/store/tool-audit-repo.ts)、[run-repo.ts](../src/synth/store/run-repo.ts) 管理，导出语义集中在 [export-policy.ts](../src/synth/export-policy.ts)。

这些追溯字段可能含材料、问答、工具参数或思考内容；它们与数据库及备份采用相同的访问控制和留存规则，普通进度日志只输出受控错误类型与调用编号。

### results：仅完整通过的最终结果

- `id INTEGER PRIMARY KEY`。
- `run_item_id INTEGER NOT NULL UNIQUE REFERENCES run_items(id)`。
- `turn_count INTEGER NOT NULL`：通过的总对话轮数（`>= 1`；单轮为 `1`，多轮为 `2..max_turns`）。
- `created_at TEXT NOT NULL`。

这里不再复制 `question`、`user_content`、`answer`、`material`，也不添加 `exhausted` 等失败状态。查询或导出时通过关联 `turns` 和 `turns.passed_attempt_id` 按 `turn_no` 顺序取得完整对话正文。

**强制不变量（由 SQLite CHECK 与触发器强制执行）：**
1. `run_item` 必须为 `status = 'pass'`。
2. 该 `run_item` 的 `turns` 数量严格等于 `turn_count`，且 `turn_no` 从 `1` 到 `turn_count` 连续无缺口。
3. 每一个 `turn` 都必须满足 `status = 'pass'`、`passed_attempt_id IS NOT NULL`，且其 `passed_attempt` 属于该 `turn` 并满足 `status = 'completed' AND decision = 'pass'`。
4. 已被 `results` 引用的 `run_item`、`turns`、通过的 `attempts`、`question`、`material` 均禁止原地修改和删除，也不允许向已入 `results` 的 `run_item` 追加新 `turn`。

### video_splits：持久化视频级分区注册表（不可变）

- `video_key TEXT PRIMARY KEY`：经 `extractVideoKey()` 归一化的视频主键（同视频多 P 分块 `BVxxxx/P001-P004` 归并为 `BVxxxx`）。
- `split TEXT NOT NULL`：`train` / `test` / `dpo`。
- `method TEXT NOT NULL`：`backfill`（历史已训练视频回填锁定为 `train`）/ `hash`（`sha256("weimingzi-split-v1:" + video_key)` 固定分桶）/ `manual`。
- `salt TEXT NOT NULL`、`assigned_at TEXT NOT NULL`。
- **不可变触发器**：`trg_video_splits_immutable_update` / `trg_video_splits_immutable_delete`，禁止修改或删除已登记分区，防止任何视频跨区泄漏。

### 历史主库结构：test_set_versions（已退役）

以下字段描述最初的不可变测试集/DPO 采题池冻结版本，供旧迁移记录溯源。当前冻结与版本复现由独立评测域的 suite 流程负责，`synth` 只生产和导出 `train/dpo`。

- `id INTEGER PRIMARY KEY`、`name TEXT NOT NULL UNIQUE`（如 `test-v1`）。
- `split TEXT NOT NULL`：仅限 `test` / `dpo`（数据库 `CHECK` 禁止冻结 `train`）。
- `result_ids_json TEXT NOT NULL`：冻结时刻选中的 `results.id` 有序数组。
- `sample_count INTEGER NOT NULL`、`video_count INTEGER NOT NULL`。
- `manifest_json TEXT NOT NULL`、`sha256 TEXT NOT NULL`（64 位导出正文指纹）、`created_at TEXT NOT NULL`。
- **不可变触发器**：`trg_test_set_versions_immutable_update` / `trg_test_set_versions_immutable_delete`，版本一旦固化永不可篡改。

### 历史主库结构：eval_model_calls 与 eval_rubrics（已退役）

以下是旧主库内评分要点调用和结构化评分卡的关系；当前评测角色、评分依据与调用记录统一在独立评测库管理。

- `eval_model_calls`：记录 `role = 'rubric'` 的每次调用轨迹（`result_id`、`turn_no`、`status`、`input_json`、`output_text`、`error`、`started_at`、`finished_at`）。
- `eval_rubrics`：按 `UNIQUE(result_id, turn_no)` 存储通过结构校验（`parseEvalRubric`）的评分卡 JSON（`stance`、`keyPoints`、`forbidden`、`mustNotHallucinate`），并关联 `call_id REFERENCES eval_model_calls(id)`。

### reasoning_runs 与 reasoning_traces：脱稿 CoT（`<think>`）逆向补写

- `reasoning_runs`：记录每次 CoT 补写运行（`status`、`writer_model`、`judge_model`、`config_json`、`prompts_json`、`skills_json`、`started_at`、`finished_at`、`error`、`owner_token`）。
- `reasoning_traces`：按 `UNIQUE(reasoning_run_id, attempt_id)` 关联 `results(id)` / `attempts(id)` / `turn_no`，记录 `length_tier`（`short` / `medium` / `long`）、`status`、`decision`（`pass` / `drop`）、`rewrite_count`、`reasoning` 正文、确定性规则校验明细 `checks_json` 与原始输出 `raw_output`。

## 3. 关系与重复运行

```text
video_splits (video_key) ── 隔离约束 ── materials 1 ── N questions
runs      1 ── N run_items N ── 1 questions
run_items 1 ── N turns     1 ── 0..1 passed_attempt
turns     1 ── N attempts
attempts  1 ── N model_calls (answer / judge) 1 ── N tool_attempt_audit
attempts  1 ── N attempt_tool_steps (成功步骤，导出按 passed_attempt 选择)
turns     1 ── 0..1 model_calls (followup，挂在上一已通过 turn)
run_items 1 ── 0..1 results
results   1 ── N reasoning_traces N ── 1 reasoning_runs
runs      1 ── N 出题 model_calls (question) ── 1 materials
```

- 同一起始问题跑两次：两条 `run_items`，两个运行各自独立保存过程和 `results`，不覆盖历史。
- 单轮题三轮返工仍 `revise`：1 条 `turn_no=1`（`exhausted`）、3 条 `attempts`、1 条 `exhausted` 的 `run_item`、**0 条 `results`**。
- 多轮题第 1 轮通过、第 2 轮返工耗尽/被 `drop`/出错：`turn_no=1` 为 `pass`，`turn_no=2` 为 `exhausted`/`drop`/`error`，`run_item` 标记为对应非通过状态，**0 条 `results`**。
- 生成零题：保留 `question_generation` 的 `run` 和 `model_calls`，不插空问题，无 `run_items`。
- 不做静默隐式混版与跨区泄漏：单次导出指定 `--run`，跨运行合并通过 `npm run dm -- synth export` 声明 `--runs` 或 `--all-formal`。正式汇总默认 `--split train`，由导出策略检查 `training_enabled` 与材料视频分区，再按 `--dedup latest | earliest | error` 选版去重；`--val-ratio` 按 `video_key` 整视频切分验证集，同一多 P 视频的所有分块绑定同侧，`--manifest` 保存审计清单。旧主库的 `--version` / `--freeze-version` 入口已退役，冻结套卷使用独立评测流程。

## 4. 输入按引用保存，避免整篇原文重复

每次发送请求前记录实际字段引用。例如第 1 轮返工回答：

```json
{
  "material": {"material_id": 1, "field": "content"},
  "question": {"question_id": 4, "field": "question"},
  "previousAnswer": {"attempt_id": 5, "field": "answer"},
  "feedback": {"attempt_id": 5, "field": "feedback"}
}
```

多轮第 2 轮回答可引用前序已通过对话轮与当前用户输入：

```json
{
  "material": {"material_id": 1, "field": "content"},
  "history": [{"turn_id": 10, "attempt_id": 12}],
  "user": {"turn_id": 11, "field": "user_content"}
}
```

首轮首次回答省略 `previousAnswer` 和 `feedback`；质检仅引用当前问答（多轮时含前序已通过 `history`）；出题引用 `material`、`video_id` 和运行中固定的 `direction`。系统提示词由 `runs.prompts_json` 角色快照取得。

引用对象不可变，输入构造版本记录在 `config_json` 中，才能精确还原模型所见的业务消息。原始 HTTP 认证头从不存储。

## 5. 写入所有权、事务与收尾

### Store facade 与同步边界

`DataMakerStore`、`ReasoningStore` 与 `EvalStore` 的底层连接均为私有成员。生产模块通过领域动作和快照接口访问，SQL 留在各自 store/repository 内；测试专用连接 helper 可构造约束负例，不是业务接口。`DataMakerStore.readCorpusSourceSnapshot()` 在一个读事务中复制分区、材料索引及可选正文，`readCorpusQuestionSnapshot()` 在同一个读快照中复制分区和问题，跨库导入/相似度检查使用返回值后再进行异步工作。

写入统一经过 `TaskSession.mutate()`：核验 owner token 与业务写入共享同一个 `BEGIN IMMEDIATE` 事务，嵌套操作使用 savepoint。事务回调只接受同步返回值；`async` 回调在执行前报 `async_transaction`，普通回调若返回 Promise/thenable 则回滚已发生的同步写入并报告该错误。网络、模型、工具及重试等待均放在事务外。正式训练筛选、工具消息投影、去重与按视频切分由纯 [export-policy.ts](../src/synth/export-policy.ts) 负责，repository 只加载候选数据。

### 单库单写 owner

可写 store 先通过 [TaskSession](../src/shared/task-store.ts) 取得物理库的唯一 owner，再初始化业务 schema、补充 `owner_token` 或恢复遗留运行。协调表 `runtime_task_lock` 仅有 `writer` 行，保存随机 token、hostname、PID、任务类型和取得时间。同主库的 synth 与 reasoning 因此互斥；独立评测库单独协调。活跃 writer、未知主机或状态不明确的进程返回 `database_busy`；同主机旧 PID 只有明确返回 `ESRCH` 才可被接管。所有权没有 TTL，不随耗时和取消信号过期。owner 丢失时写入报 `database_owner_lost`。

只读 store 不参与 owner 协调，也不建库、建表、清理退役表或恢复运行。`synth status` 可与 writer 并行；未登记视频仅预测分区并报告 `pendingSplitSyncVideos`，由后续写流程 `syncCorpusSplits()` 真正登记。缺失库路径只会打开失败，不创建空库。

### 常规写入顺序

核心表按字段使用非空、JSON、状态枚举、轮数和外键约束，工具审计状态也有枚举检查；建立必要索引。完整性检查使用 `PRAGMA foreign_key_check` 和 `PRAGMA integrity_check`。

1. 开启 `PRAGMA foreign_keys = ON` 与 `busy_timeout`，取得 owner；可写磁盘库再启用 WAL 并执行所需 schema 初始化。
2. 导入/取得 `materials` 与 `questions`，创建 `run` 及所有待处理 `run_items`。
3. 开始某题第 1 对话轮（或后续对话轮），创建 `turn`、`attempt` 和回答 `model_call`，提交；**模型网络请求不持有数据库写事务**。
4. 回答返回后保存 `model_call` 原始输出及 `attempt.answer`；再创建 `judge` `model_call`，提交后调用质检。
5. 解析质检，在同一短事务内保存 `judge` `model_call`、`attempt` 评审及状态推进：
   - `pass` 且为最后对话轮：设 `turn=pass`（绑定 `passed_attempt_id`）、`run_item=pass`，插入 `results`，原子提交。
   - `pass` 且还有后续对话轮：设 `turn=pass`（绑定 `passed_attempt_id`），提交后调用 `followup` 生成下一轮用户输入。
   - `revise` 且还有尝试次数：保留本尝试轮，继续下一尝试轮。
   - `revise` 且尝试次数用完：设 `turn=exhausted`、`run_item=exhausted`，不插 `results`。
   - `drop`：设 `turn=drop`、`run_item=drop`，不插 `results`。
   - 调用/格式错误：记录原始输出与 `error`，设 `turn=error`、`run_item=error`，不插 `results`；继续下一题。
6. 全部条目及已启动工作实际结束后写入 `run` 终态。单题出错但整批处理完，可设 `run=completed`，错误数从条目汇总；`run=error` 留给批次级故障。

### 取消、崩溃与恢复

取消或未处理的 worker 错误首先停止新任务派发、中止活跃 worker、取消重试等待；[并发池](../src/shared/concurrency.ts) 用 `Promise.allSettled` 等待已启动 worker 的实际清理。Pi runner 等待 `agent.waitForIdle()`，搜索适配器等待子进程结束。drain 期间允许工具审计补写终态，运行仍可能为 `running`，owner 持续有效。只有 drain 完成后，才将本 owner 的未完成记录标记为 `interrupted` 或相应批次错误，最后释放 owner 并关闭连接。已通过结果保留，迟到的取消输出不生成新结果。忽略 signal 的自定义适配器会延长 drain；`adapter_cleanup_failed` 作为致命错误上抛，不触发新一轮重试。

进程崩溃后，后继写任务必须先取得 owner，再恢复旧 owner 或 `owner_token IS NULL` 的遗留 `running` 记录，不改当前 owner 自己的新运行。只读查询不会恢复状态。主合成通过 `--only-unjudged` 或 `--include-unjudged` 显式补跑，独立评测按其持久化计划恢复，避免把已有通过结果当作未处理工作。所有业务 SQL 参数化，材料/问题内容不作为 SQL 执行。

## 6. 查询与训练导出（JSONL 规范）

```sql
-- 查询某次运行通过的完整对话轮（单轮与多轮统一）
SELECT r.id AS result_id,
       q.id AS question_id,
       q.material_id,
       i.run_id,
       r.turn_count,
       t.turn_no,
       COALESCE(t.user_content, q.question) AS user_content,
       a.answer AS assistant_content,
       a.attempt_no
FROM results r
JOIN run_items i ON i.id = r.run_item_id
JOIN questions q ON q.id = i.question_id
JOIN turns t ON t.run_item_id = i.id
JOIN attempts a ON a.id = t.passed_attempt_id
WHERE i.run_id = :run_id
ORDER BY q.id, t.turn_no;

-- 过程结局：包括未通过的题
SELECT status, COUNT(*) AS count
FROM run_items WHERE run_id = :run_id GROUP BY status;
```

**训练 `.jsonl` 导出格式约定：**
1. **每条样本严格压成一行**完整 JSON 对象，正文内换行以 `\n` 转义，UTF-8 中文原样输出不转 `\uXXXX`。
2. **普通问答顶层仅含 `messages`；工具样本可额外含 `tools` 声明**。溯源和失败审计保留在 SQLite 中：
   - 单轮（无 `system`）：
     `{"messages":[{"role":"user","content":"问题"},{"role":"assistant","content":"回答"}]}`
   - 多轮（含可选 `system`）：
     `{"messages":[{"role":"system","content":"..."},{"role":"user","content":"第1轮问题"},{"role":"assistant","content":"第1轮回答"},{"role":"user","content":"补充条件或反例"},{"role":"assistant","content":"第2轮回答"}]}`
3. **成功工具步骤按消息展开**：在对应用户输入与最终回答之间插入 `assistant.tool_calls` 和 `tool` 回执，工具声明可按确定性种子泛化。普通 synth 导出不附调用前思考；CoT 导出再按 `inline` / `reasoning_content` 格式呈现保留的思考。失败、限额、取消与参数错误只留在 `tool_attempt_audit`，不成为训练工具步骤。工具 profile 即使未执行工具也可带工具声明；普通样本可通过 `--negative-tools-ratio` 挂负例声明。
4. **训练 `system` 提示词在导出层按需配置**（CLI 参数或导出配置提供），不把数据生成阶段包含“依据 material 作答/返工协议”的 `prompts_json` 原样塞入训练集。
5. 汇总数通过查询计算，不另存一套容易失真的计数表。JSONL 是按需导出格式，不再是主存储。

## 7. 历史试跑迁移及后续生产能力

前 8 项记录最初 `database-trial-CkXhqo` 单轮试跑的迁移验收，保留旧数量和背景用于溯源，不是当前生产库状态。

1. 保留现有 `data/questions.sqlite` 与 `output/database-trial-CkXhqo`；在新库 `data/data-maker.sqlite` 建表并校验约束。
2. 导入 1 个材料版本、12 个问题；旧问题保留 ID 1–12，旧出题运行未知时 `generation_run_id` 为空。
3. 导入 1 次回答质检 `run`（`max_turns = 1`、`max_attempts = 3`）、12 条 `run_items`、12 条 `turns`、19 条 `attempts`、38 条 `model_calls`、11 条 `results`。
4. 现有 `traces.jsonl` 为每次调用 `role_start` / `role_result` 两个事件，按 `questionId`、`attempt`、`role` 配对，合并成一条 `model_calls`，不误算成 76 次。
5. 结果关联到最后 `pass` 的 `attempt`。第 7 题为 `exhausted`，0 条 `result`；第 4 题通过尝试轮为 2，第 8、12 题通过尝试轮为 3。
6. 对比逐条问题、答案、反馈与原始输出，验证材料指纹、外键、无凭据以及重复导入幂等。
7. 执行约束负例：插入 `revise`/`error` 对应的 `result`、跨题/跨轮关联 `attempt`、多轮仅部分轮次通过就插入 `result`、原地修改/删除被 `results` 引用的记录均应失败；事务中途失败不得留下半条通过结果。
8. 验证单轮与多轮 `.jsonl` 导出：单行合法 JSON、仅含 `messages`、可选 `system` 前置、中文未转义、换行正确转义为 `\n`。
9. 当前生产工作流通过 [workflows.ts](../src/synth/workflows.ts) 接入模块化 [store facade](../src/synth/store/index.ts)，并具备以下能力：
   - **整视频多 P 合并/分块与防重复选稿**：[corpus.ts](../src/synth/corpus.ts) 将中小多 P 视频（`<= 32,000` 字）合并为一个材料，超长合集按分 P 边界切分；按 profile 识别已处理记录，支持跳过 0 题完成调用与重复正文。
   - **持久化三分区隔离**：[splits.ts](../src/synth/splits.ts) 按 `video_key` 固定划分 `train/test/dpo`。`synth` 只生产 `train/dpo`；`test` 语料由独立评测流程只读导入，评分依据、计划与 suite 冻结均在独立评测库管理。历史划分与迁移背景见 [测试集与评测流水线设计](test-and-eval-pipeline.md)。
   - **有界并发与调用重试**：CLI 支持 `--concurrency 1–500`（默认 `10`），同一 writer 内使用同步短事务；并发不会绕过单库单写约束。业务调用异常默认最多尝试 3 次、间隔 3 秒；整项取消和清理失败直接停止重试。多轮 `answer` 使用稳定前缀字段序与首题预热闸门，角色思考等级可由 `LLM_{QUESTION,ANSWER,JUDGE,FOLLOWUP}_THINKING_LEVEL` 覆盖。
   - **九种 profile 与不可变执行计划**：[profiles.ts](../src/synth/profiles.ts) 统一声明 `standard/short/medium/long/xlong/trap/search/todo/clarify`；`standard/long/xlong` 默认最多 3 轮，其余最多 2 轮，`trap/search/todo/clarify` 默认单视频最多 2 题。[presets.ts](../src/synth/presets.ts) 的九个 `train-*` 均为 `train + core-first`，`dpo-pool` 为 `dpo + standard + shuffle + 3 轮`。八套训练 profile 可由 `synth suite` 顺序执行；配置、工具策略、提示词与快照在打开写 store 前经 [plan.ts](../src/synth/plan.ts) 统一解析。
   - **增量质检与正式训练投影**：`--only-unjudged` / `--include-unjudged` 保留已完成题目，补跑新题和错误/中断题；`synth export` 使用 `--run/--runs/--all-formal`、`train-all/train-val` 预设、显式去重、固定种子打乱、视频级验证集和 manifest。候选加载与纯导出策略分开，结果及工具导出的回归用例锁定投影行为。
   - **角色 Skill 快照与 runner 分工**：每个 profile 使用专属四角色 Skill；CoT 使用 `reasoning-writer/reasoning-judge`，严格隔离注入并快照正文与指纹。共享 [pi-runner.ts](../src/shared/pi-runner.ts) 管理通用 Agent、搜索和工具生命周期；[synth/tool-runner.ts](../src/synth/tool-runner.ts) 管理任务元数据过滤、todo/澄清工具组装及用户模拟器边界。

## 8. 验收与回归基线

- **当前本地代码回归（F1–F5）**：`npm run check` 依次执行 TypeScript 类型检查、TypeScript 测试和 Python 测试。本轮最终记录为 `tsc --noEmit` 通过，TypeScript 共 278 项（277 通过、0 失败、1 跳过），Python 共 42 项（两组分别 20 通过，以及 21 通过、1 跳过）。Windows symlink `EPERM` 对应分支明确跳过；远端 CI 尚未运行。
- **当前约束证据**：[task-session.test.ts](../test/task-session.test.ts) 覆盖 writer 争用、死 PID 接管、未知主机、Promise 事务回滚、owner 丢失与取消期保锁；[synth-status.test.ts](../test/synth-status.test.ts) 覆盖 writer 旁只读状态、待同步计数及缺失库不创建；[tool-attempt-audit.test.ts](../test/tool-attempt-audit.test.ts) 覆盖持久化审计与训练步骤分离；[synth-cancellation.test.ts](../test/synth-cancellation.test.ts)、[reasoning-cancellation.test.ts](../test/reasoning-cancellation.test.ts) 与 [tool-lifecycle.test.ts](../test/tool-lifecycle.test.ts) 覆盖实际 drain 后才结束运行；[architecture.test.ts](../test/architecture.test.ts) 守卫模块与 SQL 边界。测试均使用临时 fixture，本次文档同步未读取或迁移生产数据库。
- **历史初始生产库基线快照（2026-11-24 冻结验证，当时 `data/data-maker.sqlite` 记为 14 表）**：以下是当时记录，不代表当前 schema 或数据量。
  - **三分区注册表（`video_splits`）**：全库 **1,700** 个视频已持久化锁定：`train` **1,367**（29 个历史回填 + 1,338 个哈希）/ `test` **174** / `dpo` **159**。
  - **正式训练集（`train`）**：已处理 **29** 个视频，入库 **166** 题，产出 **163** 条通过样本（1 轮 44 / 2 轮 92 / 3 轮 27），已导出至 `output/train-all.jsonl` 与 `output/train-all-manifest.json`。
  - **冻结盲测集（`test-v1`）**：已处理 **6** 个 `test` 视频，入库 **38** 题，**38 / 38** 全部通过（1 轮 11 / 2 轮 21 / 3 轮 6，共 **71** 轮），**71 / 71** 轮 `eval_rubrics` 全量落库，已固化版本 `test-v1` 并单独导出至 `output/test.jsonl`（同 `output/test-v1.jsonl`）及 `output/test-manifest.json`。
  - **CoT 补写试点（`reasoning`）**：已完成 2 轮分层试点（`reasoning_runs` #1 / #2，共追踪 45 轮，42 轮通过规则 + LLM 双重质检）。
