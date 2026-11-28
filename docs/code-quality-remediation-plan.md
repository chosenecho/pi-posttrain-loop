# data-maker 代码质量修复与模块整理方案

> 状态：F1–F5 修复、G 模块整理及 H 本地交付验证已完成。2026-11-28 的完整检查与临时库迁移 / 恢复演练见[验收记录](<../docs/code-quality-remediation-validation.md>)。生产库迁移与远端 CI 尚未执行；切换条件见操作手册。本文主体保留实施前的设计依据，接口命名与模块职责以[当前架构](architecture.md)、验收记录及源码为准。
>
> 基线：`d2038d150921bc380048de4a82c00bae2ecd1f2b`；编写日期：2026-11-28。对象为当前本地 SQLite 数据生产工具。

## 1. 目标与实施边界

优先修复五项已复现的问题，再逐步收紧存储与编排接口。继续使用 TypeScript、Pi SDK、SQLite，以及 synth / reasoning / eval 的业务域划分。

完成后应满足：

1. 同一物理数据库同一时刻只有一个写任务；新任务不会修改活跃任务的状态。
2. 评测造题可以从已持久化的步骤继续，保留通过的题目、轮次与标定结果。
3. 评测续跑的真实请求、运行记录和报告使用同一份不可变执行规格。
4. 并行工具调用严格受预算约束；内置执行链可响应超时和任务取消。
5. 状态迁移由存储模块承担，工作流主要表达执行顺序；现有导出行为有回归保护。

本次修复按“本机、每库单写任务”设计。不同数据库可以并行；同一任务内部仍可并发调用模型。数据库独占不等于模型串行，也不需要在网络等待期间持有 SQLite 写事务。

跨主库与评测库继续使用各自连接。单库事务不提供跨库原子提交。主库分区、题目快照与冻结校验沿用现有业务约束；需要跨库持续互斥时，应另设设计任务。

## 2. 已确认问题与修复工作包

| 编号 | 优先级 | 当前问题 | 修复结果 |
| --- | --- | --- | --- |
| F1 | P1 | 全局恢复把活跃任务标成中断，间接解除冻结守卫 | 同库独占写会话；取得所有权后只恢复遗留任务 |
| F2 | P1 | 存在任意 probe 就排除材料，draft 失败后退出默认续跑 | 完整计划先落库；按 slot 的阶段和检查点续跑 |
| F3 | P1 | 续跑记录旧模型，runner 实际使用本次模型和参数 | 先解析不可变规格，再创建 runner，再改变运行状态 |
| F4 | P2 | 并发调用在计数更新前同时通过预算检查 | 首次 await 前预占；共享澄清预算；调用按 ID 追踪 |
| F5 | P2 | deadline 只约束模型流，工具和排队可能继续等待 | signal 贯穿 Agent、工具、子进程、重试和并发池 |
| D1 | 结构 | Store 暴露底层连接、Repository 和大量转发方法 | 以完整业务行为组织写接口，减少并行访问通道 |
| D2 | 结构 | 编排、导出和 profile 策略分散且交织 | 解析计划、业务执行、纯格式策略各有明确入口 |
| Q1 | 保障 | 失败组合场景不足，Python 测试未纳入 check | 建立故障注入矩阵，统一完整检查入口 |

原始证据见 [代码质量评估](<../.archify/code-quality-20261128-1526/review.md>)。现有基线检查为：145 项 TypeScript 测试通过；Python 41 项通过、1 项跳过。新增测试的验收以行为覆盖为准，不以凑测试数量为目标。

## 3. F1：建立同库独占写会话

### 3.1 推荐设计

新增通用的 `TaskSession` 模块，负责本地进程所有权、短事务、任务取消与收尾顺序。每个物理库只允许一个会话写入，所有业务 run 都归属该会话。

数据库增加协调表 `runtime_task_lock`，保存单例记录：

| 字段 | 含义 |
| --- | --- |
| `lock_key` | 固定值 `writer`，主键 |
| `owner_token` | 每个会话随机生成的不可复用标识 |
| `hostname` / `pid` | 当前持有者的主机和进程 |
| `task_kind` | synth / reasoning / eval 及具体入口 |
| `acquired_at` | 取得所有权的时间 |
| `last_seen_at` | 可选诊断信息，不作为自动抢占依据 |

使用数据库内单例行，可让 synth 和 reasoning 在写同一个主库时共享互斥规则。所有权持续跨越网络调用，但 SQLite 事务只覆盖同步数据库操作。

采用保守接管规则：

- 没有 owner：在短事务内创建本次 owner。
- owner 属于本机，且进程探测明确返回不存在：在短事务内比较并交换旧 token，接管。
- owner 的 PID 仍存活、权限不足、主机不匹配或结果不确定：返回 `database_busy`，显示任务类型、PID 和启动时间。
- 不按心跳超时自动抢占；事件循环阻塞、休眠或长模型调用不代表原进程已退出。
- PID 重用按“仍存活”保守处理。需要人工处理时先结束对应进程，维护工具再次确认原 token 与进程状态。

该规则适用于当前本机工具。共享网络盘、多主机租约与自动故障转移不纳入本轮实现。

### 3.2 接口与所有权校验

以下接口为拟新增设计，名称可在实现时按仓库习惯微调，行为必须保留：

```ts
interface TaskSession {
  readonly ownerToken: string;
  readonly signal: AbortSignal;
  mutate<T>(operation: () => T): T;
}

async function withWriteTask<T>(
  databasePath: string,
  taskKind: string,
  run: (context: { session: TaskSession; store: DomainWriteStore }) => Promise<T>,
): Promise<T>;
```

