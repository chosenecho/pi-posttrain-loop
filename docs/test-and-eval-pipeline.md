# 测试集（`test`）、DPO 采题池（`dpo`）与评测流水线设计

本文档记录 `pi-posttrain-loop` 的持久化三分区防泄漏架构、结构化评分要点（`eval_rubrics`）抽取、不可变测试集版本冻结（`test_set_versions`）、首版盲测基线 `test-v1`，以及后续脱稿盲测与 On-policy DPO 闭环演进路线。

---

## 1. 为什么需要独立测试集流水线

在模型后训练（SFT → On-policy DPO）迭代中，仅靠训练结束时临时按比例切分验证集存在三类风险：

1. **多 P 分块泄漏**：超长多 P 系列视频会按分 P 切分为多个 `materials`（如 `BVxxxx/P001-P004`、`BVxxxx/P005`）；若仅按 `material_id` 切分，同一视频的不同分块可能分别落入训练集与测试集。
2. **DPO 训练污染盲测集**：如果把同一批留出题既拿来做 On-policy DPO 错题纠偏，又拿来评估 DPO 效果，评测指标会失真。
3. **跨版本基准漂移**：随着后续持续补跑新测试题，如果不冻结测试集版本，SFT v1、SFT v2、DPO v1 将无法在同一套考卷上横向对比。

因此系统将语料库持久化划分为三个物理隔离分区，并配套结构化评分卡与不可变版本冻结：

- **`train`（约 80%）**：日常 SFT 训练集生产与导出。
- **`test`（约 10%）**：纯盲测留出区；只做评测、永不参与 SFT 或 DPO 训练。
- **`dpo`（约 10%）**：On-policy DPO 专用错题挖掘与偏好对采样池，与 `test` 严格隔离。

---

## 2. P0 · 持久化三分区注册表（`video_splits`）

实现模块：[src/synth/splits.ts](../src/synth/splits.ts)、[src/synth/store/index.ts](../src/synth/store/index.ts)。

### 2.1 分区确定性算法与历史回填

1. **统一视频主键（`extractVideoKey`）**：
   - 将旧版分 P 标识（`BVxxxx/P001`）、超长多 P 分块区间（`BVxxxx/P001-P004`）与整视频标识（`BVxxxx`）统一归一化为 `video_key`。
   - 同一多 P 视频的所有分块始终共享同一个 `video_key` 与分区。
2. **历史训练视频优先回填（`backfillProcessedTrainSplits`）**：
   - 首次同步语料库时，凡在 SQLite 中已有 `questions` 或 `completed` 出题调用的历史已处理视频，自动锁定为 `split = 'train', method = 'backfill'`，确保早期训练数据绝不会倒流进 `test` 或 `dpo`。
3. **固定哈希分桶（`computeVideoSplit`）**：
   - 其余视频按 `sha256("weimingzi-split-v1:" + video_key)` 取前 8 位十六进制映射到 `[0, 1)`：
     - `[0.0, 0.10)` → `test`
     - `[0.10, 0.20)` → `dpo`
     - `[0.20, 1.0)` → `train`
   - 语料目录增删新旧视频时，已分配视频的分区永不漂移。

### 2.2 数据库与全链路防泄漏守卫

- **表级不可变触发器**：`video_splits` 挂载 `trg_video_splits_immutable_update` 与 `trg_video_splits_immutable_delete`，禁止修改或删除已登记分区。
- **生产默认隔离**：`npm run dm -- synth run` 与 `synth questions` 默认 `--split train`，日常生产绝不触碰 `test` / `dpo` 视频。
- **导出策略双重拦截**：
  - `test` / `dpo` 分区运行自动写入 `runs.export_policy_json = {"format":"messages_jsonl","training_enabled":false,"eval_enabled":true}`；
  - `npm run dm -- synth export` 默认 `--split train`，同时校验 `training_enabled = true` 与 `video_splits.split = 'train'`；
  - `--val-ratio` 切分验证集按 `video_key` 分组，同一超长多 P 视频所有分块强制落在训练或验证同侧。

---

## 3. P1 · 评分要点抽取（`rubric` 角色）与版本冻结（`test_set_versions`）

### 3.1 第 5 角色：`rubric`（结构化评分卡）

在生产 `test` 或 `dpo` 分区样本时，开启 `--extract-rubric` 会在每条通过质检的样本完成后，逐对话轮调用独立的 `rubric` Agent，从原始材料与参考标准答案中提炼脱稿批卷用的结构化评分卡：

