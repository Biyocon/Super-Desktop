import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ConductorHost } from "./store.js";
import type { ConductorService } from "./service.js";

export type EngineProvenance = {
  revision: string; version: string; license: "MIT"; recordFormat: 5;
  artifacts: Record<string, string>;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONDUCTOR_ENGINE_INCOMPATIBLE");
  return value as Record<string, unknown>;
}

/** Verify the shipped bytes before importing any engine/adapter execution code. */
export function inspectEngine(resolveEngine: () => string = () => import.meta.resolve("@pi-desktop/conductor-runtime/engine")): EngineProvenance {
  try {
    const engine = new URL(resolveEngine());
    const provenance = object(JSON.parse(readFileSync(new URL("./provenance.json", engine), "utf8")));
    if (provenance.revision !== "879ab27bdd22203675d6f0cc678652779fc089cd" || provenance.packageVersion !== "0.1.0-rc.7"
      || provenance.license !== "MIT") throw new Error("CONDUCTOR_ENGINE_INCOMPATIBLE");
    const artifacts = object(provenance.artifacts);
    const observed: Record<string, string> = {};
    for (const name of ["engine.mjs", "adapter.mjs", "HARNESS-LICENSE", "ZOD-LICENSE"]) {
      const actual = createHash("sha256").update(readFileSync(new URL(name, engine))).digest("hex");
      if (artifacts[name] !== actual) throw new Error("CONDUCTOR_ENGINE_INCOMPATIBLE");
      observed[name] = actual;
    }
    return { revision: String(provenance.revision), version: String(provenance.packageVersion), license: "MIT", recordFormat: 5, artifacts: observed };
  } catch (error) {
    if (error instanceof Error && error.message === "CONDUCTOR_ENGINE_INCOMPATIBLE") throw error;
    throw new Error("CONDUCTOR_ENGINE_UNAVAILABLE");
  }
}

export function conductorLoader(options: {
  host: ConductorHost;
  runtimeId: string;
  changed(sessionId: string, runId: string): void;
  fault(sessionId: string, runId: string, code: string): void;
}) {
  let service: Promise<ConductorService> | undefined;
  let instance: ConductorService | undefined;
  let disposed = false;
  return {
    owns(sessionId: string) { return instance?.owns(sessionId) ?? false; },
    availability() {
      try { return { available: true as const, provenance: inspectEngine() }; }
      catch (error) { return { available: false as const, code: error instanceof Error ? error.message : "CONDUCTOR_ENGINE_UNAVAILABLE" }; }
    },
    async get() {
      if (disposed) throw new Error("CONDUCTOR_RUNTIME_DISPOSED");
      const provenance = inspectEngine();
      // URL-based import remains lazy in the sidecar bundle. The packaging
      // step emits the service beside sidecar.js, without hoisting its engine.
      const url = new URL("./service.js", import.meta.url);
      service ??= import(url.href).then((module: { ConductorService: typeof ConductorService }) => {
        if (disposed) throw new Error("CONDUCTOR_RUNTIME_DISPOSED");
        instance = new module.ConductorService({ ...options, provenance });
        return instance;
      });
      return service;
    },
    async dispose(reason?: Error) { disposed = true; if (instance) await instance.dispose(reason); }
  };
}
