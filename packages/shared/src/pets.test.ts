import { describe, expect, it } from "vitest";
import { DEFAULT_PET_PREFERENCES, PET_ANIMATIONS, parseMiniActivity, parsePetManifest, petAnimationCell, petAtlasSize, petLookCell } from "./pets.js";
const valid = { id: "hassan", displayName: "Hassan", description: "Companion", spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp" };
describe("pet package and surface contracts", () => {
  it("accepts the v2 contract and legacy v1 default", () => {
    expect(parsePetManifest(valid)).toEqual(valid);
    expect(parsePetManifest({ ...valid, spriteVersionNumber: undefined }).spriteVersionNumber).toBe(1);
    expect(petAtlasSize(2)).toEqual({ width: 1536, height: 2288 });
    expect(petAtlasSize(1)).toEqual({ width: 1536, height: 1872 });
    expect(DEFAULT_PET_PREFERENCES.selectedPet).toBe("hassan");
    expect(DEFAULT_PET_PREFERENCES.miniVisible).toBe(false);
  });
  it("rejects invalid manifests without evaluating their contents", () => {
    for (const input of [null, [], { ...valid, id: "../hassan" }, { ...valid, displayName: " " }, { ...valid, description: "x".repeat(501) }, { ...valid, spriteVersionNumber: 3 }]) expect(() => parsePetManifest(input)).toThrow();
    for (const path of ["../spritesheet.webp", "file:///secret", "https://example.com/atlas", "C:\\secret.png", "sub/atlas.png"]) expect(() => parsePetManifest({ ...valid, spritesheetPath: path })).toThrow();
  });
  it("uses the documented nonuniform cadence and reduced motion neutral", () => {
    expect(petAnimationCell("idle", 279)).toEqual({ row: 0, column: 0 });
    expect(petAnimationCell("idle", 280)).toEqual({ row: 0, column: 1 });
    expect(petAnimationCell("idle", 1100)).toEqual({ row: 0, column: 0 });
    for (const [name, spec] of Object.entries(PET_ANIMATIONS)) {
      let time = 0;
      for (let column = 0; column < spec.durations.length; column += 1) {
        expect(petAnimationCell(name as keyof typeof PET_ANIMATIONS, time)).toEqual({ row: spec.row, column });
        time += spec.durations[column]!;
      }
      expect(petAnimationCell(name as keyof typeof PET_ANIMATIONS, time)).toEqual({ row: spec.row, column: 0 });
      expect(petAnimationCell(name as keyof typeof PET_ANIMATIONS, time, true)).toEqual({ row: 0, column: 0 });
    }
    expect(PET_ANIMATIONS.failed.durations).toHaveLength(8);
    expect(PET_ANIMATIONS.waiting.durations).toHaveLength(6);
  });
  it("maps all sixteen look cells clockwise in screen coordinates", () => {
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      expect(petLookCell(Math.sin(angle) * 100, -Math.cos(angle) * 100)).toEqual({ row: 9 + Math.floor(i / 8), column: i % 8 });
    }
    expect(petLookCell(0,0)).toBeNull();
    expect(petLookCell(NaN,100)).toBeNull();
  });
  it("bounds Mini status and never accepts arbitrary actions as status", () => {
    expect(parseMiniActivity({ sessionId: null, title: "", status: "idle" }).status).toBe("idle");
    for (const bad of [{sessionId: 9,title:"",status:"idle"},{sessionId:null,title:"x".repeat(161),status:"idle"},{sessionId:null,title:"",status:"execute"}]) expect(()=>parseMiniActivity(bad)).toThrow();
  });
});
