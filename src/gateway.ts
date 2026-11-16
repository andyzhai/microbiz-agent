import { performance } from "node:perf_hooks";
import type { z } from "zod";
import type { Destination, Policy, PolicyReason, Source } from "./policy.js";

export interface ModelRequest {
  readonly instruction: string;
  readonly sources: readonly Source[];
}

// Destination and transport are bound together by trusted application setup.
// Model requests cannot override either one.
export interface ModelAdapter {
  readonly destination: Destination;
  generate(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}

export type GatewayReason = PolicyReason | "attempt_budget_exhausted" |
  "input_too_large" | "output_too_large" | "invalid_output" | "adapter_failed" | "request_timeout";

export interface Decision {
  readonly model: string;
  readonly location: Destination["location"] | "unknown";
  readonly outcome: "completed" | "blocked" | "failed";
  readonly reason: GatewayReason;
  readonly attempts: number;
  readonly durationMs: number;
  readonly usage: "unknown";
}

export type GatewayResult<T> =
  | { status: "completed"; value: T; decision: Decision }
  | { status: "blocked" | "failed"; decision: Decision };

interface GatewayLimits {
  maxAttempts: number;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

const DEFAULT_LIMITS: Readonly<GatewayLimits> = Object.freeze({
  maxAttempts: 4,
  timeoutMs: 1_000,
  maxInputBytes: 8_192,
  maxOutputBytes: 8_192,
});

export function createGateway(
  adapter: ModelAdapter,
  authorize: Policy,
  overrides: Partial<GatewayLimits> = {},
) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1) ||
      limits.maxAttempts > 4) throw new Error("Invalid gateway limits");
  const destination = Object.freeze({ ...adapter.destination });
  const generate = adapter.generate.bind(adapter);
  let attempts = 0;

  return {
    async generate<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<GatewayResult<T>> {
      const started = performance.now();
      const decision = (outcome: Decision["outcome"], reason: GatewayReason): Decision => ({
        // Denied configuration must not be echoed into diagnostic output.
        model: reason === "destination_denied" ? "unapproved" : destination.model,
        location: reason === "destination_denied" ? "unknown" : destination.location,
        outcome, reason, attempts,
        durationMs: Math.round(performance.now() - started),
        usage: "unknown",
      });
      const block = (reason: GatewayReason): GatewayResult<T> => ({ status: "blocked", decision: decision("blocked", reason) });
      // Snapshot the envelope so it cannot change between authorization and dispatch.
      const outbound = Object.freeze({ instruction: request.instruction, sources: Object.freeze([...request.sources]) });
      const permission = authorize(outbound.sources, destination);
      if (permission !== "allowed_offline_fixture") return block(permission);
      if (Buffer.byteLength(JSON.stringify(outbound), "utf8") > limits.maxInputBytes) return block("input_too_large");
      if (attempts >= limits.maxAttempts) return block("attempt_budget_exhausted");
      attempts += 1; // Reserve before dispatch, including concurrent calls and failures.

      const controller = new AbortController();
      const timeout = Symbol("timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          Promise.resolve().then(() => generate(outbound, controller.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reject(timeout); controller.abort(); }, limits.timeoutMs);
          }),
        ]);
        const serialized = JSON.stringify(raw);
        if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > limits.maxOutputBytes) {
          return { status: "failed", decision: decision("failed", "output_too_large") };
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return { status: "failed", decision: decision("failed", "invalid_output") };
        return { status: "completed", value: parsed.data, decision: decision("completed", permission) };
      } catch (error) {
        // Never propagate provider errors, raw responses, prompts or credentials.
        return { status: "failed", decision: decision("failed", error === timeout ? "request_timeout" : "adapter_failed") };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
