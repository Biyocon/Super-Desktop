// Unpacked packaged-app acceptance only. NEVER executes an installer/uninstaller.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./e2e/wait.mjs";

assert.equal(process.platform, "win32", "Windows packaged acceptance requires Windows");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unpacked = join(repo, "apps/desktop/release/win-unpacked");
const executable = join(unpacked, "Super-Desktop.exe");
const resources = join(unpacked, "resources");
const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "windows-package-"));
const home = join(root, "home");
const profile = join(root, "profile");
const agents = join(root, "agents");
const project = join(root, "project");
await Promise.all([home, profile, agents, project].map(path => mkdir(path, { recursive: true })));
const requireDesktop = createRequire(join(repo, "apps/desktop/package.json"));
const asar = createRequire(requireDesktop.resolve("app-builder-lib"))("@electron/asar");
const archive = join(resources, "app.asar");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const checks = [];
const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
const manifest = { sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim(), checks, hashes: {}, screenshots: {} };
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "", "final packaged acceptance requires a clean identified source commit");
const packaged = JSON.parse(asar.extractFile(archive, "package.json"));
assert.equal(packaged.name, "super-desktop");
assert.equal(packaged.version, "0.15.7-super.1");
assert.equal(packaged.superDesktopReleaseStage, "internal");
assert.equal(packaged.piDistribution, "installed");
for (const name of ["out/main/index.js", "out/preload/index.cjs", "out/preload/mini.cjs", "out/renderer/index.html"]) {
  const bytes = asar.extractFile(archive, join(...name.split("/")));
  assert.equal(hash(bytes), hash(await readFile(join(repo, "apps/desktop", name))), `packaged ${name} matches built candidate`);
  manifest.hashes[name] = hash(bytes);
  if (name.includes("preload")) assert.doesNotMatch(bytes.toString(), /require\(["']\.\.?\//, "sandbox preload is self-contained");
}
for (const [packed, source] of [["bin/pi-desktop-host-core.exe", "target/release/pi-desktop-host-core.exe"], ["agent-runtime/sidecar.js", "packages/agent-runtime/dist-bundle/sidecar.js"]]) {
  const bytes = await readFile(join(resources, packed));
  assert.equal(hash(bytes), hash(await readFile(join(repo, source))), `${packed} matches candidate build`);
  manifest.hashes[packed] = hash(bytes);
}
manifest.hashes.executable = hash(await readFile(executable));
manifest.hashes.asar = hash(await readFile(archive));
const feed = await readFile(join(resources, "app-update.yml"), "utf8");
assert.match(feed, /owner: Biyocon/); assert.match(feed, /repo: Super-Desktop/);
assert.match(feed, /updaterCacheDirName: super-desktop-updater/);
assert.doesNotMatch(feed, /vastsa|PI-Desktop/);
pass("ASAR, Electron executable, host, runtime, preloads and fork feed resources match candidate");

const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(root,"roaming"), LOCALAPPDATA: join(root,"local"), PI_DESKTOP_AGENTS_DIR: agents, PI_CODING_AGENT_DIR: join(root,"coding-agent"), PI_OFFLINE: "1", PI_DESKTOP_CAPTURE: "1" };
for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|PI_DESKTOP_(DATA_DIR|DEV|HOST_BIN|RUNTIME_ENTRY)|.*API_KEY|.*ACCESS_TOKEN|.*AUTH_TOKEN)$/i.test(key)) delete env[key];
async function freePort() { const server=createServer(); await new Promise(resolve => server.listen(0,"127.0.0.1",resolve)); const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port; }
const sockets = [];
let child;
let output = "";
let page;
let main;
async function connect(port, predicate) {
  let target;
  await waitFor(async () => { if (child.exitCode !== null) throw new Error(output); try {target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(predicate);return !!target;} catch {return false;} }, 35_000, "owned packaged CDP target");
  const socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket,"open"); sockets.push(socket);
  let sequence=0; const pending=new Map();
  socket.onmessage=({data})=>{const message=JSON.parse(data);const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(JSON.stringify(message.error))):request.resolve(message.result);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},20_000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||JSON.stringify(result.exceptionDetails));return result.result.value;};
  return {send,evaluate};
}
async function launch() {
  output="";
  const rendererPort=await freePort(); const mainPort=await freePort();
  child=spawn(executable,[`--remote-debugging-port=${rendererPort}`,`--inspect=${mainPort}`,`--user-data-dir=${profile}`],{cwd:project,env,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",bytes=>{output=(output+bytes).slice(-40_000);}); child.stderr.on("data",bytes=>{output=(output+bytes).slice(-40_000);});
  main=await connect(mainPort,()=>true);
  page=await connect(rendererPort,target=>target.type==="page"&&target.url.includes("index.html")&&!target.url.includes("surface="));
  await waitFor(()=>page.evaluate(`!!window.piDesktop && !!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`),40_000,"packaged shell ready");
}
const invoke=async(channel,...args)=>{const response=await page.evaluate(`window.piDesktop.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);assert.equal(response.ok,true,JSON.stringify(response));return response.data;};
const mainEval=expression=>main.evaluate(`(()=>{const {app,BrowserWindow}=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');return (${expression});})()`);
async function shutdown() {
  if(!child||child.exitCode!==null)return;
  try {await mainEval("app.quit()");} catch {}
  for(const socket of sockets.splice(0))socket.close();
  await waitFor(()=>child.exitCode!==null,15_000,"owned packaged app orderly shutdown");
}
try {
  await launch();
  const identity=await mainEval(`({packaged:app.isPackaged,name:app.getName(),version:app.getVersion(),home:process.getBuiltinModule('os').homedir(),nativeDialogHome:app.getPath('home'),profile:app.getPath('userData'),data:process.env.PI_DESKTOP_DATA_DIR,agents:process.env.PI_DESKTOP_AGENTS_DIR,electron:process.versions.electron,resources:process.resourcesPath,windows:BrowserWindow.getAllWindows().map(w=>({sandbox:w.webContents.getLastWebPreferences().sandbox,contextIsolation:w.webContents.getLastWebPreferences().contextIsolation,nodeIntegration:w.webContents.getLastWebPreferences().nodeIntegration}))})`);
  assert.equal(identity.packaged,true); assert.equal(identity.name,"Super-Desktop"); assert.equal(identity.version,packaged.version);
  assert.equal(identity.home,home); assert.equal(identity.profile,profile); assert.equal(identity.data,join(home,".super-desktop"));assert.equal(identity.agents,agents);
  assert.ok(identity.windows.length>0); for(const window of identity.windows){assert.equal(window.sandbox,true);assert.equal(window.contextIsolation,true);assert.equal(window.nodeIntegration,false);}
  manifest.identity=identity;
  const version=await invoke("pi-desktop/app/getVersion"); assert.equal(version.version,packaged.version);assert.equal(version.hostVersion,packaged.version);assert.equal(version.platform,"win32");assert.equal(version.arch,"x64");manifest.version=version;
  manifest.health=await invoke("pi-desktop/app/health");
  assert.equal(await page.evaluate("typeof require"),"undefined");
  pass("real packaged renderer/preload/main/host boot sandboxed with separate default Windows data root");
  const updates=await invoke("pi-desktop/updates/getState");assert.equal(updates.mode,"disabled");assert.equal(updates.releasesUrl,"https://github.com/Biyocon/Super-Desktop/releases");manifest.updates=updates;
  pass("internal packaged updater disabled and release destination is fork");
  await invoke("pi-desktop/settings/set",{language:"en",closeBehavior:"quit",onboardingDismissed:true,keybindings:{toggleMini:null}});
  const created=await invoke("pi-desktop/session/create",{title:"Packaged acceptance fixture",projectPath:project});manifest.session=created;
  const pets=await invoke("pi-desktop/pets/list");manifest.pets=pets;
  assert.match(JSON.stringify(pets),/hassan/i);
  manifest.petImage=await invoke("pi-desktop/pets/image","hassan");
  assert.equal(hash(Buffer.from(manifest.petImage.split(",")[1],"base64")),hash(await readFile(join(repo,"crates/host-core/assets/pets/hassan.webp"))));
  pass("packaged host serves the exact bundled Hassan WebP");
  await invoke("pi-desktop/pets/preferences",{selectedPet:null});
  await page.evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await waitFor(()=>page.evaluate("!!document.querySelector('.settings-shell-full')"),10_000,"packaged settings visible");
  const screenshot=await page.send("Page.captureScreenshot",{format:"png"});const bytes=Buffer.from(screenshot.data,"base64");await writeFile(join(root,"packaged-settings.png"),bytes);manifest.screenshots["packaged-settings.png"]=hash(bytes);
  const second=spawn(executable,[`--user-data-dir=${profile}`],{cwd:project,env,stdio:"ignore"});
  try {await waitFor(()=>second.exitCode!==null,12_000,"second instance exits");assert.equal(second.exitCode,0);} finally {if(second.exitCode===null)second.kill();}
  assert.equal(child.exitCode,null);
  pass("second launch exits without replacing first isolated packaged instance");
  await shutdown(); await launch();
  const settings=await invoke("pi-desktop/settings/get");assert.equal(settings.language,"en");
  assert.equal((await invoke("pi-desktop/pets/list")).preferences.selectedPet,null);
  const detail=await invoke("pi-desktop/session/get",created.session.id);assert.equal(detail.session.title,"Packaged acceptance fixture");
  pass("settings, session identity and None pet choice survive packaged restart without dispatch");
  const runtimeLog=await readFile(join(home,".super-desktop/logs/app/runtime.log"),"utf8");
  manifest.runtimeStarts=(runtimeLog.match(/agent.sidecar.configured/g)||[]).length;
  assert.ok(manifest.runtimeStarts>=2,"packaged runtime configured on initial launch and restart");
  await shutdown();
  await assert.rejects(access(join(home,".pi-desktop")),{code:"ENOENT"});
  await assert.rejects(access(join(home,".super-desktop-dev")),{code:"ENOENT"});
  manifest.result="PASS";
} catch(error) {manifest.result="FAIL";manifest.error=String(error);throw error;}
finally {
  if(child?.exitCode===null){try{await shutdown();}catch{if(child.exitCode===null)execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore"});}}
  for(const socket of sockets)socket.close();
  if(typeof manifest.petImage==="string")manifest.petImage={sha256:hash(manifest.petImage),length:manifest.petImage.length};
  await writeFile(join(root,"process.log"),output);await writeFile(join(root,"result.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log(`Evidence: ${root}`);
}
