import { z } from "zod";
import { findExpenseMatches } from "./expense-matches.js";
import { isFixture } from "./fixtures.js";
import type { Source } from "./policy.js";

export const toolProposalSchema = z.strictObject({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) });
export interface ToolProposal { name: string; arguments: unknown }
export interface Exchange {
  readonly source: Source;
  readonly classification: Source["classification"];
  readonly name: string;
  readonly argumentsJson: string;
  readonly resultJson: string;
}
const exchanges = new WeakSet<Exchange>();
export function isTrustedExchange(value: Exchange, source: Source): boolean {
  return exchanges.has(value) && value.source === source && value.classification === "synthetic";
}
const registry = new Map([[findExpenseMatches.name as string, findExpenseMatches]]);
export function createExecutor(task: string, source: Source, grants: readonly string[]) {
  const allowed = new Set(grants);
  let calls = 0;
  return (proposal: ToolProposal) => {
    const tool = registry.get(proposal.name);
    if (!tool || tool.task !== task || tool.effect !== "read" || tool.approvalRequired ||
        !allowed.has(tool.name) || !isFixture(source) || source.classification !== "synthetic" || tool.classification !== "synthetic") return { error: "tool_denied" } as const;
    const args = tool.args.safeParse(proposal.arguments);
    if (!args.success || !tool.inScope(args.data, source))
      return { error: "tool_arguments_denied" } as const;
    if (calls >= 2) return { error: "tool_budget_exhausted" } as const;
    calls++;
    const result = tool.result.safeParse(tool.read(source));
    if (!result.success) return { error: "invalid_tool_result" } as const;
    const resultJson = JSON.stringify(result.data);
    if (Buffer.byteLength(resultJson) > 2048) return { error: "invalid_tool_result" } as const;
    // Reconstruct this one assistant/tool turn. No provider prose, IDs or extra arguments are replayed.
    const exchange = Object.freeze({ source, classification: source.classification, name: tool.name,
      argumentsJson: JSON.stringify(args.data), resultJson });
    exchanges.add(exchange);
    return { exchange, matches: result.data } as const;
  };
}
