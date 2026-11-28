# 0001. 使用统一 SQLite 作为唯一真相源，JSONL 仅作按需导出投影

我们将语料版本、视频分区、问题、运行批次、角色技能 SHA-256 快照、多轮对话轮次、返工尝试、角色调用记录与最终通过结果存入内置 `node:sqlite`，把训练 `.jsonl` 作为按需导出的投影。该决策统一的是持久化真相源和可追溯语义：主合成与 CoT 使用主库，独立评测使用物理隔离的评测库，数据库之间通过显式只读快照与领域接口传递证据。

若直接将流水线产出写入零散 JSONL 文件，一旦需要核查“某条样本是由哪一版 Skill 产出的”“哪些 `revise → pass` 返工对可以回收做 DPO”“某次中断后哪些题目需要增量重跑”或“如何从物理上阻止 `test`/`dpo` 分区视频混入训练集导出”，就必须编写脆弱的跨文件解析脚本且无法用数据库约束与触发器强制守卫。

## Consequences

- 数据库触发器与事务强制核心不变量：所有对话轮通过才能写入 `results`，已有结果引用的过程记录受防篡改约束，`video_splits` 登记后不可变。正式训练资格、分区检查、去重、视频级验证集切分与工具消息投影集中在纯 [export-policy.ts](../../src/synth/export-policy.ts)；repository 负责候选加载，领域策略负责是否以及如何导出。
- 同一物理数据库只允许一个 [TaskSession](../../src/shared/task-store.ts) writer。owner token 校验与写入共享同步短事务，网络和工具等待留在事务外；嵌套写入使用 savepoint，异步事务回调报 `async_transaction`。owner 没有 TTL，仅同主机旧 PID 明确消失时自动接管；取消后先等实际工作 drain，再写最终状态、释放 owner 和关闭连接。
- Store 的 `db` 是私有连接；业务模块通过 facade 动作和读快照访问。`synth status` 只读打开现有库，不建库、不恢复运行、不写分区；未登记分区只在统计中预测，并以 `pendingSplitSyncVideos` 显示待同步数。
- 工具运行事实与训练成品分开：`tool_attempt_audit` 持久化尝试、成功、失败、限额、取消及参数错误；`attempt_tool_steps` 保存成功 `ToolStep`，导出仅投影已通过回答对应的成功步骤。失败审计保持可追溯，也不会进入训练工具轨迹。
- 要求运行环境 Node.js `>= 22.19.0`（提供原生 `node:sqlite`），免除了 C++ 原生插件编译依赖。结构和字段见 [SQLite 统一存储设计](../sqlite-design.md)，模块及生命周期见 [架构概览](../architecture.md)。
