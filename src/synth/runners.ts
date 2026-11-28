import { createPiRunner } from "../shared/pi-runner.js";
import { createSynthToolRunner } from "./tool-runner.js";
import type { RoleRunner, SearchAnswerRunner } from "../shared/types.js";
import { createMagpieWebSearchRunner, type WebSearchRunner } from "../shared/web-search.js";
import type { ResolvedSynthPlan } from "./plan.js";

/** Bind the resolved tool policy once, preserving explicit runner injection semantics. */
export function createSynthRunners(plan: ResolvedSynthPlan, overrides: {
  runRole?: RoleRunner;
  runSearchAnswer?: SearchAnswerRunner;
  webSearchRunner?: WebSearchRunner;
}): { runRole: RoleRunner; runSearchAnswer?: SearchAnswerRunner } {
  const runRole = overrides.runRole ?? createPiRunner(plan.config);
  const runSearchAnswer = overrides.runSearchAnswer
    ?? (plan.tools.useToolRunner && !overrides.runRole
      ? createSynthToolRunner(
          plan.config,
          plan.tools.enableSearch ? (overrides.webSearchRunner ?? createMagpieWebSearchRunner()) : undefined,
          { profile: plan.profile, enableSearch: plan.tools.enableSearch, simulatorRunner: runRole },
        )
      : undefined);
  return { runRole, ...(runSearchAnswer ? { runSearchAnswer } : {}) };
}
