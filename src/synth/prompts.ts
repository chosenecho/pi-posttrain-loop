import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROMPTS_DIR } from "../shared/paths.js";
import { nonEmpty } from "../shared/schema.js";
import type { Role, SystemPrompts } from "../shared/types.js";

export { DEFAULT_PROMPTS_DIR };

export async function readSystemPrompts(directory = DEFAULT_PROMPTS_DIR): Promise<SystemPrompts> {
  async function load(role: Role): Promise<string> {
    return nonEmpty(await readFile(join(directory, `${role}.md`), "utf8"), `${role} 系统提示词`);
  }
  const [question, answer, judge] = await Promise.all([load("question"), load("answer"), load("judge")]);
  return { question, answer, judge };
}

export async function readQuestionGeneratorPrompt(directory = DEFAULT_PROMPTS_DIR): Promise<string> {
  return nonEmpty(await readFile(join(directory, "question-generator.md"), "utf8"), "问题生成系统提示词");
}

export async function readFollowupPrompt(directory = DEFAULT_PROMPTS_DIR): Promise<string> {
  return nonEmpty(await readFile(join(directory, "followup.md"), "utf8"), "followup 系统提示词");
}

export async function readRubricPrompt(directory = DEFAULT_PROMPTS_DIR): Promise<string> {
  return nonEmpty(await readFile(join(directory, "rubric.md"), "utf8"), "rubric 系统提示词");
}

export function questionPrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<question-design>\n${skillBody}\n</question-design>`;
}

export function followupPrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<followup-strategy>\n${skillBody}\n</followup-strategy>`;
}

export function answerPrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<answer-style>\n${skillBody}\n</answer-style>`;
}

export function judgePrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<judging-skill>\n${skillBody}\n</judging-skill>`;
}

export function evalRubricPrompt(systemPrompt: string, skillBody: string): string {
  return `${systemPrompt}\n\n<eval-rubric>\n${skillBody}\n</eval-rubric>`;
}
