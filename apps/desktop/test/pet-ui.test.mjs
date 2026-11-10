import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { act, createElement as h } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import * as shared from "@pi-desktop/shared";
const { IPC, DEFAULT_PET_PREFERENCES } = shared;

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = runtimeRequire("esbuild");
const compiled = await build({
  stdin: {
    contents: 'export { PetSettings } from "./PetSettings"; export { PetSprite } from "./PetSprite"; export { usePetLibrary, usePetImage } from "./pet-store";',
    resolveDir: fileURLToPath(new URL("../src/features/pets/", import.meta.url)),
    loader: "tsx",
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
});
function loadUI() {
  const module = { exports: {} };
  // Fresh module state per fixture; React, UI primitives and client remain real.
  const external = (id) => id === "@pi-desktop/shared" ? shared : require(id);
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(external, module, module.exports);
  return module.exports;
}

// A small DOM host for ReactDOM, not a React/hook/component mock. It deliberately
// implements no layout engine: atlas geometry is asserted from the actual styles.
class Events {
  listeners = new Map();
  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? [];
    list.push({ listener, capture: options === true || !!options?.capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
  }
  count(type) { return this.listeners.get(type)?.length ?? 0; }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.stopPropagation ??= () => { event.cancelBubble = true; };
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const fire = (node, capture) => {
      event.currentTarget = node;
      event.eventPhase = capture ? 1 : 3;
      for (const entry of node.listeners.get(event.type) ?? []) {
        if (entry.capture === capture) entry.listener.call(node, event);
      }
    };
    for (const node of [...path].reverse()) fire(node, true);
    for (const node of path) { fire(node, false); if (event.cancelBubble || event.bubbles === false) break; }
    return !event.defaultPrevented;
  }
}
class DomNode extends Events {
  childNodes = [];
  parentNode = null;
  constructor(type, name, document) { super(); this.nodeType = type; this.nodeName = name; this.ownerDocument = document; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, child); child.parentNode = this; return child;
  }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
  contains(other) { return this === other || this.childNodes.some((node) => node.contains(other)); }
  get isConnected() { return this.nodeType === 9 || !!this.parentNode?.isConnected; }
}
class Element extends DomNode {
  attributes = new Map();
  style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
  value = "";
  constructor(name, document, namespace = "http://www.w3.org/1999/xhtml") {
    super(1, name.toUpperCase(), document); this.tagName = this.nodeName; this.localName = name; this.namespaceURI = namespace;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get disabled() { return this.hasAttribute("disabled"); }
  get type() { return this.getAttribute("type") ?? ""; }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 96, height: 104, right: 96, bottom: 104 }; }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true, button: 0 }); }
}
class Document extends DomNode {
  visibilityState = "visible";
  constructor() {
    super(9, "#document", null); this.ownerDocument = this;
    this.documentElement = new Element("html", this); this.body = new Element("body", this);
    this.appendChild(this.documentElement); this.documentElement.appendChild(this.body); this.activeElement = this.body;
  }
  createElement(name) { return new Element(name, this); }
  createElementNS(namespace, name) { return new Element(name, this, namespace); }
  createTextNode(value) { const node = new DomNode(3, "#text", this); node.nodeValue = value; return node; }
  getSelection() { return null; }
}
function browser() {
  const document = new Document();
  const window = new Events();
  const media = new Events(); media.matches = true;
  const observers = new Set();
  const pendingImages = new Set();
  window.document = document; document.defaultView = window;
  window.window = window; window.HTMLElement = Element; window.HTMLIFrameElement = class extends Element {};
  window.getSelection = () => null;
  window.matchMedia = () => media;
  window.Node = DomNode;
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (...args) => globalThis.clearTimeout(...args);
  window.setInterval = (...args) => globalThis.setInterval(...args);
  window.clearInterval = (...args) => globalThis.clearInterval(...args);
  window.innerWidth = 1024; window.innerHeight = 768;
  class Observer {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target) { this.target = target; this.callback([{ isIntersecting: true, target }]); }
    disconnect() { observers.delete(this); }
  }
  class Image {
    constructor() { pendingImages.add(this); }
    set src(value) { this.url = value; queueMicrotask(() => { pendingImages.delete(this); this.onload?.(); }); }
  }
  return { document, window, media, observers, pendingImages, Observer, Image };
}
const installed = browser();
// ReactDOM must see a DOM when its feature detection runs.
Object.assign(globalThis, { window: installed.window, document: installed.document, HTMLElement: Element,
  Image: installed.Image, IntersectionObserver: installed.Observer, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = require("react-dom/client");

function descendants(node) { return [node, ...node.childNodes.flatMap(descendants)]; }
function find(node, predicate) { return descendants(node).find(predicate); }
function button(node, text) {
  const result = find(node, (item) => item.tagName === "BUTTON" && (item.textContent === text || item.getAttribute("aria-label") === text));
  assert.ok(result, `Missing button: ${text}`); return result;
}
function choice(node, name) {
  const result = find(node, (item) => item.tagName === "BUTTON" && item.hasAttribute("aria-pressed") && item.textContent.includes(name));
  assert.ok(result, `Missing pet: ${name}`); return result;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const hassan = { id: "hassan", displayName: "Hassan", description: "A friendly companion", spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp", builtin: true };
const custom = { ...hassan, id: "luna", displayName: "Luna", builtin: false };
const imageUrl = "data:image/png;base64,cGV0";
async function fixture(t, overrides = {}) {
  const env = browser();
  Object.assign(globalThis, { window: env.window, document: env.document, Image: env.Image, IntersectionObserver: env.Observer });
  let library = { pets: [hassan], preferences: { ...DEFAULT_PET_PREFERENCES } };
  const calls = [];
  const handlers = new Map();
  const channelListeners = new Map();
  const emit = () => { for (const listener of channelListeners.get(IPC.event.petsChanged) ?? []) listener(structuredClone(library)); };
  env.window.piDesktop = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      if (handlers.has(channel)) return handlers.get(channel)(...args);
      if (channel === IPC.invoke.petsList) return { ok: true, data: structuredClone(library) };
      if (channel === IPC.invoke.petsImage) return { ok: true, data: imageUrl };
      if (channel === IPC.invoke.miniGetState) return { ok: true, data: { ...structuredClone(library), shortcutError: null, visible: library.preferences.miniVisible,
        dictationAvailable: false, language: "en", theme: "light", activity: { sessionId: null, title: "", status: "idle" } } };
      if (channel === IPC.invoke.petsPreferences || channel === IPC.invoke.miniSetVisible) {
        library = { ...library, preferences: { ...library.preferences, ...(channel === IPC.invoke.petsPreferences ? args[0] : { miniVisible: args[0] }) } };
        emit(); return { ok: true, data: structuredClone(library) };
      }
      if (channel === IPC.invoke.petsPreviewImport) return { ok: true, data: { token: "opaque-preview-token", pet: custom, dataUrl: imageUrl } };
      if (channel === IPC.invoke.petsConfirmImport) {
        assert.deepEqual(args, ["opaque-preview-token"]);
        library = { ...library, pets: [...library.pets, custom] }; emit(); return { ok: true, data: structuredClone(library) };
      }
      throw new Error(`Unexpected preload invocation: ${channel}`);
    },
    on: (channel, listener) => {
      const entries = channelListeners.get(channel) ?? new Set(); entries.add(listener); channelListeners.set(channel, entries);
      return () => entries.delete(listener);
    },
  };
  const i18n = createInstance();
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation: {} } }, react: { useSuspense: false } });
  const ui = loadUI();
  const container = env.document.createElement("div"); env.document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (element) => { await act(async () => root.render(h(I18nextProvider, { i18n }, element))); };
  t.after(async () => { await act(async () => root.unmount()); });
  const context = { ...env, ...ui, container, calls, handlers, render, root, channelListeners, emit,
    setLibrary(next) { library = next; }, getLibrary() { return library; },
    count(channel) { return calls.filter((call) => call.channel === channel).length; },
    async click(text) { await act(async () => button(container, text).click()); },
  };
  Object.assign(context, overrides);
  return context;
}

