import type { ExpenseDraft } from "../src/expense.js";
import { openRouterGateway } from "../src/openrouter.js";
import { runExpense } from "../src/workflow.js";

const critical = ["merchant", "date", "currency", "totalMinor"] as const;
type Expected = [string | null, string | null, "CAD", number | null, ExpenseDraft["category"]["value"]];
const reference: Readonly<Record<string, Expected>> = {
  "hold-01": ["Alder Stationery", "2026-03-01", "CAD", 904, "office_supplies"],
  "hold-02": ["Blue Tram", "2026-03-02", "CAD", 350, "travel"],
  "hold-03": ["Elm Cafe", "2026-03-03", "CAD", 1840, "meals"],
  "hold-04": [null, "2026-03-04", "CAD", 200, "office_supplies"],
  "hold-05": ["Ash Ferry", null, "CAD", 1000, "travel"],
  "hold-06": ["Oak Supply", "2026-03-06", "CAD", null, "office_supplies"],
  "hold-07": ["Birch Grill", "2026-03-07", "CAD", 1200, "meals"],
  "hold-08": ["Cedar Works", "2026-03-08", "CAD", 725, null],
};

export async function evaluate(config?: Parameters<typeof runExpense>[1]) {
  const scores = { cases: 0, validatedDrafts: 0, withoutDraft: 0, arithmeticChecks: 0, arithmeticCorrect: 0,
    criticalCorrect: 0, criticalPresent: 0, categoryCorrect: 0, categoryPresent: 0,
    citedCategories: 0, proposedCategories: 0,
    correctAbstentions: 0, missingReferenceValues: 0, unsupportedGuesses: 0 };
  const outcomes = [];
  for (const [id, expected] of Object.entries(reference)) {
    const result = await runExpense(id, config);
    scores.cases++;
    if (result.draft) scores.validatedDrafts++;
    else scores.withoutDraft++;
    const unsupported = result.issues.flatMap(issue => issue.code === "unsupported_value" && issue.field ? [issue.field] : []);
    scores.unsupportedGuesses += unsupported.length;
    const rejectedCitation = result.issues.find(issue => issue.code === "invalid_category_evidence");
    const proposedCategory = rejectedCitation?.proposedCategory ?? result.draft?.category.value;
    if (proposedCategory != null) scores.proposedCategories++;
    if (result.draft?.category.evidence) scores.citedCategories++;
    for (const [index, field] of [...critical, "category" as const].entries()) {
      const prediction = field === "category" ? proposedCategory : result.draft?.[field].value;
      if (expected[index] === null) {
        scores.missingReferenceValues++;
        if (prediction === null && !unsupported.includes(field)) scores.correctAbstentions++;
      } else if (field === "category") {
        scores.categoryPresent++;
        if (prediction === expected[index]) scores.categoryCorrect++;
      } else {
        scores.criticalPresent++;
        if (prediction === expected[index]) scores.criticalCorrect++;
      }
    }
    if (id === "hold-01" || id === "hold-07") {
      scores.arithmeticChecks++;
      const draft = result.draft;
      const mismatch = result.issues.some(i => i.code === "arithmetic_mismatch");
      if (draft && draft.subtotalMinor.value !== null && draft.taxMinor.value !== null &&
          draft.totalMinor.value !== null && mismatch === (id === "hold-07")) scores.arithmeticCorrect++;
    }
    outcomes.push({ id, status: result.status, reason: result.decisions.at(-1)?.reason,
      models: [...new Set(result.decisions.filter(d => d.route !== "catalog" && d.outcome !== "blocked").map(d => d.model))] });
    if (result.decisions.some(d => d.reason === "rate_limited")) break;
  }
  return { scores, outcomes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const live = args.length === 1 && args[0] === "--live";
  if (args.length && !live) throw new Error("Usage: npm run evaluate -- [--live]");
  const key = process.env.OPENROUTER_API_KEY;
  if (live && !key?.trim()) {
    console.error("Live evaluation requires OPENROUTER_API_KEY.");
    process.exitCode = 1;
  } else {
    const result = await evaluate(live ? () => openRouterGateway(key!, fetch, { onlyRole: "LOCAL_MODEL", maxAttempts: 2 }) : undefined);
    console.log(JSON.stringify({ mode: live ? "live" : "offline baseline", ...result }, null, 2));
    if (result.scores.withoutDraft) process.exitCode = 1;
  }
}