`mutate` 必须在同一连接、同一个短 `BEGIN IMMEDIATE` 内验证 owner 并提交业务更新。它只接受同步操作；运行时检测返回 Promise / thenable，并回滚。已有嵌套事务采用 SAVEPOINT 或复用当前事务，避免重复 BEGIN。

对外写接口由持有 session 的 store 提供。读取接口可使用独立只读连接。先实现所有权保护，再逐步关闭公开 `db` 和 Repository 通道，避免过渡期存在遗漏的写入口。

### 3.3 初始化与执行顺序

当前几个 store 的构造函数会执行 DDL，因此会话必须前移到构造之前。推荐顺序：

1. 打开原始连接，仅配置连接级 `busy_timeout`、外键等非持久化选项。
2. 在短协调事务内创建或读取最小协调表，检查 owner 并取得 token。争用失败则回滚并关闭连接。
3. 持有 token 后执行业务 schema 初始化或迁移；业务 DDL 不在未获所有权时执行。
4. 设置需要的持久化 PRAGMA，初始化领域 store。
5. 先校验本次任务的业务输入和旧运行规格，构造并验证对应 adapter 身份；校验通过后，此次会话只恢复一次遗留 running 记录，再创建或 reopen run。规格冲突时不提前改变待验证旧 run 的状态。
6. 运行各阶段；网络 await 位于数据库事务外。
7. 停止派发新工作，取消或等待在途任务，提交最终状态。
8. 按 token 条件释放 owner，关闭连接。

全新评测库仅存在协调表时，应仍被识别为“未初始化业务库”。版本检测需要排除协调表，避免误判为没有 `eval_meta` 的旧库。

协调 SQL 集中在一个小型共享存储模块，如 `shared/task-store.ts`；session 负责生命周期，领域 store 负责业务恢复。同步更新 SQL 集中度架构测试，只为这个明确路径增加技术协调表的白名单，不放开整个 shared 层任意使用 SQL。

### 3.4 删除嵌套恢复，覆盖全部写入口

同一个工作流只取得一次会话、执行一次恢复。内层引擎接收 session / scoped store，移除自行调用 `markInterruptedRuns()` 或 `recoverInterruptedRuns()` 的逻辑。

覆盖范围包括：

- synth：批量生成、独立出题、judge、demo、分区同步及其他数据库写入。
- reasoning：补写及任何会改变 trace / review 状态的入口，与 synth 共用主库 owner。
- eval：make 的导入→出题→标定→冻结全程共用会话；evaluate 的作答→批卷共用会话。
- 管理脚本、导入和迁移脚本：使用同一写会话协议。

需要特别处理 [getSynthStatus](<../src/synth/workflows.ts>)：目前它会同步分区，属于写入口。先按写入口接入会话，保持既有行为；随后在 D2 中拆成真正的只读状态查询与显式同步动作。

现有遗留记录没有 owner 时，首次升级在停掉全部旧写进程后，将其归为 legacy orphan。新记录保存 `owner_token`，恢复更新需限定旧 owner 或 legacy orphan，并覆盖该 owner 未结束的调用和子记录。领域之间各自恢复自己的表，协调模块不硬编码 synth / eval SQL。

### 3.5 冻结与跨库边界

`--allow-active-runs` 保留原有领域检查 override，但始终先取得本库写会话。它不绕过进程互斥，也不触发额外恢复。

冻结只选择完整、accepted 的题目。选择、完整性校验与写入 suite 在同一个同步短事务中完成。标准 make 工作流顺序等待 build 和 calibrate 完成后再冻结。

评测写会话不锁住主库。读取主库时使用一致的短只读快照，冻结前复核来源分区，并记录实际校验的来源标识。校验主库与评测库为不同物理文件，处理规范路径和现有文件别名。这里不承诺复核之后主库永远保持同一状态。

### 3.6 F1 验收

- 两个进程争同一库，只有一个进入业务执行；另一个零模型调用、零业务 DDL。
- 原任务停在 HTTP / 工具等待时，第二个任务返回 busy；只读查询仍可使用。
- 原任务被结束后，新任务接管并且只恢复原 owner 的遗留记录。
- 主机未知、进程探测权限不足、PID 仍存活时不自动接管。
- make 内 build / calibrate / freeze 不互相标中断；evaluate / grade 同理。
- owner 校验与写入之间不存在独立的时间窗口。
- 仍在运行的造题任务不会因为另一个入口启动而失去冻结保护。

## 4. F2：持久化造题计划与步骤检查点

### 4.1 将计划、执行记录和题目身份分开

每次 make 创建一条执行 `probe_run`，保留本次执行的时间和统计。计划具有稳定身份，续跑继续使用已有 plan、slot 和 probe ID；`probes.run_id` 保留最初创建它的 run，不迁移或复制有效题目。

推荐新增两张核心表和一张执行关联表：

| 表 | 核心字段 | 不变量 |
| --- | --- | --- |
| `probe_build_plans` | `id`、`source_material_id`、`generation`、`origin_run_id`、`last_execution_run_id`、`source_sha256`、`spec_json`、`spec_hash`、`writer_call_id`、`status`、`planned_count`、`plan_complete`、`skip_reason`、`error_code`、时间戳 | 同一 source + generation 唯一；ready 后原始计划不变 |
| `probe_build_slots` | `id`、`plan_id`、`slot_index`、`probe_id`、`draft_json`、`status`、`stage`、`checkpoint_version`、`checkpoint_json`、`last_execution_run_id`、`error_code`、时间戳 | `(plan_id, slot_index)` 唯一；`probe_id` 可空，非空时唯一且有外键 |
| `probe_build_executions` | `execution_run_id`、`plan_id`、执行统计和开始 / 结束时间 | `(execution_run_id, plan_id)` 唯一；复用、跳过和零 HTTP 执行也可追溯 |

