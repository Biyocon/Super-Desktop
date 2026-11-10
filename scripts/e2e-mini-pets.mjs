#!/usr/bin/env node
// Actual renderer/preload/main/host. Loopback providers and external media fixture only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mini-pets-e2e-"));
const dataDir = join(root, "data");
const project = join(root, "project");
const source = join(root, "package");
const agents = join(root, "agents");
await Promise.all([dataDir, project, source, agents].map((path) => mkdir(path, { recursive: true })));
const libraryFixture = join(agents, "subagent-library", "customagents");
await mkdir(libraryFixture, { recursive: true });
await writeFile(join(libraryFixture, "project-reviewer.md"), '---\nname: project-reviewer\ndescription: Generic read-only library example for documentation screenshots\ntools: Read, Glob, Grep\n---\nInspect the requested project files and report evidence.\n');
const originalAgents = process.env.PI_DESKTOP_AGENTS_DIR;
process.env.PI_DESKTOP_AGENTS_DIR = agents;
const binary = resolveHostBinary();
const chatRequests = [];
const screenshots = {};
const handoffEvidence = {};
const walk = async (path) => (await Promise.all((await readdir(path, { withFileTypes: true })).map(async (entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [entry.name]))).flat();
let speechRequests = 0;
let failSpeech = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.url === "/v1/audio/transcriptions") {
    speechRequests++;
    if (failSpeech) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "External transcription failure fixture" } })); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "Dictated fixture draft" }));
  } else if (request.url === "/v1/chat/completions") {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    chatRequests.push(payload);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "pet-fixture", object: "chat.completion.chunk", created: 1, model: payload.model };
    const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: "assistant", content: "Local pet task fixture completed. No images generated or installed." });
    emit({}, "stop"); response.end("data: [DONE]\n\n");
  } else { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const host = new Host(binary, dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", { name: "Pet fixture", type: "openai_compatible", protocol: "openai_compatible", authKind: "none", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModelId: "pet-fixture", apiStyle: "chat_completions" });
const synthesis = { providerId: provider.id, modelId: "tts-fixture", protocol: "openai_audio", voice: "alloy" };
await host.call("settings.set", { language: "en", closeBehavior: "quit", keybindings: { toggleMini: null }, defaultProviderId: provider.id, defaultModelId: "pet-fixture", imageGeneration: { providerId: provider.id, modelId: "image-fixture" }, speech: { synthesize: synthesis } });
const fixture = await host.call("session.create", { title: "Mini fixture", projectPath: project, providerId: provider.id, modelId: "pet-fixture" });
const conductor = await host.call("session.create", { title: "Conductor topology — fixture", projectPath: project });
const appendDemo = (message) => host.call("session.appendMessage", { sessionId: conductor.session.id, message: { createdAt: "2026-11-10T00:00:00.000Z", status: "complete", ...message } });
await appendDemo({ id: "demo-user", role: "user", content: "Documentation fixture: show the full Conductor team. No live model calls are represented by this scene." });
await appendDemo({ id: "demo-intro", role: "assistant", content: "Conductor topology demonstration using generic, seeded transcript data." });
for (const [index, agent] of ["explorer", "strategist", "code-reviewer", "fixer", "test-runner", "integrator", "arbiter"].entries()) {
  await appendDemo({ id: `demo-task-${index}`, role: "tool", content: "Read-only fixture report", toolName: "Task", toolCallId: `demo-call-${index}`, toolStatus: "success", toolArgs: { agent, description: `Review ${agent} evidence`, task: "Read-only documentation fixture" }, toolResult: { details: { delegationId: `demo-delegation-${index}`, status: "completed", durationMs: 1250 } } });
}
await appendDemo({ id: "demo-summary", role: "assistant", content: "All seven role cards are shown in this fixture. Production seven-agent acceptance is a separate test." });
await host.stop();
await copyFile(join(repo, "crates/host-core/assets/pets/hassan.webp"), join(source, "spritesheet.webp"));
await writeFile(join(source, "pet.json"), JSON.stringify({ id: "test-hassan", displayName: "Imported Hassan", description: "Owner-owned test copy", spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp" }));
const attachment = join(source, "acceptance-note.txt");
await writeFile(attachment, "Harmless attachment retained during Mini draft handoff.\n");
const { appDir, electronBinary } = resolveElectronBinary();
const runtime = join(root, "native-state.json");
const windowCommand = join(root, "window-size.json");
const wrapper = join(root, "entry.cjs");
await writeFile(wrapper, `const {app,dialog,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(root, "profile"))});
const nativePicker=dialog.showOpenDialog.bind(dialog);
dialog.showOpenDialog=async (...args)=>{const options=args.at(-1);if(options?.filters?.some(x=>x.name.includes('Pet manifest')))return {canceled:false,filePaths:[${JSON.stringify(join(source, "pet.json"))}]};if(options?.properties?.includes('multiSelections'))return {canceled:false,filePaths:[${JSON.stringify(join(source,"acceptance-note.txt"))}]};return nativePicker(...args);};
let tick=setInterval(()=>{try{
const windows=BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed());
const commandPath=${JSON.stringify(windowCommand)};
if(fs.existsSync(commandPath)){const bounds=JSON.parse(fs.readFileSync(commandPath,'utf8'));const main=windows.find(w=>w.isVisible()&&!w.webContents.getURL().includes('surface='));if(main){main.setSize(bounds.width,bounds.height);fs.unlinkSync(commandPath);}}
fs.writeFileSync(${JSON.stringify(runtime)},JSON.stringify(windows.map(w=>({id:w.id,title:w.getTitle(),visible:w.isVisible(),bounds:w.getBounds(),top:w.isAlwaysOnTop(),sandbox:w.webContents.getLastWebPreferences().sandbox}))));
}catch(error){console.error(String(error));}},100);
app.once('before-quit',()=>clearInterval(tick));
require(${JSON.stringify(join(appDir, "out/main/index.js"))});
`);
let processSession;
const port = Number(process.env.PI_MINI_E2E_PORT || 19521);
const results = [];
const check = (label) => { results.push(label); console.log(`PASS ${label}`); };

async function connectTarget(predicate) {
  let target;
  await waitFor(async () => {
    if (processSession.child.exitCode !== null) throw new Error(processSession.output);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(predicate); return !!target; } catch { return false; }
  }, 30_000, "candidate page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  processSession.sockets.push(socket);
  return { evaluate, send };
}
async function launch() {
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: binary, PI_DESKTOP_AGENTS_DIR: agents, ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "profile")}`, wrapper], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  processSession = { child, output: "", sockets: [] };
  child.stdout.on("data", (data) => { processSession.output = (processSession.output + data).slice(-12_000); });
  child.stderr.on("data", (data) => { processSession.output = (processSession.output + data).slice(-12_000); });
  const main = await connectTarget((target) => target.type === "page" && target.url.includes("index.html") && !target.url.includes("surface="));
  await waitFor(() => main.evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`), 35_000, "app ready");
  return main;
}
async function close(main) {
  if (!processSession) return;
  try { await main.evaluate(`window.piDesktop.invoke('pi-desktop/window/control',{action:'close'})`); } catch {}
  try { await waitFor(() => processSession.child.exitCode !== null, 8_000, "normal candidate shutdown"); }
  catch { if (processSession.child.exitCode === null) processSession.child.kill(); }
  for (const socket of processSession.sockets) socket.close();
  if (processSession.child.exitCode === null) await once(processSession.child, "exit");
  processSession = null;
}
const invoke = (page, channel, ...args) => page.evaluate(`window.piDesktop.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);
const ok = async (page, channel, ...args) => { const result = await invoke(page, channel, ...args); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const native = async () => {
  let snapshot;
  await waitFor(async () => {
    try { snapshot = JSON.parse(await readFile(runtime, "utf8")); return true; }
    catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return false; throw error; }
  }, 10_000, 'complete owned-window snapshot');
  return snapshot;
};
const resizeMain = async (width, height) => {
  await writeFile(windowCommand, JSON.stringify({ width, height }));
  await waitFor(async () => (await native()).some(window => window.title === "Super-Desktop" && window.visible && Math.abs(window.bounds.width - width) <= 2 && Math.abs(window.bounds.height - height) <= 2), 10_000, "documentation window size");
};
const screenshot = async (page, name) => { const image = await page.send("Page.captureScreenshot", { format: "png" }); const bytes = Buffer.from(image.data, "base64"); await writeFile(join(root, name), bytes); screenshots[name] = createHash('sha256').update(bytes).digest('hex'); };
const clickText = async (page, text) => {
  await waitFor(() => page.evaluate(`(() => { const element=[...document.querySelectorAll('button')].find(x=>(x.textContent.trim()===${JSON.stringify(text)}||x.querySelector('.pets-choice-name')?.textContent.trim()===${JSON.stringify(text)})&&!x.disabled);if(!element)return false;element.click();return true;})()`), 15_000, `button ${text}`);
};
const fill = (page, selector, value) => page.evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing input '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true})); })()`);
async function configureDictation(page) {
  await page.evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await clickText(page, "Mini and virtual pets");
  await waitFor(() => page.evaluate(`(() => { const e=document.querySelector('.settings-card-block button[aria-label="AI providers"]');if(!e)return false;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight; })()`), 10_000, 'visible dictation provider trigger');
  await page.evaluate(`document.querySelector('.settings-card-block button[aria-label="AI providers"]').click()`);
  await clickText(page, "Pet fixture");
  await fill(page, 'input[aria-label="Models"]', "speech-fixture");
  await clickText(page, "Save");
  await waitFor(async () => (await ok(page, 'pi-desktop/settings/get')).speech?.transcribe?.modelId === 'speech-fixture', 10_000, 'dictation UI saved');
}
let main;
try {
  for (const name of ['index.cjs', 'mini.cjs']) {
    const preload = await readFile(join(appDir, 'out/preload', name), 'utf8');
    assert.doesNotMatch(preload, /require\(["']\.\.?\//, `${name} must remain self-contained for sandboxed require`);
  }
  main = await launch();
  await main.evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await clickText(main, "Mini and virtual pets");
  await waitFor(() => main.evaluate(`document.body.innerText.includes('Hassan')`), 15_000, "pet gallery");
  await screenshot(main, "settings-dark.png");
  check("actual Settings gallery loads bundled Hassan");
  await clickText(main, "None");
  await waitFor(async () => (await ok(main, "pi-desktop/pets/list")).preferences.selectedPet === null, 10_000, "None saved");
  check("gallery None selection persists through host");
  await clickText(main, "Import pet");
  await waitFor(() => main.evaluate(`document.body.innerText.includes('Imported Hassan')`), 20_000, "decoded import preview");
  assert.equal((await ok(main, "pi-desktop/pets/list")).pets.length, 1);
  await screenshot(main, "import-preview.png");
  await clickText(main, "Install pet");
  await waitFor(async () => (await ok(main, "pi-desktop/pets/list")).preferences.selectedPet === "test-hassan", 15_000, "import selected");
  check("native picker -> complete WebP decode -> preview -> explicit install");
  await ok(main, "pi-desktop/pets/preferences", { miniVisible: true, alwaysOnTop: false, scale: 1.25, position: { x: -100000, y: -100000 } });
  await ok(main, "pi-desktop/mini/setVisible", true);
  const mini = await connectTarget((target) => target.type === "page" && target.url.includes("surface=mini"));
  await waitFor(() => mini.evaluate(`!!document.querySelector('.mini-card')`), 15_000, "Mini renderer");
  await waitFor(async () => (await native()).filter((window) => window.title === "Super-Desktop Mini" && window.visible && window.top === false && Math.abs(window.bounds.width - 425) <= 2).length === 1, 10_000, "one visible configured native Mini");
  const observed = (await native()).find((window) => window.title === "Super-Desktop Mini");
  assert.equal(observed.visible, true); assert.equal(observed.sandbox, true); assert.equal(observed.top, false); assert.ok(Math.abs(observed.bounds.width - 425) <= 2, 'native DPI rounding stays within two DIP');
  assert.ok(observed.bounds.x > -100000 && observed.bounds.y > -100000);
  check("one sandboxed native Mini; scale/topmost and offscreen clamping");
  assert.equal(await mini.evaluate(`window.piDesktop.invoke('pi-desktop/settings/get').then(()=>false,()=>true)`), true);
  assert.equal(await mini.evaluate(`window.piDesktop.invoke('pi-desktop/pets/preferences',{}).then(()=>false,()=>true)`), true);
  check("restricted Mini preload denies general settings and import writes");
  await ok(main, "pi-desktop/mini/publish", { sessionId: fixture.session.id, title: "Actual selected session", status: "waiting" });
  await waitFor(() => mini.evaluate(`document.body.innerText.includes('Actual selected session')`), 10_000, "selected status projection");
  await screenshot(mini, "mini-dark.png");
  await clickText(mini, "Hide");
  await waitFor(async () => !(await ok(main, "pi-desktop/pets/list")).preferences.miniVisible, 10_000, "Mini hidden");
  await ok(main, "pi-desktop/mini/setVisible", true);
  assert.equal((await native()).filter((window) => window.title === "Super-Desktop Mini").length, 1);
  check("Mini hide/show reuses window and records visibility");
  await ok(main, "pi-desktop/settings/set", { theme: "light", language: "en", keybindings: { toggleMini: null } });
  await waitFor(() => mini.evaluate(`document.documentElement.dataset.theme==='light'`), 10_000, "Mini light theme");
  await screenshot(main, "settings-light.png"); await screenshot(mini, "mini-light.png");
  const snapshot = await ok(main, "pi-desktop/mini/getState");
  assert.equal(snapshot.dictationAvailable, false);
  check("unconfigured dictation is disabled; light/dark state synchronized");
  await configureDictation(main);
  assert.deepEqual((await ok(main, "pi-desktop/settings/get")).speech.synthesize, synthesis);
  await waitFor(async () => (await ok(main, "pi-desktop/mini/getState")).dictationAvailable, 10_000, "dictation available after settings save");
  check("dictation UI saves existing provider binding and preserves synthesis");
  const configuredSpeech = (await ok(main, 'pi-desktop/settings/get')).speech;
  await ok(main, 'pi-desktop/settings/set', { speech: { ...configuredSpeech, transcribe: { ...configuredSpeech.transcribe, path: '/audio/transcriptions', extra: { language: 'en' } } } });
  await main.evaluate(`window.fixtureReloadMarker=true`); await main.send('Page.reload', {});
  await waitFor(async () => { try { return await main.evaluate(`!window.fixtureReloadMarker && !!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`); } catch { return false; } }, 25_000, 'renderer reloads authoritative speech settings');
  await main.evaluate(`document.querySelector('[data-nav="settings"]').click()`); await clickText(main, 'Mini and virtual pets');
  await fill(main, 'input[aria-label="Models"]', 'speech-edited'); await clickText(main, 'Save');
  await waitFor(async () => (await ok(main, 'pi-desktop/settings/get')).speech?.transcribe?.modelId === 'speech-edited', 10_000, 'model-only edit saved');
  const editedBinding = (await ok(main, 'pi-desktop/settings/get')).speech.transcribe;
  assert.equal(editedBinding.path, '/audio/transcriptions'); assert.deepEqual(editedBinding.extra, { language: 'en' });
  check('model-only dictation edits preserve compatible custom path/extra fields');
  await main.evaluate(`document.querySelector('[data-sidebar-session-row="${fixture.session.id}"]').click()`);
  await waitFor(async () => (await ok(main, "pi-desktop/mini/getState")).activity.sessionId === fixture.session.id, 10_000, "real selected fixture session");
  await waitFor(() => main.evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`), 10_000, "composer ready");
  await main.evaluate(`(() => { const editor=document.querySelector('.composer-input');editor.focus();editor.textContent='Existing unsent draft';editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Existing unsent draft'})); })()`);
  await main.evaluate(`document.querySelector('button[aria-label="Add files"]').click()`);
  await waitFor(() => main.evaluate(`document.querySelector('.composer-chip-name')?.textContent==='acceptance-note.txt'`), 15_000, 'real composer picker/import attachment');
  const attachmentSnapshot = () => main.evaluate(`[...document.querySelectorAll('.composer-chip')].map(e=>({token:e.dataset.token,path:e.title,label:e.getAttribute('aria-label')}))`);
  const originalAttachments = await attachmentSnapshot();
  assert.equal(originalAttachments.length, 1);
  await mini.evaluate(`(() => {
    window.fixtureTracksStopped=0;
    window.fixtureMediaMode='ok';
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{if(window.fixtureMediaMode==='denied')throw new DOMException('Permission denied fixture','NotAllowedError');if(window.fixtureMediaMode==='missing')throw new DOMException('No microphone fixture','NotFoundError');return {getTracks:()=>[{stop:()=>window.fixtureTracksStopped++}]};}});
    window.MediaRecorder=class extends EventTarget {
      static isTypeSupported(){return true;} state='inactive';mimeType='audio/webm';
      start(){this.state='recording';} stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture audio'],{type:'audio/webm'})});this.onstop?.();}
    };
  })()`);
  for (const mode of ['denied', 'missing']) {
    await mini.evaluate(`window.fixtureMediaMode=${JSON.stringify(mode)}`);
    await clickText(mini, 'Record dictation');
    await waitFor(() => mini.evaluate(`!!document.querySelector('[role="alert"]') && [...document.querySelectorAll('button')].some(e=>e.textContent==='Record dictation'&&!e.disabled)`), 10_000, `${mode} capture recovers visibly`);
    assert.equal(speechRequests, 0); assert.equal(chatRequests.length, 0);
    await screenshot(mini, `microphone-${mode}-fixture.png`);
    check(`${mode} microphone boundary fixture recovers through actual capture/IPC/UI without provider calls`);
  }
  await mini.evaluate(`window.fixtureMediaMode='ok'`);
  await clickText(mini, 'Record dictation'); await clickText(mini, 'Cancel');
  assert.equal(speechRequests, 0); assert.equal(chatRequests.length, 0);
  assert.ok(await mini.evaluate(`window.fixtureTracksStopped>0`));
  check('cancel during recording stops fixture tracks without transcription or chat');
  failSpeech = true;
  await clickText(mini, 'Record dictation'); await clickText(mini, 'Stop recording');
  await waitFor(() => mini.evaluate(`!!document.querySelector('[role="alert"]') && [...document.querySelectorAll('button')].some(e=>e.textContent==='Record dictation'&&!e.disabled)`), 15_000, 'provider failure recovers visibly');
  assert.equal(speechRequests, 1); assert.equal(chatRequests.length, 0);
  assert.ok(await mini.evaluate(`window.fixtureTracksStopped>0`));
  await screenshot(mini, 'provider-failure-fixture.png');
  failSpeech = false;
  check('external provider failure returns to retryable capture UI without sending a chat');
  assert.equal((await walk(join(dataDir, 'scratch'))).some(name => name.startsWith('mini-dictation-')), false, 'provider failure cleans temporary audio');
  await clickText(mini, "Record dictation"); await clickText(mini, "Stop recording");
  await waitFor(() => mini.evaluate(`document.querySelector('textarea')?.value==='Dictated fixture draft'`), 15_000, "editable transcribed draft");
  assert.equal(await mini.evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(x=>x.textContent==='Open draft');const bounds=button.getBoundingClientRect(),card=document.querySelector('.mini-card').getBoundingClientRect();return bounds.top>=card.top && bounds.bottom<=card.bottom && bounds.bottom<=innerHeight;})()`), true, 'Open draft must be in the visible Mini scrollport');
  assert.equal(speechRequests, 2); assert.equal(chatRequests.length, 0);
  assert.ok(await mini.evaluate(`window.fixtureTracksStopped>0`));
  await fill(mini, 'textarea', 'Edited dictated draft');
  await screenshot(mini, 'mini-draft.png');
  await clickText(mini, 'Open draft');
  await waitFor(() => main.evaluate(`document.querySelector('.composer-input')?.textContent.includes('Edited dictated draft')`), 10_000, 'draft explicitly opened');
  assert.match(await main.evaluate(`document.querySelector('.composer-input').textContent`), /Existing unsent draft[\s\S]*Edited dictated draft/);
  assert.deepEqual(await attachmentSnapshot(), originalAttachments, 'Open draft preserves attachment token, path and accessible identity');
  assert.equal((await ok(main, 'pi-desktop/session/get', { id: fixture.session.id })).session.messages.length, 0, 'Open draft must not create a user turn');
  await screenshot(main, 'draft-with-existing-text-and-attachment.png');
  assert.equal(chatRequests.length, 0, 'dictation must never send a model request');
  assert.equal((await walk(join(dataDir, 'scratch'))).some((name) => name.startsWith('mini-dictation-')), false);
  check('record -> local speech retry -> edit -> Open draft preserves existing text and attachment identity; no auto-send; tracks/audio cleaned');
  handoffEvidence.before = originalAttachments;
  handoffEvidence.after = await attachmentSnapshot();
  const retainedText = await main.evaluate(`document.querySelector('.composer-input').textContent`);
  await clickText(mini, 'Record dictation'); await clickText(mini, 'Stop recording');
  await waitFor(() => mini.evaluate(`document.querySelector('textarea')?.value==='Dictated fixture draft'`), 15_000, 'second draft for discard');
  await clickText(mini, 'Discard');
  await waitFor(() => mini.evaluate(`!document.querySelector('textarea')`), 10_000, 'discard removes pending draft');
  assert.equal(await main.evaluate(`document.querySelector('.composer-input').textContent`), retainedText);
  assert.deepEqual(await attachmentSnapshot(), originalAttachments);
  assert.equal(chatRequests.length, 0);
  assert.equal((await walk(join(dataDir, 'scratch'))).some(name => name.startsWith('mini-dictation-')), false);
  check('Discard leaves existing composer text/attachment unchanged and cleans temporary audio');
  await configureDictation(main);
  await clickText(main, 'Create with AI…');
  await fill(main, '.pets-creation-form input', 'Fixture pet');
  await fill(main, '.pets-creation-form textarea', 'Friendly original engineering robot');
  await clickText(main, 'Review creation');
  assert.equal(chatRequests.length, 0);
  await clickText(main, 'Cancel');
  assert.equal(chatRequests.length, 0);
  await clickText(main, 'Create with AI…'); await clickText(main, 'Review creation');
  await clickText(main, 'Confirm and start AI task');
  await waitFor(() => chatRequests.length > 0, 30_000, 'normal agent task reaches local provider');
  const submitted = JSON.stringify(chatRequests[0].messages);
  assert.match(submitted, /Friendly original engineering robot/); assert.match(submitted, /look-contact-sheet\.png/); assert.match(submitted, /QA\.md/);
  await waitFor(() => main.evaluate(`document.body.innerText.includes('Local pet task fixture completed')`), 20_000, 'normal task transcript result');
  assert.equal((await ok(main, 'pi-desktop/pets/list')).pets.length, 2, 'task reply must not install a pet');
  check('AI review/cancel is free; explicit confirm launches normal targeted task with complete package prompt and transcript; no auto-install');
  await main.evaluate(`document.querySelector('[data-sidebar-session-row="${conductor.session.id}"]').click()`);
  await waitFor(() => main.evaluate(`document.body.innerText.includes('Conductor topology demonstration')`), 10_000, 'Conductor fixture loaded');
  await resizeMain(1500, 1500);
  await main.evaluate(`document.querySelector('button[aria-label="Collapse sidebar"]')?.click()`);
  await main.evaluate(`document.querySelectorAll('button[aria-expanded="false"]').forEach(button=>{if(button.textContent.includes('Subagents completed'))button.click();})`);
  await waitFor(() => main.evaluate(`document.querySelectorAll('.subagent-topology-node').length===7`), 10_000, 'full seven-role renderer topology');
  await main.evaluate(`document.querySelector('.subagent-topology').scrollIntoView({block:'center'})`);
  await screenshot(main, 'conductor-topology.png');
  await resizeMain(1200, 800);
  await ok(main, 'pi-desktop/mini/action', 'settings'); await clickText(main, 'Subagents');
  await waitFor(() => main.evaluate(`document.body.innerText.includes('project-reviewer')`), 10_000, 'read-only library fixture');
  await fill(main, 'input[placeholder="Search subagents"]', 'project-reviewer');
  await screenshot(main, 'agent-library.png');
  check('documentation screenshots render the full Conductor team and generic read-only library fixture');
  await ok(main, "pi-desktop/pets/preferences", { selectedPet: null });
  await close(main); main = await launch();
  const restored = await ok(main, "pi-desktop/pets/list");
  assert.equal(restored.preferences.selectedPet, null); assert.equal(restored.preferences.miniVisible, true);
  assert.equal(restored.preferences.scale, 1.25); assert.equal(restored.pets.length, 2);
  await connectTarget((target) => target.type === "page" && target.url.includes("surface=mini"));
  check("restart retains explicit None, imported copy, Mini visibility and scale");
  await writeFile(join(root, "result.json"), JSON.stringify({ results, root, candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), base: execFileSync("git", ["rev-parse", "origin/main"], { cwd: repo, encoding: "utf8" }).trim(), uncommittedCandidate: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim().length > 0, paidProviders: "not invoked", microphone: "external media fixture; no physical microphone", documentationScenes: "Conductor uses seeded transcript data; library uses a generic fixture", speechRequests, chatRequests: chatRequests.length, screenshots, handoffEvidence }, null, 2));
  console.log(`MINI_PETS_E2E_PASS ${root}`);
} catch (error) {
  if (main) {
    try { console.error('UI diagnostics', await main.evaluate(`(async()=>({text:document.body.innerText.slice(0,6000),pets:await window.piDesktop.invoke('pi-desktop/pets/list')}))()`)); } catch (diagnostic) { console.error(String(diagnostic)); }
    try { await screenshot(main, 'failure.png'); } catch {}
  }
  console.error(processSession?.output || "");
  console.error(`Evidence: ${root}`);
  throw error;
} finally {
  if (main) await close(main);
  if (originalAgents === undefined) delete process.env.PI_DESKTOP_AGENTS_DIR; else process.env.PI_DESKTOP_AGENTS_DIR = originalAgents;
  await new Promise((resolve) => server.close(resolve));
}
