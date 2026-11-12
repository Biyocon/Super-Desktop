import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { executionBaselineHash, executionEffectProfile, nextQualityCycle } from "../dist/engine.mjs";
import { confinementProbe } from "./container-policy.mjs";

function capture(limit) {
  const hash = createHash("sha256"), chunks = [];
  let total = 0, retained = 0;
  return {
    add(bytes) {
      hash.update(bytes); total += bytes.length;
      const part = bytes.subarray(0, Math.max(0, limit - retained));
      if (part.length > 0) chunks.push(part);
      retained += part.length;
    },
    result() { return { text: Buffer.concat(chunks).toString("utf8"), hash: hash.digest("hex"), truncated: total > limit }; },
  };
}

/** A subprocess is a real OS boundary; no shell, unbounded buffering or silent retry. */
async function processResult(executable, args, signal, timeoutMs, outputLimitBytes) {
  signal?.throwIfAborted();
  const stdout = capture(outputLimitBytes), stderr = capture(outputLimitBytes);
  const env = Object.fromEntries(["SystemRoot", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(executable, args, { shell: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let failure;
  const stop = reason => { failure ??= reason; child.kill(); };
  const cancel = () => stop("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  if (signal?.aborted) cancel();
  child.stdout.on("data", bytes => stdout.add(bytes));
  child.stderr.on("data", bytes => stderr.add(bytes));
  try {
    const ended = await new Promise(resolve => {
      child.once("error", () => { failure = "runner-failure"; });
      child.once("close", (code, terminationSignal) => resolve({ code, signal: terminationSignal }));
    });
    return { ...ended, failure: failure ?? (ended.signal ? "signal" : ended.code !== 0 ? "nonzero-exit" : undefined), stdout: stdout.result(), stderr: stderr.result() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/** Containers are created and durably owned by the host, never by this process. */
export function createQualityRunner({ dockerExecutable, workspace, catalog, validateWorkspace, resources }) {
  const dockerHost = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
  if (typeof dockerExecutable !== "string" || typeof workspace !== "string" || typeof validateWorkspace !== "function") throw new Error("CONDUCTOR_RUNNER_CONFIGURATION_INVALID");

  return async function runQuality(request, signal) {
    signal.throwIfAborted();
    const { run, binding, gate, workerId, stage } = request;
    const baseline = run.baseline;
    const baselineHash = baseline && executionBaselineHash(baseline);
    if (run.admission.purpose !== "implementation" || run.status !== "running" || run.currentStage !== stage
      || !["headsman", "auditor"].includes(stage) || gate !== (stage === "headsman" ? "D" : "E")
      || request.runId !== run.runId || typeof workerId !== "string" || !workerId || !request.dispatchId
      || !baseline || run.executionAuthorization?.executionBaselineHash !== baselineHash
      || JSON.stringify(run.executionAuthorization.effectProfile) !== JSON.stringify(executionEffectProfile(baseline))
      || request.cycle !== nextQualityCycle(run, gate)
      || !baseline.qualityCommands.some(item => JSON.stringify(item) === JSON.stringify(binding))) throw new Error("CONDUCTOR_QUALITY_NOT_AUTHORIZED");
    const command = catalog.command(binding, gate);
    if (!command.argv[0].startsWith("/") || command.argv[0].includes("\n")) throw new Error("CONDUCTOR_COMMAND_EXECUTABLE_INVALID");
    await validateWorkspace(structuredClone(run));
    signal.throwIfAborted();
    if (!resources || typeof resources.create !== "function" || typeof resources.release !== "function") throw new Error("CONDUCTOR_RESOURCE_SERVICE_MISSING");
    const startedAt = new Date().toISOString();
    let result, policyHash;
    const containers = [], owned = [];
    try {
      const execute = async (probeArgv, timeoutMs, limit) => {
        signal.throwIfAborted();
        const resource = await resources.create(request, probeArgv);
        owned.push(resource);
        if (!resource || typeof resource.resourceId !== "string" || !/^super-conductor-[a-f0-9-]{36}$/.test(resource.containerName)
          || typeof resource.temporary !== "string" || !/^[a-f0-9]{64}$/.test(resource.policySha256)) throw new Error("CONDUCTOR_RESOURCE_RECEIPT_INVALID");
        containers.push(resource.containerName);
        policyHash = resource.policySha256;
        signal.throwIfAborted();
        return processResult(dockerExecutable, ["--config", resource.temporary, "--host", dockerHost, "start", "--attach", resource.containerName], signal, timeoutMs, limit);
      };
      const probe = await execute(["/usr/local/bin/node", "-e", confinementProbe], 15000, 8192);
      signal.throwIfAborted();
      if (probe.failure || probe.stdout.text.trim() !== "CONDUCTOR_CONFINEMENT_V1_PASS") {
        throw new Error(`CONDUCTOR_SANDBOX_UNAVAILABLE: ${probe.failure ?? "probe-invalid"}; ${probe.stderr.text.slice(0, 1024)}`);
      }
      await validateWorkspace(structuredClone(run));
      signal.throwIfAborted();
      result = await execute(undefined, command.timeoutMs, command.outputLimitBytes);
    } finally {
      const cleaned = await Promise.allSettled(owned.map(resource => resources.release(resource)));
      if (cleaned.some(item => item.status === "rejected")) throw new Error("CONDUCTOR_CONTAINER_CLEANUP_FAILED");
    }
    const evidenceId = `quality-${randomUUID()}`;
    const record = { evidenceId, runId: run.runId, childSessionId: workerId, commandId: binding.id, definitionHash: binding.definitionHash,
      executionBaselineHash: baselineHash, gate, cycle: request.cycle, policyStage: stage, executorStage: stage,
      outcome: result.failure ? "failed" : "passed", ...(result.failure ? { failure: result.failure } : {}),
      exitCode: result.code, signal: result.signal, startedAt, finishedAt: new Date().toISOString(),
      stdoutSha256: result.stdout.hash, stderrSha256: result.stderr.hash,
      stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated };
    return { record, output: { evidenceId, outcome: record.outcome, stdout: result.stdout.text, stderr: result.stderr.text },
      execution: { containerNames: [...containers], sandboxPolicySha256: policyHash } };
  };
}
