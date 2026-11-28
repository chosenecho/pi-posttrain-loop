# 0004. 独立评测库与训练侧实行数据库及 Skill 双向隔离

状态：accepted；下文保留原决策缘由，并记录 Schema v4 下的当前实现。操作细节以 [独立评测库与盲测流水线](../eval-probe-pipeline.md) 为准；跨模块职责见 [当前模块架构](../architecture.md)。

## 原决策与缘由

评测使用独立的 `data/eval.sqlite` 与 `skills/eval/*`，从主库以只读方式取得 `test` 留出材料。若评测与训练共用出题、追问和质检 Skill，测试集会偏向训练出题器熟悉的句式与角度，降低对框架迁移、错误前提和多轮立场稳定性的区分度；评测过程若可写主库，还可能将测试题或中间结果混入 SFT 训练集。

因此选择独立数据库文件与双向 Skill 白名单，接受额外的材料快照、跨库分区复核和独立运行记录成本。替代方案是在主库按表区分训练与测试，并复用训练角色；它更省维护工作，却让写入权限和提示词边界共同依赖调用方自律。

原决策记录基于 Schema v2、16 张表，以及 `adversarial` / `trap` 两套评测预设；当时允许将主库冻结的 `test-v1` 只读镜像为 `indist-v1`，且仅 `adversarial` 参考答案角色共享 `answer-style`。这些是历史实现背景。当前已统一为 5 类题型，旧主库 rubric、版本冻结和镜像入口均已退役，见 [三分区与历史归档](../test-and-eval-pipeline.md#5-历史归档主库-test-v1已退役)。

## 当前实现

- **数据库边界**：新库为 Schema v4，保留 12 张原有表并加入 `probe_build_plans`、`probe_build_slots`、`probe_build_executions` 与 `runtime_task_lock`。`eval make` 在打开可写评测库、claim owner 或执行 DDL 前比较物理文件身份；相同路径、相对/规范化别名、符号链接、硬链接、Windows 大小写别名报 `database_path_conflict`。导入与冻结入口重复校验，见 [database-path.ts](../../src/shared/database-path.ts) 与 [workflows.ts](../../src/eval/workflows.ts)。
- **主库只读边界**：材料导入在短读事务中一并复制分区、材料索引及必要正文；目录扫描、异步读取和模型调用在事务提交后进行。冻结将分区和训练问题放入同一短快照，重新验证 `test` 归属和材料 SHA-256。只读连接不 claim owner，不初始化 schema、清理旧表或恢复任务。见 [DataMakerStore](../../src/synth/store/index.ts)、[source-import.ts](../../src/eval/source-import.ts)、[suite-freeze.ts](../../src/eval/suite-freeze.ts)。
- **Skill 边界**：训练侧 [skills.ts](../../src/synth/skills.ts) 拦截 `skills/eval/*`；评测侧 [eval-prompts.ts](../../src/eval/eval-prompts.ts) 拦截训练专用的 `question-design`、`followup-strategy`、`quality-judge`、`reasoning-writer`、`reasoning-judge` 以及评测目录外的未知 Skill，仅允许共享基础 `answer-style`。当前共享口吻规则不代表共享训练出题或质检规则。
- **持久化生成边界**：writer 输出先整批校验，再将完整 draft/slot/probe 原子提交，之后才处理第一题；合法空计划明确记为 skipped。稳定 plan/slot 与每次执行 run 分开，原 `probes.run_id` 保持创建来源，本次复用由 `probe_build_executions` 关联，标定和冻结按本次执行选题。默认续跑最新 generation，`--rebuild` 创建新 generation；显式 `--resume-build <originRunId>` 使用所选旧 generation 的原提示词、预算和原模型，实际请求也固定该模型。见 [probe-loop.ts](../../src/eval/probe-loop.ts)、[build-plan-schema.ts](../../src/eval/store/build-plan-schema.ts) 与 [workflows.ts](../../src/eval/workflows.ts)。
- **候选执行边界**：不可变 `evaluationSpec` v2 保存 suite 指纹、有序条目、candidate、模型、含路径的 endpoint、历史模式、系统提示词、采样、输出处理和 adapter 契约，并计算 hash。规格解析、历史身份与 adapter 身份校验先于 reopen、状态恢复和远端调用；续跑省略参数沿用原值，显式冲突报 `resume_config_conflict`。凭据仅运行时读取，timeout/并发/传输重试单独记录。缺失或损坏规格的 legacy run 保持只读，可用同套卷 `--parent-run` 创建独立关联 run，不混入旧预测或分数。见 [evaluation-spec.ts](../../src/eval/evaluation-spec.ts)、[eval-runner.ts](../../src/eval/eval-runner.ts)。

## Consequences

1. 冻结套卷仍需检查活动 `probe_runs`、已标定状态、`easy` 占比上限（默认 20%）、主库 `test` 归属及字符 2-gram Jaccard 训练题相似度。默认裁掉多余 easy 题，默认相似度审计阈值为 0.6 并写入 manifest；显式 `--fail-on-train-sim <阈值>` 时，最大相似度达到该阈值即拦截。评分卡随已通过参考答案存入 `probe_turns`，冻结到 `suite_versions` / `suite_items` 后保持不可变。
2. 生成步骤检查点保留 critic/revision/adversary/reference/verifier 的输入、调用身份及累计业务预算。原始返回可恢复解析，已通过轮次与下一检查点一起提交；已结束 slot 不重跑。远端完成但本地未保存的调用仍可能重试。未完成计划默认使 make 返回非零并停止标定/冻结；只有显式 `--allow-partial-build` 才处理完整 accepted 子集，并在 manifest 记录遗漏。
3. `runtime_task_lock` 按物理库协调单个写任务，所有写事务同步且短时校验 owner；只读报告可并行。只在同主机旧 PID 明确不存在时接管，未知主机或 PID 仍存活时保留原 owner。取消先停止派发、abort 并 drain 在途调用/工具/子进程，再落最终状态、释放 owner 和关闭连接；`--allow-active-runs` 不绕过写会话。见 [task-store.ts](../../src/shared/task-store.ts)、[concurrency.ts](../../src/shared/concurrency.ts)。
4. 已有 v3 库继续支持只读报告；写入前通过 [显式迁移器](../../src/eval/store/migration.ts) 运行 dry-run、保存迁移前 SQLite 备份，再在事务内升级到 v4。迁移核对业务记录与冻结套卷摘要，失败保留备份并回滚；旧计划只恢复有证据的历史槽位，缺少完整批次/规格的计划保持 incomplete。迁移不补造历史 `evaluationSpec`；v1/v2 库须保留原件并使用对应版本工具读取。
5. 训练导出仍只读反查评测库的 `source_materials` 与 `suite_items` 视频键，拦截交集，见 [eval-guard.ts](../../src/synth/eval-guard.ts)。物理文件分离与 Skill 白名单之外，还保留这一导出方向的复核，避免后续流程遗漏分区检查。

边界、迁移与实际 HTTP 契约的回归证据见 [database-boundary-workflow.test.ts](../../test/database-boundary-workflow.test.ts)、[probe-build-resume.test.ts](../../test/probe-build-resume.test.ts)、[eval-workflow-resume.test.ts](../../test/eval-workflow-resume.test.ts)、[eval-spec-http.test.ts](../../test/eval-spec-http.test.ts) 与 [eval-migration.test.ts](../../test/eval-migration.test.ts)。这些测试覆盖临时夹具；CI 矩阵配置和本机通过记录应分别说明，不据此推断远端 CI 已执行。
