import { MAX_SPEECH_INPUT_BYTES, MINI_MAX_CAPTURE_MS, type MiniDraft } from "@pi-desktop/shared";
import { petsClient } from "./client";

export type CaptureState = { phase: "idle" | "requesting" | "recording" | "transcribing" | "draft"; draft: MiniDraft | null; error: string | null };
export function createCaptureController(options: {
  changed: (state: CaptureState) => void;
  client?: Pick<typeof petsClient, "startCapture" | "cancelCapture" | "transcribe">;
  getMedia?: () => Promise<MediaStream>;
  recorder?: (stream: MediaStream) => MediaRecorder;
}) {
  const client = options.client ?? petsClient;
  let generation = 0;
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let phase: CaptureState["phase"] = "idle";
  const emit = (next: CaptureState) => { phase = next.phase; if (!disposed) options.changed(next); };
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    recorder = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const cancel = () => {
    generation += 1;
    cleanup();
    emit({ phase: "idle", draft: null, error: null });
    void client.cancelCapture().catch(() => {
      if (!disposed) emit({ phase: "idle", draft: null, error: "cancelFailed" });
    });
  };
  return {
    async start() {
      if (disposed || !["idle", "draft"].includes(phase)) return;
      const epoch = ++generation;
      emit({ phase: "requesting", draft: null, error: null });
      try {
        const capture = await client.startCapture();
        if (disposed || epoch !== generation) return;
        const media = await (options.getMedia?.() ?? navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
        if (disposed || epoch !== generation) { media.getTracks().forEach((track) => track.stop()); return; }
        stream = media;
        const instance = options.recorder?.(media) ?? new MediaRecorder(media);
        recorder = instance;
        const chunks: Blob[] = [];
        let bytes = 0;
        instance.ondataavailable = (event) => {
          if (epoch !== generation) return;
          bytes += event.data.size;
          if (bytes > MAX_SPEECH_INPUT_BYTES) { cancel(); emit({ phase: "idle", draft: null, error: "audioTooLarge" }); return; }
          chunks.push(event.data);
        };
        instance.onerror = () => { cancel(); emit({ phase: "idle", draft: null, error: "recordingFailed" }); };
        instance.onstop = () => {
          const mimeType = instance.mimeType || chunks[0]?.type || "audio/webm";
          cleanup();
          if (disposed || epoch !== generation) return;
          emit({ phase: "transcribing", draft: null, error: null });
          void (async () => {
            const blob = new Blob(chunks, { type: mimeType });
            if (!blob.size || blob.size > MAX_SPEECH_INPUT_BYTES) throw new Error("audioTooLarge");
            const audio = new Uint8Array(await blob.arrayBuffer());
            if (disposed || epoch !== generation) return;
            const draft = await client.transcribe(capture.token, audio, mimeType);
            if (!disposed && epoch === generation) emit({ phase: "draft", draft, error: null });
          })().catch(() => {
            if (!disposed && epoch === generation) emit({ phase: "idle", draft: null, error: "transcriptionFailed" });
          });
        };
        instance.start(250);
        timer = setTimeout(() => {
          if (epoch === generation && instance.state === "recording") instance.stop();
          stream?.getTracks().forEach((track) => track.stop());
        }, MINI_MAX_CAPTURE_MS);
        emit({ phase: "recording", draft: null, error: null });
      } catch {
        if (!disposed && epoch === generation) {
          cleanup();
          void client.cancelCapture().catch(() => undefined);
          emit({ phase: "idle", draft: null, error: "recordingFailed" });
        }
      }
    },
    stop() {
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
    },
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