`spec_json` 保存该计划采用的模型、题型、回合和次数预算、提示词、Skill 快照及版本。hash 只包含生成语义和 source hash；路径、并发、重试延时等执行选项单独存储。凭据仅在运行时读取。默认续跑遇到配置不同的未完成计划时，报告 `build_config_conflict`，不要悄悄改用当前配置。

新增拟议参数 `eval make --resume-build <originRunId>`，显式使用旧计划规格；旧提示词或 Skill 正文缺失时报告 `build_snapshot_missing`，不静默混入当前正文。`--rebuild` 创建新 generation，保留旧 generation 的题目与审计记录。默认选择应基于最新有效 generation 的未完成工作，避免已被明确 superseded 的旧失败计划永久重新入队。

每次恢复调用的 `agent_calls.run_ref` 关联本次执行 run，同时在 `input_refs` 记录 plan / slot / stage / turn / attempt。`probe_build_executions` 保存显式关联，避免仅从调用日志反推；复用终态或完成收尾时也建立关联。

已有 probe 的 `run_id` 保留实际创建者；从旧完整计划补出的缺失 probe 记入本次创建 run，并绑定原 slot。同一执行对同一 source 只推进一个 generation，以兼容现有 `(run_id, source_material_id, slot_index)` 唯一约束。

新增 `--execution-run <id|latest>` 按执行关联查看本次处理的所有计划和题目；`--run <id>` 保留按题目创建者过滤。`--run latest` 延续最新执行 run 的解析方式，但纯续跑 run 的显示必须明确提示，并引导使用 execution 过滤；不得静默变更成另一个 run。make 的标定和冻结通过本次执行关联的 plan / probe 集合选题，不再只传当前 run ID，否则旧 probe 会漏出本次套卷。suite manifest 同时记录实际 probe、plan 与执行来源。

摘要区分 `newProbes`、`resumedSlots`、`newlyCompleted`、`reusedTerminal`、`pendingSlots`、`errorSlots`。本次执行已结束与所有计划已完成是两个独立字段。

### 4.2 状态机

计划状态：

```text
pending -> planning -> ready -> done
               |        |
               v        v
           retryable <- 发生技术错误

planning -> skipped  （writer 返回有效空计划，保存 skip_reason）
```

`retryable` 保存返回目标阶段。owner 消失后，把该 owner 的 planning / running 工作恢复到 retryable。

slot 状态：

```text
pending -> running -> accepted
              |  -> rejected
              |  -> dropped
              v
          retryable -> running
```

accepted / rejected / dropped 是业务终态。rejected 和 dropped 不因为默认续跑而重新出题。技术错误、取消或进程中断保留为可恢复工作。

当全部 slot 都进入业务终态，计划转为 done。存在 retryable 工作时，本次执行 run 标为 failed，并报告 `partial=true`、pending / retryable 数；计划本身仍可恢复。零题有效计划进入 skipped，后续默认 make 不重复调用 writer。

make 默认在存在技术失败或不完整 legacy 计划时停止自动冻结，返回非零状态并列出待恢复项。若产品需要冻结已完成子集，可增加显式 `--allow-partial-build`，suite manifest 必须记录遗漏原因与数量。该选项只接受已完整 accepted 的题，不绕过 owner、来源分区、相似度和冻结不变量；与 `--allow-active-runs` 分开处理。

### 4.3 先保存完整批次，再处理第一题

当前 writer 返回多个 draft 后逐个创建 probe，进程可能在第一题处理时退出，剩余计划没有落库。

修复顺序：

1. 调用 writer 之前保存 plan、调用记录与 planning 状态。
2. 对返回批次完成结构、数量与业务字段校验。
3. 一次短事务提交调用成功结果、完整 draft 列表、全部 slot 及初始 probe 记录。
4. 提交完成后才执行第一个 critic。
5. 空批次也在同一规则下保存 skipped 和原因。

`maxProbes` 是上限，实际计划长度取 writer 校验后的返回长度。不得用上限补造不存在的 slot。

### 4.4 检查点内容与续跑粒度

检查点记录下一步的实际输入所需信息：

- critic：已完成 round、审查结果、反馈、revision 次数、下一步是改写还是复审。
- adversary：当前 turn、已选 tactic、生成的问题、trap、对应 call ID。
- reference：当前 attempt、已生成答案、前次失败反馈、对应 call ID。
- verifier：核验结果、rubric、剩余 attempt、下一阶段。
- 已通过轮次：从 `probe_turns` 的合法连续前缀重建 history 与 usedTactics。

每次远端调用分成两次短事务：调用前保存 startCall 与阶段；返回后，finishCall 与业务检查点一起提交。原始返回已提交但后续解析未完成时，优先复用保存的返回，避免重新请求。

成功轮次、检查点推进和最终 accepted 状态必须原子提交。恢复时不覆盖通过轮次；如果发现轮次断档、规格 hash 不一致或检查点损坏，应报 `checkpoint_invalid` 并保留原记录供检查。

revision、answer attempt 等业务预算跨续跑累计。传输层重试仍单独计数，避免重启一次就重置业务失败预算。

远端已完成但本地尚未提交时，重启可能重试该次调用。此方案保证本地 slot / 轮次幂等，不承诺远端 exactly-once。

### 4.5 旧数据迁移

按旧 `(run_id, source_material_id)` 建立 legacy plan：