test("Settings persists None, leaves Mini available, and restores None on remount", async (t) => {
  const f = await fixture(t);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  assert.equal(choice(f.container, "Hassan").getAttribute("aria-pressed"), "true");
  await act(async () => choice(f.container, "pets.none").click());
  assert.equal(f.getLibrary().preferences.selectedPet, null);
  assert.equal(choice(f.container, "pets.none").getAttribute("aria-pressed"), "true");
  await f.click("pets.visible");
  assert.equal(f.getLibrary().preferences.miniVisible, true);
  assert.equal(f.getLibrary().preferences.selectedPet, null);
  await f.render(null);
  assert.equal(f.channelListeners.get(IPC.event.petsChanged).size, 0);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  assert.equal(choice(f.container, "pets.none").getAttribute("aria-pressed"), "true");
  assert.equal(f.channelListeners.get(IPC.event.petsChanged).size, 1, "gallery and hooks share one native subscription");
});

test("pending and rejected writes never claim a selection; retry persists it", async (t) => {
  const f = await fixture(t);
  const save = deferred();
  f.handlers.set(IPC.invoke.petsPreferences, () => save.promise);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  await act(async () => choice(f.container, "pets.none").click());
  assert.equal(choice(f.container, "Hassan").getAttribute("aria-pressed"), "true");
  assert.equal(choice(f.container, "pets.none").getAttribute("aria-pressed"), "false");
  for (const node of descendants(f.container).filter((node) => node.tagName === "BUTTON" && !node.getAttribute("class")?.includes("ui-help-icon"))) assert.ok(node.disabled);
  await act(async () => save.resolve({ ok: false, error: { message: "disk full" } }));
  assert.ok(f.container.textContent.includes("pets.saveError"));
  assert.equal(choice(f.container, "Hassan").getAttribute("aria-pressed"), "true");
  f.handlers.delete(IPC.invoke.petsPreferences);
  await f.click("pets.retry");
  assert.equal(choice(f.container, "pets.none").getAttribute("aria-pressed"), "true");
});

