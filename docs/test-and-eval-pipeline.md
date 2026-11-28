# 测试集（`test`）、DPO 采题池（`dpo`）与三分区防泄漏设计

当前评测由独立的 `data/eval.sqlite`（Schema v4）与 `npm run dm -- eval` 承接。主库侧的 `eval_rubrics`、`eval_model_calls`、`test_set_versions` 和 `test-v1` 生产/镜像入口已退役；当前操作以 [独立评测库与盲测流水线](eval-probe-pipeline.md) 为准。本文保留三分区规则、与独立评测库的边界，以及明确归档的旧基线记录。跨模块职责与通用运行契约见 [当前模块架构](architecture.md)。

## 1. 三分区的目的与边界

在 SFT → On-policy DPO 迭代中，按材料行临时切分会让同一多 P 视频的不同分块分别进入训练与测试；拿同一批题做 DPO 纠偏和最终盲测，也会污染指标。持久化分区与冻结套卷分别解决视频归属漂移和跨模型考卷漂移。

主库的 `video_splits` 是按视频登记的**逻辑分区**；物理隔离指主库与独立评测库使用不同 SQLite 文件。

| 分区 | 默认哈希区间 | 当前用途 |
| --- | --- | --- |
| `train` | `[0.20, 1.0)` | SFT 数据生产与正式训练导出 |
| `test` | `[0.0, 0.10)` | 永久盲测留出材料，只由独立 eval 流水线造题、标定和冻结 |
| `dpo` | `[0.10, 0.20)` | 独立采题池；`synth run --preset dpo-pool` 可生产问答，偏好对挖掘/导出仍属后续规划 |

上述比例是默认分桶规则，不保证某个有限语料库恰好为 80% / 10% / 10%；历史训练回填和已登记的手动分区优先保留。训练内部按 `--val-ratio` 切出的验证集仍来自 `train`，与永久 `test` 留出区用途不同。

## 2. 持久化三分区注册表（`video_splits`）

实现见 [splits.ts](../src/synth/splits.ts)、[split-hash.ts](../src/synth/split-hash.ts)、[utils.ts](../src/shared/utils.ts) 与 [主库 schema](../src/synth/store/schema-sql.ts)。

1. `extractVideoKey` 将 `BVxxxx/P001`、`BVxxxx/P001-P004` 等分块标识归一化为 `BVxxxx`。同一多 P 视频的所有分块共享 `video_key` 和分区。
2. `backfillProcessedTrainSplits` 将已有问题或成功出题调用、且尚未登记分区的历史处理视频登记为 `split='train', method='backfill'`，使历史训练材料留在训练侧。
3. 其余视频按 `sha256("weimingzi-split-v1:" + video_key)` 的前 8 位十六进制除以 `2^32` 得到 `[0,1)` 分桶值，使用上表默认区间。
4. 已登记分区优先于后续哈希计算；`trg_video_splits_immutable_update` / `trg_video_splits_immutable_delete` 阻止修改和删除。目录增删或后续重复同步不改变已登记视频的归属。

分区同步发生在生产路径。`synth status` 是只读观察：显示登记情况、分区统计和待同步数量，不回填分区、不建表、不恢复遗留任务；因此不能把 status 输出的预测归属当作已完成同步。

## 3. 当前防泄漏与运行约束

