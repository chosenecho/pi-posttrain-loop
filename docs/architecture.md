# 当前模块架构与运行契约

本文描述 2026-11-28 修复后的实现。设计缘由见[修复方案](code-quality-remediation-plan.md)，本地测试与迁移演练证据见[验收记录](code-quality-remediation-validation.md)，日常操作与生产切换见[操作手册](production-workflow.md)。

运行基线为 TypeScript ESM、Node.js `>=22.19.0`、`node:sqlite` 与 Pi SDK `1.6.0`。研究文档中的 Pi `1.7.0` 工具 Schema 属于外部参考，不代表本项目依赖已升级。

## 1. 模块职责与依赖方向

| 模块 | 拥有的职责 | 对外边界 |
| --- | --- | --- |
| [CLI](../src/cli/index.ts) | 解析参数、选择命令、输出报告与退出码 | 委托领域工作流，省略的评测选项留给规格解析器决定 |
| [shared](../src/shared/types.ts) | 通用类型、模型适配、重试、并发、取消、写会话和工具协议 | 仓库内仅依赖 shared，不反向导入业务域 |
| [synth](../src/synth/workflows.ts) | 语料选择、分区、问题生成、多轮质检、工具训练与导出 | 通过主库 facade 读写；不导入 eval 实现 |
| [reasoning](../src/reasoning/workflows.ts) | 已通过问答的脱稿思考补写、盲审和导出 | 复用主库问答来源，过程记录由 reasoning store 管理；不导入 eval |
| [eval](../src/eval/workflows.ts) | 从主库只读导入 test 语料、造题、标定、冻结、候选盲测与比较 | 独立评测库；主库与评测库按物理文件身份隔离 |

[架构守卫](../test/architecture.test.ts)检查循环依赖、shared 叶子依赖、禁止反向依赖 CLI，以及 synth / reasoning 对 eval 的隔离。SQL 集中在各 store；协调层、只读跨库守卫与历史独立出题 helper 的例外在测试中逐项列出。

存储 facade 的数据库连接为私有成员。工作流通过业务方法表达状态变化，跨多条读取的一致性由短同步快照提供。事务期间不等待模型、网络、文件扫描或子进程。

## 2. 单库写会话与取消收尾

[TaskSession](../src/shared/task-store.ts)在业务 DDL、遗留恢复和写入之前取得所有权，协调信息保存在同一 SQLite 文件的 `runtime_task_lock`。主库上的 synth 与 cot 共用同一写入口；独立评测库可以同时执行自己的任务。

所有权包含随机 token、主机名、PID、任务类型和取得时间，始终不按时间过期。本地主机同 PID 仍存在、探测结果不确定或记录来自其他主机时，争用返回 `database_busy`；仅确定本地旧 PID 已消失才接管。旧版本程序不遵守该协议，生产切换须先停止旧 writer。

`mutate()`将 owner 校验和业务变更放入同一 `BEGIN IMMEDIATE` 事务，嵌套操作使用 savepoint。异步事务回调与 Promise 返回值报 `async_transaction`；owner 已改变则报 `database_owner_lost`。遗留恢复仅处理旧 owner 或历史空 owner 的工作，保留当前 owner 的状态。

取消按以下次序收尾：

1. 用户信号、超时或任务级错误停止新分派，通知 worker、重试等待、warmup、Agent、工具、simulator 和适配器。
2. 等待已经开始的工作、HTTP 请求及响应、串行队列和子进程实际结束；Pi Agent 执行 `abort()` 后仍须等待 `waitForIdle()`。
3. 保存调用审计及领域中断状态，随后释放写会话并关闭连接。

[并发池](../src/shared/concurrency.ts)保留首个任务级错误，通知其他 worker 取消，并在全部 worker settle 后返回；题目局部错误由领域 worker 自行记录。[取消模块](../src/shared/cancellation.ts)区分任务取消、单次超时和适配器清理失败。

自定义 runner / 工具须合作响应取消。忽略 signal 的工作会使收尾继续等待，期间保留 owner 和数据库连接；调用方超时并不证明远端服务已停止计算。

## 3. 合成计划、profile 与工具装配

[plan](../src/synth/plan.ts)先解析默认值、校验分区并加载提示词 / Skill，再复制和冻结执行配置；完成这些步骤后才打开写库或构造 runner。出题、批处理和增量质检遵循同一预解析原则。

[profiles](../src/synth/profiles.ts)集中提供 Skill 路径、轮数、题量上限、求解范式、工具要求和导出标签；[presets](../src/synth/presets.ts)从描述符生成命令预设。

| profile | 默认最多对话轮 | 固定题量上限 | 求解范式 | 常规配置下的工具策略 |
| --- | --- | --- | --- | --- |
| standard | 3 | 无固定值，按材料计算 | direct | 默认不启用检索 |
| short / medium | 2 | 无固定值，按材料计算 | direct | 默认按需检索 |
| long / xlong | 3 | 无固定值，按材料计算 | direct | 默认按需检索 |
| trap | 2 | 2 | direct | 默认按需检索 |
| search | 2 | 2 | direct | 必须启用检索能力 |
| todo | 2 | 2 | todo_plan | todo + 默认按需检索 |
| clarify | 2 | 2 | clarify_question | question / questionnaire + 默认按需检索 |

