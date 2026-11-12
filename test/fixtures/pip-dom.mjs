// Stub documents and windows for test/pip.test.mjs (launch readiness W9, contract 9.6). No browser: just enough of
// the DOM to see which node sits in which document, in which order, and which window was asked for a frame.
// A node that is inserted into another document changes its ownerDocument, like adoption in a real DOM.

function adopt(el, doc) {
  el.ownerDocument = doc;
  for (const child of el.children) adopt(child, doc);
}

export class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.clientWidth = 0;
    this.clientHeight = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  /** How many listeners of a type are attached now. */
  count(type) { return (this.listeners[type] ?? []).length; }
  dispatch(type, ev = {}) { for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, target: this, preventDefault() {}, ...ev }); }
  click() { this.dispatch('click'); }
  get nextSibling() {
    const p = this.parentNode;
    return p ? p.children[p.children.indexOf(this) + 1] ?? null : null;
  }
  get firstChild() { return this.children[0] ?? null; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(el, ref = null) {
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: the reference node is not a child of this node');
    el.remove();
    adopt(el, this.ownerDocument);
    el.parentNode = this;
    if (ref) this.children.splice(this.children.indexOf(ref), 0, el);
    else this.children.push(el);
    return el;
  }
  appendChild(el) { return this.insertBefore(el, null); }
  append(...els) { for (const el of els) this.appendChild(el); }
  insertAdjacentElement(where, el) {
    if (where !== 'afterend') throw new Error(`unexpected position ${where}`);
    this.parentNode.insertBefore(el, this.nextSibling);
    return el;
  }
}

/** The one selector pip.js may use to collect the page styles. */
export const STYLE_SELECTOR = 'style, link[rel="stylesheet"]';

export class FakeDoc {
  constructor(title = '') {
    this.title = title;
    this.documentElement = new FakeEl('html', this);
    this.head = this.documentElement.appendChild(new FakeEl('head', this));
    this.body = this.documentElement.appendChild(new FakeEl('body', this));
  }
  createElement(tag) { return new FakeEl(tag, this); }
  all(from = this.documentElement) { return [from, ...from.children.flatMap((c) => this.all(c))]; }
  getElementById(id) { return this.all().find((el) => el.id === id) ?? null; }
  querySelector(sel) {
    if (sel === '.bar .controls') return this.all().find((el) => el.className === 'controls') ?? null;
    throw new Error(`unexpected selector ${sel}`);
  }
  querySelectorAll(sel) {
    if (sel !== STYLE_SELECTOR) throw new Error(`unexpected selector ${sel}`);
    return this.all().filter((el) => el.tagName === 'STYLE' || (el.tagName === 'LINK' && el.getAttribute('rel') === 'stylesheet'));
  }
}

/** A window: animation frames are queued and run by the test (`frame(ts)`), events are dispatched by the test. */
export class FakeWin {
  constructor(doc, { innerWidth = 1280, innerHeight = 720 } = {}) {
    this.document = doc;
    this.innerWidth = innerWidth;
    this.innerHeight = innerHeight;
    this.queued = new Map();
    this.issued = []; // every callback ever asked for, also the cancelled ones
    this.seq = 0;
    this.listeners = {};
    this.closed = false;
    this.focused = 0;
    this.observers = [];
    const observers = this.observers;
    this.MutationObserver = class {
      constructor(cb) { this.cb = cb; this.target = null; this.options = null; }
      observe(target, options) { this.target = target; this.options = options; observers.push(this); }
      disconnect() { const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
    };
  }
  requestAnimationFrame(fn) { this.seq += 1; this.queued.set(this.seq, fn); this.issued.push(fn); return this.seq; }
  cancelAnimationFrame(id) { this.queued.delete(id); }
  /** Callbacks waiting for the next frame. */
  get pending() { return this.queued.size; }
  /** One frame: run what was queued before it, with this timestamp. Returns how many callbacks ran. */
  frame(ts) {
    const batch = [...this.queued.values()];
    this.queued.clear();
    for (const fn of batch) fn(ts);
    return batch.length;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  count(type) { return (this.listeners[type] ?? []).length; }
  dispatch(type) { for (const fn of [...(this.listeners[type] ?? [])]) fn({ type, target: this }); }
  focus() { this.focused += 1; }
  /** Like the browser: closing a window fires pagehide on it once. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatch('pagehide');
  }
  /** The root attributes changed: tell the observers that watch that attribute. */
  mutated(target, name) {
    for (const o of [...this.observers]) {
      if (o.target === target && (!o.options?.attributeFilter || o.options.attributeFilter.includes(name))) o.cb([{ type: 'attributes', attributeName: name }]);
    }
  }
}

/**
 * The tab: a page with styles in its head, the stage host with the canvas and the labels element, and the top bar.
 * @param {{ extra?: boolean }} [o] extra: one more node after the labels element inside the host
 */
export function tabPage({ extra = false } = {}) {
  const doc = new FakeDoc('Office Sim');
  const win = new FakeWin(doc);
  const root = doc.documentElement;
  root.setAttribute('lang', 'en');
  root.setAttribute('data-theme', 'dark');
  const el = (tag, parent, props = {}, attrs = {}) => {
    const node = Object.assign(doc.createElement(tag), props);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return parent.appendChild(node);
  };
  el('link', doc.head, {}, { rel: 'icon', href: 'favicon.svg' });
  el('style', doc.head, { textContent: ':root { --accent: #0f766e; } .labels { position: absolute; }' });
  el('link', doc.head, { href: 'http://127.0.0.1:1/extra.css' }, { rel: 'stylesheet', media: 'screen' });
  el('style', doc.head, { id: 'needs-you-style', textContent: '#needs-you[hidden] { display: none; }' });
  const host = el('div', doc.body, { id: 'stage', clientWidth: 1280, clientHeight: 720 }, { role: 'img', 'aria-label': '3D office' });
  const canvas = el('canvas', host);
  const labels = el('div', host, { className: 'labels' });
  const tail = extra ? el('div', host, { id: 'after-labels' }) : null;
  const hud = el('div', doc.body, { id: 'hud' });
  const bar = el('header', hud, { className: 'bar' });
  const controls = el('div', bar, { className: 'controls' });
  const source = el('span', controls, { id: 'source', className: 'chip' });
  el('span', controls, { id: 'tail' });
  const langToggle = el('button', controls, { id: 'lang-toggle' });
  return { doc, win, host, canvas, labels, tail, hud, controls, source, langToggle };
}

/** A mini window as `documentPictureInPicture.requestWindow` returns it: an empty document of its own. */
export function miniWindow({ width = 420, height = 300 } = {}) {
  return new FakeWin(new FakeDoc(''), { innerWidth: width, innerHeight: height });
}