- **生产边界**：`synth run` / `synth questions` 默认 `train`；显式 `--split test` 在生产、质检和导出入口被拦截。`test` 材料交给 `eval make`。`dpo-pool` 使用 `dpo` 分区，运行导出策略的 `training_enabled=false`；`eval_enabled` 取决于 Skill 是否 ready。策略解析见 [plan.ts](../src/synth/plan.ts)。
- **正式训练导出**：默认汇总模式只选择训练导出策略允许的正式 run，并按 `train` 分区筛选；显式 run 选取时可加 `--split train` 固定范围。`--val-ratio` 按 `video_key` 分组，同一视频的全部分块落在训练或验证同侧。选取和投影规则见 [export-policy.ts](../src/synth/export-policy.ts)。
- **跨库导出守卫**：训练导出前只读读取评测库的 `source_materials.video_key` 和 `suite_items.video_key`，发现交集即中止导出，见 [eval-guard.ts](../src/synth/eval-guard.ts) 与 [workflows.ts](../src/synth/workflows.ts)。
- **同库别名拦截**：`eval make` 在打开可写评测库前校验物理身份；相同路径、规范化/相对别名、符号链接、硬链接、Windows 大小写别名指向同一文件时，报 `database_path_conflict`。低层导入和冻结也校验。实现见 [database-path.ts](../src/shared/database-path.ts)。
- **主库只读短快照**：导入先用一个短读事务复制分区、材料索引及必要正文，随后再做异步读取与模型工作；冻结把分区与训练问题放进同一个短快照，再复核 test 归属、材料 SHA-256 和训练题相似度。只读连接不 claim owner、不执行主库 legacy 表清理。见 [DataMakerStore](../src/synth/store/index.ts)、[source-import.ts](../src/eval/source-import.ts) 与 [suite-freeze.ts](../src/eval/suite-freeze.ts)。
- **单写会话与取消**：写入口先取得 `runtime_task_lock`，同库其他写任务报 `database_busy`；只读查询可并行。仅同主机旧 PID 明确不存在时接管；取消先停止派发并 drain 在途工作，随后写最终状态、释放 owner、关闭连接。`--allow-active-runs` 只放宽冻结的领域状态检查。完整规则见 [独立评测库文档](eval-probe-pipeline.md#写会话取消与恢复)。

独立 eval 的完整 writer 批次、稳定 plan/slot、每次执行关联及步骤检查点已落库。默认续跑最新 generation，显式 `--resume-build <originRunId>` 使用所选旧 generation 的持久化模型与提示词；`--rebuild` 创建新 generation。技术失败默认停止标定和冻结，`--allow-partial-build` 才允许完成子集并记录遗漏。相关规则见 [完整批次、步骤检查点与续跑](eval-probe-pipeline.md#完整批次步骤检查点与续跑)。

候选评测使用 immutable `evaluationSpec` v2：模型、endpoint、历史模式、系统提示词、采样、输出处理与有序套卷条目共同固定。`--resume-run` 的省略选项沿用原规格，显式冲突在 reopen 或远端调用前报错；缺失/损坏规格的 legacy run 保持只读，可通过同套卷的 `--parent-run` 建立独立新评测。数据库 Schema v4 与评测规格 v2 是两个不同的版本维度，详见 [不可变候选评测规格](eval-probe-pipeline.md#不可变候选评测规格与-legacy-只读)。

## 4. 当前操作入口

以下示例从仓库根目录执行。模型命令要求事先配置对应服务；run ID、套卷名与模型名按实际运行替换。

```powershell
# 只读查看登记分区与待同步进度
npm run dm -- synth status

# 由独立评测流水线从 test 材料造卷
npm run dm -- eval make --suite eval-v1 --limit 6 --export output/eval/eval-v1.jsonl --manifest-out output/eval/eval-v1.manifest.json

# 按本次执行关联抽检，包括复用的旧 probe
npm run dm -- eval inspect --execution-run latest --out output/eval/latest-execution.md

# 使用已配置候选模型盲测；默认 gold 历史
npm run dm -- eval evaluate --suite eval-v1 --candidate base --out output/eval/base.md

# 从独立 dpo 分区生产采题池
npm run dm -- synth run --preset dpo-pool --limit 15 --export output/dpo-pool.jsonl

# 正式训练导出并按视频切分内部验证集
npm run dm -- synth export --preset train-val --out output/train.jsonl --val-out output/val.jsonl --manifest output/train-manifest.json
```

已有 v3 评测库支持只读报告，写入前需停止旧写入口，再运行 `eval migrate --dry-run` 与带备份的显式 v3→v4 迁移。迁移保留历史业务记录和冻结套卷，不补造历史评测规格；迁移与回滚步骤见 [v3→v4 迁移与回滚](eval-probe-pipeline.md#v3v4-迁移与回滚)。v1/v2 库保留原文件并使用对应版本工具读取，本轮迁移器不覆盖这些版本。

## 5. 历史归档：主库 `test-v1`（已退役）

原方案在主库用独立 `rubric` 角色抽取每轮评分卡，将结果写入 `eval_rubrics` / `eval_model_calls`，再用 `test_set_versions` 冻结结果 ID 与 JSONL SHA-256。后来曾将主库 `test-v1` 镜像为独立评测的 `indist-v1`。这些设计解释了旧记录中的表名和版本名，但已不属于当前 CLI。

`test-freeze` 预设、`--extract-rubric`、`--freeze-version`、`synth export --version` 与 `eval mirror` 入口均已移除。本文不再将它们列为操作命令。当前评分卡在 `verifier` 的 `pass` 输出中产生，保存在评测库 `probe_turns.rubric_json`，冻结结果写入 `suite_versions` / `suite_items`；已合并的 5 类题型取代原 `adversarial` / `trap` 两套 profile。

主库以可写方式打开时，[LEGACY_DROP_SQL](../src/synth/store/schema-sql.ts) 清理旧评测表；只读打开不会执行此清理。历史数据库和旧导出产物应作为归档读取，当前 schema 不再提供旧表 SQL 或旧版本导出接口。

以下数字沿用本文原先记录的 **2026-11-24 历史快照**，本轮文档同步未读取生产库或导出产物核验，不代表当前库状态：

| 历史分区 | 总视频数 | 已处理视频 | 已入库问题 | 已通过样本 |
| --- | ---: | ---: | ---: | ---: |
| `train` | 1,367（含 29 个历史回填） | 29 | 166 | 163 |
| `test` | 174 | 6 | 38 | 38 |
| `dpo` | 159 | 0 | 0 | 0 |

旧 `test-v1` 记录为 Run #6 出题、Run #7 问答质检与 rubric，冻结 ID 1；38 个通过样本、71 个对话轮，评分卡覆盖 71 / 71。轮数分布为 1 轮 11 条、2 轮 21 条、3 轮 6 条。原记录的 JSONL SHA-256 为 `4774bbe995dd9c2cfa7af19e0c52f23ec8e7dee9604227d420425628dbe3a279`。该摘要仅用于辨认历史基线，不构成当前文件存在或可用旧命令复现的声明。

## 6. 当前只读分区审计 SQL

通过只读 SQLite 连接执行；只查询仍存在的分区注册表。评测库统计和冻结套卷列表使用 `eval suites`，逐题抽检使用 `eval inspect`。

```sql
SELECT split, method, COUNT(*) AS videos
FROM video_splits
GROUP BY split, method
ORDER BY split, method;

-- 以统一视频键检查多 P 分块归属
SELECT m.video_id, vs.video_key, vs.split, vs.method
FROM materials m
LEFT JOIN video_splits vs
  ON vs.video_key = CASE
    WHEN instr(m.video_id, '/P') > 0
      THEN substr(m.video_id, 1, instr(m.video_id, '/P') - 1)
    ELSE m.video_id
  END
ORDER BY m.video_id;
```

第二条 SQL 用于查看常见大写 `/P` 标识；代码中的 `extractVideoKey` 还支持小写 `/p`，需要完整一致的归一化时以代码函数为准。

## 7. 后续 DPO 演进

`dpo-pool` 的问答生产已实现。候选脱稿作答、错题挖掘、`chosen` / `rejected` 自动配对、长度比过滤和 DPO JSONL 导出仍是规划，不由该预设自动完成。后续实现应继续使用 `dpo` 材料，最终回到未参与训练的冻结 eval 套卷复检，保持 `test` 永久留出边界。