- accepted / rejected / dropped 导入对应终态 slot，保留 probe ID、轮次、reviews、标定结果。
- draft 从已保存 reviews、revisions 和连续轮次恢复检查点，不清空已完成内容。
- 如能按旧 runRef、source ID、`mode=draft` 唯一定位成功 writer 输出，重新严格校验该批次，恢复完整 slots；已存在 slot 与计划需逐项核对。
- 缺少可信原始批次时，设置 `plan_complete=false`，只恢复已知 draft。报告 `legacy_plan_incomplete`，不猜未落库题数，也不把材料伪装成完整处理。
- 已知终态题全部完成但计划完整性未知时，状态单列在报告中；通过显式 rebuild 创建新 generation 补计划，旧 accepted 题继续保留。

### 4.6 F2 验收

覆盖 writer 后、critic 后、revision 后、adversary 后、reference 后、verifier 后、通过轮次提交后这几个故障点。分别模拟异常和进程退出，重跑后检查：

- 整批 slots 不丢失、不重复创建。
- accepted / rejected / dropped 不重新执行。
- 已通过轮次及标定不变，history 和 tactic 从保存结果恢复。
- reference 已提交、verifier 未执行时复用该答案。
- 业务次数预算不因重启重置。
- 空计划只调用一次 writer。
- 旧库混合 accepted + draft 时只补 draft；原计划缺失得到明确报告。

## 5. F3：使用不可变评测执行规格

### 5.1 将规格解析前移

当前顺序是先构造 candidate runner，再读取旧 run。修复为：

```text
原始 CLI / workflow 选项
  -> 打开写会话、加载 suite / 旧 run
  -> 解析并校验 ResolvedEvaluationSpec
  -> 从规格创建 candidate adapter
  -> 校验 adapter 的规格身份
  -> 创建或 reopen run
  -> 按同一规格请求、记录、批卷与报告
```

对旧 run 配置冲突的处理必须发生在 reopen 和任何远端调用之前。规格校验失败可以记录独立诊断，但不改变旧 run 的业务状态。

### 5.2 规格字段

拟新增 `ResolvedEvaluationSpec`：

```ts
interface ResolvedEvaluationSpec {
  readonly version: 2;
  readonly hash: string;
  readonly suiteId: number;
  readonly suiteSha256: string;
  readonly itemIds: readonly number[];
  readonly candidate: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly historyMode: 'gold' | 'self';
  readonly systemPrompt: string | null;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly stripThinkTags: boolean;
  readonly adapterContractVersion: string;
}
```

存储实际有序 item ID 列表，使 limit 与选择顺序成为规格的一部分。`hash` 使用稳定键序列化，对上述字段计算 SHA-256；排除 hash 本身、时间戳与凭据。

endpoint 复用现有规范化规则，包含 API 根路径；现有规则已禁止 URL 中的认证、query 和 fragment。保留当前凭据与 API 根路径绑定的行为。

下列参数可在续跑时变化，但每次执行记录实际值：timeout、并发、传输重试次数和延时、输出路径、同 endpoint 的轮换凭据。它们归入 operational config，不与不可变规格混存，也不把凭据写入数据库。

### 5.3 默认值与三态

续跑未指定字段时，取旧规格；显式指定且不同则报 `resume_config_conflict`。只有新 run 才应用默认值和环境回退。

保留以下区别：

- `undefined`：未指定，续跑沿用旧值。
- `null`：显式禁用系统提示词。
- 具体值：显式覆盖，必须与旧规格一致。

修正工作流提前将 historyMode 默认成 gold 的行为。旧 self run 在省略 `--history-mode` 时应正常续跑。温度、maxTokens 同样不得将本次环境默认误判为用户覆盖。

### 5.4 runner 工厂与注入接口

拟将裸 `runCandidate` 注入改为规格工厂：

```ts
type CandidateFactory = (
  spec: ResolvedEvaluationSpec,
  runtime: CandidateOperationalConfig,
) => {
  readonly specHash: string;
  run(request: {
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): Promise<string>;
};
```

实际 HTTP body、调用日志和 summary 全部读取 spec。去掉逐次请求再接收不同 model / sampling 配置的通道。生产适配器由工厂创建；测试适配器也接收规格并返回对应 hash。

旧测试的裸 runner 可用显式 `bindCandidate(spec, runner)` 过渡。身份 hash 是内部契约校验，不是对任意第三方实现的执行证明；真实 HTTP fixture 仍需核对请求体。

### 5.5 legacy run 与报告

现有 run 未保存 endpoint，温度与 maxTokens 可能只有显式项。迁移不会从当前环境补出虚构的历史值。

- 历史证据足以完整还原：生成规格 v2，并注明证据来源。
- 规格不完整：legacy 原 run 只允许查询与报告，不执行 reopen、补写 / 覆盖 prediction、grade / regrade 或业务状态变更。仅允许迁移审计元数据；通用恢复流程也排除它。
- 继续评测时，使用新配置创建关联新 run，记录 `parent_run_id`；不自动把旧 predictions 计入新 run 分数。
- 若后续提供人工补全入口，补全结果落入关联新 run，标 `assumed` 及来源，并在报告中展示。只有可信历史证据完整还原并迁为 verified v2 的旧 run，才可按正常规则续跑。
- 无法从历史请求验证模型身份的旧记录标记为 `legacy_unverified`，保留原值，不根据本次环境批量改名。

同模型裁判检查使用 spec 的模型身份，并保留现有显式 override。规格相同也不保证模型服务端版本永远不变；报告应显示执行时间、模型名和规格 hash，服务方有可用 revision 时再纳入规格。

### 5.6 F3 验收

