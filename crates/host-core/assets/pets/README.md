# Bundled Hassan pet

The owner supplied this original Hassan v2 atlas for Super-Desktop.

- File: `hassan.webp`
- Original package: owner's Codex `pets/hassan/spritesheet.webp`
- RGBA WebP, 1536 × 2288, eight columns / eleven rows, 192 × 208 cells.
- Bytes: 1,731,904
- SHA-256: `926ef43dd53f4232d20feb5ddcb4e011442df2ed278358b2a8cee3534a3e8c72`

The atlas is bundled independently of Codex. The original installation is
not modified or needed at runtime. No ChatGPT builtin gallery assets or
private Pets/Library APIs are included. Imported packages remain user-owned
copies in the application's data directory and must be previewed/confirmed.

Animation timing and v2 gaze mapping are defined in
`packages/shared/src/pets.ts`. Electron/Chromium fully decodes imported WebP
before issuing an installation token; Rust separately checks the bounded
container and geometry and revalidates the exact source fingerprint.
