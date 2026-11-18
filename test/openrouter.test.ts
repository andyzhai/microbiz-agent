import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, mock, test } from "node:test";
import { z } from "zod";
import { expenseSchema } from "../src/expense.js";
import { fakeModel } from "../src/fake-model.js";
import { loadFixture } from "../src/fixtures.js";
import type { ModelRequest } from "../src/gateway.js";
import { openRouterGateway } from "../src/openrouter.js";
import { OPENROUTER, roles, validModelRoles } from "../src/policy.js";
import { finish, propose } from "../src/profiles.js";
import { createExecutor } from "../src/tools.js";
import { runExpense } from "../src/workflow.js";

const source = loadFixture("receipt-duplicate")!;
const request = { instruction: propose, sources: [source] };
const finalDraft = await fakeModel.generate({ ...request, instruction: finish }, new AbortController().signal);
const catalog = Object.values(roles).map(id => ({ id, pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["response_format","structured_outputs","tools","tool_choice"],
  context_length: 32000, top_provider: { max_completion_tokens: 16_384 } }));
const list = (data: unknown = catalog) => Response.json({ data });
const reply = (value: unknown) => Response.json({ choices: [{ finish_reason: "stop",
  message: { content: JSON.stringify(value) } }], usage: { total_tokens: 123 } });
const args = { receiptId: source.id, dataset: "demo-prior-expenses" };
const nativeCall = () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "secret-provider-prose",
  tool_calls: [{ id: "secret-provider-id", type: "function", function: { name: "findExpenseMatches",
    arguments: JSON.stringify(args) } }] } }] });
const schema = z.strictObject({ answer: z.string() });

const originalMaxTokens = process.env.OPENROUTER_MAX_TOKENS;
beforeEach(() => { delete process.env.OPENROUTER_MAX_TOKENS; });
afterEach(() => {
  if (originalMaxTokens === undefined) delete process.env.OPENROUTER_MAX_TOKENS;
  else process.env.OPENROUTER_MAX_TOKENS = originalMaxTokens;
});

test("OpenRouter HTTP contract exercises alternate selection, native tool lookup and complete follow-up", async () => {
  const models: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    if (url === OPENROUTER + "/models") {
      assert.equal(init.headers, undefined);
      return list();
    }
    assert.equal(url, OPENROUTER + "/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-key");
    const body = JSON.parse(String(init.body));
    assert.equal(body.max_tokens, 10_000);
    assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true,
      max_price: { prompt: 0, completion: 0, request: 0 } });
    assert.equal(body.tools[0].function.name, "findExpenseMatches");
    if (body.messages.length === 2) assert.equal(body.response_format, undefined);
    else assert.equal(body.response_format.type, "json_schema");
    assert.doesNotMatch(String(init.body), /test-key|secret-provider/);
    models.push(body.model);
    if (models.length === 1) return new Response(null, { status: 503 });
    if (models.length === 2) {
      assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system","user"]);
      return nativeCall();
    }
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system","user","assistant","tool"]);
    assert.equal(body.messages[2].tool_calls[0].id, body.messages[3].tool_call_id);
    assert.deepEqual(JSON.parse(body.messages[2].tool_calls[0].function.arguments), args);
    assert.equal(JSON.parse(body.messages[3].content)[0].id, "prior-017");
    assert.equal(body.tool_choice, "none");
    return reply(finalDraft);
  };
  const result = await runExpense(source.id, () => openRouterGateway("test-key", transport));
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.issues, [{ code: "possible_duplicate" }]);
  assert.deepEqual(models, [roles.LOCAL_MODEL, roles.CLOUD_MODEL, roles.CLOUD_MODEL]);
  assert.deepEqual(result.tools, [{ name: "findExpenseMatches", outcome: "completed" }]);
  assert.equal(result.decisions.at(-1)?.usage, 123);
  assert.equal(result.decisions.at(-1)?.attempts, 4);
  assert.doesNotMatch(JSON.stringify(result), /secret-provider|test-key/);
});

