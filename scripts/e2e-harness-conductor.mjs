#!/usr/bin/env node
// Native acceptance on an OWN profile. No Task aliases, internal mocks or live models.
// node scripts/e2e-harness-conductor.mjs <absolute-hostBinary> <absolute-docker> <cachedImage> <absolute-scratch>
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { installNodeGuard, pinnedImage, providerFixture, sha256 } from "./e2e/harness-conductor-fixture.mjs";

const [hostBinary, docker, image, scratch, ...extra] = process.argv.slice(2);
assert.ok(hostBinary && docker && scratch && !extra.length, "Four explicit arguments required: hostBinary docker cachedImage scratch");
assert.ok(["win32", "linux"].includes(process.platform), "This native close/relaunch harness currently supports Windows/Linux only");
for (const path of [hostBinary, docker, scratch]) assert.ok(isAbsolute(path), "Arguments must be absolute paths");
for (const path of [hostBinary, docker]) { const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Use explicit regular binaries"); }
assert.equal(image, pinnedImage, "Only the unchanged node-tests catalog's cached digest is accepted");
const fixedDocker = process.platform === "win32" ? ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"] : ["/usr/bin/docker", "/usr/local/bin/docker"];
let selectedDocker;
for (const path of fixedDocker) { try { const stat = await lstat(path); if (stat.isFile() && !stat.isSymbolicLink()) { selectedDocker = path; break; } } catch (error) { if (error.code !== "ENOENT") throw error; } }
assert.equal(resolve(docker), selectedDocker && resolve(selectedDocker), "Docker argument must match the actual main-process fixed resolver; no injected runtime path");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { appDir, mainPath, rendererPath } = assertDesktopBuild(repo);
const { electronBinary } = resolveElectronBinary(repo);
const root = await mkdtemp(join(resolve(scratch), "harness-native-"));
const runtime = join(root, "owned"), home = join(runtime, "home"), profile = join(runtime, "profile");
const data = join(runtime, "data"), project = join(runtime, "repository"), agents = join(runtime, "agents"), temp = join(runtime, "temp"), application = join(runtime, "application");
const evidence = join(root, "evidence"), audit = join(evidence, "network-and-process.ndjson"), guard = join(runtime, "network-guard.cjs");
const originalEnv = { ...process.env }, originalCwd = process.cwd();
const requests = [], outcomes = [], faults = [], interactions = [], permissionAnswers = [], saved = [], screenshots = {};
const result = { fixtureOnly: true, liveModelAccepted: false, nativeElectronAccepted: false, passed: false,
  candidateKind: "current worktree source and build; not final accepted commit", root, hostBinary, docker, image,
  chain: "native ConductorPanel -> shipped preload/main -> HostProcess/AgentSidecar -> unchanged Harness -> Rust persistence",
  requests, outcomes, interactions, permissionAnswers, screenshots, faults,
  unimplementedControls: ["missing-engine native UI negative (no candidate bundle is mutated)", "cancel/rework/stale-consent UI negatives", "in-flight crash recovery", "macOS native quit"] };
let server, preparer, owned, main, failure, launchNumber = 0;
const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
async function fingerprint() {
  const scopes = ["apps/desktop/electron", "apps/desktop/src", "packages/conductor-runtime", "packages/agent-runtime/src", "packages/host-runtime/src", "packages/shared/src", "packages/i18n/src/conductor", "crates/host-core/src", "scripts/e2e-harness-conductor.mjs", "scripts/e2e/harness-conductor-fixture.mjs"];
  const files = [...new Set((git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes)).split("\0").filter(Boolean))].sort();
  const hashes = {};
  for (const file of files) { try { const stat = await lstat(join(repo, file)); hashes[file] = stat.isFile() ? sha256(await readFile(join(repo, file))) : "not-regular"; } catch (error) { if (error.code !== "ENOENT") throw error; hashes[file] = "deleted"; } }
  const built = {};
  async function hashTree(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await hashTree(path);
      else if (entry.isFile()) built[path] = sha256(await readFile(path));
      else if (entry.isSymbolicLink()) throw new Error(`Executable tree must not contain untracked symlink targets: ${path}`);
    }
  }
  for (const directory of [join(appDir, "out"), join(repo, "packages/agent-runtime/dist"), join(repo, "packages/conductor-runtime/dist"), join(repo, "packages/host-runtime/dist"), join(repo, "packages/shared/dist")]) await hashTree(directory);
  for (const path of [hostBinary, electronBinary]) built[path] = sha256(await readFile(path));
  return { head: git("rev-parse", "HEAD").trim(), base: git("rev-parse", "origin/main").trim(), mergeBase: git("merge-base", "HEAD", "origin/main").trim(),
    status: git("status", "--porcelain=v1", "--untracked-files=normal"), sourceHashes: hashes, builtHashes: built, sourceHash: sha256(JSON.stringify(hashes)) };
}
async function wait(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    assert.deepEqual(faults, [], `Fixture faults while ${label}`);
    if (owned?.child.exitCode !== null && owned?.child.exitCode !== undefined) throw new Error(`Owned Electron exited while ${label}: ${owned.output.slice(-6000)}`);
    const value = await predicate(); if (value) return value;
    await delay(50); // Condition polling only, never a sleep-based success oracle.
  }
  throw new Error(`Timed out: ${label}`);
}
const j = JSON.stringify;
const element = selector => `document.querySelector(${j(selector)})`;
const button = (scope, label, prefix = false) => `[...document.querySelectorAll(${j(`${scope} button`)})].find(e=>e.textContent.trim().${prefix ? "startsWith" : "includes"}(${j(label)}))`;
async function cdpConnect() {
  let port;
  await wait(async () => {
    try { const rows = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/); port = Number(rows[0]); return Number.isInteger(port) && port > 0 && port < 65536 && rows[1]?.startsWith("/devtools/browser/"); }
    catch (error) { if (error.code !== "ENOENT") throw error; return false; }
  }, "OWN DevToolsActivePort");
  let target;
  await wait(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    target = (await response.json()).find(item => item.type === "page" && item.url === pathToFileURL(rendererPath).href);
    return !!target;
  }, "exact candidate renderer target");
  const endpoint = new URL(target.webSocketDebuggerUrl);
  assert.equal(endpoint.protocol, "ws:"); assert.equal(endpoint.hostname, "127.0.0.1"); assert.equal(Number(endpoint.port), port);
  const socket = new WebSocket(endpoint); await once(socket, "open"); owned.sockets.push(socket);
  let sequence = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  socket.addEventListener("close", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Owned CDP closed")); } pending.clear(); });
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); no(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve: yes, reject: no, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  return { send, evaluate };
}
async function screenshot(name) {
  const { data: encoded } = await main.send("Page.captureScreenshot", { format: "png" });
  const bytes = Buffer.from(encoded, "base64"); await writeFile(join(evidence, name), bytes); screenshots[name] = sha256(bytes);
}
async function nativeMouse(expression) {
  await wait(() => main.evaluate(`!!(${expression})&&!(${expression}).disabled`), "enabled native target");
  await main.evaluate(`(${expression}).scrollIntoView({block:'center',inline:'nearest'})`);
  let previous;
  const point = await wait(async () => {
    const hit = await main.evaluate(`(()=>{const e=${expression};if(!e)return null;const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),top=document.elementFromPoint(x,y);return {x,y,hit:r.width>0&&r.height>0&&e.contains(top),target:e.className,obstruction:top?.className,width:r.width,height:r.height};})()`);
    const stable = hit?.hit && JSON.stringify(hit) === previous; previous = JSON.stringify(hit); return stable && hit;
  }, `stable unobscured native hit target: ${expression}`).catch(error => { outcomes.push({ kind: "native-hit-failure", expression, lastObservation: previous }); throw error; });
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await main.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
}
async function nativeKey(expression, key) {
  await main.evaluate(`(${expression}).scrollIntoView({block:'center'});(${expression}).focus()`);
  assert.equal(await main.evaluate(`document.activeElement===(${expression})`), true);
  const space = key === "Space", code = space ? "Space" : "Enter", value = space ? " " : "Enter", n = space ? 32 : 13;
  await main.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code, windowsVirtualKeyCode: n, text: space ? " " : "\r", unmodifiedText: space ? " " : "\r" });
  await main.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code, windowsVirtualKeyCode: n });
}
async function fill(name, value) {
  const target = element(`.conductor-entry [name="${name}"]`);
  await nativeMouse(target);
  await main.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await main.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await main.send("Input.insertText", { text: value });
  assert.equal(await main.evaluate(`(${target}).value`), value);
}
async function disclosure(expression, input = "mouse") {
  const before = await main.evaluate(`({open:(${expression}).getAttribute('aria-expanded'),id:(${expression}).getAttribute('aria-controls')})`);
  assert.ok(before.id); assert.equal(before.open, "false");
  if (input === "mouse") await nativeMouse(expression); else await nativeKey(expression, input);
  await wait(() => main.evaluate(`(${expression}).getAttribute('aria-expanded')==='true'&&!!document.getElementById(${j(before.id)})`), `${input} opens matching aria-controls`);
  const body = await main.evaluate(`document.getElementById(${j(before.id)}).innerText`);
  interactions.push({ input, controls: before.id, title: await main.evaluate(`(${expression}).innerText`), bodySha256: sha256(body) });
  return body;
}
// Only assertion reads, the existing explicit permission answer, and closing our
// window may be called here. Start/authorize/resume are intentionally absent.
const allowedIpc = new Set(["conductor/availability", "conductor/catalog", "conductor/list", "conductor/history", "tool/resolvePermission", "window/control"]);
async function invoke(channel, input) {
  assert.ok(allowedIpc.has(channel), `Forbidden acceptance injection: ${channel}`);
  const reply = await main.evaluate(`window.piDesktop.invoke(${j(`pi-desktop/${channel}`)},${j(input)})`);
  assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.data;
}
const history = ref => invoke("conductor/history", ref);
async function ready() {
  await wait(async () => {
    try { return await main.evaluate(`!!window.piDesktop&&!!document.querySelector('[data-nav="settings"]')&&!document.querySelector('.startup-splash')`); }
    catch (error) {
      if (/Execution context was destroyed|Cannot find (?:default execution )?context|Inspected target navigated/i.test(String(error))) return false;
      throw error;
    }
  }, "shipped renderer ready", 60000);
  await main.evaluate(`window.__harnessAcceptance={permissions:[],faults:[]};window.piDesktop.on('pi-desktop/agent/event/message',p=>{if(p?.event?.type==='tool_permission_request')window.__harnessAcceptance.permissions.push(p.event.request)});window.piDesktop.on('pi-desktop/conductor/event/fault',p=>window.__harnessAcceptance.faults.push(p));`);
}
async function openSession(session) {
  await nativeMouse(element(`[data-sidebar-session-row="${session.id}"] .thread-item-main`));
  await wait(() => main.evaluate(`document.querySelector(${j(`[data-sidebar-session-row="${session.id}"]`)})?.classList.contains('active')`), "native session selection acknowledged");
  await wait(() => main.evaluate(`!!document.querySelector('.conductor-toggle')`), "actual ConductorPanel");
  if (await main.evaluate(`document.querySelector('.conductor-toggle').getAttribute('aria-expanded')==='false'`)) await nativeMouse(element(".conductor-toggle"));
  await wait(() => main.evaluate(`!!document.querySelector('.conductor-panel-body h2')`), "open ConductorPanel");
}
async function launch(env) {
  await rm(join(profile, "DevToolsActivePort"), { force: true }); // Our profile only; never discover another app.
  const child = spawn(electronBinary, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, application],
    { cwd: application, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  owned = { child, sockets: [], output: "", number: ++launchNumber };
  child.on("error", error => faults.push(`owned Electron spawn: ${error}`));
  const current = owned;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { current.output += chunk; });
  main = await cdpConnect(); await main.send("Page.enable"); await main.send("Page.bringToFront"); await ready();
}
async function observeOwnedChildAbsence() {
  let rows;
  try { rows = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const child of rows.filter(row => row.kind === "child-start" && row.childPid && !rows.some(exit => ["child-exit", "child-absence"].includes(exit.kind) && exit.pid === row.pid && exit.childPid === row.childPid))) {
    let absent = false;
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      try { process.kill(child.childPid, 0); } // Existence probe only, never signal or kill another PID.
      catch (error) { if (error.code !== "ESRCH") throw error; absent = true; break; }
      await delay(50);
    }
    if (absent) await writeFile(audit, JSON.stringify({ kind: "child-absence", pid: child.pid, childPid: child.childPid, observerPid: process.pid, evidence: "registered owned PID observed absent by signal-0 probe" }) + "\n", { flag: "a" });
  }
}
async function closeOwned() {
  if (!owned) return;
  const current = owned;
  try {
    if (current.child.exitCode === null && main) {
      try { await invoke("window/control", { action: "close" }); } catch (error) { if (!/closed|timeout/i.test(String(error))) outcomes.push({ kind: "close-reply", message: String(error) }); }
      const deadline = Date.now() + 20000;
      while (current.child.exitCode === null && Date.now() < deadline) await delay(50);
    }
    if (current.child.exitCode === null) {
      // No taskkill, process-name searches or shared port shutdowns. Killing the
      // one ChildProcess is failure cleanup, never a successful restart oracle.
      current.child.kill();
      await Promise.race([once(current.child, "exit"), delay(5000)]);
      throw new Error("Owned app did not complete normal shutdown; child-only fallback used");
    }
    assert.equal(current.child.exitCode, 0, "Owned app must exit cleanly");
  } finally {
    for (const socket of current.sockets) socket.close();
    await writeFile(join(evidence, `electron-${current.number}.log`), current.output);
    if (current.child.exitCode !== null) owned = undefined;
    main = undefined;
    if (!owned) await observeOwnedChildAbsence();
  }
}
async function assertAuthority() {
  assert.match(await main.evaluate(`document.querySelector('.conductor-authority-link').innerText`), /The Emperor — you[\s\S]*The Conductor/);
  await disclosure(button(".conductor-authority", "Specialist roles"));
  const roles = ["conductor", "detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator", "arbiter"];
  const titles = ["The Conductor", "Detective", "Strategist", "Devil’s Advocate", "Headsman", "Auditor", "Integrator", "The Arbiter"];
  await wait(() => main.evaluate(`[...document.querySelectorAll('.conductor-authority [data-conductor-role]')].length===8&&[...document.querySelectorAll('.conductor-authority [data-conductor-role]')].every(e=>e.complete&&e.naturalWidth>0)`), "existing portrait assets loaded");
  const portraits = await main.evaluate(`[...document.querySelectorAll('.conductor-authority [data-conductor-role]')].map(e=>({role:e.dataset.conductorRole,src:e.src,loaded:e.complete&&e.naturalWidth>0,title:e.parentElement.innerText}))`);
  assert.deepEqual(portraits.map(item => item.role), roles);
  for (let i = 0; i < roles.length; i++) {
    assert.ok(portraits[i].loaded, `Loaded ${roles[i]} portrait`); assert.equal(portraits[i].title, titles[i]);
    const url = new URL(portraits[i].src); assert.equal(url.protocol, "file:");
    assert.equal(sha256(await readFile(fileURLToPath(url))), sha256(await readFile(join(repo, `apps/desktop/src/assets/agent-avatars/${roles[i]}.png`))), "Exact existing portrait asset");
  }
  assert.doesNotMatch(await main.evaluate(`document.querySelector('.conductor-authority').innerText`), /Ralph/);
  outcomes.push({ kind: "proper-titles-existing-portraits-emperor", portraits });
}
async function answerPermissions(session, purpose, consent) {
  const observed = await main.evaluate("window.__harnessAcceptance"); assert.deepEqual(observed.faults, []);
  for (const request of observed.permissions.filter(item => !permissionAnswers.some(answer => answer.requestId === item.requestId))) {
    assert.equal(request.sessionId, session.id, "Only the owned selected session may receive an answer");
    assert.ok(["Read", "Write"].includes(request.toolName), "Never approve shell, arbitrary tools or session-wide access");
    assert.ok(JSON.stringify(request.argsPreview).includes("fixture.txt"), "Permission must concern the sole fixture");
    if (request.toolName === "Write") {
      assert.equal(purpose, "implementation"); assert.ok(consent, "Gate C and file-tool authorization remain separate");
      assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "before\n", "Gate C alone must not write");
      await wait(() => main.evaluate(`[...document.querySelectorAll('.permission-card')].some(e=>e.innerText.includes('Write')&&e.innerText.includes('after'))`), "separate real Write permission card with exact fixture content");
      await screenshot("separate-write-permission.png");
    }
    await invoke("tool/resolvePermission", { requestId: request.requestId, decision: "allow-once" });
    permissionAnswers.push({ ...request, decision: "allow-once", answerPath: "existing allowed permission IPC; explicit test-owner answer" });
  }
}
async function runSession(session, purpose, testHash) {
  await openSession(session); await assertAuthority();
  const availability = await invoke("conductor/availability", {}); assert.equal(availability.available, true); result.provenance = availability.provenance;
  const { commands } = await invoke("conductor/catalog", {});
  assert.equal(commands.length, 1); assert.equal(commands[0].id, "node-tests"); assert.equal(commands[0].image, image);
  assert.deepEqual(commands[0].argv, ["/usr/local/bin/node", "--test", "--test-isolation=none"]); assert.deepEqual(commands[0].requiredGates, ["D", "E"]);
  assert.deepEqual((await invoke("conductor/list", { sessionId: session.id })).runs, []);
  await nativeMouse(button(".conductor-actions", "New run"));
  await wait(() => main.evaluate(`!!document.querySelector('.conductor-entry fieldset:not(:disabled)')`), "enabled real admission form");
  await fill("objective", purpose === "analysis" ? "Assess only the owned fixture without writes." : "Change only fixture.txt from before to after and verify the existing test.");
  if (purpose === "implementation") await nativeMouse(button(".conductor-entry", "Authorized implementation"));
  await fill("scope", "fixture.txt");
  if (purpose === "implementation") await fill("allowedPaths", "fixture.txt");
  await fill("acceptanceCriteria", purpose === "analysis" ? "Observe the actual fixture." : "The existing owned fixture test passes after the bounded write.");
  await fill("materialPaths", "fixture.txt");
  if (purpose === "implementation") await nativeMouse(element('.conductor-entry input[type="checkbox"]'));
  await screenshot(`${purpose}-entry.png`);
  const providerStart = requests.length;
  await nativeMouse(element('.conductor-entry button[type="submit"]'));
  const runId = await wait(async () => {
    const { runs } = await invoke("conductor/list", { sessionId: session.id }); assert.ok(runs.length <= 1, "Exactly one native Start admission"); return runs[0]?.runId;
  }, "native Start persists exactly one run", 60000);
  const ref = { sessionId: session.id, runId }; let consent, completed;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    assert.deepEqual(faults, []);
    const loaded = await history(ref);
    if (loaded.pendingConsent && !consent) {
      assert.equal(purpose, "implementation"); assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "before\n");
      const pending = loaded.pendingConsent;
      await wait(() => main.evaluate(`!!document.querySelector('.conductor-consent')`), "rendered exact Gate C consent");
      const shown = await main.evaluate(`document.querySelector('.conductor-consent').innerText`);
      for (const value of [pending.requestId, pending.baselineHash, pending.sourceFingerprint, pending.baseline.scopeVersion, pending.baseline.planVersion, pending.baseline.acceptanceVersion, pending.baseline.rollbackReference, ...pending.baseline.allowedPaths]) assert.ok(shown.includes(value), `Exact consent value visible: ${value}`);
      const pre = await main.evaluate(`[...document.querySelectorAll('.conductor-consent pre')].map(e=>e.textContent)`);
      assert.deepEqual(JSON.parse(pre[0]), pending.baseline.qualityCommands); assert.deepEqual(JSON.parse(pre[1]), pending.effectProfile);
      assert.match(shown, /not a file-tool permission/);
      await main.evaluate(`document.querySelector('.conductor-consent').scrollIntoView({block:'start'})`);
      await screenshot("implementation-exact-gate-c.png");
      await nativeMouse(button(".conductor-consent", "Approve this exact baseline"));
      consent = pending; outcomes.push({ kind: "native-exact-owner-consent", ...ref, request: pending });
    }
    await answerPermissions(session, purpose, consent);
    if (["completed", "failed", "cancelled", "interrupted"].includes(loaded.index.status) || loaded.checkpoint.status === "escalated") { completed = loaded; break; }
    await delay(50);
  }
  assert.ok(completed, "Run must settle before the bounded deadline");
  assert.equal(completed.index.status, "completed", JSON.stringify(completed.checkpoint)); assert.deepEqual(completed.resourceIssues, []);
  const { checkpoint, projection } = completed;
  assert.deepEqual(completed.intake.engine, availability.provenance);
  assert.equal(projection.purpose, purpose); assert.equal(projection.motorStatus, purpose === "analysis" ? "reported" : "awaiting_authorization");
  assert.equal(projection.workers.length, purpose === "analysis" ? 4 : 7);
  assert.equal(new Set(projection.workers.map(worker => worker.dispatchId)).size, projection.workers.length);
  for (const worker of projection.workers) { assert.ok(worker.workerId && worker.dispatchId && worker.task && worker.inputHash && worker.output); assert.notEqual(worker.workerId, worker.dispatchId); assert.equal(worker.status, "completed"); }
  assert.deepEqual(projection.gateHistory.map(gate => [gate.gate, gate.decision]), checkpoint.history.map(gate => [gate.gate, gate.decision]));
  assert.ok(projection.reports.some(report => report.kind === "decision" && report.stage === "arbiter"));
  if (purpose === "analysis") {
    assert.equal(consent, undefined); assert.equal(checkpoint.reportDecision.decision, "accept");
    assert.deepEqual(checkpoint.history.filter(item => item.kind === "skipped").map(item => item.gate), ["B", "D", "F"]);
    assert.deepEqual(checkpoint.qualityExecutions, []); assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "before\n");
    assert.ok(requests.slice(providerStart).some(item => item.mode === "critic" && item.workerId));
    assert.equal(projection.next, "none");
  } else {
    assert.ok(consent); assert.ok(permissionAnswers.some(item => item.sessionId === session.id && item.toolName === "Write"));
    assert.deepEqual(checkpoint.history.map(item => item.gate), ["A", "B", "C", "D", "E", "F", "G"]);
    assert.equal(checkpoint.decision.decision, "go"); assert.equal(checkpoint.closeout, undefined); assert.equal(projection.next, "external-authorization");
    const quality = checkpoint.qualityExecutions;
    assert.deepEqual(quality.map(item => item.gate), ["D", "E"]); assert.equal(new Set(quality.map(item => item.childSessionId)).size, 2); assert.equal(new Set(quality.map(item => item.evidenceId)).size, 2);
    for (const item of quality) { assert.equal(item.commandId, "node-tests"); assert.equal(item.outcome, "passed"); assert.equal(item.exitCode, 0); assert.ok(outcomes.some(record => record.kind === "quality-tool-output" && record.evidenceId === item.evidenceId && record.stdoutSha256 === item.stdoutSha256)); }
    assert.equal(await readFile(join(project, "fixture.txt"), "utf8"), "after\n");
  }
  assert.equal(sha256(await readFile(join(project, "fixture.test.cjs"))), testHash);
  await wait(() => main.evaluate(`document.querySelector('.conductor-run')?.dataset.conductorRun===${j(runId)}&&document.querySelector('.conductor-run').innerText.includes(${j(purpose === "analysis" ? "Reported" : "Awaiting separate external authorization")})`), "completed authoritative UI projection");
  await inspectRun(completed);
  await screenshot(`${purpose}-completed.png`);
  await writeFile(join(evidence, `${purpose}-history.json`), JSON.stringify(completed, null, 2));
  saved.push({ session, ref, history: completed }); outcomes.push({ kind: "native-run", purpose, ...ref, externalActionAuthorized: false });
}
async function inspectRun(loaded) {
  const { projection } = loaded;
  const workers = await main.evaluate(`[...document.querySelectorAll('.conductor-workers .conductor-disclosure>button')].map(e=>e.textContent)`);
  assert.equal(workers.length, projection.workers.length);
  for (let i = 0; i < workers.length; i++) {
    const worker = projection.workers[i]; assert.ok(workers[i].includes(worker.workerId) && workers[i].includes(worker.dispatchId));
    const body = await disclosure(`document.querySelectorAll('.conductor-workers .conductor-disclosure>button')[${i}]`, ["mouse", "Enter", "Space"][i % 3]);
    for (const value of [worker.workerId, worker.dispatchId, worker.task, worker.inputHash, worker.output]) assert.ok(body.includes(value));
    assert.match(body, /not a gate approval/);
  }
  const gateButtons = await main.evaluate(`[...document.querySelectorAll('.conductor-run>.conductor-disclosure>button')].filter(e=>/^Gate [A-G] ·/.test(e.textContent)).length`);
  assert.equal(gateButtons, projection.gateHistory.length);
  for (let i = 0; i < projection.gateHistory.length; i++) {
    const gate = projection.gateHistory[i];
    const expression = `[...document.querySelectorAll('.conductor-run>.conductor-disclosure>button')].filter(e=>/^Gate [A-G] ·/.test(e.textContent))[${i}]`;
    const body = await disclosure(expression, ["mouse", "Enter", "Space"][i % 3]);
    assert.match(body, /Decision basis/); for (const value of gate.basis) assert.ok(body.includes(value));
    for (const value of gate.evidenceReviewed) assert.ok(body.includes(value));
    assert.ok(body.includes(gate.stateUpdate));
  }
  for (let i = 0; i < projection.reports.length; i++) {
    const report = projection.reports[i];
    const expression = `[...document.querySelectorAll('.conductor-run>.conductor-disclosure>button')].find(e=>e.textContent.includes(${j(report.id)}))`;
    assert.equal(await disclosure(expression, ["mouse", "Enter", "Space"][i % 3]), report.body);
  }
  if (!projection.workers.some(worker => worker.stage === "ralph")) assert.doesNotMatch(await main.evaluate(`document.querySelector('.conductor-run').innerText`), /Ralph/);
}
async function fixtureReceipt() {
  const receipt = {};
  for (const name of ["fixture.txt", "fixture.test.cjs"]) {
    const path = join(project, name), stat = await lstat(path, { bigint: true });
    receipt[name] = { hash: sha256(await readFile(path)), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), size: String(stat.size) };
  }
  return receipt;
}
async function assertNoReplay(label) {
  const count = requests.length, permissions = permissionAnswers.length, fileHash = sha256(await readFile(join(project, "fixture.txt")));
  for (const entry of saved) {
    await openSession(entry.session);
    await wait(() => main.evaluate(`document.querySelector('.conductor-run')?.dataset.conductorRun===${j(entry.ref.runId)}`), "reopened persisted UI run");
    await nativeMouse(button(".conductor-panel", "Refresh history"));
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.deepEqual(await history(entry.ref), entry.history, `${label}: exact persisted history`);
      const { runs } = await invoke("conductor/list", { sessionId: entry.session.id }); assert.equal(runs.length, 1); assert.equal(runs[0].runId, entry.ref.runId);
    }
    await screenshot(`${label}-${entry.history.projection.purpose}.png`);
  }
  assert.equal(requests.length, count, `${label}: no provider replay`); assert.equal(permissionAnswers.length, permissions);
  assert.equal(sha256(await readFile(join(project, "fixture.txt"))), fileHash, `${label}: no write replay`);
  assert.deepEqual(await main.evaluate("window.__harnessAcceptance.permissions"), [], `${label}: no permission replay`);
  outcomes.push({ kind: label, historyIdentical: true, providerReplay: 0, writeReplay: 0, dispatchReplay: 0 });
}

