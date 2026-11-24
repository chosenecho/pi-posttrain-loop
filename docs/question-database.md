# 问题数据库说明（历史单表归档）

> **状态说明**：本文件记录早期单表原型 `data/questions.sqlite` 的结构与首次试跑历史，该库保留为只读来源备份。当前所有出题、多 P 合并、视频级防重复选稿、三分区隔离、单/多轮回答质检、盲测评分要点抽取及 JSONL 导出均已迁移收敛至统一 SQLite 数据库 `data/data-maker.sqlite`，最新说明见 [README.md](<../README.md>) 与 [SQLite 统一存储设计](<sqlite-design.md>)。

## 1. 用途与位置

问题数据库（`data/questions.sqlite`）用于保存问题生成 Agent 根据目标人物视频文稿生成的问题，供后续回答、评审和训练数据制作使用。

当前仅实现：**单篇文稿 → 问题生成 Agent → 保存工具 → SQLite**。数据库里一行对应一个问题，尚未包含回答，也不等同于完整的 SFT 训练样本。

## 2. 数据格式

数据库为 SQLite，业务表只有 `questions`，结构如下：

```sql
CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    video_id TEXT NOT NULL,
    question TEXT NOT NULL
);
```

| 字段 | 类型与约束 | 含义 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 问题记录的主键，保存时由 SQLite 自动分配。 |
| `video_id` | `TEXT NOT NULL` | 来源文稿标识。当前按视频 BV 号与分 P 编号组合，例如 `BV1Dt4y1Y7S2/P001`。 |
| `question` | `TEXT NOT NULL` | 问题正文，保存工具会去掉首尾空白。 |

以下为首次试跑实际入库的一条记录，以 JSON 展示字段值；数据库本身仍是 SQLite：

```json
{
  "id": 2,
  "video_id": "BV1Dt4y1Y7S2/P001",
  "question": "自由主义为什么会对所有政治计划采取“表面服从但不认同”的拉开距离姿态？"
}
```

表中仅保留这三个字段，不存文稿全文、答案、评审状态、模型名称、生成时间或提示词版本。问题正文的非空字符串检查由保存工具执行；表结构本身的 `NOT NULL` 约束只限制空值，不限制空字符串。

## 3. 文稿来源与标识

文稿来源目录为 `data/weimingzi-semantic/`。本次使用的布局是：

```text
数据目录/by_bv/视频BV号/分P编号.md
```

例如，首次试跑文稿 `data/weimingzi-semantic/by_bv/BV1Dt4y1Y7S2/P001.md` 对应：

```text
输入路径：data/weimingzi-semantic/by_bv/BV1Dt4y1Y7S2/P001.md
video_id：BV1Dt4y1Y7S2/P001
```

程序默认取“父目录名 / 去掉扩展名的文件名”作为 `video_id`。包含分 P 编号，是为了区分同一视频下的多份文稿。也可以通过 `--video-id` 显式指定标识。

## 4. 问题如何产出

### 4.1 读取文稿并调用模型

[单篇运行入口](<../src/question-cli.ts>) 接收一个文稿路径，读取整篇文本，并加载[问题生成系统提示词](<../prompts/question-generator.md>)。发送给 Agent 的用户输入为：

```json
{
  "video_id": "BV1Dt4y1Y7S2/P001",
  "transcript": "整篇视频文稿文本"
}
```

Agent 从有价值的观点、解释、建议或个人经历出发，反推自然用户可能提出的问题。提示词要求：

- 问题有文稿依据，区分目标人物本人、他人及被引用观点的立场。
- 问题脱离文稿也能理解，适合直接向目标人物提问。
- 每题围绕一个核心意图，尽量引出其判断方式、观点和表达特点。
- 同一意图只保留一个问题，题量由内容决定，不设固定题数；没有合适问题时使用空数组。
- 只生成问题，不生成回答。

这些是生成要求，不代表每道题都已经通过质量评审。当前没有增加独立的评审或人工筛选环节。

### 4.2 Agent 调用保存工具

模型通过工具调用提交结果，而不是直接操作数据库或生成 SQL：

```json
{
  "video_id": "BV1Dt4y1Y7S2/P001",
  "questions": [
    "自由主义为什么会对所有政治计划采取“表面服从但不认同”的拉开距离姿态？"
  ]
}
```

工具名称为 `save_questions`，实现见[问题保存工具](<../src/question-store.ts>)。每次运行时，宿主将工具绑定到当前文稿标识和已打开的数据库。

