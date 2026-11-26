# SQLite 统一存储设计

## 1. 先统一语义

- **results 只包含全部对话轮均通过质检的最终样本。** 本次单轮试跑（`database-trial-CkXhqo`）应有 11 条。
- 全部 12 题的处理结局是 `run_items`（outcomes），属于过程数据，不是 results。
- 严格区分 **对话轮（Turn）** 与 **尝试/返工轮（Attempt）**：
  - **对话轮（Turn）**：训练对话中的一对 `user` + `assistant`。单轮样本即 `max_turns = 1`（1 个对话轮）；多轮样本逐轮推进并逐轮质检，单轮是 `turn_no = 1` 的特例。
  - **尝试轮（Attempt）**：针对某一个对话轮的回答-质检返工次数（`attempt_no = 1..max_attempts`）。
- **整条样本原子通过规则**：多轮对话若在第 2 轮或之后发生 `drop` / `exhausted` / `error`，则整条 `run_item` 标记为对应非通过状态，**不进入 `results`**；前面已通过的对话轮保留在过程表中供审计，但不降级混入 `results`。
- 原文是生成依据，不默认拼入训练问答；默认训练导出为单行 JSONL `{"messages": [...]}`，可选在导出层统一注入训练 `system` 提示词。
- “通过”与“正式训练导出”分开：无 Skill 运行也能产出 results，但其验收范围仅为当时的系统提示词要求。不得因为改名就扩大质量保证。

历史试跑产物 [results](<../output/database-trial-CkXhqo/results.jsonl>)（11 条通过问答）与
[outcomes](<../output/database-trial-CkXhqo/outcomes.jsonl>)（全部 12 题过程记录）已完成迁移验证；
所有业务入口已收敛至统一单入口 [src/cli/index.ts](<../src/cli/index.ts>)（`npm run dm -- synth | cot | eval`），统一落盘到 SQLite，不再以 `candidates.jsonl` 等 JSONL 文件作为主存储。

## 2. 统一库结构：核心 8 表 + 分区/盲测 4 表 + CoT 补写 2 表（共 14 表）

主库位于 `data/data-maker.sqlite`。现有早期单表问题库 `data/questions.sqlite` 保留作只读来源和备份，不原地改写。

- **核心业务 8 表**（由 [src/synth/store/index.ts](<../src/synth/store/index.ts>) 管理）：`materials`、`runs`、`questions`、`run_items`、`turns`、`attempts`、`model_calls`、`results`
- **分区与盲测扩展 4 表**（由 [src/synth/store/index.ts](<../src/synth/store/index.ts>) 与 [src/synth/splits.ts](<../src/synth/splits.ts>) 管理）：`video_splits`、`test_set_versions`、`eval_model_calls`、`eval_rubrics`
- **CoT 逆向补写扩展 2 表**（由 [src/reasoning/store.ts](<../src/reasoning/store.ts>) 管理）：`reasoning_runs`、`reasoning_traces`

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
- `prompts_json TEXT NOT NULL`：本次实际使用的各角色完整系统提示词（`question` / `answer` / `judge` / `followup` / 可选 `rubric`），只存一份快照。
- `skills_json TEXT NOT NULL`：本次加载的 Skill 名称、状态、完整正文与指纹；无 Skill 为 `[]`。
- `export_policy_json TEXT NOT NULL`：例如 `{"format":"messages_jsonl","training_enabled":true}`（`test` / `dpo` 分区运行为 `{"format":"messages_jsonl","training_enabled":false,"eval_enabled":true}`）。只表示导出策略，不决定 result 是否存在。
- `import_key TEXT UNIQUE`：历史运行导入时的稳定标识，重复导入不生成第二份运行。
- `error TEXT`。

运行配置一旦开始即保持不变；改提示词或模型后创建新运行。密钥仍在环境配置中，不进入库。

### questions：起始问题

- `id INTEGER PRIMARY KEY`：首次迁移保留旧问题 ID（1–12）。
- `material_id INTEGER NOT NULL REFERENCES materials(id)`。
- `question TEXT NOT NULL`。
- `generation_run_id INTEGER REFERENCES runs(id)`：问题生成来源；旧数据未知时为空，不虚构历史。
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

