# Hassan home mascot artwork

The four `home-mascot-*` renderer assets depict Hassan, supplied by the user
for the Super-Desktop fork. They replace only the empty-home decorative mark;
sidebar branding, agent portraits, and the installed Codex pet are unchanged.

## Provenance

- Source: the existing Hassan delivery's `hassan-vinker.gif` (not a screenshot
  of the Codex mini-window or its controls).
- Installed identity reference: `hassan/pet.json`, id `hassan`, display name
  `Hassan`, spriteVersionNumber `2`, atlas size 1536 x 2288.
- Source GIF SHA-256:
  `b06e2785e00058ea50d7f62c4db1cd735815b2eb7a2b740dfc9e499e49ba80c4`.
- Reference atlas SHA-256:
  `926ef43dd53f4232d20feb5ddcb4e011442df2ed278358b2a8cee3534a3e8c72`.

## Derivation and runtime contract

Both theme GIFs are byte-for-byte copies of the supplied transparent 192 x 208
four-frame wave, looping at 140ms per frame. Both PNGs are the first GIF frame
converted to RGBA and saved losslessly. No generated poses, recoloring,
background removal, new timers, or changes to the source pet were needed.
The existing component still fits the images into a 100 x 100 CSS slot and
switches to the PNG under `prefers-reduced-motion: reduce`. Full-color artwork
is shared by the two theme slots; it is not inverted or tinted.

The application uses only the bundled files. It never reads `.codex/pets` or
requires the original source delivery to be present on another computer.
