import "./offline.js";
import { fixtureIds } from "./fixtures.js";
import { openRouterGateway } from "./openrouter.js";
import { runExpense } from "./workflow.js";

const args = process.argv.slice(2);
const live = args[0] === "--live";
const ids = live ? args.slice(1) : args;
if (ids.length !== 1 || ids[0] === "--help") {
  console.log(`Usage: npm run demo -- [--live] <fixture-id>\nFixtures: ${fixtureIds.join(", ")}\nDefault is offline. --live uses OPENROUTER_API_KEY and the two configured free external models.\nExit codes: 0 completed, 2 needs review, 1 blocked/failed/invalid arguments.`);
  process.exitCode = !live && args.length === 1 && args[0] === "--help" ? 0 : 1;
} else if (live && !process.env.OPENROUTER_API_KEY?.trim()) {
  console.error(JSON.stringify({ status: "blocked", issues: [{ code: "missing_openrouter_key" }] }));
  process.exitCode = 1;
} else {
  try {
    const result = await runExpense(ids[0]!, live ? () => openRouterGateway(process.env.OPENROUTER_API_KEY!) : undefined);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "completed" ? 0 : result.status === "needs_review" ? 2 : 1;
  } catch {
    console.error(JSON.stringify({ status: "failed", issues: [{ code: "workflow_failed" }] }));
    process.exitCode = 1;
  }
}
