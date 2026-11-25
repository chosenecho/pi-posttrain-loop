# 0003. 思考链（CoT）采用脱稿逆向补写，严禁向补写角色提供原始材料

我们在主问答流水线有稿产出并通过质检之后，由独立的 `npm run reasoning` 流水线在不提供原始文稿（`material`）的条件下，仅凭用户提问、前序对话历史与已通过的目标回答，逆向补写第一人称开口前思考骨架（`reasoning_traces`），并通过确定性规则 + LLM 评审双重质检。

如果在有稿回答阶段直接让模型输出 `<think>`，思考链会不可避免地变成“原文第三段提到了 X，因此我这样复述”的阅读理解摘抄；而微调后的模型在实际部署推理时没有任何参考原稿，这种“看着稿子找答案”的思考链会在脱稿推理时引发严重的幻觉或检索式口癖泄漏。

## Consequences

- `reasoning-writer` 在架构上无法读取 `materials` 表字段；程序层仅保留极简工程安全阀（非空、无 `<think>`/Markdown/列表脏污、禁止“原稿/材料/逐字稿/提示词”等硬泄漏词、极端超长与极端整段照抄熔断），而将字数、重合度与最长共现片段作为参考指标（`referenceMetrics`）提供给 `reasoning-judge`，由 Agent Loop 主导语义质量、自然度、去摘要化与边界一致性裁决。
- 多轮样本导出给 `ms-swift` 时默认采用 `--format inline`（将 `<think>...</think>` 内联进 `content`，适配 `ms-swift 4.6.0`；也保留 `--format reasoning_content` 供直调 HF `apply_chat_template`）并默认按轮展开（`--expand-turns`），历史轮次仅保留纯回答正文，只对当前训练目标末轮附带思考块，与实际推理时的上下文分布完全一致。
