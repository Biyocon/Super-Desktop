import type {
  ConductorRun, ConductorStage, ConductorDispatcher, ExecutionAuthorization,
  ExecutionBaseline, ExecutionEffectProfile, QualityCommandBinding, QualityExecutionRecord,
} from "./engine.mjs";

export type DispatchMode = "specialist" | "producer" | "critic" | "arbiter";
export interface DispatchIdentity {
  runId: string; stage: ConductorStage; mode: DispatchMode;
  dispatchId: string; workerId: string;
}
export interface QualityRequest extends DispatchIdentity {
  run: ConductorRun; binding: QualityCommandBinding;
  gate: "D" | "E"; cycle: number;
}
export interface QualityResult {
  record: QualityExecutionRecord;
  output: { evidenceId: string; outcome: "passed" | "failed"; stdout: string; stderr: string };
  execution: { containerNames: string[]; sandboxPolicySha256: string };
}
export type DispatchJournalEvent = DispatchIdentity & (
  | { type: "dispatch-start"; input: unknown; requiredQualityCommands: QualityCommandBinding[] }
  | { type: "quality-result"; record: QualityExecutionRecord }
  | { type: "dispatch-end"; status: "completed"; response: unknown }
  | { type: "dispatch-end"; status: "failed" | "cancelled"; error: string }
);
export interface HostServices {
  journal(event: DispatchJournalEvent): Promise<void>;
  executeTool(request: DispatchIdentity & { name: string; arguments: Record<string, unknown> }, signal: AbortSignal): Promise<unknown>;
  authorizeExecution(run: ConductorRun, baseline: ExecutionBaseline, effectProfile: ExecutionEffectProfile, signal: AbortSignal): Promise<ExecutionAuthorization | null>;
  resolveBaseline(run: ConductorRun, proposal: unknown): Promise<ExecutionBaseline>;
  runQuality(request: QualityRequest, signal: AbortSignal): Promise<QualityResult>;
  validateWorkspace(run: ConductorRun): Promise<void>;
  countTokens(text: string): number;
}
export interface ProviderDispatch extends DispatchIdentity {
  input: unknown;
  run: ConductorRun | undefined;
  tools: string[];
  requiredQualityCommands: QualityCommandBinding[];
  executeTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  quality(commandId: string): Promise<QualityResult["output"]>;
  signal: AbortSignal;
  maxOutputTokens: number | undefined;
}
export interface SpecialistProvider { dispatch(request: ProviderDispatch): Promise<unknown> }
export function createDispatcher(options: {
  host: HostServices; provider: SpecialistProvider; workspace: string; signal: AbortSignal;
}): ConductorDispatcher;

export interface QualityCommandDefinition {
  id: string; image: string; argv: string[]; requiredGates: Array<"D" | "E">;
  timeoutMs: number; outputLimitBytes: number;
}
export interface QualityCatalog {
  bindings(): QualityCommandBinding[];
  resolve(ids: string[]): QualityCommandBinding[];
  command(binding: QualityCommandBinding, gate: "D" | "E"): QualityCommandDefinition & { definitionHash: string };
}
export function createQualityCatalog(input: unknown): QualityCatalog;
export interface QualityResource {
  resourceId: string; containerName: string; temporary: string; policySha256: string;
}
export interface ContainerResources {
  create(request: QualityRequest, probeArgv?: string[]): Promise<QualityResource>;
  release(resource: QualityResource): Promise<void>;
}
export function createQualityRunner(options: {
  dockerExecutable: string; scratchRoot?: string; workspace: string; catalog: QualityCatalog; resources: ContainerResources;
  validateWorkspace(run: ConductorRun): Promise<void>;
}): (request: QualityRequest, signal: AbortSignal) => Promise<QualityResult>;

export interface MandateInput {
  owner: string; objective: string; purpose: "analysis" | "implementation";
  scope: string[]; allowedPaths: string[]; excludedPaths: string[];
  qualityCommandIds: string[]; sourceBaseline: string;
}
export interface MandateSnapshot extends MandateInput {
  workspace: string; qualityCommands: QualityCommandBinding[];
}
export interface CapturedMandate {
  snapshot(): MandateSnapshot;
  validate(run: ConductorRun): void;
  resolveBaseline(run: ConductorRun, proposal: unknown): ExecutionBaseline;
}
export function captureMandate(workspace: string, input: unknown, catalog: QualityCatalog): CapturedMandate;
