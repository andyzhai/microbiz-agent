import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { z } from "zod";
import { loadFixture } from "../src/fixtures.js";
import { createGateway } from "../src/gateway.js";
import type { ModelRequest } from "../src/gateway.js";
import { createPolicy, OFFLINE_DESTINATION } from "../src/policy.js";
import type { Classification, Source } from "../src/policy.js";

const source = loadFixture("receipt-normal")!;
const request: ModelRequest = { instruction: "Static test instruction", sources: [source] };
const schema = z.strictObject({ answer: z.string().max(100) });
const policy = createPolicy([source]);

test("authorized request reaches the fake transport and is validated", async () => {
  const generate = mock.fn(async () => ({ answer: "ok" }));
  const gateway = createGateway({ destination: OFFLINE_DESTINATION, generate }, policy);
  const result = await gateway.generate(request, schema);
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.value, { answer: "ok" });
  assert.equal(generate.mock.callCount(), 1);
  assert.equal(result.decision.attempts, 1);
  assert.equal(result.decision.usage, "unknown");
});

test("forged provenance, arbitrary text, empty and mixed sources never reach transport", async () => {
  const generate = mock.fn(async () => ({ answer: "must not run" }));
  const gateway = createGateway({ destination: OFFLINE_DESTINATION, generate }, policy);
  const sources: Source[][] = [[], [{ ...source }], [Object.freeze({ ...source })]];
  for (const classification of ["synthetic", "public", "internal", "sensitive", "unknown"] as Classification[]) {
    sources.push([Object.freeze({ id: source.id, classification, content: "Arbitrary caller text" })]);
    sources.push([source, Object.freeze({ id: "extra", classification, content: "Other data" })]);
  }
  for (const inputs of sources) {
    const result = await gateway.generate({ ...request, sources: inputs }, schema);
    assert.equal(result.status, "blocked");
    assert.equal(result.decision.reason, "source_denied");
    assert.equal(result.decision.attempts, 0);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test("even trusted non-synthetic or mutable sources fail closed", async () => {
  for (const classification of ["public", "internal", "sensitive", "unknown"] as Classification[]) {
    const other = Object.freeze({ ...source, classification });
    assert.equal(createPolicy([other])([other], OFFLINE_DESTINATION), "source_denied");
  }
  const mutable = { ...source };
  assert.equal(createPolicy([mutable])([mutable], OFFLINE_DESTINATION), "source_denied");
});

test("external, local, unknown model and unapproved endpoints never reach transport", async () => {
  const generate = mock.fn(async () => ({ answer: "must not run" }));
  for (const destination of [
    { ...OFFLINE_DESTINATION, location: "external" as const },
    { ...OFFLINE_DESTINATION, location: "local" as const },
    { ...OFFLINE_DESTINATION, model: "secret-model-name" },
    { ...OFFLINE_DESTINATION, endpoint: "https://example.invalid/secret-token" },
  ]) {
    const result = await createGateway({ destination, generate }, policy).generate(request, schema);
    assert.equal(result.status, "blocked");
    assert.equal(result.decision.reason, "destination_denied");
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test("attempt reservations cap concurrent calls and failures consume the same budget", async () => {
  const generate = mock.fn(async () => { throw new Error("private-provider-error"); });
  const gateway = createGateway({ destination: OFFLINE_DESTINATION, generate }, policy);
  const results = await Promise.all(Array.from({ length: 6 }, () => gateway.generate(request, schema)));
  assert.equal(generate.mock.callCount(), 4);
  assert.equal(results.filter(result => result.status === "failed").length, 4);
  assert.equal(results.filter(result => result.decision.reason === "attempt_budget_exhausted").length, 2);
  assert.doesNotMatch(JSON.stringify(results), /private-provider-error|Static test instruction|Demo Paper/);
  assert.throws(() => createGateway({ destination: OFFLINE_DESTINATION, generate }, policy, { maxAttempts: Infinity }));
  assert.throws(() => createGateway({ destination: OFFLINE_DESTINATION, generate }, policy, { maxAttempts: 5 }));
});

test("malformed and oversized output are surfaced without returning raw data", async () => {
  for (const [raw, reason] of [
    [{ unexpected: "secret-output" }, "invalid_output"],
    [undefined, "invalid_output"],
    [{ answer: "secret-output".repeat(1_000) }, "output_too_large"],
  ] as const) {
    const gateway = createGateway({ destination: OFFLINE_DESTINATION, generate: async () => raw }, policy);
    const result = await gateway.generate(request, schema);
    assert.equal(result.status, "failed");
    assert.equal(result.decision.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /secret-output/);
  }
});

test("input limit denies before transport and timeout aborts without retrying", async () => {
  const generate = mock.fn(async () => ({ answer: "must not run" }));
  const small = createGateway({ destination: OFFLINE_DESTINATION, generate }, policy, { maxInputBytes: 1 });
  assert.equal((await small.generate(request, schema)).decision.reason, "input_too_large");
  assert.equal(generate.mock.callCount(), 0);
  let signal: AbortSignal | undefined;
  const hung = mock.fn(async (_: ModelRequest, value: AbortSignal) => {
    signal = value;
    return new Promise<never>(() => {});
  });
  const gateway = createGateway({ destination: OFFLINE_DESTINATION, generate: hung }, policy, { timeoutMs: 10, maxAttempts: 1 });
  assert.equal((await gateway.generate(request, schema)).decision.reason, "request_timeout");
  assert.equal(signal?.aborted, true);
  assert.equal((await gateway.generate(request, schema)).decision.reason, "attempt_budget_exhausted");
  assert.equal(hung.mock.callCount(), 1);
});