- **系统提示词**：[prompts/rubric.md](../prompts/rubric.md)（无 Skill 版：[prompts/no-skill/rubric.md](../prompts/no-skill/rubric.md)）
- **独立 Skill**：[skills/eval-rubric/SKILL.md](../skills/eval-rubric/SKILL.md)（`status: ready`，注入标签 `<eval-rubric>`）
- **独立思考等级配置**：支持环境变量 `LLM_RUBRIC_THINKING_LEVEL`（未设置时继承 `LLM_THINKING_LEVEL`）
- **结构校验合同（`parseEvalRubric`，见 [src/shared/schema.ts](../src/shared/schema.ts)）**：
  - `stance`（string，非空）：作者在本轮问题上的核心立场与定性判断。
  - `keyPoints`（string[]，1–6 条，去重）：被测模型脱稿作答必须覆盖的核心论点、机制或概念辨析（多轮只提炼本轮新增/深化要点）。
  - `forbidden`（string[]，0–5 条，去重）：反立场禁区与常见教科书式误解。
  - `mustNotHallucinate`（string[]，0–5 条，去重）：原文未提及、严禁胡编的事实、经历或数字边界。
- **存储表**：
  - `eval_model_calls`：记录每次 `rubric` 调用的原始输入、原始输出、状态与耗时（内置与主流程相同的自动重试机制）。
  - `eval_rubrics`：按 `UNIQUE(result_id, turn_no)` 存储校验通过的结构化 JSON。

### 3.2 不可变测试集版本冻结（`test_set_versions`）

- 仅允许对 `test` 或 `dpo` 分区使用 `--freeze-version <NAME>`（传入 `train` 分区直接报错拒绝）。
- 冻结时将当前选中样本的 `result_ids_json`、`sample_count`、`video_count`、`manifest_json` 与导出正文 64 位 `sha256` 写入 `test_set_versions`。
- 挂载 `trg_test_set_versions_immutable_update` 与 `trg_test_set_versions_immutable_delete`，版本一旦冻结即不可覆盖、修改或删除。
- 后续任何时候执行 `npm run dm -- synth export --version <NAME> --out <PATH>`，都会严格按冻结时的 `result_ids` 精确复现导出，不受后续新增批次影响。

---

## 4. 常用操作命令

```powershell
# 1. 查看 train / test / dpo 三分区进度（不调用模型）
npm run dm -- synth status

# 2. 从 test 分区生产盲测样本 + 抽取每轮评分要点 + 冻结版本
npm run dm -- synth run --preset test-freeze --limit 6 --concurrency 40 --freeze-version test-v1 --export output/test-v1.jsonl

# 3. 按已冻结版本号单独导出为 test.jsonl 与审计清单
npm run dm -- synth export --version test-v1 --out output/test.jsonl --manifest output/test-manifest.json

# 4. 后续扩充盲测集并冻结新版本（test-v1 保持不变，test-v2 包含累积的全部 test 通过样本）
npm run dm -- synth run --preset test-freeze --limit 14 --concurrency 40 --freeze-version test-v2 --export output/test-v2.jsonl

# 5. 从 dpo 分区独立生产 On-policy DPO 采题池（绝不污染 test 分区）
npm run dm -- synth run --preset dpo-pool --limit 15 --concurrency 40 --export output/dpo-pool.jsonl

# 6. 若曾中断或未开启 --extract-rubric，可单独对某分区补跑质检与 rubric
npm run dm -- synth judge --split test --max-turns 3 --concurrency 40 --only-unjudged --extract-rubric
```

---

## 5. 当前已落地基线：`test-v1`

截至 2026-11-24，生产库 `data/data-maker.sqlite` 全库 1,700 个视频已完成持久化分区，首版盲测集 `test-v1` 已完成生产、全量 Rubric 抽取与版本冻结：

### 5.1 全库三分区现状

| 分区 | 总视频数 | 已处理视频 | 未处理视频 | 已入库问题 | 已通过样本 | 用途 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `train` | 1,367（含 29 个历史回填） | 29 | 1,338 | 166 | 163 | SFT 正式训练集 |
| `test` | 174 | 6 | 168 | 38 | 38 | 冻结盲测基准集 |
| `dpo` | 159 | 0 | 159 | 0 | 0 | On-policy DPO 采题池 |