保存工具执行以下操作：

1. 检查 `video_id` 与当前文稿一致。
2. 检查 `questions` 为字符串数组，每个问题去掉首尾空白后仍有内容；空数组合法。
3. 去掉问题首尾空白，使用参数化 SQL 插入。
4. 跳过同一 `video_id` 下正文完全相同的已有问题，包括本批次内的重复项。
5. 在一个事务中完成本次工具调用的整批写入；写入异常时回滚该批次。
6. 返回实际新增和跳过重复的数量。

去重由工具执行，表中没有额外的唯一约束。当前仅做同一文稿内的精确文本去重，不做语义去重或跨文稿去重；改写后的同义问题可能再次入库。再次运行同一文稿时，新增问题会追加保存，已有问题保持不变。

### 4.3 返回结果

首次试跑的真实回执为：

```json
{
  "video_id": "BV1Dt4y1Y7S2/P001",
  "saved_count": 12,
  "skipped_count": 0
}
```

`saved_count` 表示这次工具调用实际新增的条数，`skipped_count` 表示因完全重复而跳过的条数。

当前[模型适配器](<../src/pi-runner.ts>) 在一次模型请求产生工具调用后执行工具并结束，由宿主直接展示回执，不再额外调用模型生成确认语。运行入口随后查询并打印该文稿在库中的全部问题，因此打印的总数可能大于本次新增数。

如果模型只返回正文或待保存 JSON、没有成功调用工具，运行入口会报告尚未入库，不会把正文自动解析后写入。当前未配置自动重试。空数组成功保存时回执为新增 0 条，数据库不会额外记录“该文稿已处理”的状态。

## 5. 如何运行

在项目根目录执行。需要项目依赖已安装，Node.js 满足 [package.json](<../package.json>) 声明的 `>=22.19.0`，并支持内置 `node:sqlite`。

模型配置从项目根目录的 `.env` 或进程环境变量读取，变量说明见[环境变量示例](<../.env.example>)：

- 必填：`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。
- 可选：`LLM_MAX_TOKENS`、`LLM_CONTEXT_WINDOW`、`LLM_TIMEOUT_MS`。
- 接口使用支持流式响应和工具调用的 OpenAI Chat Completions 兼容模型；`LLM_BASE_URL` 填 API 根地址。

处理一篇文稿，写入默认数据库：

```powershell
npm run questions -- --input "data/weimingzi-semantic/by_bv/BV1Dt4y1Y7S2/P001.md"
```

显式指定数据库和文稿标识：

```powershell
npm run questions -- --input "data/weimingzi-semantic/by_bv/BV1Dt4y1Y7S2/P001.md" --db "data/questions.sqlite" --video-id "BV1Dt4y1Y7S2/P001"
```

`--input` 必填；`--db` 和 `--video-id` 可选。默认数据库为 `data/questions.sqlite`。指定的数据库文件及 `questions` 表应预先存在，运行入口没有自动建库建表步骤；另建数据库时可使用第 2 节的建表 SQL。

命令每次只处理一篇文稿，不会自动遍历整个来源目录，也不会运行后续回答、评审 Agent。

## 6. 查询与已验证样本

使用 SQLite 客户端打开 `data/questions.sqlite` 后，可执行：

```sql
-- 查看某篇文稿的问题。
SELECT id, video_id, question
FROM questions
WHERE video_id = 'BV1Dt4y1Y7S2/P001'
ORDER BY id;

-- 按文稿统计题量。
SELECT video_id, COUNT(*) AS question_count
FROM questions
GROUP BY video_id
ORDER BY video_id;
```

首次试跑使用《【十分钟哲学】左翼—自由—保守——政治立场三元组》，配置模型为 `auto/deepseek-v4.1-flash`，生成并入库 12 题，记录 ID 为 1–12，跳过重复 0 题。

首次试跑结果快照（`output/question-trial-BV1Dt4y1Y7S2-P001.json`）保存了来源路径、配置模型和这 12 条记录。该 JSON 是试跑后单独导出的快照，不是每次运行都会自动产生的文件，后续入库也不会同步更新它。

这批问题保留了模型原始结果，未人工改写。其中部分追问超出了文稿已经展开的解释；后续制作问答样本时仍需检查文稿能否充分支持回答。入库表示保存成功，不表示训练质量已经验收。