test("import previews are not installed until explicit confirmation, and Cancel discards them", async (t) => {
  const f = await fixture(t);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  await f.click("pets.import");
  assert.ok(f.container.textContent.includes("pets.importReview"));
  assert.equal(f.document.activeElement, button(f.container, "pets.cancel"));
  assert.equal(f.getLibrary().pets.length, 1);
  assert.equal(f.count(IPC.invoke.petsConfirmImport), 0);
  assert.equal(f.calls.find((call) => call.channel === IPC.invoke.petsPreviewImport).args.length, 0, "native picker receives no renderer path");
  await f.click("pets.cancel");
  assert.equal(f.count(IPC.invoke.petsConfirmImport), 0);
  assert.ok(!f.container.textContent.includes("pets.importReview"));
  assert.equal(f.document.activeElement, button(f.container, "pets.import"));
  await f.click("pets.import");
  await f.click("pets.confirmImport");
  assert.equal(f.count(IPC.invoke.petsConfirmImport), 1);
  assert.ok(choice(f.container, "Luna"));
  assert.equal(f.getLibrary().preferences.selectedPet, "hassan", "installation does not silently select a pet");
});

test("picker cancellation and failed validation are observable without installing", async (t) => {
  const f = await fixture(t);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  f.handlers.set(IPC.invoke.petsPreviewImport, async () => ({ ok: true, data: null }));
  await f.click("pets.import");
  assert.ok(!f.container.textContent.includes("pets.importReview"));
  f.handlers.set(IPC.invoke.petsPreviewImport, async () => ({ ok: false, error: { message: "PET_INVALID_IMAGE" } }));
  await f.click("pets.import");
  assert.ok(f.container.textContent.includes("pets.importError"));
  assert.equal(f.count(IPC.invoke.petsConfirmImport), 0);
});

test("failed confirmation preserves the preview and allows cancellation without installation", async (t) => {
  const f = await fixture(t);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  f.handlers.set(IPC.invoke.petsConfirmImport, async () => ({ ok: false, error: { message: "PET_PREVIEW_CHANGED" } }));
  await f.click("pets.import");
  await f.click("pets.confirmImport");
  assert.ok(f.container.textContent.includes("pets.importError"));
  assert.ok(f.container.textContent.includes("pets.importReview"));
  assert.equal(f.getLibrary().pets.length, 1);
  await f.click("pets.cancel");
  assert.ok(!f.container.textContent.includes("pets.importReview"));
  assert.equal(f.getLibrary().pets.length, 1);
});

