// Unchanged upstream code owns every run/gate decision. This file only exposes it.
export * from "../vendor/conductor/index.ts";
export { analysisToolGuard, toolGuardForStage, toolRestrictionForStage } from "../vendor/guards/capability.ts";
export { canonicalAbsolute, containsPath } from "../vendor/guards/path-policy.ts";
