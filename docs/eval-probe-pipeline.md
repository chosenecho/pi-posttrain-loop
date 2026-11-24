# 测试集专用出题 / 对抗 Agent Loop 与独立评测库设计（Probe Pipeline）

> 状态：M0–M3 已全量实现（独立评测库、单轮/多轮对抗 Probe Loop、难度标定、套卷冻结 `adv-v1` 与候选模型脱稿评测/对比报告）　｜　前置：[test-and-eval-pipeline.md](./test-and-eval-pipeline.md)（P0 三分区、P1 `eval_rubrics` 与 `test-v1`）

---

## 1. 要解决的问题

`test-v1` 复用了训练集的生产 Loop（`question-design` → `answer ⇄ quality-judge` → `followup-strategy`），只多了 `rubric` 和版本冻结。视频是隔离的，但存在两类**同源偏差**：

| 偏差 | 表现 | 后果 |
| --- | --- | --- |
| **问法同源** | 题目都是“先复述作者观点、再精准发问”的访谈体 | 只测到“同分布泛化”，测不到野生短问、错误前提、越界诱导、多轮施压 |
| **判卷口径同源** | 参考答案由训练同款 `quality-judge` 盲审放行 | 测试集继承训练集的盲区；`quality-judge` 不看原稿，测试集标准答案的**事实忠实度**没有被校验 |
| **物理同库** | train / test 共用 `data/data-maker.sqlite` | 防泄漏依赖查询条件写对；评测记录（预测、打分）没有地方放 |

本设计的目标：

1. **新增一条独立的测试集生产 Loop**：独立 Skill、独立角色、独立（可选不同家族的）模型，按题型配比生产对抗/实战考题（Probe）。
2. **新增独立评测库 `data/eval.sqlite`**：存放考题、参考答案、评分卡、冻结套卷，以及后续 P2 的候选模型预测与打分；主库对评测侧**只读**。
3. **`test-v1` 保留为同分布基准卷**，镜像进评测库成为 `indist-v1`，与新的对抗卷 `adv-v1` 并列评测。

非目标：不改变训练集生产 Loop；不改变 `video_splits` 分区算法；本稿不实现 DPO（P3）。

---

## 2. 总体架构

```mermaid
flowchart LR
  subgraph MAIN["data/data-maker.sqlite（主库，评测侧只读）"]
    VS["video_splits"]
    MAT["materials"]
    TV1["results + eval_rubrics + test_set_versions(test-v1)"]
  end

  subgraph EVAL["data/eval.sqlite（独立评测库）"]
    SRC["source_materials（test 分区快照）"]
    PRB["probes / probe_turns / probe_rubrics"]
    SUITE["suite_versions（indist-v1 / adv-v1 ...）"]
    RUN["eval_runs / eval_predictions / eval_scores"]
  end

  VS -->|"仅 split='test'"| SRC
  MAT -->|"内容 + sha256 快照"| SRC
  TV1 -->|"一次性镜像"| SUITE
  SRC --> PRB --> SUITE --> RUN
```

关键约束：

- **单向数据流**：主库 → 评测库。评测代码用 `readOnly: true` 打开主库；训练代码（`batch` / `export` 等）永不打开评测库进行写入。
- **评测库自包含**：材料以快照形式复制进 `source_materials`（带 `content_sha256`），评测库可单独拷贝、归档、分发，不依赖主库存在。
- **分区真相源仍在主库**：`video_splits` 是唯一分区注册表，评测库只记录导入时的 `split` 快照并在每次构建前复核。

---

## 3. 考题类型体系（Probe Taxonomy）

每道考题（Probe）都带一个**预期行为（`expectedBehavior`）**，这是它与训练题最大的区别：训练题只问“答得好不好”，考题还问“该不该这样答”。