test("Mini toggles persist and creation is routed to the supplied workflow", async (t) => {
  const f = await fixture(t);
  let creations = 0;
  await f.render(h(f.PetSettings, { onCreate() { creations += 1; } }));
  await f.click("pets.alwaysOnTop");
  await f.click("pets.followPointer");
  assert.equal(f.getLibrary().preferences.alwaysOnTop, false);
  assert.equal(f.getLibrary().preferences.followPointer, false);
  await f.click("pets.create");
  assert.equal(creations, 1);
  assert.equal(f.count(IPC.invoke.petsConfirmImport), 0);
});

test("library and image failures surface, retry recovers, and stale list replies cannot overwrite events", async (t) => {
  const f = await fixture(t);
  f.handlers.set(IPC.invoke.petsList, async () => ({ ok: false, error: { message: "read failed" } }));
  await f.render(h(f.PetSettings, { onCreate() {} }));
  assert.ok(f.container.textContent.includes("pets.loadError"));
  f.handlers.delete(IPC.invoke.petsList);
  f.handlers.set(IPC.invoke.petsImage, async () => ({ ok: false, error: { message: "image failed" } }));
  await f.click("pets.retry");
  assert.ok(f.container.textContent.includes("pets.loadError"));
  f.handlers.delete(IPC.invoke.petsImage);
  await f.click("pets.retry");
  assert.ok(!f.container.textContent.includes("pets.loadError"));
  const stale = deferred();
  f.handlers.set(IPC.invoke.petsList, () => stale.promise);
  await f.click("pets.refresh");
  const old = structuredClone(f.getLibrary());
  await act(async () => { f.setLibrary({ ...old, preferences: { ...old.preferences, selectedPet: null } }); f.emit(); });
  await act(async () => stale.resolve({ ok: true, data: old }));
  assert.equal(choice(f.container, "pets.none").getAttribute("aria-pressed"), "true");
});

test("image hooks ignore old identities and evict beyond the 21-entry cache", async (t) => {
  const f = await fixture(t);
  let current;
  function Probe({ id }) { current = { ...f.usePetLibrary(), image: f.usePetImage(id) }; return null; }
  const oldImage = deferred();
  f.handlers.set(IPC.invoke.petsImage, (id) => id === "old" ? oldImage.promise : Promise.resolve({ ok: true, data: `${imageUrl}-${id}` }));
  await f.render(h(Probe, { id: "old" }));
  await f.render(h(Probe, { id: "new" }));
  await act(async () => oldImage.resolve({ ok: true, data: `${imageUrl}-old` }));
  assert.equal(current.image, `${imageUrl}-new`);
  const staleFailure = deferred();
  f.handlers.set(IPC.invoke.petsImage, (id) => id === "failed-old" ? staleFailure.promise : Promise.resolve({ ok: true, data: `${imageUrl}-${id}` }));
  await f.render(h(Probe, { id: "failed-old" }));
  await f.render(h(Probe, { id: "newer" }));
  await act(async () => staleFailure.resolve({ ok: false, error: { message: "stale image failure" } }));
  assert.equal(current.error, null, "a disposed image request cannot publish a stale error");
  assert.equal(current.image, `${imageUrl}-newer`);
  for (let index = 0; index < 22; index += 1) await f.render(h(Probe, { id: `pet-${index}` }));
  const before = f.count(IPC.invoke.petsImage);
  await f.render(h(Probe, { id: "pet-0" }));
  assert.equal(f.count(IPC.invoke.petsImage), before + 1);
  await f.render(h(Probe, { id: "pet-21" }));
  assert.equal(f.count(IPC.invoke.petsImage), before + 1, "recent atlas is reused");
  assert.equal(f.channelListeners.get(IPC.event.petsChanged).size, 1);
});