### model_calls：实际模型调用轨迹

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
  - `UNIQUE(attempt_id, role) WHERE attempt_id IS NOT NULL`（每尝试轮每角色只请求一次，无隐式重试）；
  - `UNIQUE(turn_id, role) WHERE role = 'followup'`（在某个已通过对话轮之后生成下一轮用户追问时，绑定到上一对话轮 `turn_id`，避免追问失败或决定结束时遗留空对话轮）。

库内触发器验证：`turn_id` 必须属于同一个 `run_id`，`attempt_id` 必须属于同一个 `turn_id`。

`output_text` 与解析后 answer/评审存在有限重复，这是保留原始证据与有效业务数据的刻意取舍；完整原文、系统提示词则不在每次调用中重复存储。

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

### test_set_versions：不可变测试集/DPO 采题池冻结版本

- `id INTEGER PRIMARY KEY`、`name TEXT NOT NULL UNIQUE`（如 `test-v1`）。
- `split TEXT NOT NULL`：仅限 `test` / `dpo`（数据库 `CHECK` 禁止冻结 `train`）。
- `result_ids_json TEXT NOT NULL`：冻结时刻选中的 `results.id` 有序数组。
- `sample_count INTEGER NOT NULL`、`video_count INTEGER NOT NULL`。
- `manifest_json TEXT NOT NULL`、`sha256 TEXT NOT NULL`（64 位导出正文指纹）、`created_at TEXT NOT NULL`。
- **不可变触发器**：`trg_test_set_versions_immutable_update` / `trg_test_set_versions_immutable_delete`，版本一旦固化永不可篡改。

### eval_model_calls 与 eval_rubrics：盲测评分要点调用与结构化评分卡

- `eval_model_calls`：记录 `role = 'rubric'` 的每次调用轨迹（`result_id`、`turn_no`、`status`、`input_json`、`output_text`、`error`、`started_at`、`finished_at`）。
- `eval_rubrics`：按 `UNIQUE(result_id, turn_no)` 存储通过结构校验（`parseEvalRubric`）的评分卡 JSON（`stance`、`keyPoints`、`forbidden`、`mustNotHallucinate`），并关联 `call_id REFERENCES eval_model_calls(id)`。

### reasoning_runs 与 reasoning_traces：脱稿 CoT（`<think>`）逆向补写

- `reasoning_runs`：记录每次 CoT 补写运行（`status`、`writer_model`、`judge_model`、`config_json`、`prompts_json`、`skills_json`、`started_at`、`finished_at`、`error`）。
- `reasoning_traces`：按 `UNIQUE(reasoning_run_id, attempt_id)` 关联 `results(id)` / `attempts(id)` / `turn_no`，记录 `length_tier`（`short` / `medium` / `long`）、`status`、`decision`（`pass` / `drop`）、`rewrite_count`、`reasoning` 正文、确定性规则校验明细 `checks_json` 与原始输出 `raw_output`。

## 3. 关系与重复运行

```text
video_splits (video_key) ── 隔离约束 ── materials 1 ── N questions
runs      1 ── N run_items N ── 1 questions
run_items 1 ── N turns     1 ── 0..1 passed_attempt
turns     1 ── N attempts
attempts  1 ── N model_calls (answer / judge)
turns     1 ── 0..1 model_calls (followup，挂在上一已通过 turn)
run_items 1 ── 0..1 results
results   1 ── N eval_rubrics (按 turn_no) ── 0..1 eval_model_calls
results   N ── M test_set_versions (通过 result_ids_json 不可变快照)
results   1 ── N reasoning_traces N ── 1 reasoning_runs
runs      1 ── N 出题 model_calls (question) ── 1 materials
```

- 同一起始问题跑两次：两条 `run_items`，两个运行各自独立保存过程和 `results`，不覆盖历史。
- 单轮题三轮返工仍 `revise`：1 条 `turn_no=1`（`exhausted`）、3 条 `attempts`、1 条 `exhausted` 的 `run_item`、**0 条 `results`**。
- 多轮题第 1 轮通过、第 2 轮返工耗尽/被 `drop`/出错：`turn_no=1` 为 `pass`，`turn_no=2` 为 `exhausted`/`drop`/`error`，`run_item` 标记为对应非通过状态，**0 条 `results`**。
- 生成零题：保留 `question_generation` 的 `run` 和 `model_calls`，不插空问题，无 `run_items`。
- 不做静默隐式混版与跨区泄漏：单次导出指定 `--run`，跨运行合并通过 `npm run dm -- synth export` 显式声明 `--runs`、`--all-formal`（默认 `--split train`，受 `training_enabled = true` 与 `video_splits.split = 'train'` 双重拦截）或 `--version <NAME>`（按冻结版本精确复现），按显式 `--dedup latest | earliest | error` 选版去重；`--val-ratio` 严格按 `video_key` 整视频切分验证集（同一多 P 视频的所有分块自动绑定同侧）并支持 `--manifest` 审计清单。

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