- 原规格模型 A，本次环境默认 B，省略覆盖参数续跑：真实请求仍为 A 和原采样参数。
- 显式冲突：零远端调用，旧 run 状态不变。
- self 模式省略参数正常续跑；系统提示词三态分别覆盖。
- item 列表、suite hash、endpoint、输出处理规则变化均识别为规格冲突。
- 轮换凭据、调整并发或重试策略不改变 spec hash；实际 operational config 单独记录。
- legacy 缺项不被当前默认补齐，不同模型预测不混入一个可验证 run。

## 6. F4：并发前预占工具预算，按调用身份记录

### 6.1 预算语义

每次 answer attempt 新建 search、todo 和 clarify 三类预算。`question` 与 `questionnaire` 共用 clarify；不同 attempt 的预算独立，摘要显示累计调用量。

参数同步校验后、第一个 await 前执行 `claim(toolCallId)`。额度一次授予后不退还：成功、失败、取消和 cache 命中均消耗一次工具调用额度。这样重试与失败不产生免费调用窗口。

调用开始时先检查 already-aborted，已取消请求不 claim；取得额度后再取消仍消耗预算。参数错误、超额调用不消耗执行额度，但仍记录 attempted 事件。工具内部不自行增加隐藏重试；如果调用模拟器使用传输重试，其次数另行记录。

```ts
interface CallBudget {
  claim(toolCallId: string): { sequence: number } | undefined;
}
```

同批并行任务仍可运行，不通过关闭 Pi 并行模式掩盖预算问题。

### 6.2 追踪与训练导出分离

每次工具尝试以 `attemptId + batchId + toolCallId` 标识，记录源顺序、工具名、状态、耗时和受控错误码；不假定 provider 的调用 ID 全局唯一。完成可以乱序，身份关联保持稳定。schema 校验若在 SDK execute 前失败，需通过 SDK 事件或钩子补记 attempted，不能仅在 execute 中计数。

当前通过“结果条数减工具条数”推断 preCallThought 所属批次。超额、失败或并发乱序会破坏这个假设。改为工具调用 ID / 批次映射；若 SDK 不提供所需批次事件，先保留 toolCallId 关联，缺少证据时省略该字段，避免填错。

完整尝试日志属于运行审计。既有训练 `ToolStep` 的成功结果格式由明确投影生成；失败、超额、取消记录不会因为新增审计就自动进入训练样本。存储侧可为工具步骤增加可空调用 ID，保持旧数据可读。

### 6.3 F4 验收

- cap=1、同批 3 个搜索，实际只执行 1 个。
- question + questionnaire 同批执行，合计不超过 clarify cap。
- 先失败或取消，再调用时不重新获得额度。
- cache 命中遵循调用预算规则。
- 并行完成顺序与发起顺序相反时，日志、参数、结果及思考关联仍对应同一个 ID。
- todo 的同步行为与现有导出保持兼容。

## 7. F5：贯穿取消信号，等在途工作收尾后再关库

### 7.1 取消与超时契约

`RoleRequest`、`WebSearchRequest`、candidate request 和工具执行上下文增加可选 `signal`。signal 是运行时元数据，不进入模型 JSON、提示词、数据库快照或 spec hash。

一次 role / answer attempt 的 timeout 从开始执行起覆盖排队、模型流、工具、模拟器和后续模型回合。外层任务 signal 控制整个批次；重试间隔也响应任务取消。

错误区分：

- 本次 attempt 到时：`model_timeout`，允许按既有策略在清理后重试。
- 用户终止、session 结束或上级任务取消：`operation_aborted`，停止继续尝试。
- 适配器清理异常：`adapter_cleanup_failed`，升级为任务级错误并保留诊断。

上级 `operation_aborted` 必须穿透单项 catch，停止所有派发和重试，不能记录单项错误后继续下一项。保留任务取消与 deadline 的各自来源，不能仅凭合并 signal 的 aborted 状态判断 timeout。启动 Agent、claim 预算、进入队列和 spawn 前均先检查 already-aborted。

### 7.2 Pi SDK 接入

当前 SDK 1.6.0 的 `Agent.prompt()` 没有 signal 参数，`AgentTool.execute()` 第三个参数是 signal，Agent 提供 `abort()` 和 `waitForIdle()`。

实施方式：

1. 合并任务 signal 与本次 deadline。
2. 监听合并信号并调用 `agent.abort()`。
3. 把同一信号合并进 stream、工具 execute、模拟器及底层 HTTP。
4. 正常、超时、异常均在 finally 移除监听并清理 timer。
5. 取消后不使用模拟器随机 / 默认 fallback；关闭 adapter 的 late onStep 和业务成功提交入口。协调者在 drain 后仍可提交失败 call、已有检查点与最终 interrupted / failed 状态，不能把正常收尾也一并封住。

`createPiRunner` 和 `createPiSearchRunner` 都接入，避免只修带搜索的一条路径。

### 7.3 搜索队列、缓存与子进程

重做 Magpie 的许可队列，使 `acquire(signal)` 可取消：

- 排队被取消后移出队列，不启动子进程。
- 许可直接交给下一位等待者，避免先减 active 再异步加 active 的窗口。
- `execFile` 接收 signal；跟踪进程 close。
- 取消错误先返回时，不立即归还许可；确认进程 close 或尚未 spawn 后归还。
- 有效 deadline 取上级剩余时间与搜索自身 timeout 的较小值。

最小缓存设计改为只缓存已完成且 `isError=false` 的成功 response，移除跨请求共享的 in-flight Promise。一个调用者取消不会影响另一个调用者。代价是同一时刻的重复查询可能各发一次；先保证取消语义，后续有实际需要再设计带订阅者计数的共享执行。

