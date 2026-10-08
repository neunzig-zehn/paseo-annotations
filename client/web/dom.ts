/*
 * The page this plugin drives, and the parts of the DOM it uses.
 *
 * Paseo has no plugin API for chat selections, the message box, or chat
 * decorations, so the web client reads and writes the app's own markup. Every
 * host selector is listed in this file; when a Paseo release renames one, this
 * is the place to fix. Checked against Paseo 0.11.1.
 *
 * The plugin typechecks without the DOM library, so the browser APIs it uses
 * are declared here by hand and reached through `web`. Only code under
 * `client/web` imports this module, and only after `isWebDom()` passed.
 *
 * `nearestUnique`, `readPassage`, and the composer editing helpers are adapted
 * from paseo-quote; see NOTICE.md.
 */

import type { Annotation } from "../../shared/annotations";

// ---------------------------------------------------------------------------
// Host DOM contract

/** One chat transcript. Inactive tabs keep theirs mounted with `display: none`. */
export const CHAT_SCROLL = '[data-testid="agent-chat-scroll"]';
/** A transcript row; assistant messages span several rows with the same id. */
export const MESSAGE_ROW = "[data-message-id]";
export const MESSAGE_ID_ATTRIBUTE = "data-message-id";
/** The message bodies inside rows; they tell a user message from an assistant one. */
export const USER_MESSAGE = '[data-testid="user-message"]';
const ASSISTANT_MESSAGE = '[data-testid="assistant-message"]';
/** The composer and its textarea. Every retained chat has one, visible or not. */
export const COMPOSER_ROOT = '[data-testid="message-input-root"]';
export const COMPOSER = "textarea[data-composer-input]";
/** A split-view pane; its tab row names the agent whose chat it shows. */
const PANE = '[data-testid^="workspace-pane-"]';
const ACTIVE_AGENT_TAB = '[data-testid^="workspace-tab-agent_"][aria-selected="true"]';
const AGENT_TAB_PREFIX = "workspace-tab-agent_";
/** React's per-node fiber property (React 17 and later). */
const REACT_FIBER_PREFIX = "__reactFiber$";
/** The chat's `agentId` owner sits a few dozen components above its DOM nodes. */
const FIBER_DEPTH = 120;
/** The visible workspace, named `workspace-deck-entry-<serverId>:<workspaceId>`. */
const DECK_ENTRY = '[data-testid^="workspace-deck-entry-"]';
const DECK_ENTRY_PREFIX = "workspace-deck-entry-";
/** Markdown serialization hints the host puts on rendered assistant messages. */
const CODE_BLOCK = '[data-paseo-markdown-tag="pre"]';
const CODE_SPAN = '[data-paseo-markdown-tag="code"]';
const CODE_LANGUAGE_ATTRIBUTE = "data-paseo-markdown-language";
/** Monospace surfaces such as tool output. */
const CODE_SURFACE = "[data-pmono]";
/** The app opens an agent's tab when a web notification is clicked. */
const OPEN_AGENT_EVENT = "paseo:web-notification-click";
/** Where the app keeps Settings; the legacy key predates the current one. */
const APP_SETTINGS_KEYS = ["@paseo:app-settings", "@paseo:settings"];

// ---------------------------------------------------------------------------
// Declarations

export interface DomRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface DomMouseEvent extends DomEvent {
  readonly clientX: number;
  readonly clientY: number;
}

export interface DomEvent {
  readonly type: string;
  readonly target: DomNode | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface DomKeyboardEvent extends DomEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
}

export type DomListener = (event: DomEvent) => void;

export interface DomEventTarget {
  addEventListener(type: string, listener: DomListener, capture?: boolean): void;
  removeEventListener(type: string, listener: DomListener, capture?: boolean): void;
  dispatchEvent(event: DomEvent): boolean;
}

export interface DomNode extends DomEventTarget {
  readonly nodeType: number;
  readonly parentElement: DomElement | null;
  readonly isConnected: boolean;
}

export interface DomText extends DomNode {
  readonly data: string;
}

export interface DomStyle {
  setProperty(name: string, value: string, priority?: string): void;
  getPropertyValue(name: string): string;
  readonly fontFamily: string;
}

