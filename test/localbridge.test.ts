import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runObjective } from "../src/coordinator.js";
import { alertIds, getServiceIncidentEvidence, loadAlert } from "../src/incident-fixtures.js";
import { runOperations } from "../src/operations.js";
import { createExecutor } from "../src/tools.js";

// Recorded from LocalBridge 0.1.0. The catalog retains the permitted read and a representative write.
const recorded = JSON.parse(readFileSync(new URL("./fixtures/localbridge.json", import.meta.url), "utf8"));
const source = loadAlert("alert-normal")!;
const call = { name: getServiceIncidentEvidence.name, arguments: source.scope };
const token = "isolated-test-token";
function setToken(t: TestContext) {
  const original = process.env.LOCALBRIDGE_ACCESS_TOKEN;
  process.env.LOCALBRIDGE_ACCESS_TOKEN = token;
  t.after(() => {
    if (original === undefined) delete process.env.LOCALBRIDGE_ACCESS_TOKEN;
    else process.env.LOCALBRIDGE_ACCESS_TOKEN = original;
  });
}
const pathFor = (id: string) => fileURLToPath(new URL("../dist/incident-evidence/" + id + ".json", import.meta.url));

test("the MCP path reproduces all direct triage outcomes and only reads the selected alert", async t => {
  setToken(t);
  let active = source.id;
  const methods: string[] = [];
  const transport = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:3000/mcp");
    assert.equal(init.redirect, "error");
    assert.equal(init.method, "POST");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    const { id, method, params } = JSON.parse(String(init.body));
    methods.push(method);
    assert.equal(headers.get("Authorization"), "Bearer " + token);
    assert.equal(headers.get("Mcp-Method"), method);
    assert.equal(headers.get("MCP-Protocol-Version"), "2026-07-28");
    assert.deepEqual(params._meta, { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "microbiz-agent", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {} });
    const reply = structuredClone(recorded[method]);
    assert.equal(reply.id, id);
    if (method === "tools/call") {
      assert.equal(headers.get("Mcp-Name"), "read_text_file");
      assert.equal(params.name, "read_text_file");
      assert.deepEqual(params.arguments, { path: pathFor(active) });
      const content = readFileSync(pathFor(active), "utf8");
      reply.result.content[0].text = reply.result.structuredContent.content = content;
    }
    return Response.json(reply);
  });
  for (active of alertIds) {
    methods.length = 0;
    const direct = await runOperations(active);
    assert.deepEqual(methods, []);
    const mcp = await runOperations(active, undefined, undefined, "localbridge");
    assert.deepEqual([mcp.status, mcp.evidence, mcp.report, mcp.tools, mcp.issues],
      [direct.status, direct.evidence, direct.report, direct.tools, direct.issues]);
    assert.deepEqual(methods, ["server/discover", "tools/list", "tools/call"]);
  }
  active = source.id;
  methods.length = 0;
  const daily = await runObjective("daily-review", undefined, "localbridge");
  assert.equal(daily.status, "completed");
  assert.deepEqual(methods, ["server/discover", "tools/list", "tools/call"]);
  assert.equal(transport.mock.callCount(), (alertIds.length + 1) * 3);
});

test("MCP discovery and reads spend the existing scoped grant only after host authorization", async t => {
  setToken(t);
  const transport = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 401 }));
  const make = (grants: string[]) => createExecutor("operations-triage", source, grants, "localbridge");
  assert.equal((await make([])(call)).error, "tool_denied");
  const execute = make([call.name]);
  for (const name of ["read_text_file", "write_file"]) assert.equal((await execute({ ...call, name })).error, "tool_denied");
  for (const args of [{ ...source.scope, path: "../.env" }, { ...source.scope, service: "other" }])
    assert.equal((await execute({ ...call, arguments: args })).error, "tool_arguments_denied");
  assert.equal(transport.mock.callCount(), 0);
  const outcomes = await Promise.all([execute(call), execute(call), execute(call)]);
  assert.deepEqual(outcomes.map(x => x.error), ["invalid_tool_result", "invalid_tool_result", "tool_budget_exhausted"]);
  assert.equal(transport.mock.callCount(), 2);
});

