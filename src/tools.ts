import { z } from "zod";
import { findExpenseMatches } from "./expense-matches.js";
import type { ExpenseMatch } from "./expense-matches.js";
import { getServiceIncidentEvidence } from "./incident-fixtures.js";
import type { IncidentEvidence } from "./incident-fixtures.js";
import { isTaskFixture } from "./fixtures.js";
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
interface ReadTool<A, R> {
  name: string; task: string; effect: "read"; approvalRequired: false; classification: "synthetic";
  args: z.ZodType<A>; result: z.ZodType<R>;
  inScope(args: A, source: Source): boolean;
  read(source: Source): unknown;
}
export type ToolError = "tool_denied" | "tool_arguments_denied" | "tool_budget_exhausted" | "invalid_tool_result";
type ReadOutcome<T> = ({ exchange: Exchange; error?: never } & T) |
  { error: ToolError; exchange?: never; matches?: never; evidence?: never };
type Executor<T> = (proposal: ToolProposal) => ReadOutcome<T>;

function scopedExecutor<A, R, T>(task: string, source: Source, grants: readonly string[], tool: ReadTool<A, R>,
  expose: (data: R) => T): Executor<T> {
  const allowed = new Set(grants);
  let calls = 0;
  return (proposal: ToolProposal) => {
    if (proposal.name !== tool.name || tool.task !== task || tool.effect !== "read" || tool.approvalRequired ||
        !allowed.has(tool.name) || !isTaskFixture(task, source) || source.classification !== "synthetic" || tool.classification !== "synthetic") return { error: "tool_denied" };
    const args = tool.args.safeParse(proposal.arguments);
    if (!args.success || !tool.inScope(args.data, source))
      return { error: "tool_arguments_denied" } as const;
    if (calls >= 2) return { error: "tool_budget_exhausted" } as const;
    calls++;
    try {
      const result = tool.result.safeParse(tool.read(source));
      if (!result.success) return { error: "invalid_tool_result" };
      const resultJson = JSON.stringify(result.data);
      if (Buffer.byteLength(resultJson) > 2048) return { error: "invalid_tool_result" };
      // Reconstruct one assistant/tool turn without replaying arbitrary provider history.
      const exchange = Object.freeze({ source, classification: source.classification, name: tool.name,
        argumentsJson: JSON.stringify(args.data), resultJson });
      exchanges.add(exchange);
      return { exchange, ...expose(result.data) };
    } catch {
      return { error: "invalid_tool_result" };
    }
  };
}

type ExpenseRead = { matches: ExpenseMatch[] };
type IncidentRead = { evidence: IncidentEvidence };
export function createExecutor(task: "operations-triage", source: Source, grants: readonly string[]): Executor<IncidentRead>;
export function createExecutor(task: "expense-review", source: Source, grants: readonly string[]): Executor<ExpenseRead>;
export function createExecutor(task: string, source: Source, grants: readonly string[]): Executor<ExpenseRead | IncidentRead>;
export function createExecutor(task: string, source: Source, grants: readonly string[]) {
  if (task === getServiceIncidentEvidence.task) {
    return scopedExecutor(task, source, grants, getServiceIncidentEvidence, evidence => ({ evidence }));
  }
  return scopedExecutor(task, source, grants, findExpenseMatches, matches => ({ matches }));
}