export interface DomElement extends DomNode {
  readonly style: DomStyle;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  title: string;
  closest(selector: string): DomElement | null;
  matches(selector: string): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild<Child extends DomNode>(child: Child): Child;
  contains(node: DomNode | null): boolean;
  remove(): void;
  getClientRects(): ArrayLike<DomRect>;
  getBoundingClientRect(): DomRect;
  attachShadow(init: { mode: "open" }): DomShadowRoot;
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView(options?: { block?: "center" | "nearest"; behavior?: "smooth" | "auto" }): void;
}

export interface DomButton extends DomElement {
  disabled: boolean;
}

export interface DomShadowRoot {
  innerHTML: string;
  querySelector(selector: string): DomElement | null;
  appendChild<Child extends DomNode>(child: Child): Child;
}

export interface DomTextArea extends DomElement {
  value: string;
  placeholder: string;
  rows: number;
  readOnly: boolean;
  disabled: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
}

export interface DomRange {
  readonly startContainer: DomNode;
  readonly endContainer: DomNode;
  readonly commonAncestorContainer: DomNode;
  setStart(node: DomNode, offset: number): void;
  setEnd(node: DomNode, offset: number): void;
  getClientRects(): ArrayLike<DomRect>;
  getBoundingClientRect(): DomRect;
  cloneRange(): DomRange;
  toString(): string;
}

export interface DomSelection {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): DomRange;
  removeAllRanges(): void;
  toString(): string;
}

interface DomTreeWalker {
  nextNode(): DomNode | null;
}

interface DomDataTransfer {
  getData(format: string): string;
}

interface DomMutationObserver {
  observe(
    target: DomNode,
    options: {
      childList?: boolean;
      subtree?: boolean;
      characterData?: boolean;
      attributes?: boolean;
      attributeFilter?: string[];
    },
  ): void;
  disconnect(): void;
}

export interface DomHighlight {
  add(range: DomRange): void;
  clear(): void;
  readonly size: number;
}

interface Web {
  window: DomEventTarget & {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly location: { readonly pathname: string };
    getSelection(): DomSelection | null;
    getComputedStyle(element: DomElement): DomStyle;
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(handle: number): void;
    requestAnimationFrame(callback: () => void): number;
    cancelAnimationFrame(handle: number): void;
  };
  document: DomEventTarget & {
    readonly body: DomElement;
    readonly head: DomElement;
    readonly documentElement: DomElement;
    readonly activeElement: DomElement | null;
    createElement(tag: "div" | "style" | "button"): DomElement;
    createElement(tag: "textarea"): DomTextArea;
    createRange(): DomRange;
    createTreeWalker(root: DomNode, whatToShow: number): DomTreeWalker;
    execCommand(command: "insertText" | "delete", showUi: boolean, value?: string): boolean;
    querySelectorAll(selector: string): ArrayLike<DomElement>;
  };
  Event: new (type: string, init?: { bubbles?: boolean }) => DomEvent;
  CustomEvent: new (type: string, init: { cancelable?: boolean; detail: unknown }) => DomEvent;
  DataTransfer?: new () => DomDataTransfer;
  ClipboardEvent?: new (
    type: string,
    init: { bubbles: boolean; cancelable: boolean; clipboardData: DomDataTransfer },
  ) => DomEvent;
  MutationObserver: new (callback: () => void) => DomMutationObserver;
  Highlight?: new () => DomHighlight;
  CSS?: { highlights?: { set(name: string, highlight: DomHighlight): void; delete(name: string): void } };
  localStorage: { getItem(key: string): string | null };
}

/** Typed by the declarations above; only read after `isWebDom()` passed. */
export const web = globalThis as unknown as Web;

const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

/** True in a browser or the desktop app, where the chat is real DOM. */
export function isWebDom(): boolean {
  return "document" in globalThis && "window" in globalThis;
}

// ---------------------------------------------------------------------------
// Reading the page

export function elementOf(node: DomNode | null): DomElement | null {
  if (!node) return null;
  return node.nodeType === ELEMENT_NODE ? (node as DomElement) : node.parentElement;
}