### 5.2 `test-v1` 盲测集明细（Run #6 出题 + Run #7 问答质检 & Rubric）

- **冻结版本号**：`test-v1`（`test_set_versions.id = 1`）
- **导出产物**：
  - 盲测集 JSONL：`output/test.jsonl`（与 `output/test-v1.jsonl` 字节一致）
  - 审计清单：`output/test-manifest.json`
  - SHA-256：`4774bbe995dd9c2cfa7af19e0c52f23ec8e7dee9604227d420425628dbe3a279`
- **样本统计**：
  - 通过率：**38 / 38（100%）**，0 报错
  - 轮数分布：1 轮 **11 条**（28.9%）/ 2 轮 **21 条**（55.3%）/ 3 轮 **6 条**（15.8%），共 **71 个对话轮**
  - 篇幅分布：`short` **27 轮** / `medium` **28 轮** / `long` **16 轮**
  - Rubric 覆盖率：**71 / 71 轮（100%）** 均已写入 `eval_rubrics`

| 视频 ID | 问题数 | 通过样本数 | 总对话轮数 | Rubric 条数 |
| --- | ---: | ---: | ---: | ---: |
| `BV16v4y1X7UN` | 3 | 3 | 5 | 5 |
| `BV1rh411A7vK` | 5 | 5 | 10 | 10 |
| `BV1gi4y197JV` | 7 | 7 | 13 | 13 |
| `BV1s14y1Z7bk` | 7 | 7 | 13 | 13 |
| `BV1oN411R78y` | 7 | 7 | 13 | 13 |
| `BV1LR4y187Vd` | 9 | 9 | 17 | 17 |
| **合计** | **38** | **38** | **71** | **71** |

---

## 6. 常用只读审计 SQL

```sql
-- 1. 检查全库分区分布与分配方式（backfill / hash / manual）
SELECT split, method, COUNT(*) AS videos
FROM video_splits
GROUP BY split, method
ORDER BY split, method;

-- 2. 查看已冻结测试集版本
SELECT id, name, split, sample_count, video_count, substr(sha256, 1, 16) AS sha_prefix, created_at
FROM test_set_versions
ORDER BY id;

-- 3. 核对 test 分区通过样本的 eval_rubrics 覆盖率
SELECT r.id AS result_id, r.turn_count, COUNT(er.id) AS rubric_count
FROM results r
JOIN run_items ri ON ri.id = r.run_item_id
JOIN questions q ON q.id = ri.question_id
JOIN materials m ON m.id = q.material_id
JOIN video_splits vs ON vs.video_key = m.video_id
LEFT JOIN eval_rubrics er ON er.result_id = r.id
WHERE vs.split = 'test'
GROUP BY r.id
HAVING rubric_count != r.turn_count;

-- 4. 抽查某条测试样本的评分卡内容
SELECT er.result_id, er.turn_no, er.rubric_json
FROM eval_rubrics er
ORDER BY er.result_id, er.turn_no
LIMIT 5;
```

---

## 7. 后续演进状态（P2 已落地 / P3 规划）

- **P2 · 脱稿盲测与自动批卷闭环（已落地，见 [eval-probe-pipeline.md](./eval-probe-pipeline.md)）**：
  - 已在独立评测库 `data/eval.sqlite` 与 `npm run dm -- eval` 中全量实现 `eval-runner`（原生多轮 Chat API，支持 `gold` / `self` 历史模式与默认 `prompts/eval/candidate-system.md`）、`eval-grader`（v3 整体语义批卷，兼容 `indist-*`、`adv-*` 与 `trap-*` 评分卡）、`evaluate`（一键 `run + grade + report`）、`report` 与 `compare` 跨模型对比报告；主库冻结版本 `test-v1` 通过 `npm run dm -- eval mirror` 只读镜像为 `indist-v1` 参与横向对比。
- **P3 · On-policy DPO 错题挖掘与偏好对导出（待实现）**：
  - 仅在独立的 `dpo` 分区运行候选模型脱稿作答与批卷；
  - 将翻车回答（`rejected`）与库内对应标准通过回答（`chosen`）自动配对，执行长度比过滤（防长度偏差），与过程表沉淀的高质量 `revise → pass` 样本按需合并导出为 DPO JSONL；
  - 训练完 DPO 模型后，回到从未用于训练的冻结 `indist-*` / `adv-*` / `trap-*` 盲测集上做盲测复检。
