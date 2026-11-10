// Minimal ReactDOM host, following pet-ui.test.mjs; no layout or component mocks.
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
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.stopPropagation ??= () => { event.cancelBubble = true; };
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const fire = (node, capture) => {
      event.currentTarget = node;
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
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; if (value) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
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
  set type(value) { this.setAttribute("type", value); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true, button: 0 }); }
}
class Document extends DomNode {
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
export function browser() {
  const document = new Document(); const window = new Events();
  window.document = document; document.defaultView = window;
  window.window = window; window.HTMLElement = Element; window.HTMLIFrameElement = class extends Element {};
  window.getSelection = () => null; window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.Node = DomNode; window.setTimeout = globalThis.setTimeout; window.clearTimeout = globalThis.clearTimeout;
  return { document, window };
}
export function installBrowser(env = browser()) {
  Object.assign(globalThis, { window: env.window, document: env.document, HTMLElement: Element, IS_REACT_ACT_ENVIRONMENT: true });
  return env;
}
export function descendants(node) { return [node, ...node.childNodes.flatMap(descendants)]; }
