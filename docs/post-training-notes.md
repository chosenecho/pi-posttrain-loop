# 后训练数据与 DPO 推进备忘

本文同步至 2026-11-28 的实现。生产入口见[操作手册](production-workflow.md)，模块与执行约束见[当前架构](architecture.md)，评测制作与盲测见[独立评测流水线](eval-probe-pipeline.md)。SFT 数据制作、CoT 补写与独立评测已落地；候选模型训练和 On-policy DPO 配对仍由外部训练流程推进。

## 1. 三分区与历史数据口径

视频按 `video_key`永久归属 `train` / `test` / `dpo`，同视频多 P 与材料版本共享用途边界。历史已生产视频回填为 `train`，其余使用带固定盐的 SHA-256 分桶；增加语料不重排既有视频。

此前记录的 1,700 个视频、29 个历史回填，以及 train 1,367 / test 174 / dpo 159，属于历史生产快照。本次修复没有重查真实语料或生产数据库；当前规模以 `synth status`为准。该命令只读，未持久化的分区归属以 `pendingSplitSyncVideos`报告。

主库保存训练和 DPO 采题过程；test 材料只通过只读快照进入独立评测库。主库旧 `eval_rubrics`、`test_set_versions`与 `test-v1`链路已经退役，当前不再提供 `test-freeze`、`--extract-rubric`、`--freeze-version`或按主库 `--version`导出盲测集的命令。

```powershell
# 训练样本、按需检索、规划和反问澄清
npm run dm -- synth run --preset train-short --limit 20
npm run dm -- synth run --preset train-todo --limit 5
npm run dm -- synth run --preset train-clarify --limit 5

# suite 默认运行八种 profile，可选择子集
npm run dm -- synth suite --profiles short,medium,long,xlong,trap,search,todo,clarify --limit 5

# 独立评测库造题、标定与冻结（现有 v3 库须先显式迁移）
npm run dm -- eval make --suite eval-v1 --limit 10 --export output/eval/eval-v1.jsonl --manifest-out output/eval/eval-v1.manifest.json

# 预留给后续偏好配对的 DPO 采题池
npm run dm -- synth run --preset dpo-pool --limit 15 --export output/dpo-pool.jsonl
```

套卷名由操作者指定，文中的 `eval-v1`是示例，不代表已经生成的生产资产。test 始终用于盲测验收，DPO 候选题及其负样本采样不回流到 test。

## 2. 已落地的数据制作机制

1. **多 P 合并与按视频选择**：中小系列合并为材料，超长系列按分 P 边界切块；一个视频被选中后保留其完整材料范围。`core-first`优先理论内容较多的视频。
2. **九种合成 profile**：`standard`、`short`、`medium`、`long`、`xlong`、`trap`、`search`、`todo`、`clarify`。`standard` / `long` / `xlong`默认最多 3 轮，其余最多 2 轮；`trap` / `search` / `todo` / `clarify`默认最多 2 题，其余按材料计算上限，允许零题。`suite`默认运行除兼容入口 `standard`外的八种 profile。
3. **工具求解范式**：问题保存 `direct`、`todo_plan`或 `clarify_question`及任务设定；规划与澄清工具由领域 runner 装配。隐藏画像不发送给回答模型；反问由持有对应设定的用户模拟器响应。检索默认策略和例外见[架构说明](architecture.md)。
4. **重试与取消**：单次调用默认最多尝试 3 次、间隔 3000ms；并发支持 1–500。题目局部失败保留记录，取消与适配器清理失败走任务级收尾。写会话保持到已启动工作实际结束；失败工具审计与成功训练步骤分开保存。
5. **脱稿 CoT 补写**：以通过质检的问答和必要工具轨迹为输入，writer / judge 均不接触原始材料；可按全部九种来源 profile、长度档位与轮次筛选。当前硬上限默认 `maxChars=1500`、`maxVerbatimRun=36`，操作侧可通过 `--max-chars` / `--max-verbatim-run`收紧。
6. **可复现导出与发布**：支持同题版本去重、工具 Schema 泛化、固定随机种子和视频级验证集切分。CoT 默认 inline `<think>`及按轮展开；`reasoning_content`供兼容模板使用。ModelScope prepare / upload 的数据校验、发布清单和人工审阅流程见[操作手册](production-workflow.md)。

## 3. 后训练路线与尚待完成的 DPO 闭环

### 阶段 1：SFT 与脱稿盲测

使用 train 分区制作不同篇幅、陷阱识别和工具交互样本，再按需补写 CoT；训练交给外部框架。保留主库过程记录及 `revise → pass`尝试，作为后续偏好分析来源。训练配方可混入通用对话与工具回放，比例由实际回归确定。

训练后在已经冻结的 suite 上比较 base 与 sft-v1。候选评测规格固定所用套卷、模型、提示词、采样、历史模式与选题顺序，续跑继续同一条件。更换配置应新建评测，历史关联可用 `--parent-run`记录。

### 阶段 2：On-policy DPO 配对

使用 dpo 分区的题目和强模型通过回答作为候选 chosen，让 SFT 模型无原稿作答并收集实际错误作为 rejected。当前 `dpo-pool`只提供采题与标准回答；主库已经停止自动提炼 `eval_rubrics`，DPO 专用评分卡、候选裸答采样、批卷和配对导出尚未形成独立命令闭环。

后续实现应记录 chosen / rejected 的模型版本和采样条件，对照立场、必答点、防幻觉边界与行为要求筛选；答对的样本只计通过率，避免硬造负例。还需处理篇幅悬殊、重复问题及同源视频泄漏，再由外部框架训练，最后回到从未参与训练的 test suite 复测。

### 阶段 3：按实测决定 CPT / RAG

原始转写稿仍含口癖与 ASR 噪声。仅在 SFT + DPO 后，核心观点或冷门概念的记忆缺口仍持续出现时，再比较 RAG 与轻量 CPT；语料清洗、混合比例和训练参数属于后续实验设计。