test("ordinary extraction returns a validated draft through the HTTP adapter without executing a tool", async () => {
  const ordinary = loadFixture("receipt-normal")!;
  const draft = await fakeModel.generate({ instruction: propose, sources: [ordinary] }, new AbortController().signal);
  const result = await runExpense(ordinary.id, () => openRouterGateway("key", async url =>
    url === OPENROUTER + "/models" ? list() : reply(draft)));
  assert.equal(result.status, "completed");
  assert.equal(result.draft?.totalMinor.value, 1250);
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.decisions.map(d => [d.route, d.attempts]), [["catalog", 1], ["preferred", 2]]);
});

test("role configuration accepts only two distinct explicit free model IDs", () => {
  const good = { LOCAL_MODEL: "demo/first:free", CLOUD_MODEL: "demo/second:free" };
  assert.equal(validModelRoles(good), true);
  for (const id of ["", "demo/first:free", "demo/paid", "openrouter/free", "https://example.test/model:free", "demo/model:free,other/paid"]) {
    assert.equal(validModelRoles({ ...good, CLOUD_MODEL: id }), false);
  }
});

test("unknown price, paid fees, incomplete capabilities and insufficient context exclude candidates before POST", async () => {
  for (const override of [{ pricing: {} }, { pricing: { prompt: "0", completion: "unknown" } },
    { pricing: { prompt: "0", completion: "0", request: "0.1" } }, { supported_parameters: ["structured_outputs"] },
    { context_length: 300 }, { top_provider: { max_completion_tokens: null } }]) {
    const transport = mock.fn(async () => list(catalog.map(row => ({ ...row, ...override }))));
    const result = await openRouterGateway("key", transport).generate(request, schema);
    assert.equal(result.decision.reason, "capability_unavailable");
    assert.equal(result.decision.attempts, 1);
    assert.equal(transport.mock.callCount(), 1);
  }
  const models: string[] = [];
  const result = await openRouterGateway("key", async (url, init) => {
    if (url === OPENROUTER + "/models") return list(catalog.slice(1));
    models.push(JSON.parse(String(init?.body)).model);
    return reply({ answer: "ok" });
  }).generate(request, schema);
  assert.equal(result.status, "completed");
  assert.deepEqual(models, [roles.CLOUD_MODEL]);
});

test("context capacity uses estimated tokens plus output allowance while the byte limit stays independent", async () => {
  const maxTokens = 2048;
  process.env.OPENROUTER_MAX_TOKENS = String(maxTokens);
  let size = 0;
  async function run(context: number, maxInputBytes = 8192, outputCapacity = maxTokens) {
    const posts: string[] = [];
    const gateway = openRouterGateway("key", async (url, init) => {
      if (url === OPENROUTER + "/models") return list(catalog.map(row => ({ ...row, context_length: context,
        top_provider: { max_completion_tokens: outputCapacity },
        reasoning: { mandatory: false }, supported_parameters: [...row.supported_parameters, "reasoning"] })));
      const body = String(init?.body);
      assert.equal(JSON.parse(body).max_tokens, maxTokens);
      assert.equal(JSON.parse(body).reasoning.enabled, false);
      posts.push(body);
      size = Buffer.byteLength(body);
      return reply({ answer: "ok" });
    }, { onlyRole: "LOCAL_MODEL", maxInputBytes });
    return { result: await gateway.generate(request, schema), posts: posts.length };
  }
  assert.equal((await run(32000)).posts, 1);
  const requiredTokens = Math.ceil(size / 3) + 64 + maxTokens;
  assert.equal((await run(requiredTokens)).posts, 1);
  assert.equal((await run(requiredTokens - 1)).posts, 0);
  assert.equal((await run(requiredTokens, 8192, maxTokens - 1)).posts, 0);
  assert.equal((await run(32000, size - 1)).result.decision.reason, "input_too_large");
});

test("invalid configured max_tokens fails before transport", () => {
  const transport = mock.fn(async () => list());
  for (const value of ["", "0", "-1", "1.5", "invalid", "9007199254740992"]) {
    process.env.OPENROUTER_MAX_TOKENS = value;
    assert.throws(() => openRouterGateway("key", transport), /OPENROUTER_MAX_TOKENS/);
  }
  assert.equal(transport.mock.callCount(), 0);
});