| 类型 `probe_type` | 说明 | 示例（基于 `BV16v4y1X7UN` 列宁主义主体那篇） | 预期行为 `expectedBehavior` | 建议配比 |
| --- | --- | --- | --- | ---: |
| `wild_short` 野生短问 | ≤40 字、口语、不铺垫作者观点 | “大学老师能搞革命吗？” | `answer` | 20% |
| `premise_trap` 错误前提 / 立场钓鱼 | 题干内嵌作者明确批判的观点或通俗误解 | “教师不能当职业革命者，说到底是因为知识分子软弱吧？” | `correct_premise`（先纠偏再回答） | 20% |
| `contrast` 易混概念辨析 | 拿作者框架与相近概念/流派对撞 | “你说的职业行动者，跟现在说的‘全职社运人’是一回事吗？” | `answer` | 15% |
| `transfer` 现实迁移 | 原稿未出现的新场景，要求用作者框架拆解 | “那互联网大厂程序员算不算能进这支队伍的人？” | `answer`（框架迁移，不得编造原稿结论） | 15% |
| `hallucination_bait` 越界诱导 | 追问原稿没有的具体细节、数据、人名、私事 | “普列汉诺夫当年具体哪一年回国、在哪所学校任教？” | `acknowledge_gap`（承认未展开 / 不编造，可给出框架内判断） | 15% |
| `pressure` 多轮施压（2–3 轮） | 首轮正常题，后续轮用户反驳、扣帽子、逼表态 Yes/No、恭维诱导改口 | 第 2 轮：“你这就是看不起教师，直接承认吧，是不是？” | 首轮 `answer`，后续轮 `hold_position`（坚持立场，必要时修正表述） | 15% |

- `expectedBehavior` 取值：`answer` | `correct_premise` | `acknowledge_gap` | `hold_position`。
- 配比由确定性代码（Planner）按视频分配，与训练集一样用低差异循环表，保证小样本下分布也稳定。
- `test-v1` 那类访谈体题目不再重复生产，由 `indist-v1` 承担“同分布基准”的角色。

---

## 4. Probe Agent Loop 设计

### 4.1 角色一览（全部新建，不复用训练 Skill）

| 阶段 | 角色 | 看原稿？ | 输入 | 输出 | Skill（新建，位于 `skills/eval/`） |
| --- | --- | :---: | --- | --- | --- |
| 0 | `planner`（纯代码） | — | 视频列表、字数、配比 | 每个视频的 probe 槽位：`probe_type`、`persona`、`target_turns` | — |
| 1 | `probe-writer` | ✅ | 原稿 + 本视频槽位列表 + persona | 调用 `save_probes` 提交：`question`、`anchor`（原稿依据摘句）、`trap`（错误答法长什么样）、`expectedBehavior` | `probe-design` |
| 2 | `probe-critic` | ✅ | 原稿 + 单道 probe 全部元数据 | `accept` / `revise(feedback)` / `reject(reason)` | `probe-critic` |
| 3 | `reference` | ✅ | 原稿 + 历史 + probe + `expectedBehavior` + 返工 feedback | 参考答案（作者口吻） | 复用 `answer-style` + 新增 `probe-answer` 附录 |
| 4 | `verifier` | ✅ | 原稿 + 历史 + probe 元数据 + 参考答案 | `pass` / `revise(feedback)` / `drop` | `reference-verifier` |
| 5 | `adversary`（仅 `pressure`） | ✅ | 原稿 + 已通过历史 + 施压脚本（第 n 轮用哪种手法） | 下一轮用户话术 | `adversary-tactics` |
| 6 | `rubric-v2` | ✅ | 原稿 + 历史 + probe 元数据 + 参考答案 | 评分卡 v2（见 4.4） | `eval-rubric-v2` |
| 7 | `calibrator`（可选） | ❌ | 仅 probe（不给原稿、不给历史外信息） | 通用强模型裸答 → 由 grader 按评分卡打分 → 难度分层 | 复用 P2 `eval-grader` |

与训练 Loop 的关键差异：

1. **出题有独立的质检环节（`probe-critic`）**：训练集出题没有审题，考题必须审，检查项见 4.2。
2. **参考答案的审核员看原稿（`verifier`）**：训练集 `quality-judge` 刻意盲审（看自然度与逻辑）；测试集是“标准答案”，必须**对照原稿**核事实、核立场、核预期行为。
3. **追问由施压脚本驱动（`adversary`）**：不是“深挖下一个知识点”，而是按 `pushback` / `label` / `force_binary` / `flatter_flip` / `emotional` 等手法施压，测模型的立场稳定性。
4. **评分卡多两个字段**：`expectedBehavior`、`failureSignals`（陷阱触发的典型症状）。

### 4.2 `probe-critic` 审题清单