表中的题量是上限，允许生成更少或零题；CLI 显式参数可覆盖轮数和题量。`suite` 默认运行 `short,medium,long,xlong,trap,search,todo,clarify` 八种 profile；`standard` 保留为兼容入口。仓库共 44 份就绪 Skill：合成 36 份、reasoning 2 份、eval 6 份。

默认检索还受 `noSkill`、judge 自定义提示词 / Skill 和显式 runner 注入影响；这些情况由计划解析器决定。`--no-search` 可关闭可选检索，`search` profile 始终要求检索能力；`todo` / `clarify` 的领域工具仍按任务要求装配。

[runners](../src/synth/runners.ts)只绑定已经解析的计划与显式注入的 runner。[synth 工具 runner](../src/synth/tool-runner.ts)根据 profile 和问题范式装配工具与用户模拟器，在请求发给回答模型前剥离 `_questionMode` / `_taskSpec`；隐藏用户画像与缺失槽位仅传给相应模拟器，评审可见自己的任务基准。

[通用 Pi runner](../src/shared/pi-runner.ts)负责 Agent、调用生命周期、工具扩展接口和审计，不了解训练 profile 或问题隐藏设定。内置工具在开始异步工作前同步预占额度，失败、取消及缓存命中不返还额度；`question` 与 `questionnaire` 共用同一份澄清预算。

[工具审计库](../src/synth/store/tool-audit-repo.ts)使用 `modelCallId + attemptId(UUID) + batchId + toolCallId` 区分尝试与并行批次，保存 `attempted`、`succeeded`、`failed`、`cancelled` 等状态。成功工具步骤的训练投影独立保存在 `attempt_tool_steps`，失败过程不会作为成功训练轨迹导出。

[纯导出策略](../src/synth/export-policy.ts)拥有正式运行筛选、结果投影、工具 Schema 泛化、随机种子、同题去重和视频级验证集切分。store 提供数据与执行查询；工作流负责跨库防泄漏检查和输出文件。

## 4. 评测造题计划与不可变规格

新建评测库使用 Schema v4。已有 v3 库可只读查询，写入前须显式迁移；迁移行为与回退条件见[存储设计](eval-probe-pipeline.md)及[操作手册](production-workflow.md)。

[计划表](../src/eval/store/build-plan-schema.ts)分别保存：

- `probe_build_plans`：一份材料某代完整批次、来源摘要、生成规格与 writer 调用身份。
- `probe_build_slots`：候选题的固定身份、原始 draft、下一阶段输入、检查点和已消耗预算。
- `probe_build_executions`：本次 run 与计划的执行关联，区别于考题最初创建 run。

完整 writer 批次先提交，再处理首题；合法空批次记为 skipped。已通过轮次和业务检查点一起提交，恢复继续累计预算；本地提交前已完成的远端请求仍可能重试。

默认续跑处理最新 generation 的未完成工作。`--resume-build <originRunId>`使用原计划快照及实际出题模型；`--rebuild`另建 generation。缺少完整历史提示词 / Skill 正文时报 `build_snapshot_missing`，不会用当前默认值补齐。部分构建默认退出 1 并跳过自动标定 / 冻结；显式 `--allow-partial-build`才处理完整 accepted 子集并在 manifest 记录遗漏计划。

[Evaluation Spec v2](../src/eval/evaluation-spec.ts)保存在 `eval_runs.config.evaluationSpec`，固定套卷与内容摘要、有序条目 ID、候选模型及服务地址、历史模式、系统提示词、采样参数、think 标签处理与适配器契约版本，并对语义字段计算 hash。候选请求和后续批卷均校验该规格；并发、传输重试和凭据属于本次执行设置。

显式续跑参数与规格冲突会在恢复或 HTTP 请求之前失败。历史规格缺失、损坏、条目不完整或跨套卷时禁止续写；缺少完整规格的历史仍可报告，可用 `--parent-run`新建有关联的评测。详情与命令示例见[评测流水线](eval-probe-pipeline.md)。

[物理路径守卫](../src/shared/database-path.ts)结合规范路径、真实路径、文件设备 / inode 与 Windows 大小写规则，拦截主库与评测库的同文件别名。导入和冻结从主库取得短只读一致快照，不把跨库操作描述为原子事务。

## 5. 只读入口与验证入口

`synth status`使用只读 store：数据库不存在时不创建文件，现有库不写分区或恢复状态。`pendingSplitSyncVideos`报告尚未持久化的分区归属数量；状态中的预测分区计数须在下一次生成 / 同步写入后才成为持久记录。导出和报告等读取入口也不承担孤儿恢复。

运行 `npm run check`依次执行类型检查、TypeScript 测试与两组 Python unittest。架构边界、写会话、造题恢复、实际 HTTP 规格一致性、工具生命周期和导出 oracle 都有回归入口，具体测试链接及本地结果见[验收记录](code-quality-remediation-validation.md)。

[CI](../.github/workflows/check.yml)配置 Ubuntu / Windows、Node 22.19.0 / 24.x 与 Python 3.12 矩阵。配置已经加入工作区，远端执行结果仍待确认；生产迁移和真实数据恢复也未包含在本地验收中。