### 7.4 并发池和关闭顺序

当前 `Promise.all` 遇到首个异常会提前返回，其余 worker 可能继续写库。新增池级 signal，明确两种错误：

- 单项可处理错误：worker 记录单项失败后正常返回，继续处理其余项。
- 致命错误：停止派发新项、abort 在途 worker、`allSettled` 等待已启动任务结束，再抛首个错误。

所有调用方遵循：

```text
stop dispatch
  -> abort / settle in-flight operations
  -> persist final run and checkpoints
  -> release session owner
  -> close database
```

`allSettled` 等待的必须是实际执行、子进程 close 和清理完成，不能是 `Promise.race` 提前拒绝的外壳。首个致命错误为 primary，取消或清理错误另存 secondary。清理失败且仍有 live 工作时保留 owner 与连接，记录诊断，不宣称已 drain。

本次 timeout 的作用不等于立即结束整个批次。一个 attempt 超时后，先等其内置适配器清理，再按单项重试策略执行。

### 7.5 注入扩展的能力边界

Pi SDK 直接 await 工具 Promise。任意扩展如果忽略 signal，仅调用 `agent.abort()` 也可能继续等待。

本轮要求内置 HTTP、Magpie、模拟器与新增注入适配器遵守协作取消契约。公共封装在取消后关闭 onStep / 结果提交入口，避免延迟结果改变状态。

`Promise.race` 可以停止等待，不能证明外部工作已终止。不合作扩展挂起时，仍持有 owner 与连接，不自动发起新尝试或提前释放写会话。需要有限时间退出时，必须增加 worker / 子进程隔离并确认隔离单元已终止。不得把这部分包装成已经具有硬终止保证。

### 7.6 F5 验收

- 慢工具跨过 deadline 后触发取消；内置适配器停止，后续模型回合不启动。
- 工具在许可队列等待时取消，零 spawn、队列计数归零。
- 活跃子进程在 close 后释放许可，无残留受跟踪进程。
- 模拟器取消不进入 fallback；retry sleep 取消不发下一次请求。
- worker 致命错误后不派发新项，在途 worker 收尾后才 finishRun / close。
- 两个相同搜索，一位取消不使另一位失败。
- 不合作 fake adapter 单列能力测试，不把“停止等待”断言为“工作已终止”。

## 8. 数据库版本、历史数据与迁移

### 8.1 版本策略

评测库由 v3 升为 v4，提供显式、事务化的 `migrateV3ToV4`。现有初始化器仅接受当前版本，直接修改常量会使所有 v3 库失效，必须先补迁移器。

v4 增量包括：协调表、plan / slot 表、run owner、规格字段 / 版本 / hash、父 run 关联及必要索引。尽量使用新增表和可空列，不重建已冻结的 suite / item，不删除通过题目。

主库和 reasoning 共用协调表及运行 owner 字段，增加内部迁移版本记录。两个 store 使用同一个初始化入口，避免各自建相同技术表却采用不同协议。

只读连接不执行迁移。新代码保留旧版只读报告投影；写入旧版库时先经过明确迁移。v1 / v2 评测库继续按独立旧版本处理，给出保留原库的兼容说明，本轮不承诺跨越这些历史版本迁移。

### 8.2 迁移不变量

迁移前后核对：

- source、probe、probe_turn、calibration、suite、prediction、score 的既有记录数一致。
- suite manifest、suite items 与 sha256 不变。
- accepted 题目及其轮次、rubric、标定不变。
- legacy 缺项得到显式标识，未被当前环境默认覆盖。
- `PRAGMA integrity_check` 为 ok，`foreign_key_check` 无违规。
- 中途失败完整回滚；重复运行迁移器不会重复创建 slots。

writer 原始输出与 probe 对不上时不猜测覆盖。迁移报告列出冲突数量与 ID，保留旧业务数据，阻止对应计划的自动续跑。

### 8.3 升级步骤

以下步骤是实施时的操作规程，本轮尚未执行：

1. 停止全部旧版写入口，确认没有存活的 synth / reasoning / eval 写任务。
2. 对主库和评测库创建可验证快照，记录基线提交、schema 版本、表计数与 suite hash。
3. 使用 SQLite backup API，或停写并确认 checkpoint 完成后复制库；不要仅在 WAL 仍活动时复制一个 `.sqlite` 文件。
4. 在快照副本上执行迁移 dry-run 与回归，输出 legacy 不完整项。
5. 持有独占会话后迁移正式库，提交新版本标识。
6. 先运行只读检查，再小批恢复一个已知任务，核对规格、检查点和导出。
7. 全部入口统一到新版后恢复正常批量任务。

旧 v3 评测程序会因 v4 版本而停止新写入；旧 synth 代码没有相同版本闸门，单靠新增 lock 行挡不住它。首次升级必须在部署上停用旧入口，不能混跑新旧写进程。

### 8.4 回滚

- 迁移事务尚未提交：自动回滚并保留原版本。
- 迁移提交、尚无新业务写入：停止新版，恢复迁移前快照和原代码版本。
- 已产生新结果：先备份新版库，保留新增结果；需要回退时使用原快照，并把新增结果作为待核验导入材料另行处理。
- 不执行自动降级或批量删除 v4 数据。旧代码不直接写 v4 库。

## 9. D1 / D2：在修复稳定后整理模块

### 9.1 存储接口按业务动作收紧

沿用现有 `commitJudgeOutcome` 的方式，逐步提供 `beginItem`、`recordCallOutcome`、`commitTurn`、`finishItem`、`failItem`、`recoverOwnedWork` 等完整行为。