test("sprite uses exact atlas positions, shared nonuniform timing, gaze, suspension and cleanup", async (t) => {
  const f = await fixture(t);
  let now = 0, sequence = 0;
  const timers = new Map();
  t.mock.method(globalThis.performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]);
      await act(async () => next[1].callback());
    }
    now = target;
  };
  const renderSprite = (props = {}) => f.render(h(f.PetSprite, { pet: hassan, dataUrl: imageUrl, followPointer: true, ...props }));
  const sprite = () => find(f.container, (node) => node.getAttribute?.("class") === "pet-sprite");
  await renderSprite();
  assert.equal(sprite().style.width, "96px");
  assert.equal(sprite().style.height, "104px");
  assert.equal(sprite().style.backgroundSize, "768px 1144px");
  assert.equal(sprite().style.backgroundPosition, "0px 0px");
  assert.equal(timers.size, 0, "reduced motion schedules no animation");
  assert.equal(f.window.count("pointermove"), 0);
  await act(async () => { f.media.matches = false; f.media.dispatchEvent({ type: "change" }); });
  await advance(280);
  assert.equal(sprite().style.backgroundPosition, "-96px 0px");
  await advance(110);
  assert.equal(sprite().style.backgroundPosition, "-192px 0px");
  await act(async () => f.window.dispatchEvent({ type: "pointermove", clientX: 48, clientY: -100 }));
  assert.equal(sprite().style.backgroundPosition, "0px -936px");
  assert.equal(timers.size, 0, "directional gaze is a static cell, not sprite rotation");
  for (let index = 0; index < 16; index += 1) {
    const angle = index * Math.PI / 8;
    await act(async () => f.window.dispatchEvent({ type: "pointermove", clientX: 48 + Math.sin(angle) * 100, clientY: 52 - Math.cos(angle) * 100 }));
    assert.equal(sprite().style.backgroundPosition, `${-(index % 8) * 96}px ${-(9 + Math.floor(index / 8)) * 104}px`);
  }
  assert.equal(sprite().style.transform, undefined);
  await renderSprite({ animation: "running" });
  assert.equal(sprite().style.backgroundPosition, "0px -728px");
  assert.equal(f.window.count("pointermove"), 0, "gaze must not override non-idle animation");
  await act(async () => { f.media.matches = true; f.media.dispatchEvent({ type: "change" }); });
  assert.equal(sprite().style.backgroundPosition, "0px 0px", "reduced motion always uses idle frame zero");
  assert.equal(timers.size, 0);
  await act(async () => { f.media.matches = false; f.media.dispatchEvent({ type: "change" }); });
  await renderSprite({ pet: { ...hassan, spriteVersionNumber: 1 } });
  assert.equal(sprite().style.backgroundSize, "768px 936px");
  assert.equal(f.window.count("pointermove"), 0, "v1 has no gaze rows");
  await act(async () => { f.document.visibilityState = "hidden"; f.document.dispatchEvent({ type: "visibilitychange" }); });
  assert.equal(timers.size, 0);
  await act(async () => { f.document.visibilityState = "visible"; f.document.dispatchEvent({ type: "visibilitychange" }); });
  assert.equal(timers.size, 1);
  await act(async () => { for (const observer of f.observers) observer.callback([{ isIntersecting: false }]); });
  assert.equal(timers.size, 0, "offscreen sprites suspend scheduling");
  await renderSprite({ dataUrl: "" });
  assert.equal(timers.size, 0);
  assert.equal(f.document.count("visibilitychange"), 0);
  assert.equal(f.media.count("change"), 0);
  assert.equal(f.observers.size, 0);
  await renderSprite();
  assert.equal(timers.size, 1);
  assert.equal(f.window.count("pointermove"), 1);
  await f.render(null);
  assert.equal(f.window.count("pointermove"), 0);
  assert.equal(f.window.count("pointerout"), 0);
  assert.equal(f.window.count("blur"), 0);
  assert.equal(timers.size, 0);
  assert.equal(f.document.count("visibilitychange"), 0);
  assert.equal(f.media.count("change"), 0);
  assert.equal(f.observers.size, 0);
});

test("loading and disposed requests do not leak into a later mount", async (t) => {
  const f = await fixture(t);
  const first = deferred();
  f.handlers.set(IPC.invoke.petsList, () => first.promise);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  assert.ok(f.container.textContent.includes("pets.loading"));
  await f.render(null);
  assert.equal(f.channelListeners.get(IPC.event.petsChanged).size, 0);
  f.handlers.delete(IPC.invoke.petsList);
  await f.render(h(f.PetSettings, { onCreate() {} }));
  await act(async () => first.resolve({ ok: true, data: { pets: [], preferences: { ...DEFAULT_PET_PREFERENCES, selectedPet: null } } }));
  assert.equal(choice(f.container, "Hassan").getAttribute("aria-pressed"), "true");
  assert.equal(f.channelListeners.get(IPC.event.petsChanged).size, 1);
});
