import { readFile } from "node:fs/promises";
import { normalizeText, sha256Hex } from "./utils.js";
import type { Skill } from "./types.js";

/** True when a skill path lives under the isolated test-set skill tree `skills/eval/`. */
export function isEvalSkillPath(path: string): boolean {
  return /(^|[\\/])skills[\\/]eval[\\/]/.test(path);
}

/** Raw skill reader shared by the training loop and the isolated eval loop (callers enforce their own whitelist). */
export async function readSkillFile(path: string, label: string): Promise<Skill> {
  const text = normalizeText(await readFile(path, "utf8"));
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
  return { status, body, sha256: sha256Hex(text) };
}
