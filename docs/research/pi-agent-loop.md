# 用 Pi 实现训练数据生成与质检循环

调研日期：2026-11-23。范围：材料出题（0–3 题）→ 回答 → 按判断 Skill 质检 → 有界返工；仅核实选型，不实现项目。

## 结论

- 可以复用 Pi 的 Agent 运行时，但单 Agent 的模型/工具循环，与回答 Agent、质检 Agent 之间的业务循环，是两层不同的循环。推荐 Pi 管单个角色，项目代码管理 pass/revise/drop 和最大轮次。
- 第一版可用 TypeScript + pi-agent-core + pi-ai + JSONL。没有工具调用、只做纯文本生成时，pi-ai 加一个普通循环已足够。
- 第一版无需引入完整 coding-agent 会话层；只有需要标准 Skill 发现、会话管理、扩展等能力时再使用它。

## 当前包名与版本

本次查询 npm latest，以下三包均为 1.6.0，Node.js 要求 >=22.19.0：

- @earendil-works/pi-ai：统一模型调用、流式响应、用量与成本信息。
- @earendil-works/pi-agent-core：Agent 状态、工具执行、事件，以及 agentLoop / agentLoopContinue。
- @earendil-works/pi-coding-agent：完整 Pi SDK/CLI，含会话、资源加载与 Skill 集成。

旧 @mariozechner/pi-agent-core 的 latest 为 0.73.1；npm 元数据包含 `deprecated: please use @earendil-works/pi-agent-core instead going forward`。新项目按当前 scope 使用同一版本线，避免混用旧教程的导入和新版本接口。

一手来源：
- https://registry.npmjs.org/@earendil-works/pi-agent-core/latest
- https://registry.npmjs.org/@earendil-works/pi-ai/latest
- https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest
- https://registry.npmjs.org/@mariozechner/pi-agent-core/latest
- https://github.com/earendil-works/pi/tree/v1.6.0

## 循环能力与项目仍需实现的内容

Pi Agent 的工具循环会在模型提出工具调用时执行工具并回传结果。Agent 类提供 prompt、事件订阅、abort、状态等功能；低层函数 agentLoop / agentLoopContinue 也对外提供。它不是自动识别出题/回答/质检角色的训练数据流水线。

v1.6.0 的 finishTurn 钩子可以返回 `{ action: "end" }` 或 `{ action: "continue" }` 影响同一 Agent 的延续。始终返回 continue 会产生无限循环；该钩子本身并不建立多个 Agent 之间的反馈协议。为保持实现简单，质量循环放在项目代码中更直观。

项目自己负责：
1. 解析并校验出题结果为 0–3 题。
2. 质检结果的结构校验（pass/revise/drop）。
3. 把最新答案和修改意见回传给回答角色。
4. 最大返工轮次、错误处理、样本与过程记录的保存。
5. 每题隔离上下文，质检始终读取原材料。

一手来源：
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/agent/README.md
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/agent/src/agent-loop.ts
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/ai/README.md

## 判断 Skill

Skill 是指令及其支持文件，不是质量证明或结构化结果校验器。低层 pi-agent-core 不自动提供 coding-agent 的 Skill 资源发现系统；最简单的固定规则场景，可显式读取判断规则正文并注入质检角色上下文。

完整 pi-coding-agent SDK 通过 ResourceLoader 提供 Skill 发现；默认只在上下文公布名称、说明与路径，模型按需加载正文。文档明确指出模型可能漏加载，强制调用可用 `/skill:name`。固定质检流程应明确保证规则正文已被加载，而不是只登记一个 Skill 名称。

一手来源：
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/skills.md
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/examples/sdk/04-skills.ts

## 暂不引入的包

当前还有 pi-durable，但官方 README 将其标为 Experimental，接口可在发布间无预告变化。它用于持久化 Agent、恢复等更复杂需求；本项目第一版无需因有循环就引入。

来源：https://github.com/earendil-works/pi/blob/main/packages/durable/README.md

## 核验限制

以上基于官方文档、源码和 npm 元数据；未安装依赖，未调用真实模型，未运行实现测试。npm latest 是查询时快照，落地时应锁定版本。
