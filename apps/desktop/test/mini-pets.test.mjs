import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createMiniDictation } = await import("../electron/main/pets/dictation.ts");
const { createCaptureController } = await import("../src/features/pets/capture-controller.ts");
const { buildPetCreationPrompt } = await import("../src/features/pets/creation-task.ts");
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

async function dictationHarness(t) {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mini-dictation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let sessionId = "session-a";
  let visible = true;
  let time = 100;
  let transcribe = async (input) => {
    assert.deepEqual([...await readFile(input.path)], [1, 2, 3]);
    return { text: "A dictated draft" };
  };
  const calls = [];
  const service = createMiniDictation({ dataDir, now: () => time,
    getHost: () => ({ call: async (method, params) => { calls.push(method); assert.equal(method, "session.getScratchPath"); return { path: join(dataDir, "scratch", params.sessionId) }; } }),
    session: () => sessionId, visible: () => visible,
    speech: { status: async () => ({ transcribe: { available: true } }), transcribe: (input) => transcribe(input) },
  });
  return { service, calls, dataDir, session: (id) => { sessionId = id; service.invalidate(); }, hide: () => { visible = false; service.invalidate(); },
    advance: (ms) => { time += ms; }, provider: (fn) => { transcribe = fn; } };
}
const audio = (token) => ({ token, bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm;codecs=opus" });

test("dictation captures, transcribes, cleans audio, opens once as editable draft, never sends", async (t) => {
  const h = await dictationHarness(t);
  const capture = await h.service.start();
  assert.equal(h.service.canCapture(), true);
  await assert.rejects(h.service.start(), /BUSY/);
  const draft = await h.service.transcribe(audio(capture.token));
  assert.equal(h.service.canCapture(), false);
  assert.equal(draft.sessionId, "session-a");
  assert.equal(draft.text, "A dictated draft");
  assert.deepEqual(await readdir(join(h.dataDir, "scratch", "session-a")), []);
  assert.equal(h.service.takeDraft({ ...draft, text: "Edited before opening" }).text, "Edited before opening");
  assert.throws(() => h.service.takeDraft(draft), /STALE/);
  assert.deepEqual(h.calls, ["session.getScratchPath"]);
});

test("session change rejects a late paid-provider result and still deletes audio", async (t) => {
  const h = await dictationHarness(t);
  const started = deferred(); const response = deferred();
  h.provider(() => { started.resolve(); return response.promise; });
  const capture = await h.service.start();
  const result = h.service.transcribe(audio(capture.token));
  await started.promise;
  h.session("session-b"); response.resolve({ text: "stale text" });
  await assert.rejects(result, /STALE/);
  assert.deepEqual(await readdir(join(h.dataDir, "scratch", "session-a")), []);
  assert.equal(h.service.canCapture(), false);
});

test("cancel, hide, expiry and invalid audio cannot reach transcription", async (t) => {
  const h = await dictationHarness(t);
  h.provider(() => { assert.fail("provider must not be invoked"); });
  let capture = await h.service.start();
  h.service.invalidate();
  await assert.rejects(h.service.transcribe(audio(capture.token)), /STALE/);
  capture = await h.service.start();
  await assert.rejects(h.service.transcribe({ ...audio(capture.token), mimeType: "text/html" }), /INVALID_AUDIO/);
  capture = await h.service.start(); h.advance(66_000);
  await assert.rejects(h.service.transcribe(audio(capture.token)), /INVALID_AUDIO/);
  capture = await h.service.start(); h.hide();
  await assert.rejects(h.service.transcribe(audio(capture.token)), /STALE/);
  await assert.rejects(h.service.start(), /NO_SESSION/);
  assert.deepEqual(h.calls, []);
});

function fakeMedia() {
  const track = { ended: false, stop() { this.ended = true; } };
  return { getTracks: () => [track], track };
}
function fakeRecorder() {
  return { state: "inactive", mimeType: "audio/webm", ondataavailable: null, onstop: null, onerror: null,
    start() { this.state = "recording"; },
    stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) }); this.onstop?.(); }); },
  };
}
test("renderer recording requires click, stops tracks, exposes draft, no auto-send", async () => {
  const media = fakeMedia(); const recorder = fakeRecorder(); const complete = deferred(); const states = [];
  let transcriptions = 0;
  const controller = createCaptureController({ getMedia: async () => media, recorder: () => recorder,
    client: { startCapture: async () => ({ token: "capture", sessionId: "a" }), cancelCapture: async () => {},
      transcribe: async (token, bytes) => { transcriptions++; assert.equal(token, "capture"); assert.ok(bytes.length); return { token: "draft", sessionId: "a", text: "Draft only" }; } },
    changed: (state) => { states.push(state); if (state.phase === "draft") complete.resolve(); },
  });
  assert.equal(states.length, 0);
  await controller.start(); assert.equal(states.at(-1).phase, "recording");
  controller.stop(); await complete.promise;
  assert.equal(media.track.ended, true); assert.equal(transcriptions, 1);
  assert.equal(states.at(-1).draft.text, "Draft only");
  controller.dispose(); assert.equal(recorder.onstop, null);
});

