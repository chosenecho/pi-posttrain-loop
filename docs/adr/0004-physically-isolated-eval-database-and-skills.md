# 0004. 独立评测库（`data/eval.sqlite`）与训练侧实行数据库及 Skill 双向物理隔离

对抗与陷阱评测流水线（`npm run dm -- eval`）使用独立的 `data/eval.sqlite` 数据库（Schema v2，16 张表）与专属的 `skills/eval/*`（含 `skills/eval/trap/*`）技能目录，仅允许以只读方式从主库导入 `test` 分区文稿快照或只读镜像 `test-v1`，并在代码加载层通过双向白名单守卫（`src/synth/eval-guard.ts` 与 `src/eval/eval-prompts.ts`）阻止训练与评测互读对方的 Skill 或跨库写入。

若评测题与训练题共用同一套出题与质检提示词（所谓“同源评测”），测试集只会考察训练出题器偏好的句式和角度，变成虚高的“开卷模拟考”；一旦同时允许评测流程读写主库，还存在将对抗测试题或过程数据误导流进 SFT 训练集的风险。

## Consequences

- 训练流水线（含 `standard` / `short` / `trap` 三套训练预设）加载任何 `skills/eval/*` 路径、或评测流水线加载 `question-design` / `quality-judge` / `reasoning-*` 等训练专用 Skill 时，会在进程启动阶段直接抛出异常拒绝执行（仅 `adversarial` 预设的参考答案角色共享基础口吻规范 `skills/answer-style/SKILL.md`，`trap` 评测预设完全独立）。
- 评测套件冻结（如 `adv-main-v1` / `trap-main-v1`）时必须强制执行四道自动化校验：并发活动运行态守卫（禁止在仍有 `running` 状态的 `probe_runs` 时冻结）、通用模型裸答标定的 `easy` 题占比上限、主库 `video_splits.split = 'test'` 分区核验，以及与主库全部训练集问题的字符 2-gram Jaccard 相似度审计。