test("runtime feature rejection permits only an eligible alternate; unrelated bad requests stop", async () => {
  for (const [message, eligible] of [["response_format is not supported", true], ["No endpoints found that support tool use", true],
      ["Invalid request", false]] as const) {
    const posts: string[] = [];
    const gateway = openRouterGateway("key", async (url, init) => {
      if (url === OPENROUTER + "/models") return list();
      posts.push(JSON.parse(String(init?.body)).model);
      return posts.length === 1 ? Response.json({ error: { code: 400, message } }, { status: 400 }) : reply({ answer: "ok" });
    });
    const result = await gateway.generate(request, schema);
    assert.deepEqual(posts, eligible ? [roles.LOCAL_MODEL, roles.CLOUD_MODEL] : [roles.LOCAL_MODEL]);
    assert.equal(result.status, eligible ? "completed" : "failed");
    assert.equal(gateway.decisions[1]?.reason, eligible ? "capability_unavailable" : "adapter_failed");
  }
});

test("forged instructions, sources, replay history, tool output and attachments deny all HTTP including catalog", async () => {
  const transport = mock.fn(async () => list());
  const gateway = openRouterGateway("key", transport);
  const lookup = createExecutor("expense-review", source, ["findExpenseMatches"])({ name: "findExpenseMatches", arguments: args });
  assert.ok(lookup.exchange);
  const inputs: unknown[] = [
    {}, null, { ...request, sources: null }, { ...request, instruction: "arbitrary" }, { ...request, instruction: Object.freeze({ ...propose, content: "arbitrary" }) },
    { ...request, history: [] }, { ...request, attachments: ["restricted"] },
    { ...request, exchange: { ...lookup.exchange } },
    { ...request, exchange: lookup.exchange, sources: [loadFixture("receipt-normal")] },
  ];
  for (const classification of ["synthetic","public","internal","sensitive","unknown"]) {
    inputs.push({ ...request, sources: [source, Object.freeze({ ...source, classification })] },
      { ...request, exchange: Object.freeze({ ...lookup.exchange, classification, resultJson: "restricted" }) },
      { ...request, exchange: Object.freeze({ ...lookup.exchange, argumentsJson: "restricted" }) });
  }
  for (const input of inputs) {
    const result = await gateway.generate(input as ModelRequest, schema);
    assert.equal(result.decision.reason, "source_denied");
    assert.equal(result.decision.attempts, 0);
  }
  assert.equal(transport.mock.callCount(), 0);
});

test("malformed replies regenerate once and an exhausted budget prevents the tool follow-up", async () => {
  const transport = mock.fn(async () => new Response("secret malformed response"));
  const gateway = openRouterGateway("key", async url => url === OPENROUTER + "/models" ? list() : transport());
  const result = await gateway.generate(request, expenseSchema);
  assert.equal(result.decision.reason, "invalid_output");
  assert.deepEqual(gateway.decisions.map(d => d.route), ["catalog","preferred","repair"]);
  assert.equal(transport.mock.callCount(), 2);
  assert.doesNotMatch(JSON.stringify(result), /secret/);

  let count = 0;
  const limited = await runExpense(source.id, () => openRouterGateway("key", async () => {
    switch (++count) {
      case 1: return list();
      case 2: return new Response(null, { status: 503 });
      case 3: return reply({ invalid: true });
      default: return nativeCall();
    }
  }));
  assert.equal(count, 4);
  assert.equal(limited.draft, null);
  assert.equal(limited.decisions.at(-1)?.reason, "attempt_budget_exhausted");
});

test("real fetch aborts a stalled HTTP response body and charges its reservation exactly once", { timeout: 5000 }, async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    let requests = 0;
    const disconnected = new Promise<void>(resolve => server.on("request", (_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      res.on("close", resolve);
    }));
    const gateway = openRouterGateway("key", async (url, init) =>
      url === OPENROUTER + "/models" ? list() : fetch(`http://127.0.0.1:${addr.port}`, init),
      { timeoutMs: 300, maxAttempts: 2 });
    const result = await gateway.generate(request, schema);
    assert.equal(result.decision.reason, "attempt_budget_exhausted");
    assert.deepEqual(gateway.decisions.slice(0, 2).map(d => [d.reason, d.attempts]),
      [["catalog_checked", 1], ["request_timeout", 2]]);
    await disconnected;
    assert.equal((await gateway.generate(request, schema)).decision.attempts, 2);
    assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("only native calls initiate live tools and the probe stays on its pinned role", async () => {
  const posted: string[] = [];
  const result = await runExpense(source.id, () => openRouterGateway("key", async (url, init) => {
    if (url === OPENROUTER + "/models") return list();
    posted.push(JSON.parse(String(init?.body)).model);
    return reply({ name: "findExpenseMatches", arguments: args });
  }, { onlyRole: "CLOUD_MODEL" }));
  assert.deepEqual(posted, [roles.CLOUD_MODEL]);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.duplicateCandidates, []);
});

