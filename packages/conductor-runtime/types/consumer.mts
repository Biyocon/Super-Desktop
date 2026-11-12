import { createDispatcher, type HostServices, type SpecialistProvider } from "@pi-desktop/conductor-runtime/adapter";
import { drive, type ConductorRun, type ConductorDispatcher } from "@pi-desktop/conductor-runtime/engine";

type Assert<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;
type Assignable<A, B> = A extends B ? true : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsUnknown<T> = unknown extends T ? (IsAny<T> extends true ? false : true) : false;
export type Contracts = [
  Assert<Not<IsAny<ConductorRun>>>,
  Assert<Assignable<ReturnType<typeof createDispatcher>, ConductorDispatcher>>,
  Assert<Not<Assignable<{ journal: (event: string) => Promise<void> }, Pick<HostServices, "journal">>>>,
  Assert<Not<Assignable<{ countTokens: () => string }, Pick<HostServices, "countTokens">>>>,
  Assert<Not<Assignable<{ runQuality: () => Promise<string> }, Pick<HostServices, "runQuality">>>>,
  Assert<Not<Assignable<{ dispatch: (input: number) => Promise<unknown> }, SpecialistProvider>>>,
  Assert<IsUnknown<Awaited<ReturnType<SpecialistProvider["dispatch"]>>>>,
  Assert<Not<Assignable<{ runId: string; currentStage: "gate-pass-by-prose" }, ConductorRun>>>,
];

declare const host: HostServices;
declare const provider: SpecialistProvider;
declare const run: ConductorRun;
const dispatcher = createDispatcher({ host, provider, workspace: "fixture", signal: new AbortController().signal });
void drive(run, dispatcher, async checkpoint => { host.validateWorkspace(checkpoint); });