## 5. 写入顺序与事务

建表时统一约束：正文非空 `CHECK(length(trim(...)) > 0)`；JSON 字段以 `json_valid` + `json_type` 校验；状态字段用 `CHECK` 枚举；轮次为正整数且不超过运行上限。建立必要索引，迁移完成后执行 `PRAGMA foreign_key_check` 和 `PRAGMA integrity_check`。

1. 开启 `PRAGMA foreign_keys = ON`、WAL 模式和 `busy_timeout`。
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
6. 全部条目处理结束后关闭 `run`。单题出错但整批处理完，可设 `run=completed`，错误数从条目汇总；`run=error` 留给批次级故障。

进程崩溃会遗留 `running` 记录；下次启动先标记为 `interrupted`。第一版只识别中断，暂不自动续跑，避免重复扣费。所有写入参数化，材料/问题内容不作为 SQL 执行。

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
2. **顶层仅含 `messages` 字段**（溯源信息保留在 SQLite 中，不污染训练文件）：
   - 单轮（无 `system`）：
     `{"messages":[{"role":"user","content":"问题"},{"role":"assistant","content":"回答"}]}`
   - 多轮（含可选 `system`）：
     `{"messages":[{"role":"system","content":"..."},{"role":"user","content":"第1轮问题"},{"role":"assistant","content":"第1轮回答"},{"role":"user","content":"补充条件或反例"},{"role":"assistant","content":"第2轮回答"}]}`
3. **训练 `system` 提示词在导出层按需配置**（CLI 参数或导出配置提供），不把数据生成阶段包含“依据 material 作答/返工协议”的 `prompts_json` 原样塞入训练集。
4. 汇总数通过查询计算，不另存一套容易失真的计数表。JSONL 是按需导出格式，不再是主存储。

## 7. 本次运行迁移及验收清单

