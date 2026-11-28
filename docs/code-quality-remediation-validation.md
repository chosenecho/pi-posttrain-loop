# 代码修复验收与迁移演练记录

验收日期：2026-11-28。代码基线为 `d2038d150921bc380048de4a82c00bae2ecd1f2b`。验收时修复仍在工作区；后续提交与推送以 Git 历史为准。

本记录覆盖本地 Windows、Node.js v24.16.0、Python 3.12.10 下的临时 SQLite、真实子进程及 loopback HTTP 测试。生产数据库与真实数据集未参与本次执行，本记录不包含远端 CI 执行结果。

## 1. 完整检查结果

统一入口：

```sh
npm run check
```

该命令依次运行类型检查、全部 TypeScript 测试与两组 Python unittest。完整输出另存于本地 `.archify/` 归档，该目录不入库；下述结果与测试入口构成版本化的验收记录。

- TypeScript 类型检查通过；测试共 278 项，277 项通过、0 项失败、1 项跳过。
- Python 第一组共 20 项，全部通过；第二组共 22 项，21 项通过、1 项跳过。
- 两个跳过项均为当前 Windows 账户缺少创建符号链接的权限。Node 的硬链接、路径规范化和 Windows 大小写别名测试实际执行通过。
- 导入图、领域边界和裸 SQL 位置检查通过；新增共享模块保持叶子依赖。

[CI 配置](<../.github/workflows/check.yml>)覆盖 Ubuntu / Windows 与 Node 22.19.0 / 24.x，配套 Python 3.12。矩阵配置已加入工作区；本记录只报告上述本地运行结果。

当前模块职责、profile 默认值、工具装配和写会话生命周期集中记录在[架构说明](architecture.md)。

## 2. 修复行为与证据

| 工作项 | 已验证行为 | 主要回归入口 |
| --- | --- | --- |
| F1 写会话 | 业务 DDL 前排他 claim；活跃 writer 不被恢复；只读查询共存；本地主进程确定退出后才接管；owner 检查与写入同事务；取消收尾前保留 owner | [会话测试](<../test/task-session.test.ts>) |
| F1 跨库边界 | 主库 / 评测库同路径、规范别名、硬链接及 Windows 大小写别名在写库构造前阻断；导入与冻结使用短只读快照 | [跨库工作流测试](<../test/database-boundary-workflow.test.ts>) |
| F2 持久计划 | 完整批次先落库；plan / slot / probe 稳定；各阶段检查点、业务预算与原始调用输出可恢复；空计划、淘汰、技术失败分开处理 | [造题恢复测试](<../test/probe-build-resume.test.ts>) |
| F2 工作流 | 按执行关联标定 / 冻结；partial 默认非零并停止冻结；rebuild 新建 generation；显式恢复旧 origin 使用其计划与实际模型 | [工作流恢复测试](<../test/eval-workflow-resume.test.ts>) |
| F3 不可变规格 | 请求、存储、历史模式、采样和选题顺序一致；冲突在 HTTP / 恢复 / 批卷前失败；legacy 不完整记录保持只读；缺失条目和跨套卷引用禁止写入 | [规格及 HTTP 测试](<../test/eval-spec-http.test.ts>) |
| F4 工具预算 | 同步预占；question / questionnaire 共享额度；失败、取消和缓存命中不退额度；重试 / 批次 / toolCallId 可区分；审计与成功训练步骤分离 | [工具生命周期测试](<../test/tool-lifecycle.test.ts>)、[持久审计测试](<../test/tool-attempt-audit.test.ts>) |
| F5 取消收尾 | Agent、HTTP、工具、simulator、retry、队列、子进程与 worker 共享取消；等待真实 Promise / 进程回收后才提交最终状态、释放 owner；cleanup 失败保持任务级首错 | [Pi 测试](<../test/pi-runner.test.ts>)、[Magpie 测试](<../test/magpie-lifecycle.test.ts>)、[领域取消测试](<../test/synth-cancellation.test.ts>) |
| G 模块整理 | 不可变 synth 计划、profile 描述符、领域工具装配、纯导出策略、私有数据库连接；状态查询只读并报告待同步数量 | [计划测试](<../test/synth-plan.test.ts>)、[工具装配测试](<../test/synth-tool-runner.test.ts>)、[状态测试](<../test/synth-status.test.ts>) |

正式导出使用重构前固定的五组结果 oracle，检查 JSONL 字节、版本去重、工具投影、正式样本筛选、随机种子及视频级验证集切分。[导出回归](<../test/synth-export-regression.test.ts>)中的工作流样本保持 train 1 条、validation 3 条、材料 4 个、去重 1 条。

