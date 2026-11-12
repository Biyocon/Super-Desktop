import type { ZodType } from "zod";

// Erased nominal primitive, matching the pinned Harness brand contract.
declare const BRAND: unique symbol;
export type Branded<B extends string> = string & { readonly [BRAND]: B };
export type SessionId = Branded<"SessionId">;

// Minimal structural surfaces used by upstream exported session-log helpers.
// Desktop does not instantiate these Harness services; no runtime shim ships.
export interface SessionEventMap { "session/end-seed": unknown }
export type SessionEvent = {
  [K in keyof SessionEventMap]: { type: K; data: SessionEventMap[K] }
}[keyof SessionEventMap];
export interface Session {
  readonly id: SessionId;
  readonly events: readonly SessionEvent[];
  append<K extends keyof SessionEventMap>(type: K, data: SessionEventMap[K]): unknown;
}
export interface ProjectionDefinition<K extends string, S> {
  key: K;
  schema: ZodType<S>;
  init(): S;
  apply(state: S, event: SessionEvent): S;
  view(state: S): S;
  stateVersion: number;
}
export interface Context {
  sessionProjections: { register(definition: unknown): void };
}
export interface ToolExecution {
  name: string;
  arguments: Record<string, unknown>;
  agent: { session: { id: string; header: { cwd?: string } } };
}
export type ToolGuard = (execution: ToolExecution) => string | undefined;
export type ToolRestriction = { allow: readonly string[] };
