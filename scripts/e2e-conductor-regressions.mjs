#!/usr/bin/env node
// Full Electron/preload/main/host/sidecar test. Only the external provider is a loopback fixture.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "conductor-e2e-"));
console.log(`Artifacts: ${root}`);
const dataDir = join(root, "data"), project = join(root, "project"), agents = join(root, "agents");
await Promise.all([dataDir, project, agents].map(path => mkdir(path, { recursive: true })));
await writeFile(join(project, "evidence.txt"), "CONDUCTOR_REAL_READ_FIXTURE\n");
const originalAgents = process.env.PI_DESKTOP_AGENTS_DIR;
process.env.PI_DESKTOP_AGENTS_DIR = agents;
const binary = resolveHostBinary();
const requests = [], held = [], results = [];
const screenshots = {};
let phase = "settlement", parentStep = 0, releaseParent;
const check = label => { results.push(label); console.log(`PASS ${label}`); };
const tool = (id, name, args, index = 0) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function respond(res, payload, delta) {
  if (res.destroyed) return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "conductor-fixture", object: "chat.completion.chunk", created: 1, model: payload.model };
  for (const [value, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}
const server = createServer(async (req, res) => {
  try {
    let body = ""; for await (const chunk of req) body += chunk;
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    const payload = JSON.parse(body);
    const parent = payload.tools?.some(t => t.function?.name === "Task");
    const user = payload.messages.findLast(m => m.role === "user");
    const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    const marker = ["alpha", "beta", "failure", "cancel", "restart"].find(x => text?.includes(`worker-${x}`));
    const read = payload.messages.some(m => m.role === "tool");
    requests.push({ parent, marker, read, phase });
    if (parent) {
      const step = parentStep++;
      if (step === 0) {
        const names = phase === "settlement" ? ["alpha", "beta", "failure", "cancel"] : ["restart"];
        respond(res, payload, { role: "assistant", tool_calls: names.map((name, i) => tool(`task-${name}`, "Task", { agent: "explorer", description: `Fixture ${name}`, task: `worker-${name}: Read evidence.txt and report only this worker marker.` }, i)) });
      } else if (step === 1) {
        await new Promise(resolve => { releaseParent = resolve; });
        respond(res, payload, { role: "assistant", tool_calls: [tool(`stop-${phase}`, "TaskStop", {})] });
      } else if (step === 2) {
        respond(res, payload, { role: "assistant", tool_calls: [tool(`wait-${phase}`, "TaskWait", { timeoutSeconds: 10 })] });
      } else respond(res, payload, { role: "assistant", content: `Fixture ${phase} converged; failure and cancellation are not success.` });
    } else if (marker === "failure") {
      res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Fixture permanent provider failure" } }));
    } else if (!read) {
      respond(res, payload, { role: "assistant", tool_calls: [tool(`read-${marker}`, "Read", { path: join(project, "evidence.txt") })] });
    } else if (marker === "cancel" || marker === "restart") {
      held.push({ marker, res });
    } else respond(res, payload, { role: "assistant", content: `worker-${marker}: CONDUCTOR_REAL_READ_FIXTURE verified.` });
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const host = new Host(binary, dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", { name: "Conductor loopback fixture", type: "openai_compatible", protocol: "openai_compatible", authKind: "none", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModelId: "fixture", apiStyle: "chat_completions" });
await host.call("settings.set", { language: "en", closeBehavior: "quit", keybindings: { toggleMini: null }, defaultProviderId: provider.id, defaultModelId: "fixture" });
const { session } = await host.call("session.create", { title: "Conductor lifecycle fixture", projectPath: project, providerId: provider.id, modelId: "fixture" });
await host.stop();
const { appDir, electronBinary } = resolveElectronBinary();
assert.equal(resolve(appDir), join(repo, "apps/desktop"), "must execute candidate desktop");
const wrapper = join(root, "entry.cjs");
await writeFile(wrapper, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(root, "profile"))});require(${JSON.stringify(join(appDir, "out/main/index.js"))});`);
const port = Number(process.env.PI_CONDUCTOR_E2E_PORT || 19541);
let owned, main;
async function connect() {
  let target;
  await waitFor(async () => {
    if (owned.child.exitCode !== null) throw new Error(owned.output);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page" && t.url.includes("index.html") && !t.url.includes("surface=")); return !!target; } catch { return false; }
  }, 30_000, "owned Electron target");
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  owned.sockets.push(socket);
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const msg = JSON.parse(data), p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 25_000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails)); return result.result.value; };
  return { send, evaluate };
}
async function launch() {
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: binary, PI_DESKTOP_AGENTS_DIR: agents, ELECTRON_RENDERER_URL: "" }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [`--remote-debugging-port=${port}`, "--force-device-scale-factor=1", `--user-data-dir=${join(root, "profile")}`, wrapper], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  owned = { child, output: "", sockets: [] };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { owned.output += chunk; });
  main = await connect(); await ready();
}
const invoke = async (channel, args) => { const result = await main.evaluate(`window.piDesktop.invoke(${JSON.stringify(`pi-desktop/${channel}`)},${JSON.stringify(args)})`); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const history = async () => (await invoke("session/get", { id: session.id })).session;
async function ready() { await waitFor(() => main.evaluate(`!!document.querySelector('[data-nav="settings"]')&&!document.querySelector('.startup-splash')`), 40_000, "renderer ready"); }
async function selectSession() {
  await waitFor(() => main.evaluate(`(() => { const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Conductor lifecycle fixture'));if(!e)return false;e.click();return true;})()`), 15_000, "session navigation");
}
async function screenshot(name) { const image = await main.send("Page.captureScreenshot", { format: "png" }); const bytes = Buffer.from(image.data, "base64"); await writeFile(join(root, name), bytes); screenshots[name] = createHash('sha256').update(bytes).digest('hex'); }
const cards = () => main.evaluate(`[...document.querySelectorAll('.subagent-topology-node[data-message-id]')].map(e=>({id:e.dataset.messageId,text:e.innerText,html:e.outerHTML}))`);
async function openCard(call, input, expectedRead) {
  const selector = `.subagent-topology-node[data-message-id="${call}"] button`;
  await main.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});for(let p=e.parentElement;p;p=p.parentElement){const b=[...p.children].find(x=>x.matches('button[aria-expanded="false"]'));if(b&&!b.classList.contains('subagent-topology-node-header'))b.click();} })()`);
  await main.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  if (input === "mouse") {
    let last = "";
    await waitFor(async () => { const rect = await main.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`); const value = JSON.stringify(rect); const stable = rect.hit && value === last; last = value; return stable; }, 10_000, "stable card hit target");
    const { x, y } = JSON.parse(last);
    await main.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await main.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await main.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } else {
    await main.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await main.send("Page.bringToFront");
    const key = input === "Enter" ? "Enter" : " ", code = input === "Enter" ? "Enter" : "Space", n = input === "Enter" ? 13 : 32;
    await main.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: n, text: input === "Enter" ? "\r" : " ", unmodifiedText: input === "Enter" ? "\r" : " " });
    await main.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: n });
  }
  await waitFor(() => main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')==='true'`), 10_000, `${input} expands ${call}`);
  const controls = await main.evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-controls')`);
  await waitFor(() => main.evaluate(`!!document.getElementById(${JSON.stringify(controls)})?.querySelector('[data-testid="subagent-transcript-tab"]')`), 12_000, `${input} matching detail ${call}`);
  const detail = await main.evaluate(`document.getElementById(${JSON.stringify(controls)}).innerText`);
  const messages = (await history()).messages;
  const task = messages.find(m => m.id === call);
  assert.equal(controls, `work-panel-surface-subagent:${task.toolResult.details.delegationId}`);
  const rows = await main.evaluate(`[...document.getElementById(${JSON.stringify(controls)}).querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId)`);
  const children = messages.filter(m => m.parentToolCallId === call);
  for (const row of rows) assert.ok(children.some(m => m.id === row), `foreign child ${row} in ${call}`);
  if (expectedRead) assert.ok(rows.includes(`read-${call.replace('task-', '')}`), JSON.stringify(rows));
  await screenshot(`${phase}-${call}-${input}.png`);
  return { call, input, controls, detail, rows };
}
async function close() {
  if (!owned) return;
  const current = owned;
  try { await invoke("window/control", { action: "close" }); } catch { /* window may close before reply */ }
  try { await waitFor(() => current.child.exitCode !== null, 12_000, "owned app exit"); } catch { current.child.kill(); }
  for (const socket of current.sockets) socket.close();
  if (current.child.exitCode === null) await once(current.child, "exit");
  await writeFile(join(root, `electron-${phase}.log`), current.output);
  owned = null;
}
const interactions = [];
try {
  await launch(); await selectSession();
  await invoke("agent/prompt", { sessionId: session.id, content: "Run the settlement fixture." });
  await waitFor(() => held.some(x => x.marker === "cancel") && !!releaseParent && requests.filter(x => !x.parent && ["alpha", "beta"].includes(x.marker) && x.read).length === 2, 40_000, "real child Reads and held cancellation");
  await waitFor(async () => (await cards()).length === 4, 15_000, "four independent explorer cards");
  assert.ok((await cards()).every(card => !card.html.includes('agent-avatar') && card.text.includes('explorer')), 'generic explorer keeps exact name and bot glyph');
  assert.equal(await main.evaluate(`document.querySelectorAll('.subagent-topology-idle').length`), 0);
  assert.equal(await main.evaluate(`document.querySelectorAll('.subagent-topology-root').length`), 1);
  await writeFile(join(root, "inflight-history.json"), JSON.stringify(await history(), null, 2));
  await waitFor(async () => (await history()).messages.filter(m=>['task-alpha','task-beta'].includes(m.id)&&m.toolResult?.details?.status==='completed').length===2, 10_000, 'successful siblings durably settled');
  const before = requests.length;
  await main.send("Page.reload", { ignoreCache: true }); await ready(); await selectSession();
  await waitFor(async () => (await cards()).length === 4, 15_000, "reload restores cards");
  assert.deepEqual((await cards()).map(c=>c.id), ['task-alpha','task-beta','task-failure','task-cancel']);
  assert.ok((await cards()).find(c=>c.id==='task-cancel').html.includes('outcome-running'));
  interactions.push(await openCard('task-cancel','Enter',true));
  await screenshot('inflight-reloaded.png');
  assert.equal(requests.length, before, "reload must not redispatch provider work");
  check("in-flight renderer reload preserves four identities without duplicate dispatch");
  releaseParent(); releaseParent = null;
  await waitFor(async () => (await history()).messages.some(m => m.role === "assistant" && m.content?.includes("Fixture settlement converged")), 30_000, "TaskStop and TaskWait settlement");
  await writeFile(join(root, "settled-history.json"), JSON.stringify(await history(), null, 2));
  const expected = { 'task-alpha':'completed', 'task-beta':'completed', 'task-failure':'failed', 'task-cancel':'stopped' };
  for (const [id,status] of Object.entries(expected)) assert.ok((await cards()).find(c=>c.id===id)?.html.includes(`outcome-${status}`), `${id} must be ${status}`);
  assert.ok(await main.evaluate(`document.querySelector('.tool-activity-group.has-subagents .tool-activity-label').textContent.includes('issues')`));
  interactions.push(await openCard('task-failure','Enter',false));
  assert.match(interactions.at(-1).detail, /Failed/);
  interactions.push(await openCard('task-cancel','Space',true));
  assert.match(interactions.at(-1).detail, /Stopped by request/);
  check('failed and cancelled delegates retain independent outcomes and issue group status');
  interactions.push(await openCard("task-alpha", "mouse", true));
  interactions.push(await openCard("task-beta", "Enter", true));
  interactions.push(await openCard("task-alpha", "Space", true));
  await screenshot("settled-native.png");
  check("repeated-role cards open through mouse, Enter and Space with matching panels");
  phase = "restart"; parentStep = 0;
  await invoke("agent/prompt", { sessionId: session.id, content: "Run the restart fixture." });
  await waitFor(() => held.some(x => x.marker === "restart") && !!releaseParent, 30_000, "restart child held after real Read");
  const count = requests.length;
  await close(); releaseParent?.(); releaseParent = null;
  await launch(); await selectSession();
  const restored = await history();
  await writeFile(join(root, "restarted-history.json"), JSON.stringify(restored, null, 2));
  assert.equal(requests.length, count, "full restart must not replay provider requests");
  await waitFor(async () => (await cards()).length===5, 10_000, 'restored five cards');
  for (const [id,status] of Object.entries({...expected,'task-restart':'aborted'})) assert.ok((await cards()).find(c=>c.id===id)?.html.includes(`outcome-${status}`), `restart ${id} must be ${status}`);
  interactions.push(await openCard('task-restart','Enter',true));
  assert.match(interactions.at(-1).detail, /Stopped/);
  await screenshot("restarted.png");
  check("full app restart retains history without request replay");
} catch (error) {
  if (main && owned) { try { await screenshot("failure.png"); await writeFile(join(root, "failure-dom.html"), await main.evaluate("document.documentElement.outerHTML")); await writeFile(join(root, "failure-history.json"), JSON.stringify(await history(), null, 2)); } catch {} }
  throw error;
} finally {
  await close(); releaseParent?.(); for (const { res } of held) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (originalAgents === undefined) delete process.env.PI_DESKTOP_AGENTS_DIR; else process.env.PI_DESKTOP_AGENTS_DIR = originalAgents;
  await writeFile(join(root, "result.json"), JSON.stringify({ fixture: "external loopback provider only; real internal runtime/UI", candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), base: execFileSync("git", ["rev-parse", "origin/main"], { cwd: repo, encoding: "utf8" }).trim(), uncommittedCandidate: !!execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), results, interactions, requests, screenshots }, null, 2));
}
