export interface Material {
  id: string;
  text: string;
}

export type DatasetSplit = "train" | "test" | "dpo";
export type SplitAssignMethod = "backfill" | "hash" | "manual";
export type DedupPolicy = "latest" | "earliest" | "error";

export type SynthProfile = "standard" | "short" | "medium" | "long" | "xlong" | "trap" | "search";

export const ALL_SYNTH_PROFILES = [
  "standard",
  "short",
  "medium",
  "long",
  "xlong",
  "trap",
  "search",
] as const;

/** The 6 Skill-driven length/type profiles run per video so train distribution emerges naturally. */
export const TRAIN_SUITE_PROFILES = [
  "short",
  "medium",
  "long",
  "xlong",
  "trap",
  "search",
] as const;

export type Role = "question" | "answer" | "judge";
export type DialogueRole = Role | "followup";

/** Roles used only by the isolated test-set probe pipeline (src/eval/*). */
export type EvalRole =
  | "probe_writer"
  | "probe_critic"
  | "reference"
  | "verifier"
  | "adversary"
  | "bare_answer"
  | "eval_grader"
  | "candidate";

export type SystemPrompts = Record<Role, string>;

export interface RoleRequest {
  role: DialogueRole | EvalRole;
  systemPrompt: string;
  input: Record<string, unknown>;
}

export type RoleRunner = (request: RoleRequest) => Promise<string>;

export type FollowupDecision =
  | { action: "followup"; user: string }
  | { action: "stop" };

export interface Skill {
  status: "placeholder" | "ready";
  body: string;
  sha256: string;
}

export type Rubric = Skill;

export interface SkillSnapshot {
  name: string;
  path?: string;
  status: Skill["status"];
  body: string;
  sha256: string;
}

export interface Review {
  decision: "pass" | "revise" | "drop";
  issues: string[];
  feedback: string;
}

export interface ToolStep {
  stepNo: number;
  toolName: string;
  arguments: Record<string, unknown>;
  toolOutput: string;
  preCallThought?: string | null;
}

export interface SearchAnswerResult {
  answer: string;
  toolSteps: ToolStep[];
}

export type SearchAnswerRunner = (request: RoleRequest) => Promise<SearchAnswerResult>;

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

export interface TrainingToolCall {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface TrainingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: TrainingToolCall[];
  reasoning_content?: string;
}

export interface TrainingSampleLine {
  tools?: ToolDefinition[];
  messages: TrainingMessage[];
}

export interface ResultSample {
  questionId: number;
  materialId: number;
  attempts: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OutcomeSummary {
  questionId: number;
  question: string;
  status: "pending" | "running" | "pass" | "drop" | "exhausted" | "error" | "interrupted";
  attempts: number;
  review?: Review;
  error?: string;
}

export interface VideoUnit {
  videoId: string;
  sourceGroup: string;
  partPaths: string[];
  sourcePath: string;
}