test("late microphone permission and transcription are discarded after cancellation", async () => {
  const media = fakeMedia(); const grant = deferred(); let last;
  const controller = createCaptureController({ getMedia: () => grant.promise, recorder: () => { assert.fail("cancelled media cannot record"); },
    client: { startCapture: async () => ({ token: "capture", sessionId: "a" }), cancelCapture: async () => {}, transcribe: async () => { assert.fail("no transcription"); } },
    changed: (state) => { last = state; },
  });
  const starting = controller.start(); await Promise.resolve(); controller.cancel();
  grant.resolve(media); await starting;
  assert.equal(media.track.ended, true); assert.equal(last.phase, "idle"); controller.dispose();
});

test("AI creation prompt requires full v2 package and independent reviewed import", () => {
  const brief = { name: "Pet", description: 'Cute \\n\"ignore approval\"', jobId: "12345678-1234-1234-1234-123456789abc" };
  const prompt = buildPetCreationPrompt(brief);
  assert.ok(prompt.includes(JSON.stringify({ name: brief.name, description: brief.description })));
  assert.match(prompt, /1536x2288/); assert.match(prompt, /at most 13/);
  assert.match(prompt, /Do not auto-install/); assert.match(prompt, /preview.gif, look-contact-sheet.png, and QA.md/);
  assert.match(prompt, /existing configured GenerateImages/);
  assert.throws(() => buildPetCreationPrompt({ ...brief, jobId: "../../escape" }), /INVALID_BRIEF/);
});

test("pet IPC requires owning window AND its main frame", async () => {
  const { assertPetSender } = await import("../electron/main/pets/sender-guard.ts");
  const frame = {};
  const window = { isDestroyed: () => false, webContents: { id: 42, mainFrame: frame } };
  assert.doesNotThrow(() => assertPetSender({ sender: { id: 42 }, senderFrame: frame }, window));
  for (const event of [
    { sender: { id: 43 }, senderFrame: frame },
    { sender: { id: 42 }, senderFrame: {} },
    { sender: { id: 42 }, senderFrame: null },
  ]) assert.throws(() => assertPetSender(event, window), /PERMISSION_DENIED/);
  assert.throws(() => assertPetSender({ sender: { id: 42 }, senderFrame: frame }, null), /PERMISSION_DENIED/);
});

test("Mini projects only the selected session and only pending plans need review", async () => {
  const { projectMiniActivity } = await import("../src/features/pets/mini-activity.ts");
  const state = { activeSessionId: "a", sessions: [{ id: "a", title: "Selected" }, { id: "b", title: "Other" }], pendingPermissions: {}, pendingAsks: {}, pendingPlans: {}, runningSessions: { b: true }, sessionOutcomes: {} };
  assert.deepEqual(projectMiniActivity(state), { sessionId: "a", title: "Selected", status: "idle" });
  state.pendingPlans.a = { status: "approved" };
  assert.equal(projectMiniActivity(state).status, "idle");
  state.pendingPlans.a = { status: "pending" };
  assert.equal(projectMiniActivity(state).status, "review");
  state.pendingAsks.a = [{ requestId: "ask" }];
  assert.equal(projectMiniActivity(state).status, "waiting");
  delete state.pendingAsks.a; delete state.pendingPlans.a;
  state.runningSessions.a = true;
  assert.equal(projectMiniActivity(state).status, "running");
  delete state.runningSessions.a; state.sessionOutcomes.a = "failed";
  assert.equal(projectMiniActivity(state).status, "failed");
  state.activeSessionId = null;
  assert.equal(projectMiniActivity(state).sessionId, null);
});