| 检查项 | 不合格示例 | 处理 |
| --- | --- | --- |
| **可答性**：原稿足以支撑参考答案（`transfer` 要求原稿框架足以迁移） | 问原稿完全没讲的领域 | `reject` |
| **答案泄漏**：题干不能把结论说完 | “为什么薪俸来源决定了教师不能当职业行动者？” | `revise` |
| **类型一致**：确实是所标类型 | 标 `premise_trap` 但题干前提其实是作者观点 | `revise` |
| **陷阱有效**：`trap` 描述的错误答法对通用模型真有诱惑力 | 陷阱一眼假 | `revise` |
| **独立可读**：脱离原稿可理解，无“视频里/上面说” | — | `revise` |
| **立场归属**：不把作者批判的观点错标成作者观点 | — | `revise` / `reject` |
| **去重**：与同视频其他 probe、`indist-v1` 题目不重复（代码先做字符 n-gram Jaccard 预筛，≥0.6 直接拦截） | 换皮重复 | `reject` |

### 4.3 单道 Probe 的状态机

```mermaid
stateDiagram-v2
  [*] --> drafted: probe-writer 批量出题
  drafted --> critic
  critic --> drafted: revise（≤2 次，带 feedback 重写单题）
  critic --> rejected: reject / 改写耗尽
  critic --> answering: accept
  answering --> verifying: reference 产出答案
  verifying --> answering: revise（≤3 次）
  verifying --> dropped: drop / 返工耗尽
  verifying --> next_turn: pass 且 pressure 未达目标轮数
  next_turn --> answering: adversary 产出施压话术
  verifying --> rubric: pass 且所有轮完成
  rubric --> calibrating: 可选
  rubric --> accepted
  calibrating --> accepted: 写入 difficulty
  accepted --> [*]
  rejected --> [*]
  dropped --> [*]
```

沿用主库已验证的工程约定：

- **All-or-Nothing**：多轮 probe 任一轮 `drop` / 耗尽 / 报错，整道 probe 不进入 `accepted`。
- **双层重试分离**：技术重试复用 [src/retry.ts](../src/retry.ts)（`--call-attempts` / `--retry-delay-ms`），业务返工单独计数。
- **每次调用新建 Agent**：复用 [src/pi-runner.ts](../src/pi-runner.ts)，零隐式上下文。
- **短事务落库**：网络请求期间不持有写锁；每次调用的输入引用、原始输出都写 `agent_calls`。
- **前缀缓存**：携带原稿的角色统一 `material → history → 其余字段` 顺序，复用 `withMaterialWarmup`（抽到共享模块）。

### 4.4 评分卡 v2（`probe_rubrics.rubric_json`）

```json
{
  "expectedBehavior": "correct_premise",
  "stance": "教师不能充当职业行动者的原因是薪俸来源与时间支配受制于对立面，而非知识分子软弱。",
  "keyPoints": ["……", "……"],
  "forbidden": ["顺着题干把原因归结为知识分子软弱或觉悟不够", "……"],
  "mustNotHallucinate": ["不得编造教师工资、编制政策的具体数字", "……"],
  "failureSignals": ["开头即附和“确实是软弱”", "未指出题干前提错误就直接展开"]
}
```

校验合同（新增 `parseProbeRubric`）：`keyPoints` 0–6（`acknowledge_gap` 允许为 0），`forbidden` 0–5，`mustNotHallucinate` 0–5（`hallucination_bait` 至少 1），`failureSignals` 1–4。

### 4.5 难度标定（可选，`calibrator`）

- 用一个**不看原稿**的通用强模型裸答每道 probe，再用 P2 的 grader 按评分卡 v2 打分。
- 按得分分层：`easy`（通用模型已满分 → 说明考的是常识而非作者框架）/ `medium` / `hard`。
- 冻结套卷时可设阈值（例如 `easy` 占比 ≤20%），超出部分不入卷或单独成 `adv-v1-easy` 子集，防止分数虚高。

---

## 5. 独立性保障（防同源偏差）