每个行为负责相关状态、时间戳、次数预算和不变量；工作流不再手动组合多张表的结束顺序。只为现有调用需求增加方法，不一次性设计全套通用仓储框架。

迁移顺序：内部封装→调用者改用新方法→测试改用公共行为→限制 `db` 与 Repository 可见性→删除无调用转发。确需测试非法 SQL 的数据库约束测试，可通过专用测试 fixture 接口访问底层连接，避免生产接口为测试保留后门。

### 9.2 编排拆出配置计划

新增 `resolveSynthPlan()`，一次解析 profile、轮次、选材、工具、提示词、导出政策与覆盖项，返回只读 `ResolvedSynthPlan`。将来源值与默认值在这里解析，执行层不再重复读取 process.env。

工作流保留：打开会话、加载输入、依次执行阶段、处理任务级失败、输出摘要。

profile 固有信息集中在一个类型化描述符：Skill 路径、默认题型、默认轮次、工具策略、导出标签。`ALL_SYNTH_PROFILES` 保留单一事实来源，旧导入位置可临时 re-export，待使用点迁移后删除。

通用 Pi runner 仅接收工具工厂、预算和取消上下文；profile / taskSpec 到工具组合的决定移入 synth。共享基础类型保留稳定通用契约，业务类型按实际依赖渐进迁移。

### 9.3 导出拆分与等价验收

将导出拆为候选查询、正式样本筛选、去重选择、工具格式投影、按 videoKey 划分验证集、序列化几个阶段。数据库查询留在 store；纯数据转换不依赖数据库连接。

现有固定 seed、分区和去重规则保持。选取包含多轮、工具、train / test / dpo、formal / 非 formal 的小型 fixture，对比整理前后的样本集合、顺序及内容。JSONL 在固定选项下要求字节一致；含时间戳的 manifest 只比较业务字段，不能以时间变化判重构失败。

`getSynthStatus` 在此阶段变成纯只读。分区同步移动到明确写命令及生成入口；帮助文案说明只读状态可能报告“待同步语料”，避免状态查询暗中改库。

### 9.4 架构规则

继续保留无环、shared 不反向依赖、业务不依赖 CLI、训练域不导入 eval 的规则。当前正则规则可先保留；若加入动态导入或规则继续扩展，再改为 TypeScript AST 分析。

AST 规则覆盖静态 import、export-from、动态字符串 import；无法静态解析的路径报告为未知，不能静默视作通过。不要把静态依赖检查当作 F1–F5 的行为测试替代品。

## 10. 测试与检查入口

### 10.1 回归矩阵

| 测试层 | 覆盖内容 | 建议落点 |
| --- | --- | --- |
| 多进程 SQLite | owner 争用、进程退出、恢复范围、只读共存、DDL 顺序 | 新增 `task-session.test.ts` 与进程 fixture |
| 故障恢复 | writer 全批计划、每阶段中断、计数累计、legacy draft、空计划 | 现有 eval store / make 测试及新增 resume 测试 |
| 真实请求边界 | 旧规格驱动真实请求；self 默认；冲突零调用 | candidate / eval HTTP fixture |
| Pi 同批工具 | 并发搜索预算、共享澄清、乱序关联、错误预算 | search-tools 与 Pi search runner 集成测试 |
| 取消生命周期 | 排队、活跃子进程、模拟器、retry、pool drain、关库顺序 | 新增 cancellation / concurrency 测试 |
| 迁移 | v3→v4、幂等、回滚、保留冻结数据、legacy 缺项 | 新增 eval migration 测试 |
| 导出等价 | 固定 seed、多轮工具、视频级 split、正式样本闸门 | 现有导出测试与小型固定 fixture |
| 全仓回归 | TypeScript 与两组 Python 测试 | 统一 check 命令 |

故障注入用内存或临时 SQLite、loopback HTTP/SSE、可控假子进程。使用 deferred Promise、事件与栅栏安排执行顺序；仅验证取消的时间界限时采用宽松上限，避免精确 100ms 断言造成 CI 抖动。

### 10.2 日常入口

保留 `npm test` 为 TypeScript 测试入口，新增：

- `check:ts`：类型检查与 TypeScript 测试。
- `test:python`：依次执行两组 Python unittest。
- `check`：执行上述完整回归。

Python 命令使用跨平台薄封装，优先显式 `PYTHON`，其次环境中的 python，Windows 可支持 `py -3`。缺少解释器或测试失败时返回非零，不把整组测试跳过伪装成成功。单项 OS 能力跳过需保留原因。

建议在现有 CI（如有）或新增最小 CI job 中覆盖仓库声明的最低 Node 版本和选定当前受支持版本；至少保留 Windows 与 Linux 的生命周期测试。版本矩阵在实现时以实际依赖可用性验证，不在方案中宣称已经通过。

迁移与取消测试属于必须验收项。暂不以新增大量 lint / formatter 规则扩大修复范围。

## 11. 分批实施与依赖

以下为建议的变更批次，不代表已创建提交或 PR。每批单独可审查；数据库升级与首次旧数据迁移需协调发布。

