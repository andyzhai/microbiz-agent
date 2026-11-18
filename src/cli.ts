import "./offline.js";
import { runObjective } from "./coordinator.js";
import { fakeModel } from "./fake-model.js";
import { fixtureIds } from "./fixtures.js";
import { createGateway } from "./gateway.js";
import type { ModelAdapter } from "./gateway.js";
import { alertIds, loadAlert } from "./incident-fixtures.js";
import { runOperations } from "./operations.js";
import { openRouterGateway } from "./openrouter.js";
import { runExpense } from "./workflow.js";

const args = process.argv.slice(2);
const live = args[0] === "--live";
const inputs = live ? args.slice(1) : args;
const objective = inputs[0] === "--objective";
const simulateFailure = !live && objective && inputs.length === 3 && inputs[2] === "--simulate-expense-failure";
const id = inputs[objective ? 1 : 0];
if (!id || id === "--help" || (inputs.length !== (objective ? 2 : 1) && !simulateFailure)) {
  console.log(`Usage: npm run demo -- [--live] <fixture-id>\n       npm run demo -- [--live] --objective daily-review\n       npm run demo -- --objective daily-review --simulate-expense-failure\nReceipts: ${fixtureIds.join(", ")}\nService alerts: ${alertIds.join(", ")}\nDefault is offline. --live uses OPENROUTER_API_KEY and the two configured free external models.\nExit codes: 0 completed, 2 needs review, 1 blocked/failed/invalid arguments.`);
  process.exitCode = !live && args.length === 1 && args[0] === "--help" ? 0 : 1;
} else if (live && !process.env.OPENROUTER_API_KEY?.trim()) {
  console.error(JSON.stringify({ status: "blocked", issues: [{ code: "missing_openrouter_key" }] }));
  process.exitCode = 1;
} else {
  try {
    const offline: ModelAdapter = simulateFailure ? { ...fakeModel, generate(request, signal) {
      if (request.instruction.task === "expense-review") throw new Error("Simulated expense outage");
      return fakeModel.generate(request, signal);
    } } : fakeModel;
    const makeGateway = live ? () => openRouterGateway(process.env.OPENROUTER_API_KEY!) : () => createGateway(offline);
    const run = objective ? runObjective : loadAlert(id) ? runOperations : runExpense;
    const result = await run(id, makeGateway);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "completed" ? 0 : result.status === "needs_review" ? 2 : 1;
  } catch {
    console.error(JSON.stringify({ status: "failed", issues: [{ code: "workflow_failed" }] }));
    process.exitCode = 1;
  }
}