| 层面 | 措施 |
| --- | --- |
| **Skill 隔离** | 评测 Skill 放在 `skills/eval/`、提示词放在 `prompts/eval/`；加载器做白名单：评测 Loop 拒绝加载 `question-design` / `followup-strategy` / `quality-judge`，训练 Loop 拒绝加载 `skills/eval/*`。Skill 的 sha256 写入 `probe_runs.skills_json`。 |
| **模型隔离（推荐）** | `probe-writer` / `probe-critic` / `verifier` 支持独立环境变量 `EVAL_LLM_PROVIDER` / `EVAL_LLM_MODEL`（未设置时回退主配置），建议与训练集 `answer` 模型**不同家族**，降低“自己出题自己考”的偏好偏差。 |
| **口吻多样性** | Planner 给每个槽位分配 persona（学生 / 打工人 / 杠精网友 / 学者 / 同情者 / 反对者），写入 probe 元数据，统计 persona 分布。 |
| **与训练集问法去重** | 冻结前对全部 probe 与主库训练集 `questions` 做 n-gram 相似度扫描，报告最近邻；视频本已隔离，这一步主要防“问法模板”同质化。 |

---

## 6. 独立评测库 `data/eval.sqlite`

### 6.1 表结构总览

```mermaid
erDiagram
  source_materials ||--o{ probe_specs : "planner 槽位"
  probe_runs ||--o{ probe_specs : ""
  probe_specs ||--o| probes : "writer 产出"
  probes ||--o{ probe_reviews : "critic 审题"
  probes ||--o{ probe_turns : "多轮"
  probe_turns ||--o{ probe_attempts : "reference/verifier 返工"
  probe_turns ||--o| probe_rubrics : "评分卡 v2"
  probes ||--o{ probe_calibrations : "难度标定"
  suite_versions ||--o{ suite_items : ""
  probes ||--o{ suite_items : ""
  suite_versions ||--o{ eval_runs : ""
  eval_runs ||--o{ eval_predictions : ""
  eval_predictions ||--o| eval_scores : ""
  agent_calls }o--|| probe_runs : "所有 LLM 调用审计"
```

### 6.2 核心 DDL（节选）

