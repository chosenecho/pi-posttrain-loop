import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root directory (two levels up from `src/shared/paths.ts`). */
export const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const DEFAULT_MAIN_DB = join(PROJECT_ROOT, "data/data-maker.sqlite");
export const DEFAULT_EVAL_DB = join(PROJECT_ROOT, "data/eval.sqlite");
export const DEFAULT_DEMO_DB = join(PROJECT_ROOT, "output/demo.sqlite");
export const DEFAULT_CORPUS_DIR = join(PROJECT_ROOT, "data/weimingzi-semantic");
export const DEFAULT_PROMPTS_DIR = join(PROJECT_ROOT, "prompts");
export const NO_SKILL_PROMPTS_DIR = join(PROJECT_ROOT, "prompts/no-skill");
export const DEFAULT_EVAL_PROMPTS_DIR = join(PROJECT_ROOT, "prompts/eval");
export const DEFAULT_SKILLS_DIR = join(PROJECT_ROOT, "skills");
export const DEFAULT_EVAL_SKILLS_DIR = join(PROJECT_ROOT, "skills/eval");
export const EXAMPLE_MATERIALS_PATH = join(PROJECT_ROOT, "data/materials.example.jsonl");