## 3. v3 → v4 临时库迁移报告

[迁移专项](<../test/eval-migration.test.ts>)共 13 项通过。使用真实临时 SQLite 文件生成 v3 数据，包含 accepted / draft probe、已通过轮次、标定、冻结套卷、旧预测、评分与调用日志。

主迁移样本的实际断言结果：

- `fromVersion=3`、`toVersion=4`、`migrated=true`；迁移前后 probe 数量均为 2。
- 新建 1 个计划与 2 个 slot；缺少完整历史快照的计划标为 incomplete，保留原 accepted slot。
- `integrityCheck=["ok"]`，`foreignKeyViolations=[]`。
- 历史 11 张业务表的完整内容保持相等，新增 owner 元数据不参与旧业务内容比较。
- 冻结套卷的 manifest、items 内容及示例 `frozen-sha-v3` 均保持不变；备份中的业务内容与原始 v3 相等。
- dry-run 只迁移临时副本，源库版本仍为 3；临时副本随后清理。
- 在 legacy slot 写入后注入失败，新增表、owner 列、计划和版本更新一起回滚，迁移前备份保留；随后可重新迁移。
- WAL 中已提交、尚未 checkpoint 的记录进入备份；已有备份文件保留原字节；v4 重复执行不新增重复计划、slot 或备份。
- 活跃 owner 会同时阻止 dry-run 与正式迁移；v1 / v2 数据保持原样并提示对应升级路径。

此处是合成临时库的演练结果。正式迁移命令会自行输出含路径、前后摘要、完整性与 legacy 报告的 JSON，可按[生产操作手册](<../docs/production-workflow.md>)保存生产迁移报告。

## 4. 小批恢复记录

[造题恢复测试](<../test/probe-build-resume.test.ts>)执行了 7 个真实子进程中断场景：writer、critic、revision、adversary、reference、verifier 和已通过 turn 提交之后退出。下一进程复用同一计划、slot 与已有 probe，只推进尚未提交的工作。

一个三槽 legacy 样本中，第一题已 accepted 且有旧标定，第二题已有第一轮通过答案，第三题尚未落库。恢复后的结果为：

- writer 调用为 0，原完整批次被复用；本次新增 probe 为 1。
- 原 accepted probe 的创建 run 不变；原轮次与标定逐字段相等。
- 第三题使用本次 run 作为创建者，并绑定原计划的第三个 slot。
- 第二次 legacy 计划导入新增数为 0。

空批次再次执行产生 0 次模型调用；显式 rebuild 才建立新 generation。技术错误、取消及检查点断档保留为可诊断或可重试工作，默认部分构建阻止自动冻结。

## 5. 生产切换条件

本地代码与回归验收完成后，生产切换仍按[操作手册](<../docs/production-workflow.md>)执行：停止旧版写进程，先 dry-run，再以独立备份路径迁移，核对 JSON 报告、冻结套卷摘要和首次小批恢复结果。旧版本不识别新 owner 协议，切换窗口须保持停写。

评测历史缺失规格时保持只读，通过 `--parent-run` 新建关联评测；造题历史缺失提示词 / Skill 正文时报告 `build_snapshot_missing`。忽略取消的自定义 adapter 会使任务继续等待其真实结束，期间保持写会话。

## 6. 文档同步后的复核

本轮同步 README、领域术语、当前架构、主库与评测设计、生产操作及历史 ADR；原研究和规划保留历史身份。CLI 帮助的 profile 列表、suite 数量和重试默认值改为从现有常量生成，命令执行行为保持原实现。

- 再次运行 `npm run typecheck`：通过。
- 直接运行 `node --import tsx --test test/cli.test.ts test/eval-evaluate-and-cli.test.ts`：7 项通过，0 失败，0 跳过。
- 直接运行 `node --import tsx --test test/architecture.test.ts`：3 项通过，0 失败，0 跳过。
- 通过直接 Node / tsx 入口检查 10 个代表性 CLI 帮助，确认九种 profile、八套 suite、3000ms 默认重试和现行评测恢复 / 迁移选项；检查未加载工作区 `.env`，没有真实模型调用。
- 校验 22 份仓库文档中的 335 个本地 Markdown 链接目标：全部存在；失效的旧模块链接改为现行入口，已退役模块保留为历史路径。
- `git diff --check`通过。本地 `.archify/`报告与日志保留在工作区，由忽略规则排除；生产库、语料与本机环境配置不参与提交。