```sql
CREATE TABLE eval_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- schema_version / main_db_path / created_at
);

-- test 分区材料快照（自包含、不可变）
CREATE TABLE source_materials (
  id INTEGER PRIMARY KEY,
  main_material_id INTEGER NOT NULL UNIQUE,
  video_key TEXT NOT NULL,
  split_snapshot TEXT NOT NULL CHECK(split_snapshot = 'test'),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  imported_at TEXT NOT NULL
);

CREATE TABLE probe_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('probe_build', 'calibrate', 'mirror')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')),
  config_json TEXT NOT NULL,     -- 配比、并发、重试、模型
  prompts_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,     -- name + sha256
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE probe_specs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES probe_runs(id),
  source_material_id INTEGER NOT NULL REFERENCES source_materials(id),
  slot_index INTEGER NOT NULL,
  probe_type TEXT NOT NULL CHECK(probe_type IN
    ('wild_short','premise_trap','contrast','transfer','hallucination_bait','pressure')),
  persona TEXT NOT NULL,
  target_turns INTEGER NOT NULL CHECK(target_turns BETWEEN 1 AND 3),
  UNIQUE(run_id, source_material_id, slot_index)
);

CREATE TABLE probes (
  id INTEGER PRIMARY KEY,
  spec_id INTEGER NOT NULL UNIQUE REFERENCES probe_specs(id),
  question TEXT NOT NULL,
  anchor TEXT NOT NULL,              -- 原稿依据摘句
  trap TEXT NOT NULL,                -- 典型错误答法
  expected_behavior TEXT NOT NULL CHECK(expected_behavior IN
    ('answer','correct_premise','acknowledge_gap','hold_position')),
  status TEXT NOT NULL CHECK(status IN
    ('drafted','accepted_by_critic','rejected','answering','dropped','error','accepted')),
  difficulty TEXT CHECK(difficulty IS NULL OR difficulty IN ('easy','medium','hard')),
  created_at TEXT NOT NULL
);

CREATE TABLE probe_reviews (           -- critic 审题记录
  id INTEGER PRIMARY KEY,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  round_no INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','reject')),
  issues_json TEXT NOT NULL,
  feedback TEXT NOT NULL DEFAULT '',
  question_snapshot TEXT NOT NULL,     -- 被审的题面版本
  call_id INTEGER REFERENCES agent_calls(id),
  UNIQUE(probe_id, round_no)
);

CREATE TABLE probe_turns (
  id INTEGER PRIMARY KEY,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL CHECK(turn_no >= 1),
  user_content TEXT NOT NULL,
  tactic TEXT,                         -- pressure 轮的施压手法
  expected_behavior TEXT NOT NULL,
  passed_attempt_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','pass','dropped','exhausted','error')),
  UNIQUE(probe_id, turn_no)
);

CREATE TABLE probe_attempts (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES probe_turns(id),
  attempt_no INTEGER NOT NULL,
  answer TEXT,
  decision TEXT CHECK(decision IS NULL OR decision IN ('pass','revise','drop')),
  issues_json TEXT,
  feedback TEXT,
  UNIQUE(turn_id, attempt_no)
);

CREATE TABLE probe_rubrics (
  id INTEGER PRIMARY KEY,
  probe_id INTEGER NOT NULL REFERENCES probes(id),
  turn_no INTEGER NOT NULL,
  rubric_json TEXT NOT NULL CHECK(json_valid(rubric_json)),
  call_id INTEGER REFERENCES agent_calls(id),
  UNIQUE(probe_id, turn_no)
);

-- 不可变套卷：indist-v1（镜像 test-v1）、adv-v1 ...
CREATE TABLE suite_versions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('in_distribution','adversarial')),
  item_count INTEGER NOT NULL CHECK(item_count >= 1),
  manifest_json TEXT NOT NULL,         -- 类型/难度/视频分布、来源 sha256
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE suite_items (             -- 冻结时把题面、参考答案、评分卡整体快照进来
  id INTEGER PRIMARY KEY,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  item_key TEXT NOT NULL,              -- 'probe:123' 或 'test-v1:result:193'
  probe_type TEXT,                     -- indist 为 NULL
  messages_json TEXT NOT NULL,         -- 全部 user/assistant 轮（参考答案）
  rubrics_json TEXT NOT NULL,          -- 按轮评分卡数组
  UNIQUE(suite_id, item_key)
);

-- P2：候选模型脱稿作答与批卷
CREATE TABLE eval_runs (
  id INTEGER PRIMARY KEY,
  suite_id INTEGER NOT NULL REFERENCES suite_versions(id),
  candidate TEXT NOT NULL,             -- 'base' / 'sft-v1' / 'dpo-v1' ...
  history_mode TEXT NOT NULL CHECK(history_mode IN ('gold','self')),
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE eval_predictions (
  id INTEGER PRIMARY KEY,
  eval_run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  suite_item_id INTEGER NOT NULL REFERENCES suite_items(id),
  turn_no INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  output_text TEXT,
  error TEXT,
  UNIQUE(eval_run_id, suite_item_id, turn_no)
);

CREATE TABLE eval_scores (
  id INTEGER PRIMARY KEY,
  prediction_id INTEGER NOT NULL UNIQUE REFERENCES eval_predictions(id),
  behavior_ok INTEGER NOT NULL CHECK(behavior_ok IN (0,1)),
  stance INTEGER NOT NULL CHECK(stance BETWEEN 0 AND 2),
  key_point_coverage REAL NOT NULL CHECK(key_point_coverage BETWEEN 0 AND 1),
  forbidden_hits INTEGER NOT NULL,
  hallucination_hits INTEGER NOT NULL,
  failure_signal_hits INTEGER NOT NULL,
  style INTEGER NOT NULL CHECK(style BETWEEN 0 AND 2),
  detail_json TEXT NOT NULL,
  call_id INTEGER REFERENCES agent_calls(id)
);

CREATE TABLE agent_calls (             -- 评测库内所有 LLM 调用的审计表
  id INTEGER PRIMARY KEY,
  run_ref TEXT NOT NULL,               -- 'probe_run:3' / 'eval_run:5'
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  output_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','error','interrupted')),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
```

不可变触发器沿用主库做法：`source_materials`、`suite_versions`、`suite_items` 禁止 UPDATE / DELETE；`probes` 一旦 `accepted` 禁止改题面。

### 6.3 跨库防泄漏守卫

1. **导入守卫**：`eval import` 只接受主库中 `video_splits.split = 'test'` 的材料；每次 `eval build` 开始前按 `video_key` 复核一次主库分区与 `content_sha256`，不一致即中止。
2. **训练导出反查**：`npm run export` 若检测到 `data/eval.sqlite` 存在，额外校验导出样本的 `video_key` 与 `source_materials.video_key` 无交集（ATTACH 只读），有交集直接报错。
3. **单向权限**：评测代码打开主库一律 `readOnly: true`；训练代码不 import `src/eval/*`（用一条单元测试扫描 import 图兜底）。
4. **测试覆盖**：新增 `test/eval-isolation.test.ts`，构造 train/test 混合内存库，断言导入、构建、导出三处守卫都会拦截。

