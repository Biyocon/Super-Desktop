import { randomUUID } from "node:crypto";
import { decodePetImage } from "./image-decoder";
import { PET_ANIMATIONS, PET_CELL, PET_ID, petAtlasSize, type PetImportPreview, type PetLibrary, type PetRecord } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";

type Preview = { pet: PetRecord; dataUrl: string; fingerprint: string };
type Ticket = { owner: number; path: string; fingerprint: string; expires: number };

/** Decode the complete image, not just its header. Every required atlas cell must contain art. */
export async function validatePetImage(preview: Pick<Preview, "pet" | "dataUrl">): Promise<void> {
  const image = await decodePetImage(preview.dataUrl, preview.pet.spriteVersionNumber);
  const size = petAtlasSize(preview.pet.spriteVersionNumber);
  const actual = image.getSize();
  if (image.isEmpty() || actual.width !== size.width || actual.height !== size.height) throw new Error("PET_INVALID_IMAGE");
  const pixels = image.toBitmap();
  if (pixels.length !== size.width * size.height * 4) throw new Error("PET_INVALID_IMAGE");
  let transparent = false;
  const cells: { row: number; column: number }[] = Object.values(PET_ANIMATIONS).flatMap((animation) =>
    animation.durations.map((_, column) => ({ row: animation.row, column })),
  );
  if (preview.pet.spriteVersionNumber === 2) {
    for (let index = 0; index < 16; index += 1) cells.push({ row: 9 + Math.floor(index / 8), column: index % 8 });
  }
  for (const cell of cells) {
    let occupied = false;
    for (let y = 0; y < PET_CELL.height; y += 1) {
      for (let x = 0; x < PET_CELL.width; x += 1) {
        const alpha = pixels[((cell.row * PET_CELL.height + y) * size.width + cell.column * PET_CELL.width + x) * 4 + 3]!;
        if (alpha > 0) occupied = true;
        if (alpha === 0) transparent = true;
      }
    }
    if (!occupied) throw new Error("PET_EMPTY_FRAME");
  }
  if (!transparent) throw new Error("PET_TRANSPARENCY_REQUIRED");
}

export function createPetImportService(getHost: () => Pick<HostProcess, "call"> | null, now = Date.now) {
  let ticket: { token: string; value: Ticket } | null = null;
  let generation = 0;
  const host = () => {
    const value = getHost();
    if (!value) throw new Error("HOST_UNAVAILABLE");
    return value;
  };
  return {
    async preview(path: string, owner: number): Promise<PetImportPreview> {
      ticket = null;
      const epoch = ++generation;
      const preview = await host().call<Preview>("pets.preview", { manifestPath: path });
      await validatePetImage(preview);
      if (epoch !== generation) throw new Error("PET_PREVIEW_EXPIRED");
      const token = randomUUID();
      ticket = { token, value: { owner, path, fingerprint: preview.fingerprint, expires: now() + 300_000 } };
      return { token, pet: preview.pet, dataUrl: preview.dataUrl };
    },
    async confirm(token: unknown, owner: number): Promise<PetLibrary> {
      const current = ticket;
      // Consume before awaiting; concurrent confirms cannot install twice.
      if (!current || token !== current.token || owner !== current.value.owner) throw new Error("PET_PREVIEW_EXPIRED");
      ticket = null;
      generation += 1;
      if (now() > current.value.expires) throw new Error("PET_PREVIEW_EXPIRED");
      return host().call<PetLibrary>("pets.import", { manifestPath: current.value.path, fingerprint: current.value.fingerprint });
    },
    async image(id: unknown): Promise<string> {
      if (typeof id !== "string" || !PET_ID.test(id)) throw new Error("PET_INVALID_ID");
      const result = await host().call<{ dataUrl: string }>("pets.image", { id });
      return result.dataUrl;
    },
    clear() { ticket = null; generation += 1; },
  };
}