1. 保留现有 `data/questions.sqlite` 与 `output/database-trial-CkXhqo`；在新库 `data/data-maker.sqlite` 建表并校验约束。
2. 导入 1 个材料版本、12 个问题；旧问题保留 ID 1–12，旧出题运行未知时 `generation_run_id` 为空。
3. 导入 1 次回答质检 `run`（`max_turns = 1`、`max_attempts = 3`）、12 条 `run_items`、12 条 `turns`、19 条 `attempts`、38 条 `model_calls`、11 条 `results`。
4. 现有 `traces.jsonl` 为每次调用 `role_start` / `role_result` 两个事件，按 `questionId`、`attempt`、`role` 配对，合并成一条 `model_calls`，不误算成 76 次。
5. 结果关联到最后 `pass` 的 `attempt`。第 7 题为 `exhausted`，0 条 `result`；第 4 题通过尝试轮为 2，第 8、12 题通过尝试轮为 3。
6. 对比逐条问题、答案、反馈与原始输出，验证材料指纹、外键、无凭据以及重复导入幂等。
7. 执行约束负例：插入 `revise`/`error` 对应的 `result`、跨题/跨轮关联 `attempt`、多轮仅部分轮次通过就插入 `result`、原地修改/删除被 `results` 引用的记录均应失败；事务中途失败不得留下半条通过结果。
8. 验证单轮与多轮 `.jsonl` 导出：单行合法 JSON、仅含 `messages`、可选 `system` 前置、中文未转义、换行正确转义为 `\n`。
9. 全部生产工作流（`npm run dm -- synth run|questions|judge|export|demo`）均已通过 [src/synth/workflows.ts](<../src/synth/workflows.ts>) 接入模块化存储 [src/synth/store/index.ts](<../src/synth/store/index.ts>)（拆分为 `corpus-repo.ts` / `run-repo.ts` / `export-repo.ts`），并具备以下批量生产能力：
   - **整视频多 P 自适应合并/分块与防重复选稿（[src/synth/corpus.ts](<../src/synth/corpus.ts>)）**：中小多 P 视频（`<= 32,000` 字）合并为 1 条 `materials`，超长系列大合集按分 P 边界切分为多个分块；自动跳过已存在 `questions` 或 `completed` 出题调用（含 0 题）的视频及相同全文 `sha256` 的跨目录重复稿。
   - **持久化三分区隔离、评分卡与版本冻结（[src/synth/splits.ts](<../src/synth/splits.ts>)）**：按 `video_key` 哈希持久化划分 `train` / `test` / `dpo`，支持 `--extract-rubric` 抽取 `eval_rubrics` 评分要点、`--freeze-version` 固化不可变 `test_set_versions` 与 `--version` 精确复现导出（详见 [测试集与评测流水线设计](<test-and-eval-pipeline.md>)）。
   - **有界并发、前缀缓存优化、自动重试与按角色思考等级**：出题与回答质检支持 `--concurrency 1–500`（默认 `10`），单进程同步短事务无锁冲突；单次模型调用异常默认自动重试 3 次（3 秒间隔），仍失败丢弃；多轮 `answer` 固定稳定前缀字段序并实行首题缓存预热闸门；支持按角色覆盖 `LLM_{QUESTION,ANSWER,JUDGE,FOLLOWUP,RUBRIC}_THINKING_LEVEL`。
   - **增量质检（`--only-unjudged`）、多预设与总训练集导出（`--all-formal` / `--runs` / `--version`）**：`synth run` 与 `synth judge` 支持 `--profile standard | short | trap` 及 `--preset` 一键切换预设；`synth judge --only-unjudged` 自动跳过同 `max_turns` 下已有 `pass` / `drop` / `exhausted` 终态的旧问题，仅跑新问题及上次 `error` / `interrupted` 的问题；`synth export` 支持 `--preset train-all|train-val`、`--split`、`--version`、`--freeze-version`、`--dedup latest | earliest | error`、可复现 `--shuffle --seed`、按 `video_key` 整视频切分验证集（`--val-out` / `--val-ratio`）、`--timestamp` 与 `--manifest` 审计清单。
   - **多预设正式 Skill 全量快照**：核心 5 角色（`question-design`、`followup-strategy`、`answer-style`、`quality-judge`、`eval-rubric`）、`short` / `trap` 专职预设变体（各 4 份）与 CoT 补写 2 角色（`reasoning-writer`、`reasoning-judge`）全员 `status: ready`，严格按角色隔离注入并完整快照进 `runs.skills_json` / `reasoning_runs.skills_json`。

## 8. 验收与回归基线

- **代码与测试**：`npm run check`（`tsc --noEmit` + `tsx --test`）全量通过（涵盖核心存储、对话循环、多 P 语料、三分区防泄漏、多预设 Skill、Rubric 抽取、版本冻结、CoT 逆向补写、独立对抗/陷阱评测与架构边界守卫）。
- **初始首版生产库基线快照（2026-11-24 冻结验证，`data/data-maker.sqlite`，14 表）**：
  - **三分区注册表（`video_splits`）**：全库 **1,700** 个视频已持久化锁定：`train` **1,367**（29 个历史回填 + 1,338 个哈希）/ `test` **174** / `dpo` **159**。
  - **正式训练集（`train`）**：已处理 **29** 个视频，入库 **166** 题，产出 **163** 条通过样本（1 轮 44 / 2 轮 92 / 3 轮 27），已导出至 `output/train-all.jsonl` 与 `output/train-all-manifest.json`。
  - **冻结盲测集（`test-v1`）**：已处理 **6** 个 `test` 视频，入库 **38** 题，**38 / 38** 全部通过（1 轮 11 / 2 轮 21 / 3 轮 6，共 **71** 轮），**71 / 71** 轮 `eval_rubrics` 全量落库，已固化版本 `test-v1` 并单独导出至 `output/test.jsonl`（同 `output/test-v1.jsonl`）及 `output/test-manifest.json`。
  - **CoT 补写试点（`reasoning`）**：已完成 2 轮分层试点（`reasoning_runs` #1 / #2，共追踪 45 轮，42 轮通过规则 + LLM 双重质检）。
