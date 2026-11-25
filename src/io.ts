import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { errorMessage, parseMaterial } from "./schema.js";
import type { Material, Rubric, Skill } from "./types.js";

export const DEFAULT_QUESTION_SKILL = fileURLToPath(new URL("../skills/question-design/SKILL.md", import.meta.url));
export const DEFAULT_FOLLOWUP_SKILL = fileURLToPath(new URL("../skills/followup-strategy/SKILL.md", import.meta.url));
export const DEFAULT_ANSWER_STYLE = fileURLToPath(new URL("../skills/answer-style/SKILL.md", import.meta.url));
export const DEFAULT_QUALITY_JUDGE = fileURLToPath(new URL("../skills/quality-judge/SKILL.md", import.meta.url));
export const DEFAULT_EVAL_RUBRIC_SKILL = fileURLToPath(new URL("../skills/eval-rubric/SKILL.md", import.meta.url));

export const SHORT_QUESTION_SKILL = fileURLToPath(new URL("../skills/short/question-design/SKILL.md", import.meta.url));
export const SHORT_FOLLOWUP_SKILL = fileURLToPath(new URL("../skills/short/followup-strategy/SKILL.md", import.meta.url));
export const SHORT_ANSWER_STYLE = fileURLToPath(new URL("../skills/short/answer-style/SKILL.md", import.meta.url));
export const SHORT_QUALITY_JUDGE = fileURLToPath(new URL("../skills/short/quality-judge/SKILL.md", import.meta.url));

export const TRAP_QUESTION_SKILL = fileURLToPath(new URL("../skills/trap/question-design/SKILL.md", import.meta.url));
export const TRAP_FOLLOWUP_SKILL = fileURLToPath(new URL("../skills/trap/followup-strategy/SKILL.md", import.meta.url));
export const TRAP_ANSWER_STYLE = fileURLToPath(new URL("../skills/trap/answer-style/SKILL.md", import.meta.url));
export const TRAP_QUALITY_JUDGE = fileURLToPath(new URL("../skills/trap/quality-judge/SKILL.md", import.meta.url));

export async function readMaterials(path: string): Promise<Material[]> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  const seen = new Set<string>();
  const materials: Material[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let material: Material;
    try {
      material = parseMaterial(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`输入第 ${index + 1} 行：${errorMessage(error)}`);
    }
    if (seen.has(material.id)) throw new Error(`材料 id 重复：${material.id}`);
    seen.add(material.id);
    materials.push(material);
  }
  if (!materials.length) throw new Error("输入文件中没有材料");
  return materials;
}

/** True when a skill path lives under the isolated test-set skill tree `skills/eval/`. */
export function isEvalSkillPath(path: string): boolean {
  return /(^|[\\/])skills[\\/]eval[\\/]/.test(path);
}

async function readSkill(path: string, label: string): Promise<Skill> {
  if (isEvalSkillPath(path)) {
    throw new Error(`${label}：训练 Loop 禁止加载测试集专用 Skill（skills/eval/*）：${path}`);
  }
  return readSkillFile(path, label);
}

/** Raw skill reader shared by the training loop and the isolated eval loop (callers enforce their own whitelist). */
export async function readSkillFile(path: string, label: string): Promise<Skill> {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${label} 需要 YAML frontmatter，并设置 status: placeholder 或 ready`);
  const statuses = [...match[1].matchAll(/^status:\s*(placeholder|ready)\s*$/gm)];
  if (statuses.length !== 1) throw new Error(`${label} 必须恰好设置一次 status: placeholder 或 ready`);
  const status = statuses[0][1] as Skill["status"];
  const body = match[2].trim();
  if (!body) throw new Error(`${label} 正文为空`);
  if (status === "ready" && /\bTODO\b|占位模式的输出/.test(body)) {
    throw new Error(`${label} 仍含 TODO 或占位输出段，请先填写规则再启用 ready`);
  }
  return { status, body, sha256: createHash("sha256").update(text).digest("hex") };
}

export function readQuestionSkill(path = DEFAULT_QUESTION_SKILL): Promise<Skill> {
  return readSkill(path, "出题 Skill");
}

export function readFollowupSkill(path = DEFAULT_FOLLOWUP_SKILL): Promise<Skill> {
  return readSkill(path, "追问 Skill");
}

export function readAnswerStyle(path = DEFAULT_ANSWER_STYLE): Promise<Skill> {
  return readSkill(path, "回答风格 Skill");
}

export function readRubric(path = DEFAULT_QUALITY_JUDGE): Promise<Rubric> {
  return readSkill(path, "判断 Skill");
}

export function readEvalRubricSkill(path = DEFAULT_EVAL_RUBRIC_SKILL): Promise<Skill> {
  return readSkill(path, "评测要点 Skill");
}
