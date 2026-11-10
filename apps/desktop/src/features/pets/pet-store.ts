import { useEffect, useState, useSyncExternalStore } from "react";
import type { PetLibrary } from "@pi-desktop/shared";
import { petsClient } from "./client";

type Snapshot = { library: PetLibrary | null; error: string | null };
type ImageEntry = { promise: Promise<string>; value: string | null };
const MAX_IMAGES = 21;
const images = new Map<string, ImageEntry>();
const listeners = new Set<() => void>();
let state: Snapshot = { library: null, error: null };
let unsubscribeHost: (() => void) | null = null;
let lifetime = 0;
let request = 0;

const getSnapshot = () => state;
function publish(next: Snapshot) {
  state = next;
  for (const listener of listeners) listener();
}
function failure(error: unknown): string {
  return error instanceof Error ? error.message : "PET_REQUEST_FAILED";
}
function accept(library: PetLibrary) {
  const ids = new Set(library.pets.map((pet) => pet.id));
  for (const id of images.keys()) if (!ids.has(id)) images.delete(id);
  publish({ library: { ...library }, error: null });
}

/** Refresh errors are observable through the hook, never an unhandled rejection. */
async function refresh(): Promise<void> {
  const currentLifetime = lifetime;
  const currentRequest = ++request;
  try {
    const library = await petsClient.list();
    if (currentLifetime === lifetime && currentRequest === request && listeners.size) accept(library);
  } catch (error) {
    if (currentLifetime === lifetime && currentRequest === request && listeners.size) {
      publish({ ...state, error: failure(error) });
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const currentLifetime = ++lifetime;
    try {
      unsubscribeHost = petsClient.onChanged((library) => {
        if (currentLifetime !== lifetime || !listeners.size) return;
        // A host event supersedes list requests that began before it.
        ++request;
        accept(library);
      });
    } catch (error) {
      publish({ ...state, error: failure(error) });
    }
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    ++lifetime;
    ++request;
    unsubscribeHost?.();
    unsubscribeHost = null;
    // A later mount must not inherit in-flight work from a disposed surface.
    for (const [id, entry] of images) if (entry.value === null) images.delete(id);
  };
}

export function usePetLibrary(): Snapshot & { refresh: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, refresh };
}

function imageFor(id: string): Promise<string> {
  const cached = images.get(id);
  if (cached) {
    images.delete(id);
    images.set(id, cached);
    return cached.promise;
  }
  const currentLifetime = lifetime;
  const entry: ImageEntry = { value: null, promise: Promise.resolve("") };
  entry.promise = petsClient.image(id).then((value) => {
    if (!value) throw new Error("PET_IMAGE_EMPTY");
    if (currentLifetime === lifetime && images.get(id) === entry) entry.value = value;
    return value;
  }).catch((error: unknown) => {
    if (images.get(id) === entry) images.delete(id);
    throw error;
  });
  images.set(id, entry);
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value!);
  return entry.promise;
}

export function usePetImage(id: string | null): string | null {
  const { library } = usePetLibrary();
  const [image, setImage] = useState<{ id: string; value: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setImage((previous) => previous?.id === id ? previous : null);
    if (!id) return;
    const currentLifetime = lifetime;
    void imageFor(id).then((value) => {
      if (!cancelled && currentLifetime === lifetime) setImage({ id, value });
    }).catch((error: unknown) => {
      if (!cancelled && currentLifetime === lifetime) {
        publish({ ...state, error: failure(error) });
      }
    });
    return () => { cancelled = true; };
    // A successful refresh retries failed previews, while fulfilled entries are reused.
  }, [id, library]);
  return image?.id === id ? image.value : null;
}