export function isVisible(element: DomElement): boolean {
  return element.getClientRects().length > 0;
}

/**
 * The first visible match walking up from `from`, stopping at its pane. Two
 * visible matches at the same level mean two chats share it: no answer beats a
 * wrong one.
 */
export function nearestUnique(from: DomElement, selector: string): DomElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const visible = Array.from(node.querySelectorAll(selector)).filter(isVisible);
    if (visible.length === 1) return visible[0]!;
    if (visible.length > 1 || node.matches(PANE)) return null;
  }
  return null;
}

/**
 * The agent whose chat contains `element`. The app renders each chat and
 * composer inside components that take an `agentId` prop, which React keeps
 * on the DOM node's fiber; that works in every layout. The selected agent tab
 * of the pane is the fallback, on wide layouts only.
 */
export function agentIdAround(element: DomElement): string | null {
  const fromReact = agentIdFromFiber(element);
  if (fromReact) return fromReact;
  const testId = nearestUnique(element, ACTIVE_AGENT_TAB)?.getAttribute("data-testid");
  return testId?.startsWith(AGENT_TAB_PREFIX) ? testId.slice(AGENT_TAB_PREFIX.length) || null : null;
}

function agentIdFromFiber(element: DomElement): string | null {
  const key = Object.keys(element).find((name) => name.startsWith(REACT_FIBER_PREFIX));
  let fiber: unknown = key ? Reflect.get(element, key) : null;
  for (let depth = 0; depth < FIBER_DEPTH && fiber && typeof fiber === "object"; depth += 1) {
    const props: unknown = Reflect.get(fiber, "memoizedProps");
    if (props && typeof props === "object" && "agentId" in props) {
      const { agentId } = props;
      if (typeof agentId === "string" && agentId) return agentId;
    }
    fiber = Reflect.get(fiber, "return");
  }
  return null;
}

export function visibleTranscripts(): DomElement[] {
  return Array.from(web.document.querySelectorAll(CHAT_SCROLL)).filter(isVisible);
}

export function composerAround(transcript: DomElement): DomTextArea | null {
  const input = nearestUnique(transcript, COMPOSER) as DomTextArea | null;
  return input && !input.readOnly && !input.disabled ? input : null;
}

/** The transcript row `element` sits in, and what kind of message it shows. */
export function rowAnchor(element: DomElement): Annotation["anchor"] {
  const messageId = element.closest(MESSAGE_ROW)?.getAttribute(MESSAGE_ID_ATTRIBUTE);
  if (!messageId) return null;
  const role = element.closest(USER_MESSAGE)
    ? "user"
    : element.closest(ASSISTANT_MESSAGE)
      ? "assistant"
      : "other";
  return { messageId, role };
}

/** The selected host, from the `/h/<serverId>/…` route or the visible workspace. */
export function currentServerId(): string | null {
  const match = /^\/h\/([^/]+)/.exec(web.window.location.pathname);
  if (match) return decodeURIComponent(match[1]!);
  const entry = Array.from(web.document.querySelectorAll(DECK_ENTRY)).find(isVisible);
  const id = entry?.getAttribute("data-testid")?.slice(DECK_ENTRY_PREFIX.length);
  return id?.split(":")[0] || null;
}

/** Opens and focuses an agent's tab, the way a clicked notification does. */
export function openAgentTab(target: { serverId: string; workspaceId: string; agentId: string }): void {
  web.window.dispatchEvent(
    new web.CustomEvent(OPEN_AGENT_EVENT, { cancelable: true, detail: { data: target } }),
  );
}

/** Settings → Sending → Default send, as the composer reads it. */
export function readSendBehavior(): "interrupt" | "steer" | "queue" {
  for (const key of APP_SETTINGS_KEYS) {
    try {
      const raw = web.localStorage.getItem(key);
      if (raw === null) continue;
      const settings: unknown = JSON.parse(raw);
      const value =
        settings && typeof settings === "object" && "sendBehavior" in settings
          ? settings.sendBehavior
          : undefined;
      return value === "interrupt" || value === "queue" ? value : "steer";
    } catch {
      // Unreadable settings fall through to the app's own default.
    }
  }
  return "steer";
}

