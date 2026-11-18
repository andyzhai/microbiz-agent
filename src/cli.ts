import "./offline.js";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { exportReviewedArtifact } from "./artifact.js";
import type { ArtifactPreview } from "./artifact.js";
import { approvalMinutes, manageReview, startReview } from "./durable-review.js";
import { ReviewError } from "./review-store.js";
import { runObjective } from "./coordinator.js";
import { fakeModel } from "./fake-model.js";
import { fixtureIds } from "./fixtures.js";
import { createGateway } from "./gateway.js";
import type { ModelAdapter } from "./gateway.js";
import { alertIds, loadAlert } from "./incident-fixtures.js";
import { runOperations } from "./operations.js";
import { openRouterGateway } from "./openrouter.js";
import { runExpense } from "./workflow.js";

async function confirmExport(review: ArtifactPreview, durable = false) {
  const answer = "approve " + randomBytes(4).toString("hex");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    console.log(`Validation passed for ${review.fixtureId}. The export path is ${review.destination}`);
    console.log(durable ? `Approval lasts ${approvalMinutes} minutes. It creates the file or records an existing file with the same digest.` :
      "Approval creates one new file.");
    console.log(`UTF-8 content (SHA-256 ${review.sha256})\n--- begin file ---`);
    process.stdout.write(review.content);
    const effect = durable ? "approve this export" : "create the file";
    console.log(`--- end file ---\nType "${answer}" to ${effect}. Any other answer cancels.`);
    for await (const line of lines) return line === answer;
    return false;
  } finally {
    lines.close();
  }
}

const args = process.argv.slice(2);
const live = args[0] === "--live";
const options = live ? args.slice(1) : args;
const mcp = options[0] === "--mcp";
const inputs = mcp ? options.slice(1) : options;
const objective = inputs[0] === "--objective";
const exporting = inputs[0] === "--export";
const reviewing = inputs[0] === "--review";
const management = (["--inspect", "--resume", "--cancel", "--cleanup"] as const).find(command => command === inputs[0]);
const simulateFailure = !live && objective && inputs.length === 3 && inputs[2] === "--simulate-expense-failure";
const hasCommand = objective || exporting || reviewing || !!management;
const id = inputs[hasCommand ? 1 : 0];
if (!id || id === "--help" || (management && (live || mcp)) || (mcp && !objective && !loadAlert(id)) ||
    (inputs.length !== (hasCommand ? 2 : 1) && !simulateFailure)) {
  console.log(`Usage: npm run demo -- [--live] [--mcp] [--export | --review] <fixture-id>
       npm run demo -- <--inspect | --resume | --cancel | --cleanup> <run-id>
       npm run demo -- [--live] [--mcp] --objective daily-review
       npm run demo -- --objective daily-review --simulate-expense-failure
Receipts: ${fixtureIds.join(", ")}
Service alerts: ${alertIds.join(", ")}
Default is offline. --live uses OPENROUTER_API_KEY and the two configured free external models.
--mcp reads service evidence from LocalBridge using LOCALBRIDGE_ACCESS_TOKEN.
Exit codes: 0 completed, 2 needs review/cancelled, 1 blocked/failed/invalid arguments.`);
  process.exitCode = !live && args.length === 1 && args[0] === "--help" ? 0 : 1;
} else if (live && !process.env.OPENROUTER_API_KEY?.trim()) {
  console.error(JSON.stringify({ status: "blocked", issues: [{ code: "missing_openrouter_key" }] }));
  process.exitCode = 1;
} else if (mcp && !process.env.LOCALBRIDGE_ACCESS_TOKEN?.trim()) {
  console.error(JSON.stringify({ status: "blocked", issues: [{ code: "missing_localbridge_access_token" }] }));
  process.exitCode = 1;
} else if (management) {
  try {
    const outcome = await manageReview(management, id, preview => confirmExport(preview, true));
    console.log(JSON.stringify(outcome));
    process.exitCode = management === "--resume" && outcome.status === "cancelled" ? 2 : 0;
  } catch (error) {
    reportReviewError(error);
  }
} else {
  try {
    const offline: ModelAdapter = simulateFailure ? { ...fakeModel, generate(request, signal) {
      if (request.instruction.task === "expense-review") throw new Error("Simulated expense outage");
      return fakeModel.generate(request, signal);
    } } : fakeModel;
    const makeGateway = live ? () => openRouterGateway(process.env.OPENROUTER_API_KEY!) : () => createGateway(offline);
    const backend = mcp ? "localbridge" : "direct";
    const result = objective ? await runObjective(id, makeGateway, backend) :
      loadAlert(id) ? await runOperations(id, makeGateway, undefined, backend) : await runExpense(id, makeGateway);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "completed" ? 0 : result.status === "needs_review" ? 2 : 1;
    if (reviewing && "task" in result && result.status === "completed") {
      console.log(JSON.stringify(await startReview(result)));
      process.exitCode = 2;
    } else if (exporting && "task" in result) {
      const outcome = await exportReviewedArtifact(result, confirmExport);
      console.log(JSON.stringify(outcome));
      if (result.status === "completed") process.exitCode = outcome.status === "exported" ? 0 : outcome.status === "cancelled" ? 2 : 1;
    }
  } catch (error) {
    reportReviewError(error);
  }
}

function reportReviewError(error: unknown) {
  if (error instanceof ReviewError) console.error(JSON.stringify({ status: "blocked", reason: error.message }));
  else console.error(JSON.stringify({ status: "failed", issues: [{ code: "workflow_failed" }] }));
  process.exitCode = 1;
}
