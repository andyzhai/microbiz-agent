import assert from "node:assert/strict";
import { test } from "node:test";
import { expenseSchema } from "../src/expense.js";
import { fakeModel } from "../src/fake-model.js";
import { openRouterGateway } from "../src/openrouter.js";
import { evaluate } from "./evaluate-expenses.js";

test("eight held-out fixtures produce schema-valid drafts and flag the inconsistent sum", async () => {
  const { scores, outcomes } = await evaluate();
  assert.equal(scores.cases, 8);
  assert.equal(scores.validatedDrafts, 8);
  assert.equal(scores.arithmeticCorrect, 2);
  assert.equal(scores.criticalPresent, 29);
  assert.equal(scores.categoryPresent, 7);
  assert.equal(scores.missingReferenceValues, 4);
  assert.equal(outcomes.find(row => row.id === "hold-07")?.status, "needs_review");
});

test("a rejected item citation affects evidence coverage independently of category accuracy", async () => {
  const baseline = await evaluate();
  const invalidCitations = await evaluate({ ...fakeModel, async generate(request, signal) {
    const draft = expenseSchema.parse(await fakeModel.generate(request, signal));
    if (draft.category.value !== null) draft.category.evidence = "L1"; // Merchant rather than the item.
    return draft;
  } });
  assert.equal(invalidCitations.scores.categoryCorrect, baseline.scores.categoryCorrect);
  assert.equal(invalidCitations.scores.citedCategories, 0);
  assert.ok(baseline.scores.citedCategories > baseline.scores.categoryCorrect);
});

test("the held-out batch stops at the first catalog rate limit", async () => {
  let requests = 0;
  const result = await evaluate(() => openRouterGateway("test-key", async () => {
    requests++;
    return new Response(null, { status: 429 });
  }));
  assert.equal(requests, 1);
  assert.equal(result.scores.cases, 1);
  assert.equal(result.outcomes[0]?.reason, "rate_limited");
});
