import "./offline.js";
import { fixtureIds } from "./fixtures.js";
import { runExpense } from "./workflow.js";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === "--help") {
  console.log(`Usage: npm run demo -- <fixture-id>\nFixtures: ${fixtureIds.join(", ")}\nOffline fake model. Output is a draft; no state is saved.\nExit codes: 0 completed, 2 needs review, 1 blocked/failed/invalid arguments.`);
  process.exitCode = args.length === 1 && args[0] === "--help" ? 0 : 1;
} else {
  try {
    const result = await runExpense(args[0]!);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "completed" ? 0 : result.status === "needs_review" ? 2 : 1;
  } catch {
    console.error(JSON.stringify({ status: "failed", issues: [{ code: "workflow_failed" }] }));
    process.exitCode = 1;
  }
}
