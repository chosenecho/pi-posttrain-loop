/** One attempt's non-refundable execution allowance. claim is synchronous by contract. */
export interface CallBudget {
  claim(toolCallId: string): { sequence: number } | undefined;
}

export function createCallBudget(limit: number): CallBudget {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("工具预算必须是非负整数");
  let claimed = 0;
  return {
    claim(_toolCallId) {
      if (claimed >= limit) return undefined;
      return { sequence: ++claimed };
    },
  };
}
