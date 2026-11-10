import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PET_ANIMATIONS,
  PET_CELL,
  petAnimationCell,
  petAtlasSize,
  petLookCell,
  type PetAnimation,
  type PetRecord,
} from "@pi-desktop/shared";
import "./pets.css";

type Cell = { row: number; column: number };

export type PetSpriteProps = {
  pet: PetRecord;
  dataUrl: string;
  /** Height in device-independent pixels; the atlas aspect ratio is preserved. */
  size?: number;
  animation?: PetAnimation;
  followPointer?: boolean;
  decorative?: boolean;
};

export function PetSprite({
  pet,
  dataUrl,
  size = 104,
  animation = "idle",
  followPointer = false,
  decorative = false,
}: PetSpriteProps) {
  const { t } = useTranslation();
  const element = useRef<HTMLSpanElement>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [intersecting, setIntersecting] = useState(false);
  const [clock, setClock] = useState({ animation, elapsed: 0 });
  const [look, setLook] = useState<Cell | null>(null);
  const ready = !!dataUrl && loadedUrl === dataUrl;
  const active = ready && pageVisible && intersecting;
  const canLook = active && !reduced && followPointer &&
    pet.spriteVersionNumber === 2 && animation === "idle";
  const gaze = canLook ? look : null;

  useEffect(() => {
    setLoadedUrl(null);
    if (!dataUrl) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => { if (!cancelled) setLoadedUrl(dataUrl); };
    image.onerror = () => { if (!cancelled) setLoadedUrl(null); };
    image.src = dataUrl;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [dataUrl]);

  useEffect(() => {
    setIntersecting(false);
    let cancelled = false;
    if (!dataUrl) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => setReduced(media.matches);
    const onVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    onMotion();
    onVisibility();
    media.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    const observer = typeof IntersectionObserver === "undefined" ? null :
      new IntersectionObserver(([entry]) => {
        if (!cancelled) setIntersecting(!!entry?.isIntersecting);
      });
    if (observer && element.current) observer.observe(element.current);
    else setIntersecting(true);
    return () => {
      cancelled = true;
      media.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [dataUrl]);

  useEffect(() => {
    setLook(null);
    if (!canLook) return;
    const onPointer = (event: PointerEvent) => {
      const bounds = element.current?.getBoundingClientRect();
      if (!bounds) return;
      const next = petLookCell(
        event.clientX - bounds.left - bounds.width / 2,
        event.clientY - bounds.top - bounds.height / 2,
      );
      setLook((previous) => previous?.row === next?.row && previous?.column === next?.column ? previous : next);
    };
    const reset = () => setLook(null);
    const onOut = (event: PointerEvent) => { if (!event.relatedTarget) reset(); };
    // Deliberately local to this window: no native/global pointer tracking.
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerout", onOut);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerout", onOut);
      window.removeEventListener("blur", reset);
    };
  }, [canLook, dataUrl, pet.id]);

  useEffect(() => {
    setClock({ animation, elapsed: 0 });
    if (!active || reduced || gaze) return;
    const started = performance.now();
    const durations: readonly number[] = PET_ANIMATIONS[animation].durations;
    const cycle = durations.reduce((sum, duration) => sum + duration, 0);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const elapsed = performance.now() - started;
      setClock({ animation, elapsed });
      const cell = petAnimationCell(animation, elapsed);
      const before = durations.slice(0, cell.column).reduce((sum, duration) => sum + duration, 0);
      const remaining = before + durations[cell.column]! - (elapsed % cycle);
      timer = setTimeout(tick, Math.max(1, remaining));
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, reduced, animation, gaze, dataUrl, pet.id]);

  const height = Number.isFinite(size) && size > 0 ? size : 104;
  const scale = height / PET_CELL.height;
  const width = PET_CELL.width * scale;
  const atlas = petAtlasSize(pet.spriteVersionNumber);
  const cell = reduced || !active ? petAnimationCell("idle", 0, true) :
    gaze ?? petAnimationCell(animation, clock.animation === animation ? clock.elapsed : 0);

  return <span
    ref={element}
    className="pet-sprite"
    role={decorative ? undefined : "img"}
    aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : t("pets.spriteLabel", { name: pet.displayName })}
    style={{
      width,
      height,
      backgroundImage: ready ? `url(${JSON.stringify(dataUrl)})` : undefined,
      backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
      backgroundPosition: `${-cell.column * width}px ${-cell.row * height}px`,
    }}
  />;
}
