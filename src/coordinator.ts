import { findExpenseMatches } from "./expense-matches.js";
import { fakeModel } from "./fake-model.js";
import { loadFixture } from "./fixtures.js";
import { createGateway } from "./gateway.js";
import { getServiceIncidentEvidence, loadAlert } from "./incident-fixtures.js";
import { runOperations } from "./operations.js";
import type { OperationsResult } from "./operations.js";
import type { TaskResult } from "./task.js";
import { runExpense } from "./workflow.js";
import type { ExpenseResult } from "./workflow.js";

const dailyReview = [
  { task: findExpenseMatches.task, source: loadFixture("receipt-normal")!, grants: [findExpenseMatches.name], maxAttempts: 2 },
  { task: getServiceIncidentEvidence.task, source: loadAlert("alert-normal")!, grants: [getServiceIncidentEvidence.name], maxAttempts: 3 },
] as const;
type ChildResult = ExpenseResult | OperationsResult;
interface Unavailable extends TaskResult {
  task: ChildResult["task"];
  status: "failed" | "blocked";
  issues: readonly { code: string }[];
}
function headline(result: ChildResult | Unavailable): string {
  const issue = result.issues[0]?.code;
  if (!("tools" in result)) {
    if (issue === "attempt_budget_exhausted") return "Skipped because the shared attempt budget was spent.";
    if (issue === "rate_limited") return "Skipped because the provider rate-limited the run.";
    return `${result.task} ${result.status} (${issue}).`;
  }
  if (result.status === "failed" || result.status === "blocked") {
    const reason = issue === "model_request_failed" ? result.decisions.at(-1)?.reason : issue;
    return `${result.task} ${result.status} (${reason}).`;
  }
  if (result.task === "expense-review") {
    const draft = result.draft;
    if (draft && draft.totalMinor.value !== null && draft.currency.value)
      return `${draft.merchant.value ?? "Expense"} receipt totals ${draft.currency.value} ${(draft.totalMinor.value / 100).toFixed(2)} (${draft.totalMinor.evidence}).`;
    return "Expense total needs review.";
  }
  const trend = result.report?.observations.find(item => item.finding.startsWith("error_rate_"));
  if (trend) {
    const [before, after] = trend.evidenceIds.map(id => result.evidence?.samples.find(sample => sample.id === id));
    if (before && after)
      return `${result.scope?.service} error rate went from ${before.errorPercent}% to ${after.errorPercent}% (${before.id}, ${after.id}).`;
  }
  return "See the service observations and evidence gaps.";
}

export async function runObjective(objective: string, makeGateway = () => createGateway(fakeModel)) {
  const children: (ChildResult | Unavailable)[] = [];
  if (objective !== "daily-review") return { objective: null, status: "blocked" as const,
    issues: [{ code: "unsupported_objective" }], budget: null, briefing: [], children };

  const gateway = makeGateway();
  for (const { task, source, grants, maxAttempts } of dailyReview) {
    const base = { task, fixtureId: source.id, classification: source.classification };
    const stop = gateway.stopReason;
    if (stop) {
      children.push({ ...base, status: "blocked", issues: [{ code: stop }], decisions: [] });
      continue;
    }
    const child = gateway.forTask(task, source, maxAttempts);
    try {
      const result = task === "expense-review" ? await runExpense(source.id, () => child, grants) :
        await runOperations(source.id, () => child, grants);
      if (result.classification !== "synthetic" || result.fixtureId !== source.id || result.task !== task) {
        children.push({ ...base, classification: result.classification, status: "blocked",
          issues: [{ code: "result_scope_denied" }], decisions: [] });
      } else {
        children.push(result);
      }
    } catch {
      children.push({ ...base, status: "failed", issues: [{ code: "workflow_failed" }], decisions: child.decisions });
    }
  }
  const severity = ["failed", "blocked", "needs_review"] as const;
  const status = severity.find(s => children.some(child => child.status === s)) ?? "completed";
  const briefing = children.map(child => ({ task: child.task, fixtureId: child.fixtureId,
    classification: child.classification, status: child.status, headline: headline(child) }));
  return { objective, status, budget: gateway.budget, briefing, children };
}