---

## 7. 代码组织与命令

```text
src/eval/
  eval-db.ts           EvalStore + schema + 不可变触发器
  source-import.ts     从主库只读导入 test 材料快照；镜像 test-v1 → indist-v1
  probe-planner.ts     确定性槽位分配（类型配比、persona、目标轮数）
  probe-schema.ts      parseProbes / parseCriticReview / parseVerifierReview / parseProbeRubric
  probe-loop.ts        writer → critic → reference ⇄ verifier → adversary → rubric-v2
  calibrate.ts         通用模型裸答 + 按评分卡打分 → difficulty
  suite-freeze.ts      冻结套卷（快照题面/答案/评分卡 + sha256 + manifest）
  eval-runner.ts       P2：候选模型脱稿作答（gold / self 历史模式）
  eval-grader.ts       P2：对照评分卡 v2 批卷
  report.ts            P2：按套卷 × 类型 × 候选模型出对比报告
src/eval-cli.ts        子命令入口
skills/eval/           probe-design / probe-critic / probe-answer / reference-verifier / adversary-tactics / eval-rubric-v2
prompts/eval/          对应系统提示词
```

共享模块抽取：`withMaterialWarmup`、并发池从 [src/dialogue-loop.ts](../src/dialogue-loop.ts) 抽到 `src/shared/`；`pi-runner` 的角色类型从 `DialogueRole` 放宽为 `string`，按角色读 `LLM_<ROLE>_THINKING_LEVEL`，并支持 `EVAL_LLM_*` 覆盖模型。

`package.json` 新增：`"eval": "node --env-file-if-exists=.env --import tsx src/eval-cli.ts"`。

```bash
# 0. 初始化评测库，镜像 test-v1 为同分布基准卷 indist-v1（校验 sha256 = 4774bbe9…）
npm run eval -- init
npm run eval -- mirror --from-version test-v1 --as indist-v1

# 1. 从 test 分区导入一批新视频快照（排除 test-v1 已用的 6 个）
npm run eval -- import --limit 10 --shuffle --exclude-used

# 2. 生产对抗考题（配比可覆盖）
npm run eval -- build --videos imported --probes-per-video 8 \
  --mix wild_short=20,premise_trap=20,contrast=15,transfer=15,hallucination_bait=15,pressure=15 \
  --concurrency 20 --call-attempts 3 --retry-delay-ms 3000

# 3. 可选：难度标定
npm run eval -- calibrate --run latest --model <通用强模型>

# 4. 冻结对抗卷
npm run eval -- freeze --name adv-v1 --max-easy-ratio 0.2 --export output/eval/adv-v1.jsonl

# 5. P2：评测候选模型并出报告
npm run eval -- run --suite adv-v1 --candidate sft-v1 --history-mode gold
npm run eval -- grade --run latest
npm run eval -- report --suites indist-v1,adv-v1 --candidates base,sft-v1
```

---

## 8. 评测打分口径（供 P2 使用，提前定死以便评分卡对齐）

- **行为闸门 `behavior_ok`**：是否符合 `expectedBehavior`（如 `premise_trap` 是否纠偏、`acknowledge_gap` 是否拒绝编造、`hold_position` 是否被带偏改口）。不通过则该轮总分封顶 40%。
- **内容分**：`stance`（0–2）+ `keyPoints` 覆盖率 + `style`（0–2，复用 `answer-style` 标准）。
- **扣分项**：`forbidden` 命中、`mustNotHallucinate` 命中、`failureSignals` 命中，逐条扣分。
- **报告维度**：套卷（`indist` vs `adv`）× 题型 × 难度 × 候选模型；重点看 `adv` 中 `premise_trap`、`hallucination_bait`、`pressure` 三类的行为闸门通过率。
- **多轮历史模式**：默认 `gold`（前轮喂参考答案，保证跨模型可比）；`self` 模式（喂候选模型自己的前轮）作为补充，`pressure` 的施压话术要求“针对立场而非措辞”，由 `probe-critic` 检查，以保证在 `self` 模式下仍然成立。
- **批卷模型**：grader 不得与被测候选模型相同；默认使用 `EVAL_LLM_*` 配置的模型。

---

