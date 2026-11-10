/** Data-only contracts for the host-owned pet library and native Mini surface. */
export const PET_CELL = { width: 192, height: 208, columns: 8 } as const;
export const MAX_PET_IMAGE_BYTES = 8_000_000;
export const MAX_PET_MANIFEST_BYTES = 16_384;
export const PET_ANIMATIONS = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
} as const;
export type PetAnimation = keyof typeof PET_ANIMATIONS;
export type PetVersion = 1 | 2;
export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: PetVersion;
  spritesheetPath: string;
};
export type PetRecord = PetManifest & { builtin: boolean };
export type PetPreferences = {
  selectedPet: string | null;
  miniVisible: boolean;
  alwaysOnTop: boolean;
  scale: number;
  followPointer: boolean;
  position: { x: number; y: number } | null;
};
export const DEFAULT_PET_PREFERENCES: PetPreferences = {
  selectedPet: "hassan", miniVisible: false, alwaysOnTop: true,
  scale: 1, followPointer: true, position: null,
};
export type PetLibrary = { pets: PetRecord[]; preferences: PetPreferences };
export type PetImportPreview = { token: string; pet: PetRecord; dataUrl: string };
export type MiniActivity = {
  sessionId: string | null;
  title: string;
  status: "idle" | "running" | "waiting" | "review" | "failed";
};
export type MiniSnapshot = PetLibrary & {
  activity: MiniActivity;
  shortcutError: string | null;
  dictationAvailable: boolean;
  captureGeneration: number;
  runtimeError: string | null;
  visible: boolean;
  language: string;
  theme: "light" | "dark";
};
export type MiniAction = "newTask" | "dictate" | "settings" | "focus";
export type MiniDraft = { token: string; sessionId: string; text: string };
export const MINI_MAX_CAPTURE_MS = 60_000;
export const PET_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function parsePetManifest(input: unknown): PetManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PET_INVALID_MANIFEST");
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !PET_ID.test(value.id)) throw new Error("PET_INVALID_ID");
  if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 80) throw new Error("PET_INVALID_NAME");
  if (typeof value.description !== "string" || value.description.length > 500) throw new Error("PET_INVALID_DESCRIPTION");
  const version = value.spriteVersionNumber ?? 1;
  if (version !== 1 && version !== 2) throw new Error("PET_INVALID_VERSION");
  if (value.spritesheetPath !== "spritesheet.webp" && value.spritesheetPath !== "spritesheet.png") throw new Error("PET_INVALID_PATH");
  return { id: value.id, displayName: value.displayName.trim(), description: value.description,
    spriteVersionNumber: version, spritesheetPath: value.spritesheetPath };
}

export function petAtlasSize(version: PetVersion) {
  return { width: PET_CELL.width * PET_CELL.columns, height: PET_CELL.height * (version === 2 ? 11 : 9) };
}

/** v2 gaze is clockwise from screen-up, never whole-sprite rotation. */
export function petLookCell(dx: number, dy: number): { row: number; column: number } | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 24) return null;
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(angle / (Math.PI / 8)) % 16;
  return { row: 9 + Math.floor(index / 8), column: index % 8 };
}

export function petAnimationCell(animation: PetAnimation, elapsedMs: number, reducedMotion = false) {
  if (reducedMotion) return { row: 0, column: 0 };
  const spec = PET_ANIMATIONS[animation];
  const durations: readonly number[] = spec.durations;
  let offset = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) % durations.reduce((a, b) => a + b, 0);
  for (let column = 0; column < durations.length; column += 1) {
    if (offset < durations[column]!) return { row: spec.row, column };
    offset -= durations[column]!;
  }
  return { row: spec.row, column: 0 };
}

export function parseMiniActivity(input: unknown): MiniActivity {
  if (!input || typeof input !== "object") throw new Error("PET_INVALID_ACTIVITY");
  const value = input as Record<string, unknown>;
  if (value.sessionId !== null && (typeof value.sessionId !== "string" || value.sessionId.length > 100)) throw new Error("PET_INVALID_SESSION");
  if (typeof value.title !== "string" || value.title.length > 160 || !["idle","running","waiting","review","failed"].includes(String(value.status))) throw new Error("PET_INVALID_ACTIVITY");
  return { sessionId: value.sessionId, title: value.title, status: value.status as MiniActivity["status"] };
}