try {
  await Promise.all([home, profile, data, project, agents, temp, application, evidence].map(path => mkdir(path, { recursive: true })));
  console.log(`Owned native Conductor evidence: ${evidence}`);
  result.sourceAtStart = await fingerprint();
  result.uncommittedCandidate = !!result.sourceAtStart.status.trim();
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
    TMPDIR: temp, TMP: temp, TEMP: temp, PATH: [dirname(process.execPath), dirname(docker)].join(delimiter),
    PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: resolve(hostBinary), PI_DESKTOP_AGENTS_DIR: agents, ELECTRON_RENDERER_URL: "",
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1",
    ...(originalEnv.SystemRoot ? { SystemRoot: originalEnv.SystemRoot } : {}), ...(originalEnv.WINDIR ? { WINDIR: originalEnv.WINDIR } : {}),
    ...(process.platform === "linux" ? Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"].filter(key => originalEnv[key]).map(key => [key, originalEnv[key]])) : {}) };
  // HostProcess itself merges process.env: sanitize this runner as well as child
  // env before importing any application transport. Never inherit tokens/proxies.
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env); process.chdir(home);
  const { currentAuditHash } = await import("../packages/conductor-runtime/dist/engine.mjs");
  const key = "task-owned-native-fixture-key";
  server = createServer(providerFixture({ currentAuditHash, requests, outcomes, faults, key }));
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(guard, `(${installNodeGuard.toString()})(require,${j({ origin, audit, guard })});\n`, { flag: "wx" });
  const metadata = { custom: { id: "custom", name: "Owned fixture", api: `${origin}/v1`, models: {
    "fixture-model": { id: "fixture-model", name: "Owned fixture model", reasoning: false, tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 8192 } } } } };
  await mkdir(join(application, "resources/models.dev"), { recursive: true });
  await writeFile(join(application, "resources/models.dev/api.json"), JSON.stringify(metadata));
  const manifest = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
  await writeFile(join(application, "package.json"), JSON.stringify({ ...manifest, main: "entry.cjs" }));
  // Only external metadata and isolation belong to this wrapper. App imports,
  // preload, renderer, permissions, host/sidecar and engine remain the candidate.
  await writeFile(join(application, "entry.cjs"), `require(${j(guard)});\nconst {app,session}=require('electron');\napp.setPath('userData',${j(profile)});app.setPath('home',${j(home)});app.setPath('temp',${j(temp)});\nconst fs=require('node:fs');\napp.on('session-created',s=>s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,done)=>{const url=new URL(details.url);const cancel=url.origin!==${j(origin)};if(cancel)fs.appendFileSync(${j(audit)},JSON.stringify({pid:process.pid,kind:'chromium-denied',origin:url.origin})+'\\n');done({cancel});}));\napp.whenReady().then(()=>{session.defaultSession;});\nrequire(${j(mainPath)});\n`);
  await writeFile(join(project, "fixture.txt"), "before\n");
  await writeFile(join(project, "fixture.test.cjs"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('owned fixture changed', () => { assert.equal(fs.readFileSync(path.join(__dirname, 'fixture.txt'), 'utf8'), 'after\\n'); });\n");
  const testHash = sha256(await readFile(join(project, "fixture.test.cjs")));
  await writeFile(join(data, "close-behavior.json"), JSON.stringify("quit")); // Own native window preference, not SQLite.
  const { HostProcess } = await import("../packages/host-runtime/dist/host-process.js");
  const { PROTOCOL_VERSION } = await import("../packages/shared/dist/index.js");
  preparer = new HostProcess({ binaryPath: resolve(hostBinary), dataDir: data, env, onStderr: text => outcomes.push({ kind: "preparation-host-stderr", text }) });
  await preparer.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
  await preparer.call("workspace.set", { path: project });
  const { provider } = await preparer.call("providers.create", { name: "Owned native fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl: `${origin}/v1`, authKind: "api_key_and_base_url", defaultModelId: "fixture-model", secretValue: key, apiStyle: "chat_completions" });
  assert.equal(provider.hasSecret, true);
  await preparer.call("providers.cacheModels", { providerId: provider.id, models: [{ modelId: "fixture-model", displayName: "Owned fixture model", capabilities: ["text", "tools"] }] });
  await preparer.call("settings.set", { language: "en", closeBehavior: "quit", keybindings: { toggleMini: null, toggleWindow: null }, defaultProviderId: provider.id, defaultModelId: "fixture-model" });
  const sessions = [];
  for (const purpose of ["analysis", "implementation"]) {
    const { session } = await preparer.call("session.create", { title: `Owned native Conductor ${purpose}`, mode: "agent", projectPath: project, providerId: provider.id, modelId: "fixture-model" });
    await preparer.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask", thinkingLevel: "off" }); sessions.push(session);
  }
  await preparer.dispose(); preparer = undefined; // No concurrent host owns the DB at app launch.
  await launch(env);
  for (let i = 0; i < sessions.length; i++) await runSession(sessions[i], i ? "implementation" : "analysis", testHash);
  // New renderer observer starts empty; only explicit history/list reads follow.
  const requestsBeforeReload = requests.length;
  const settledFixture = await fixtureReceipt();
  await main.send("Page.reload", { ignoreCache: true }); await ready(); await assertNoReplay("renderer-reload");
  assert.equal(requests.length, requestsBeforeReload, "Reload itself must not replay provider work");
  assert.deepEqual(await fixtureReceipt(), settledFixture, "Renderer reload must not repeat even an identical-content write");
  const settledRequests = requests.length;
  await closeOwned(); await launch(env); await assertNoReplay("full-app-relaunch"); assert.equal(requests.length, settledRequests);
  assert.deepEqual(await fixtureReceipt(), settledFixture, "Full relaunch must not repeat even an identical-content write");
  outcomes.push({ kind: "no-write-replay-file-receipts", receipt: settledFixture });
  assert.deepEqual(await readdir(join(data, "conductor-resources")), [], "Actual host cleans only registered own containers/resources");
  await closeOwned();
  const auditRows = (await readFile(audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const children = auditRows.filter(row => row.kind === "child-start" && row.childPid);
  for (const child of children) {
    assert.ok(auditRows.some(row => ["child-exit", "child-absence"].includes(row.kind) && row.pid === child.pid && row.childPid === child.childPid), `Owned child ${child.childPid} must be observed reaped`);
    if (child.guarded) assert.ok(auditRows.some(row => row.kind === "guard-installed" && row.pid === child.childPid), "Sidecar preload must execute before its runtime");
    if (child.guarded) assert.ok(auditRows.some(row => row.kind === "guard-self-test" && row.pid === child.childPid && row.fetchDenied && row.socketDenied), "Sidecar non-loopback guard self-test");
  }
  assert.ok(children.some(child => child.guarded), "Real guarded Electron-as-Node sidecar was launched");
  result.networkGuard = { kind: "pre-import Node numeric-endpoint allowlist plus per-session Chromium request denial; not an OS firewall", denied: auditRows.filter(row => row.kind.endsWith("denied")), ownedChildren: children.length };
  result.nativeElectronAccepted = true; result.passed = true;
} catch (error) {
  failure = error; result.error = { name: error.name, message: error.message, stack: error.stack };
  if (main) {
    try { await screenshot("failure.png"); await writeFile(join(evidence, "failure-dom.html"), await main.evaluate("document.documentElement.outerHTML")); }
    catch (captureError) { outcomes.push({ kind: "failure-capture-error", message: String(captureError) }); }
  }
} finally {
  for (const [name, stop] of [["owned-app", closeOwned], ["preparation-host", () => preparer?.dispose()]]) {
    try { await stop(); } catch (error) { result.passed = false; result.nativeElectronAccepted = false; faults.push(`${name} cleanup: ${error}`); failure ??= error; }
  }
  if (server?.listening) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); }
  process.chdir(originalCwd); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
  try {
    result.sourceAtEnd = await fingerprint();
    result.concurrentCandidateChange = result.sourceAtStart?.head !== result.sourceAtEnd.head || result.sourceAtStart?.base !== result.sourceAtEnd.base || result.sourceAtStart?.sourceHash !== result.sourceAtEnd.sourceHash || JSON.stringify(result.sourceAtStart?.builtHashes) !== JSON.stringify(result.sourceAtEnd.builtHashes);
    if (result.concurrentCandidateChange) throw new Error("Candidate source/build changed during acceptance; rerun on a stable built candidate");
  } catch (error) { result.passed = false; result.nativeElectronAccepted = false; failure ??= error; faults.push(String(error)); }
  // A failed shutdown must not delete configuration beneath a possibly live
  // owned descendant. Audit only our child handles; never discover/kill PIDs.
  let childrenReaped = true;
  try {
    const rows = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const remaining = rows.filter(row => row.kind === "child-start" && row.childPid && !rows.some(exit => ["child-exit", "child-absence"].includes(exit.kind) && exit.pid === row.pid && exit.childPid === row.childPid));
    childrenReaped = remaining.length === 0;
    if (!childrenReaped) throw new Error(`Owned descendants lack exit receipts; retained own runtime: ${remaining.map(row => row.childPid).join(",")}`);
  } catch (error) { if (error.code !== "ENOENT") { childrenReaped = false; result.passed = false; failure ??= error; faults.push(String(error)); } }
  if (!owned && childrenReaped) {
    try { await rm(runtime, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    catch (error) { result.passed = false; failure ??= error; faults.push(`owned-directory cleanup: ${error}`); }
  } else {
    result.passed = false;
    failure ??= new Error("Owned cleanup incomplete; own runtime retained; no unrelated PID/port touched");
  }
  if (!result.passed) result.nativeElectronAccepted = false;
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`HARNESS_CONDUCTOR_NATIVE_FIXTURE_PASS (NOT live-model acceptance): ${join(evidence, "result.json")}`);