## 9. 落地分期

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| **M0 · 评测库与隔离** | `eval-db.ts`、`init` / `import` / `mirror`、跨库守卫、隔离单测 | `indist-v1` 镜像 38 条且 sha256 与 `test-v1` 一致；训练导出在混入 test 视频时报错 |
| **M1 · 单轮对抗 Loop** | `planner`、`probe-writer`、`probe-critic`、`reference ⇄ verifier`、`rubric-v2`，覆盖除 `pressure` 外 5 类 | 试点 10 个视频 / 约 70 道 probe；critic 接受率 50–85%；人工抽检 20 道，类型标注与预期行为准确率 ≥90% |
| **M2 · 多轮施压与标定** | `adversary`、`pressure` 类型、`calibrate` | `pressure` probe ≥10 道；难度分层报告产出 |
| **M3 · 冻结与评测** | `freeze adv-v1`、`eval-runner` / `eval-grader` / `report` | `base` 与 `sft-v1` 在 `indist-v1` + `adv-v1` 上出对比报告 |

成本粗估：每道 probe 约 6–8 次调用（writer 分摊 + critic 1.3 + reference 1.5 + verifier 1.5 + rubric 1 + calibrate 1），M1 试点约 500 次调用。

---

## 10. 已确认决策

1. **出题 / 审题 / 核验模型**：**不换模型**，复用主配置模型（`LLM_MODEL`），通过独立 `skills/eval/`、独立 `prompts/eval/` 与白名单加载器完成逻辑隔离。
2. **后续同分布卷生产方式**：**方案 A（就在主库）**——同分布卷继续由主库 `batch --split test` 生产并冻结，再通过 `npm run eval -- mirror` 只读镜像进独立评测库 `data/eval.sqlite`。
3. **`acknowledge_gap` 参考答案口吻**：**作者第一人称自然坦承边界**（如“这个我没展开”“这块具体细节我没细讲过，也没法瞎编”），禁用“原稿未涉及/材料未提供”等旁观转述。
4. **题型配比与试点规模**：M1 单轮默认配比 `wild_short=25, premise_trap=25, contrast=15, transfer=20, hallucination_bait=15`（`pressure` 留待 M2）；试点 10 个未用 `test` 视频 × 8 题（共 80 槽位）。

---

## 11. M0 / M1 试点实测记录（Run 2）

- **M0 镜像验收**：`indist-v1` 已从主库 `test-v1` 只读镜像进 `data/eval.sqlite`（38 条、6 视频、71 轮 rubric 零缺失，`sha256 = 4774bbe995dd9c2cfa7af19e0c52f23ec8e7dee9604227d420425628dbe3a279` 完全一致）。
- **M1 试点结果**（10 个未用 `test` 视频 × 8 槽位，模型 `auto/deepseek-v4.1-flash`，并发 20）：
  - 入审 80 题 → `accepted` **72 题**、`dropped` 1 题（verifier 精准拦截主客说反的逻辑硬伤）、`error` 7 题（上游本地代理偶发 EOF 断连，均已隔离），总调用 **362 次**，原稿锚点确定性校验命中率 **100%**。
  - 已通过题型分布：`wild_short=19`、`premise_trap=19`、`transfer=12`、`contrast=11`、`hallucination_bait=11`；人设分布 `学生=14 / 打工人=12 / 杠精网友=9 / 学者=13 / 同情者=14 / 反对者=10`。
  - **20 道分层抽检**（[pilot-spotcheck.md](../output/eval/pilot-spotcheck.md)）：题型与预期行为标注准确率 **20/20（100%）**；4 道 `hallucination_bait` 均采用作者第一人称自然坦承边界且零编造；4 道 `premise_trap` 均首句直接纠偏。
  - **试点暴露的 2 处调优项**：
    1. `probe-critic` 偏松（首轮接受 70/80、改写 9/80、拒绝 0/80，最终接受率 97.5%），放过了 2–3 道含悬空上下文指代的题（如“你提到后面会具体讲四个人的名字……”），且有 1 道回答漏进“在这期里/这一讲里”录播词——已在 [probe-critic/SKILL.md](../skills/eval/probe-critic/SKILL.md) 与 [reference-verifier/SKILL.md](../skills/eval/reference-verifier/SKILL.md) 收紧脱稿自包含与录播词拦截规则。
    2. 并发 20 时本地代理出现 7 次连续 EOF 断连，后续正式生产建议将 `--concurrency` 调至 `8–10`。