export interface PassageSource {
  /** Markdown when the host could serialize the selection, rendered text otherwise. */
  quote: string;
  code: { language: string | null } | null;
}

/** The selection as Markdown when the host can provide it, plus its code context. */
export function readPassage(selection: DomSelection, range: DomRange, start: DomElement): PassageSource {
  const common = elementOf(range.commonAncestorContainer);
  const block = common?.closest(CODE_BLOCK) ?? null;
  const inCode = Boolean(block || common?.closest(CODE_SPAN) || common?.closest(CODE_SURFACE));
  return {
    quote: hostMarkdown(start) ?? selection.toString(),
    code: inCode ? { language: block?.getAttribute(CODE_LANGUAGE_ATTRIBUTE) ?? null } : null,
  };
}

/**
 * The selection as Markdown, from the host's own copy handler. Assistant
 * messages turn a copied selection back into Markdown; a synthetic copy event
 * with a private DataTransfer runs that handler without touching the clipboard.
 */
function hostMarkdown(target: DomElement): string | null {
  const { ClipboardEvent, DataTransfer } = web;
  if (!ClipboardEvent || !DataTransfer) return null;
  try {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) return null;
    const text = clipboardData.getData("text/plain");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finding a passage again

/**
 * A range over `needle` inside `roots`, compared without whitespace: rendered
 * Markdown splits text across many nodes and the selection's line breaks do
 * not exist in the DOM text.
 */
export function findPassage(roots: readonly DomElement[], needle: string): DomRange | null {
  const target = needle.replace(/\s+/g, "");
  if (!target) return null;
  const nodes: DomText[] = [];
  const nodeIndex: number[] = [];
  const offsets: number[] = [];
  let haystack = "";
  for (const root of roots) {
    const walker = web.document.createTreeWalker(root, SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as DomText;
      const index = nodes.push(text) - 1;
      const data = text.data;
      for (let offset = 0; offset < data.length; offset += 1) {
        const char = data[offset]!;
        if (/\s/.test(char)) continue;
        haystack += char;
        nodeIndex.push(index);
        offsets.push(offset);
      }
    }
  }
  const at = haystack.indexOf(target);
  if (at < 0) return null;
  const last = at + target.length - 1;
  const range = web.document.createRange();
  range.setStart(nodes[nodeIndex[at]!]!, offsets[at]!);
  range.setEnd(nodes[nodeIndex[last]!]!, offsets[last]! + 1);
  return range;
}

// ---------------------------------------------------------------------------
// Editing the composer

/**
 * Inserts `text` at `at` through the browser's editing path, so the composer's
 * change handler sees a real edit, then puts the caret back where it was.
 */
export function insertIntoComposer(input: DomTextArea, at: number, text: string): boolean {
  const before = input.value;
  const caret = [input.selectionStart, input.selectionEnd] as const;
  input.focus({ preventScroll: true });
  input.setSelectionRange(at, at);
  const expected = before.slice(0, at) + text + before.slice(at);
  let landed = web.document.execCommand("insertText", false, text) && input.value === expected;
  if (!landed && input.value === before) {
    setNativeValue(input, expected);
    landed = input.value === expected;
  }
  const shift = (position: number) => (position >= at && at < before.length ? position + text.length : position);
  input.setSelectionRange(shift(caret[0]), shift(caret[1]));
  return landed;
}

/** Removes `[start, end)` from the composer through the editing path. */
export function deleteFromComposer(input: DomTextArea, start: number, end: number): void {
  const before = input.value;
  const caret = [input.selectionStart, input.selectionEnd] as const;
  input.setSelectionRange(start, end);
  const expected = before.slice(0, start) + before.slice(end);
  if (!web.document.execCommand("delete", false) || input.value !== expected) {
    if (input.value === before) setNativeValue(input, expected);
  }
  const shift = (position: number) =>
    position >= end ? position - (end - start) : Math.min(position, start);
  input.setSelectionRange(shift(caret[0]), shift(caret[1]));
}

function setNativeValue(input: DomTextArea, value: string): void {
  const prototype = Object.getPrototypeOf(input) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new web.Event("input", { bubbles: true }));
}
