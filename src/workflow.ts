import "./offline.js";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { expenseSchema, validateExpense } from "./expense.js";
import type { ExpenseDraft, ReviewIssue } from "./expense.js";
import { findExpenseMatches } from "./expense-matches.js";
import type { ExpenseMatch } from "./expense-matches.js";
import { fakeModel } from "./fake-model.js";
import { loadFixture } from "./fixtures.js";
import type { GatewayResult } from "./gateway.js";
import { taskGateway } from "./task.js";
import type { GatewayConfig, TaskResult } from "./task.js";
import { finish, lookup, propose } from "./profiles.js";
import { createExecutor, toolProposalSchema } from "./tools.js";

const firstResponse = z.union([expenseSchema, toolProposalSchema]);
export interface ExpenseResult extends TaskResult {
  task: "expense-review";
  draft: ExpenseDraft | null;
  duplicateCandidates: readonly ExpenseMatch[];
  issues: readonly (ReviewIssue | { code: "unknown_fixture" | "model_request_failed" | "tool_denied" | "tool_arguments_denied" |
    "tool_budget_exhausted" | "invalid_tool_result" })[];
  tools: readonly { name: "findExpenseMatches" | "unregistered"; outcome: "completed" | "blocked" | "failed" }[];
}

export async function runExpense(fixtureId: string, config: GatewayConfig = fakeModel,
  grants: readonly string[] = [findExpenseMatches.name]): Promise<ExpenseResult> {
  const task = "expense-review";
  const source = loadFixture(fixtureId);
  if (!source) return { task, fixtureId: null, classification: "unknown", status: "blocked", draft: null,
    duplicateCandidates: [], issues: [{ code: "unknown_fixture" }], decisions: [], tools: [] };
  const gateway = taskGateway(config);
  const execute = createExecutor(task, source, grants);
  const possiblePreviousSubmission = source.content.includes("previously submitted");
  const base = { task, fixtureId: source.id, classification: source.classification, draft: null,
    decisions: gateway.decisions, duplicateCandidates: [], tools: [] } as const;
  const State = Annotation.Root({
    proposal: Annotation<GatewayResult<z.infer<typeof firstResponse>>>(),
    result: Annotation<ExpenseResult>(),
  });
  const graph = new StateGraph(State)
    .addNode("propose", async () => ({
      proposal: await gateway.generate({ instruction: possiblePreviousSubmission ? lookup : propose, sources: [source] }, firstResponse),
    }))
    .addNode("validate", async (state): Promise<{ result: ExpenseResult }> => {
      const proposal = state.proposal;
      if (proposal.status !== "completed") return { result: { ...base, status: proposal.status, issues: [{ code: "model_request_failed" }] } };
      let draft: ExpenseDraft;
      let matches: ExpenseMatch[] = [];
      const tools: ExpenseResult["tools"][number][] = [];
      if ("name" in proposal.value) {
        const lookup = execute(proposal.value);
        const name = proposal.value.name === findExpenseMatches.name ? findExpenseMatches.name : "unregistered";
        if (lookup.error) {
          const status = lookup.error === "invalid_tool_result" ? "failed" : "blocked";
          return { result: { ...base, status, issues: [{ code: lookup.error }], tools: [{ name, outcome: status }] } };
        }
        matches = lookup.matches;
        tools.push({ name, outcome: "completed" });
        const final = await gateway.generate({ instruction: finish, sources: [source], exchange: lookup.exchange }, expenseSchema);
        if (final.status !== "completed") return { result: { ...base, status: final.status, tools, duplicateCandidates: matches,
          issues: [{ code: "model_request_failed" }] } };
        draft = final.value;
      } else draft = proposal.value;
      const validated = validateExpense(draft, source);
      if (matches.length) validated.issues.push({ code: "possible_duplicate" });
      else if (!tools.length && possiblePreviousSubmission) validated.issues.push({ code: "lookup_needed" });
      return { result: { ...base, ...validated, status: validated.issues.length ? "needs_review" : "completed",
        tools, duplicateCandidates: matches } };
    })
    .addEdge(START, "propose").addEdge("propose", "validate").addEdge("validate", END).compile();
  return (await graph.invoke({}, { recursionLimit: 4, callbacks: [] })).result;
}
