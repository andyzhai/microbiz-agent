import { createGateway } from "./gateway.js";
import type { Decision, ModelAdapter } from "./gateway.js";
import type { Classification } from "./policy.js";

export type GatewayConfig = ModelAdapter | (() => ReturnType<typeof createGateway>);
export function taskGateway(config: GatewayConfig) {
  return typeof config === "function" ? config() : createGateway(config);
}

export interface TaskResult {
  fixtureId: string | null;
  classification: Classification;
  status: "completed" | "needs_review" | "blocked" | "failed";
  decisions: readonly Decision[];
}
