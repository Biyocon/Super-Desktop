import { randomUUID } from "node:crypto";
import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MAX_SPEECH_INPUT_BYTES, MINI_MAX_CAPTURE_MS, type MiniDraft } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { SpeechService } from "../services/speech-service";

type Capture = { token: string; sessionId: string; started: number; generation: number; used: boolean };
const MIME_EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav" };
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Owns capture/result identity. No sending API exists in this service. */
export function createMiniDictation(options: {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  speech: SpeechService;
  session: () => string | null;
  visible: () => boolean;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let generation = 0;
  let capture: Capture | null = null;
  let draft: { token: string; sessionId: string; generation: number } | null = null;
  const invalidate = () => { generation += 1; capture = null; draft = null; };
  const current = (value: Capture) => {
    if (value.generation !== generation || !options.visible() || options.session() !== value.sessionId) throw new Error("MINI_STALE_CAPTURE");
  };
  return {
    canCapture: () => !!capture && !capture.used && capture.generation === generation && options.visible() && options.session() === capture.sessionId,
    invalidate,
    async start() {
      if (capture) throw new Error("MINI_CAPTURE_BUSY");
      const sessionId = options.session();
      if (!sessionId || !options.visible()) throw new Error("MINI_NO_SESSION");
      invalidate();
      const value: Capture = { token: randomUUID(), sessionId, started: now(), generation, used: false };
      capture = value;
      try {
        const status = await options.speech.status();
        current(value);
        if (!status.transcribe.available) throw new Error("SPEECH_NOT_CONFIGURED");
        return { token: value.token, sessionId };
      } catch (error) {
        if (capture === value) capture = null;
        throw error;
      }
    },
    async transcribe(input: unknown): Promise<MiniDraft> {
      if (!input || typeof input !== "object") throw new Error("MINI_INVALID_AUDIO");
      const { token, bytes, mimeType } = input as Record<string, unknown>;
      const value = capture;
      if (!value || value.used || token !== value.token) throw new Error("MINI_STALE_CAPTURE");
      current(value);
      value.used = true;
      const mime = typeof mimeType === "string" ? mimeType.split(";")[0]!.trim() : "";
      const extension = MIME_EXT[mime];
      if (!extension || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_SPEECH_INPUT_BYTES || now() - value.started > MINI_MAX_CAPTURE_MS + 5_000) {
        invalidate();
        throw new Error("MINI_INVALID_AUDIO");
      }
      const host = options.getHost();
      if (!host) throw new Error("HOST_UNAVAILABLE");
      let path: string | null = null;
      try {
        const scratch = await host.call<{ path: string }>("session.getScratchPath", { sessionId: value.sessionId });
        current(value);
        const root = resolve(options.dataDir, "scratch");
        const directory = resolve(scratch.path);
        if (!inside(root, directory)) throw new Error("MINI_INVALID_SCRATCH");
        await mkdir(directory, { recursive: true });
        if (!inside(await realpath(root), await realpath(directory))) throw new Error("MINI_INVALID_SCRATCH");
        current(value);
        path = join(directory, `mini-dictation-${randomUUID()}.${extension}`);
        await writeFile(path, bytes, { flag: "wx" });
        current(value);
        const result = await options.speech.transcribe({ sessionId: value.sessionId, path, mimeType: mime });
        current(value);
        if (typeof result.text !== "string" || result.text.length > 100_000) throw new Error("MINI_INVALID_TRANSCRIPT");
        draft = { token: randomUUID(), sessionId: value.sessionId, generation };
        return { token: draft.token, sessionId: value.sessionId, text: result.text };
      } finally {
        if (capture === value) capture = null;
        if (path) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    },
    takeDraft(input: unknown): MiniDraft {
      if (!input || typeof input !== "object") throw new Error("MINI_INVALID_DRAFT");
      const value = input as Record<string, unknown>;
      if (!draft || value.token !== draft.token || value.sessionId !== draft.sessionId || draft.generation !== generation || options.session() !== draft.sessionId || !options.visible()) throw new Error("MINI_STALE_CAPTURE");
      if (typeof value.text !== "string" || value.text.length > 100_000) throw new Error("MINI_INVALID_DRAFT");
      const result = { token: draft.token, sessionId: draft.sessionId, text: value.text };
      draft = null;
      return result;
    },
  };
}