test("unexpected identity, tool contracts, remote content and transport failures stop triage before the follow-up", async t => {
  setToken(t);
  const cases = [
    ["server/discover", (r: typeof recorded) => { r.result._meta["io.modelcontextprotocol/serverInfo"].name = "other"; }],
    ["server/discover", (r: typeof recorded) => { r.result.supportedVersions = ["unknown"]; }],
    ["tools/list", (r: typeof recorded) => { r.result.tools[0].name = "other_read"; }],
    ["tools/list", (r: typeof recorded) => { r.result.tools.push(r.result.tools[0]); }],
    ["tools/list", (r: typeof recorded) => { delete r.result.tools[0].inputSchema.properties.head; }],
    ["tools/list", (r: typeof recorded) => { r.result.tools[0].outputSchema.required = []; }],
    ["tools/list", (r: typeof recorded) => { r.result.tools[0]._meta.securitySchemes = [{ type: "noauth" }]; }],
    ["tools/call", (r: typeof recorded) => { r.result.isError = true; }],
    ["tools/call", (r: typeof recorded) => { r.id++; }],
    ["tools/call", (r: typeof recorded) => { r.result.content[0].text = "unreviewed data"; }],
  ] as const;
  const failed = async () => {
    const result = await runOperations(source.id, undefined, undefined, "localbridge");
    assert.equal(result.status, "failed");
    assert.equal(result.evidence, null);
    assert.equal(result.report, null);
    assert.equal(result.decisions.length, 1);
    assert.deepEqual(result.issues, [{ code: "invalid_tool_result" }]);
    assert.doesNotMatch(JSON.stringify(result), /unreviewed data|isolated-test-token/);
  };
  for (const [target, change] of cases) {
    const requests: string[] = [];
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      requests.push(method);
      const reply = structuredClone(recorded[method]);
      if (method === target) change(reply);
      return Response.json(reply);
    });
    await failed();
    assert.equal(requests.at(-1), target);
    fetch.mock.restore();
  }
  const original = JSON.parse(recorded["tools/call"].result.structuredContent.content);
  const wrongWindow = { ...original.scope, end: original.scope.start };
  for (const change of [{ classification: "internal" }, { fixtureId: "alert-insufficient" }, { scope: wrongWindow },
    { evidence: { ...original.evidence, deployments: [{ ...original.evidence.deployments[0], log: "unreviewed data" }] } }]) {
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body));
      const reply = structuredClone(recorded[method]);
      if (method === "tools/call")
        reply.result.content[0].text = reply.result.structuredContent.content = JSON.stringify({ ...original, ...change });
      return Response.json(reply);
    });
    await failed();
    fetch.mock.restore();
  }
  for (const response of [() => new Response(null, { status: 401 }), () => { throw new Error("connection refused"); },
    () => new Response(" ".repeat(8192) + JSON.stringify(recorded["server/discover"]), { headers: { "Content-Type": "application/json" } })]) {
    const fetch = t.mock.method(globalThis, "fetch", response);
    await failed();
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("CLI explains a missing LocalBridge token before model or transport dispatch", () => {
  const run = spawnSync(process.execPath, ["--require", fileURLToPath(new URL("./deny-network.cjs", import.meta.url)),
    fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--mcp", source.id], {
    env: { ...process.env, LOCALBRIDGE_ACCESS_TOKEN: "" }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).issues[0].code, "missing_localbridge_access_token");
});

test("a stalled LocalBridge call shares the discovery deadline and ends without retry", async t => {
  setToken(t);
  const controller = new AbortController();
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    deadlines.push(ms);
    return controller.signal;
  });
  const methods: string[] = [];
  const transport = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, controller.signal);
    const { method } = JSON.parse(String(init.body));
    methods.push(method);
    if (method !== "tools/call") return Response.json(recorded[method]);
    return new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      setImmediate(() => controller.abort());
    });
  });
  const execute = createExecutor("operations-triage", source, [call.name], "localbridge");
  assert.equal((await execute(call)).error, "invalid_tool_result");
  assert.deepEqual(deadlines, [5000]);
  assert.deepEqual(methods, ["server/discover", "tools/list", "tools/call"]);
  assert.equal(transport.mock.callCount(), 3);
});