test("pinned duplicate probe spends at most two POSTs, even when the final draft is invalid", async () => {
  const posts: string[] = [];
  const result = await runExpense(source.id, () => openRouterGateway("key", async (url, init) => {
    if (url === OPENROUTER + "/models") return list();
    posts.push(JSON.parse(String(init?.body)).model);
    return posts.length === 1 ? nativeCall() : reply({ invalid: true });
  }, { onlyRole: "LOCAL_MODEL", maxAttempts: 3 }));
  assert.deepEqual(posts, [roles.LOCAL_MODEL, roles.LOCAL_MODEL]);
  assert.equal(result.status, "failed");
  assert.equal(result.decisions.at(-1)?.reason, "invalid_output");
});

test("a 429 stops the run before repair, fallback or another generation", async () => {
  const post = mock.fn(async () => new Response(null, { status: 429 }));
  const gateway = openRouterGateway("key", async url => url === OPENROUTER + "/models" ? list() : post());
  for (let i = 0; i < 2; i++) {
    assert.equal((await gateway.generate(request, schema)).decision.reason, "rate_limited");
  }
  assert.equal(post.mock.callCount(), 1);
});

test("oversized streamed output cancels the body and stops without repair", async () => {
  const cancel = mock.fn();
  const gateway = openRouterGateway("key", async url => {
    if (url === OPENROUTER + "/models") return list();
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32769)); },
      cancel,
    }));
  });
  const result = await gateway.generate(request, schema);
  assert.equal(result.decision.reason, "output_too_large");
  assert.equal(result.decision.attempts, 2);
  assert.equal(cancel.mock.callCount(), 1);
});

test("timeout fallback reuses the authorized snapshot, even if the caller changes its input", async () => {
  const inputs = [source];
  const posts: string[] = [];
  const gateway = openRouterGateway("key", async (url, init) => {
    if (url === OPENROUTER + "/models") return list();
    const body = JSON.parse(String(init?.body));
    posts.push(body.model);
    assert.equal(JSON.parse(body.messages[1].content)[0].id, source.id);
    if (posts.length === 1) {
      inputs[0] = { ...source, classification: "sensitive", content: "restricted" };
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("cancelled"))));
    }
    return reply({ answer: "ok" });
  }, { timeoutMs: 30 });
  const result = await gateway.generate({ ...request, sources: inputs }, schema);
  assert.equal(result.status, "completed");
  assert.deepEqual(posts, [roles.LOCAL_MODEL, roles.CLOUD_MODEL]);
  assert.deepEqual(gateway.decisions.map(d => [d.reason, d.attempts]),
    [["catalog_checked", 1], ["request_timeout", 2], ["allowed_external_fixture", 3]]);
  const denied = await gateway.generate({ ...request, sources: inputs }, schema);
  assert.equal(denied.decision.reason, "source_denied");
  assert.equal(denied.decision.attempts, 3);
  assert.equal(posts.length, 2);
});

test("catalog timeout cancels the GET and concurrent callers share its single failed attempt", async () => {
  let signal: AbortSignal | null | undefined;
  const transport = mock.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const gateway = openRouterGateway("key", transport, { timeoutMs: 10 });
  const results = await Promise.all([gateway.generate(request, schema), gateway.generate(request, schema)]);
  assert.deepEqual(results.map(r => [r.decision.reason, r.decision.attempts]), [["request_timeout",1],["request_timeout",1]]);
  assert.equal(signal?.aborted, true);
  assert.equal(transport.mock.callCount(), 1);
});