| 批次 | 交付内容 | 前置条件 | 完成标准 |
| --- | --- | --- | --- |
| A | 固化五项复现与故障 fixture；建立迁移测试骨架 | 当前基线 | 测试能准确暴露原问题，现有基线保持可解释 |
| B | TaskSession、启动顺序、owner 字段；覆盖全部写入口 | A | F1 验收通过，无内层全局恢复 |
| C | v4 增量迁移、计划 / slot、检查点、默认续跑与 legacy 报告 | B | F2 与迁移矩阵通过 |
| D | 规格 resolver、candidate 工厂、续跑 / legacy 规则 | B；共用 C 的 v4 定义 | F3 请求与存储一致 |
| E | 同步预算、共享 clarify、调用 ID 追踪 | A | F4 真实 Pi 并发 fixture 通过 |
| F | signal、Magpie 队列 / 缓存、retry / pool drain、生命周期清理 | B、E | F5 取消和关库顺序通过 |
| G | 存储接口收紧、ResolvedSynthPlan、profile 和导出整理 | C、D、F | 行为与导出等价，无新环 |
| H | 统一完整 check、CLI / 文档同步、快照迁移演练与小批恢复 | B–G | 全部验收项完成，可发布 |

C / D 可以分开实现，但由同一集成者维护 v4 迁移定义，避免两个分支分别发布不兼容的“v4”。E 可与 B–D 并行；F 需要先确定 E 的预算与追踪生命周期。G 中修改 Pi 工具挂载的部分等待 F 完成。

第一阶段生产修复终点是 B–F：五项缺陷全部验收。第二阶段完成 G–H 的结构整理和交付检查。若需要提前交付，统一 check、必要帮助文案和迁移演练应随第一阶段一起完成，不能等重构结束才补。

## 12. 文件级实施清单

以下为实施前规划的路径建议，实际实现采用了等价的较小接口。例如[写会话](<../src/shared/task-store.ts>)与[迁移器](<../src/eval/store/migration.ts>)已落地；具体证据见验收记录：

| 区域 | 现有主要修改点 | 拟新增模块 |
| --- | --- | --- |
| 会话与生命周期 | synth / eval / reasoning store 构造及 workflows | `shared/task-session.ts`、`shared/execution-context.ts` |
| 迁移 | eval schema / types、主库 schema、reasoning store 初始化 | `eval/store/migrations.ts`、共享协调表初始化 |
| 造题恢复 | eval probe-loop、source-repo、probe-repo、workflows | `eval/store/build-plan-repo.ts`、`eval/probe-checkpoint.ts` |
| 评测规格 | eval workflows、eval-runner、candidate-client、report | `eval/evaluation-spec.ts` |
| 工具预算 | shared web-search、pi-tools、pi-runner | `shared/call-budget.ts`；审计投影按复杂度决定是否独立 |
| 取消 | shared types、retry、concurrency、web-search、pi-runner；candidate-client | 必要的可取消队列；避免重复封装 |
| 模块整理 | synth workflows / skills / presets / store、reasoning store、export-repo | `synth/plan.ts`、profile 描述符与纯导出策略 |
| 日常检查 | npm scripts、现有测试及 CLI 帮助 | 跨平台 Python 检查薄封装、进程 fixture |

当前源码入口（原设计引用的行号已随重构失效，以下按模块定位）：

- [主库恢复](<../src/synth/store/run-repo.ts>)、[reasoning 初始化](<../src/reasoning/store.ts>)、[评测初始化](<../src/eval/store/index.ts>)。
- [造题执行](<../src/eval/probe-loop.ts>)、[材料筛选](<../src/eval/store/source-repo.ts>)、[现有版本闸门](<../src/eval/store/schema-sql.ts>)。
- [候选 runner 构造](<../src/eval/workflows.ts>)、[续跑处理](<../src/eval/eval-runner.ts>)、[真实请求体](<../src/eval/candidate-client.ts>)。
- [搜索额度](<../src/shared/web-search.ts>)、[澄清额度](<../src/shared/pi-tools.ts>)、[Agent deadline](<../src/shared/pi-runner.ts>)、[并发池](<../src/shared/concurrency.ts>)。
- [完整状态提交的现有范例](<../src/synth/dialogue-loop.ts>)、[批量编排](<../src/synth/workflows.ts>)、[导出仓储](<../src/synth/store/export-repo.ts>)与[纯投影策略](<../src/synth/export-policy.ts>)。

## 13. 发布验收清单

以下勾选表示本地临时库、子进程与 loopback HTTP 回归通过，不代表生产切换已执行。完整数量、跳过原因和迁移 / 小批恢复记录见[验收记录](<../docs/code-quality-remediation-validation.md>)。

- [x] 两个进程争同库时，不会互相改状态或同时执行写任务。
- [x] 取消、崩溃恢复、冻结和后续新任务遵循同一个 owner 协议。
- [x] 造题每阶段恢复保持同一 plan / slot / probe 身份，已通过结果不重做。
- [x] 空计划、业务淘汰与技术失败在状态和默认续跑中有不同处理。
- [x] 续跑的请求、日志、报告、裁判检查来自同一规格，冲突在调用前发现。
- [x] legacy 不完整计划和配置有显式报告，迁移未伪造缺失历史。
- [x] 同批并行工具严格遵守额度，澄清共享预算，结果按 ID 关联。
- [x] 内置链路响应取消，队列与进程回收完成后释放许可。
- [x] 所有在途 worker 收尾之后才提交最终 run、释放 owner、关闭数据库。
- [x] v3→v4 在副本上通过完整性、幂等与失败回滚验证。
- [x] 冻结套卷、accepted 题目、已有通过轮次和标定在迁移后保持一致。
- [x] 固定选项下导出等价，视频级 split 与正式样本闸门持续有效。
- [x] 完整 check 覆盖 TypeScript 与两组 Python；跳过原因可见。
- [x] CLI 帮助与生产文档说明 busy、resume、legacy、取消和回滚行为。

最终交付应包含修复代码、回归测试、迁移器、迁移报告、小批恢复记录与更新后的操作文档。是否完成以这份清单和实际测试结果为准。
