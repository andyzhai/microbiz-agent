import { openRouterGateway } from "../src/openrouter.js";
import { roles } from "../src/policy.js";
import { runExpense } from "../src/workflow.js";

// A functional probe per model. Pin the candidate so fallback cannot mask a failure.
const key = process.env.OPENROUTER_API_KEY;
const [role = "LOCAL_MODEL", fixture = "receipt-normal", ...extra] = process.argv.slice(2);
if (extra.length || (role !== "LOCAL_MODEL" && role !== "CLOUD_MODEL") ||
    (fixture !== "receipt-normal" && fixture !== "receipt-duplicate")) {
  console.error("Usage: npm run probe -- [LOCAL_MODEL|CLOUD_MODEL] [receipt-normal|receipt-duplicate]");
  process.exitCode = 1;
} else if (!key?.trim()) {
  console.error("Live capability probes require OPENROUTER_API_KEY.");
  process.exitCode = 1;
} else {
  const maxPosts = fixture === "receipt-normal" ? 1 : 2;
  const result = await runExpense(fixture, () => openRouterGateway(key, fetch, { onlyRole: role, maxAttempts: 1 + maxPosts }));
  const verified = fixture === "receipt-normal"
    ? result.status === "completed" && result.tools.length === 0 && result.draft?.totalMinor.value === 1250
    : result.status === "needs_review" && result.draft?.totalMinor.value === 2260 &&
      result.issues.length === 1 && result.issues[0]?.code === "possible_duplicate" &&
      result.tools[0]?.outcome === "completed" && result.duplicateCandidates[0]?.id === "prior-017";
  const clean = verified && result.decisions.every(d => d.outcome === "completed");
  console.log(JSON.stringify({ role, model: roles[role], fixture, verified, clean, totalMinor: result.draft?.totalMinor.value,
    matches: result.duplicateCandidates.map(match => match.id), tools: result.tools, decisions: result.decisions }));
  if (!clean) process.exitCode = 1;
}
