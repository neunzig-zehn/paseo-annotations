/*
 * The floating UI: a toolbar over a chat selection, the comment card that
 * opens from it, and the card a chat marker opens for an existing annotation.
 * The cards never repeat the passage: it stays marked in the chat behind them.
 *
 * Plugins have no portal, so it lives in a shadow root on `document.body`; the
 * chat clips and translates its own content, and the app's global CSS would
 * otherwise restyle it. The comment field is the one light-DOM element, slotted
 * into the shadow tree: the app's keyboard shortcuts classify the event
 * target, and a textarea reads as editable while anything inside a shadow root
 * reads as its host, where Escape interrupts the agent and Space toggles voice.
 */

import { copyText } from "@getpaseo/plugin/client/react-native";
import type { Annotation } from "../../shared/annotations";
import { logError } from "../log";
import {
  CHAT_SCROLL,
  agentIdAround,
  elementOf,
  isVisible,
  readPassage,
  rowAnchor,
  web,
  type DomButton,
  type DomElement,
  type DomEvent,
  type DomHighlight,
  type DomKeyboardEvent,
  type DomListener,
  type DomRange,
  type DomRect,
  type PassageSource,
} from "./dom";
import { DRAFT_HIGHLIGHT, SURFACE_CSS, applyThemeTokens, clamp, createLayer, icon } from "./theme";

/** A selected chat passage, ready to become an annotation. */
export interface Passage extends PassageSource {
  agentId: string;
  transcript: DomElement;
  /** The selection's rendered text; finds the passage again later. */
  anchorText: string;
  anchor: Annotation["anchor"];
}

export interface PopoverActions {
  /** Whether the selected chat's agent lives on this installation's host. */
  owns(agentId: string): boolean;
  add(passage: Passage, comment: string): Promise<void>;
  ask(passage: Passage, comment: string): Promise<void>;
  save(annotation: Annotation, comment: string): Promise<void>;
  remove(annotation: Annotation): Promise<void>;
  /** The card for `annotation` closed; its passage no longer needs emphasis. */
  closed(annotation: Annotation): void;
}

export interface Popover {
  /**
   * Opens the card for an existing annotation below `anchor`, which reports
   * the passage's current position so the card follows the chat as it scrolls.
   */
  showAnnotation(annotation: Annotation, anchor: () => DomRect | null, reference: DomElement): void;
  dispose(): void;
}

interface Selected {
  passage: Passage;
  /** A copy of the selection's range, painted while the comment card is open. */
  range: DomRange;
  first: DomRect;
  last: DomRect;
  anchor: DomElement;
}

type Mode =
  | { kind: "hidden" }
  /** `copied` holds the toolbar, check mark showing, until it closes. */
  | { kind: "toolbar"; selected: Selected; copied?: boolean }
  | { kind: "compose"; intent: "add" | "ask"; selected: Selected }
  | { kind: "annotation"; annotation: Annotation };

const GAP = 8;
/** How long a keyboard or touch selection must hold still before the toolbar shows. */
const SELECTION_SETTLE_MS = 300;
/** How long the copy button shows its check before the toolbar closes. */
const COPY_CONFIRM_MS = 700;

const POPOVER_CSS = `
.panel { position: fixed; display: none; }
.panel[data-open] { display: block; }
.toolbar { display: flex; align-items: center; gap: 2px; padding: 4px; }
.divider { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--colors-border-accent); }
.toolbar .icon-button { width: 28px; height: 28px; }
/* The comment card is Paseo's browser annotation card. */
.panel[data-view="card"] {
  background: var(--colors-surface0);
  border-color: var(--colors-border);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}
.card { display: none; flex-direction: column; gap: 8px; padding: 12px; width: min(420px, calc(100vw - 16px)); }
.panel[data-view="card"] .toolbar { display: none; }
.panel[data-view="card"] .card { display: flex; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close { width: 24px; height: 24px; padding: 0; border-radius: 6px; color: var(--colors-foreground-muted); }
.comment {
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 20px;
  user-select: text;
  -webkit-user-select: text;
}
.comment:empty, .error:empty { display: none; }
.error { font-size: 12px; line-height: 16px; color: var(--colors-destructive); overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.action { min-height: 32px; padding: 0 12px; border-radius: 12px; line-height: 18px; }
.action:active:not(:disabled) { opacity: 0.85; }
.action.ghost { color: var(--colors-foreground-muted); }
.action.ghost:hover:not(:disabled) { color: var(--colors-foreground); }
.action.default {
  background: var(--colors-accent);
  border-color: var(--colors-accent);
  color: var(--colors-accent-foreground);
}
`;

const MARKUP = `
<style>${SURFACE_CSS}${POPOVER_CSS}</style>
<div class="surface panel" data-view="toolbar">
  <div class="toolbar" role="toolbar" aria-label="Annotate selection">
    <button class="item" data-action="add">Add to chat</button>
    <span class="divider" aria-hidden="true"></span>
    <button class="item" data-action="ask">Ask in new chat</button>
    <span class="divider" aria-hidden="true"></span>
    <button class="icon-button" data-action="copy" title="Copy" aria-label="Copy selection">${icon("copy")}</button>
  </div>
  <div class="card" role="dialog" aria-labelledby="card-title">
    <div class="header">
      <span class="title" id="card-title"></span>
      <button class="close" data-action="close" aria-label="Close">${icon("x", 16)}</button>
    </div>
    <slot name="field"></slot>
    <div class="comment"></div>
    <div class="error" role="alert"></div>
    <div class="actions">
      <button class="action ghost" data-action="remove">Delete</button>
      <button class="action ghost" data-action="cancel">Cancel</button>
      <button class="action default" data-action="submit"></button>
    </div>
  </div>
</div>
`;

export function installPopover(actions: PopoverActions): Popover {
  const { host, root } = createLayer("popover", 2147483000);
  root.innerHTML = MARKUP;
  const panel = root.querySelector(".panel")!;
  const title = root.querySelector(".title")!;
  const comment = root.querySelector(".comment")!;
  const error = root.querySelector(".error")!;
  const button = (action: string) => root.querySelector(`[data-action="${action}"]`) as DomButton;

  const field = web.document.createElement("textarea");
  field.setAttribute("slot", "field");
  field.setAttribute("data-paseo-annotations-field", "");
  field.setAttribute("spellcheck", "true");
  field.rows = 3;
  // Inline and important: the app's global CSS reaches light-DOM elements.
  // The look is the browser annotation card's input.
  const setFieldStyle = (entries: ReadonlyArray<readonly [string, string]>) => {
    for (const [property, value] of entries) field.style.setProperty(property, value, "important");
  };
  setFieldStyle([
    ["all", "unset"],
    ["box-sizing", "border-box"],
    ["width", "100%"],
    ["min-height", "64px"],
    ["max-height", "200px"],
    ["padding", "8px"],
    ["border", "1px solid var(--colors-border)"],
    ["border-radius", "6px"],
    ["outline", "none"],
    ["background", "var(--colors-surface1)"],
    ["color", "var(--colors-foreground)"],
    ["caret-color", "var(--colors-foreground)"],
    ["font-family", "var(--pa-font)"],
    ["font-size", "14px"],
    ["line-height", "20px"],
    ["white-space", "pre-wrap"],
    ["overflow-wrap", "anywhere"],
    ["overflow-y", "auto"],
    ["resize", "none"],
    ["user-select", "text"],
    ["-webkit-user-select", "text"],
    ["cursor", "text"],
  ]);
  // `hidden` alone cannot win over the important inline styles.
  const showField = (visible: boolean) => {
    field.hidden = !visible;
    setFieldStyle([["display", visible ? "block" : "none"]]);
  };
  host.appendChild(field);
  showField(false);

  // Focusing the comment field moves the page selection into it, so the
  // selected passage is painted the way the browser paints a selection.
  const draft = createDraftHighlight();

  let mode: Mode = { kind: "hidden" };
  let busy = false;
  let pending = 0;
  let flashTimer = 0;
  /** The chat an open card belongs to; the card closes when it goes away. */
  let cardChat: DomElement | null = null;
  /** Where an open card hangs; read again whenever the chat scrolls or resizes. */
  let cardAnchor: { rect: () => DomRect | null; align: "center" | "end" } | null = null;
  const placeCard = () => {
    const rect = cardAnchor?.rect();
    if (cardAnchor && rect) place(rect, "below", cardAnchor.align);
  };

  const place = (anchor: DomRect, prefer: "above" | "below", align: "center" | "end") => {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const { innerWidth, innerHeight } = web.window;
    const preferredLeft = align === "center" ? anchor.left + anchor.width / 2 - width / 2 : anchor.right - width;
    const left = clamp(preferredLeft, GAP, innerWidth - width - GAP);
    const above = anchor.top - height - GAP;
    const below = anchor.bottom + GAP;
    const fitsAbove = above >= GAP;
    const fitsBelow = below + height <= innerHeight - GAP;
    const top =
      prefer === "above"
        ? fitsAbove || !fitsBelow
          ? above
          : below
        : fitsBelow || !fitsAbove
          ? below
          : above;
    panel.style.setProperty("left", `${Math.round(left)}px`);
    panel.style.setProperty("top", `${Math.round(clamp(top, GAP, innerHeight - height - GAP))}px`);
  };

  const setBusy = (value: boolean) => {
    busy = value;
    field.readOnly = value;
    for (const action of ["submit", "cancel", "remove", "close"]) button(action).disabled = value;
  };

  const hide = () => {
    web.window.clearTimeout(flashTimer);
    const closing = mode;
    mode = { kind: "hidden" };
    cardChat = null;
    cardAnchor = null;
    draft?.clear();
    setBusy(false);
    field.value = "";
    error.textContent = "";
    panel.removeAttribute("data-open");
    if (closing.kind === "annotation") actions.closed(closing.annotation);
  };

  const open = (view: "toolbar" | "card", reference: DomElement) => {
    applyThemeTokens(host, reference);
    error.textContent = "";
    panel.setAttribute("data-view", view);
    panel.setAttribute("data-open", "");
  };

  const showToolbar = (selected: Selected) => {
    mode = { kind: "toolbar", selected };
    button("copy").innerHTML = icon("copy");
    open("toolbar", selected.anchor);
    place(selected.first, "above", "center");
  };

  const openCompose = (intent: "add" | "ask", selected: Selected) => {
    mode = { kind: "compose", intent, selected };
    open("card", selected.anchor);
    cardChat = selected.passage.transcript;
    draft?.clear();
    draft?.add(selected.range);
    title.textContent = intent === "add" ? "Annotate selection" : "Ask about selection";
    comment.textContent = "";
    showField(true);
    field.value = "";
    field.placeholder =
      intent === "add" ? "Message to the agent about this selection…" : "Ask about this selection…";
    button("remove").hidden = true;
    button("cancel").hidden = false;
    button("submit").hidden = false;
    button("submit").textContent = intent === "add" ? "Add to chat" : "Ask in new chat";
    const { range } = selected;
    cardAnchor = {
      rect: () => {
        const rects = range.getClientRects();
        return rects.length > 0 ? rects[rects.length - 1]! : selected.last;
      },
      align: "center",
    };
    placeCard();
    field.focus({ preventScroll: true });
  };

  const showAnnotation = (annotation: Annotation, anchor: () => DomRect | null, reference: DomElement) => {
    mode = { kind: "annotation", annotation };
    draft?.clear();
    open("card", reference);
    cardChat = reference;
    const isPending = annotation.status === "pending";
    title.textContent = isPending ? "Annotation" : "Sent annotation";
    showField(isPending);
    field.value = isPending ? annotation.comment : "";
    field.placeholder = "Message to the agent about this selection…";
    comment.textContent = isPending ? "" : annotation.comment;
    button("remove").hidden = false;
    button("cancel").hidden = true;
    button("submit").hidden = !isPending;
    button("submit").textContent = "Save";
    cardAnchor = { rect: anchor, align: "end" };
    placeCard();
    if (isPending) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  };

  /** Runs `work` with the controls disabled; closes on success, shows the error otherwise. */
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    error.textContent = "";
    try {
      await work();
      hide();
    } catch (cause) {
      setBusy(false);
      error.textContent = cause instanceof Error ? cause.message : String(cause);
      if (!field.hidden) field.focus({ preventScroll: true });
    }
  };

  const submit = () => {
    const current = mode;
    if (current.kind === "compose") {
      const text = field.value.trim();
      const { passage } = current.selected;
      void run(() => (current.intent === "add" ? actions.add(passage, text) : actions.ask(passage, text)));
    } else if (current.kind === "annotation") {
      if (current.annotation.status !== "pending") return hide();
      const text = field.value.trim();
      void run(() => actions.save(current.annotation, text));
    }
  };

  /** Copies the selection as Markdown, confirms with a check, then closes. */
  const copy = () => {
    if (mode.kind !== "toolbar") return;
    const target = button("copy");
    copyText(mode.selected.passage.quote.trim()).then(
      () => {
        if (mode.kind !== "toolbar") return;
        mode = { ...mode, copied: true };
        target.innerHTML = icon("check");
        web.window.clearTimeout(flashTimer);
        flashTimer = web.window.setTimeout(hide, COPY_CONFIRM_MS);
      },
      (cause: unknown) => logError("Could not copy the selection", cause),
    );
  };

  const handlers: Record<string, () => void> = {
    add: () => mode.kind === "toolbar" && openCompose("add", mode.selected),
    ask: () => mode.kind === "toolbar" && openCompose("ask", mode.selected),
    copy,
    cancel: hide,
    close: hide,
    submit,
    remove: () => {
      const current = mode;
      if (current.kind === "annotation") void run(() => actions.remove(current.annotation));
    },
  };

  // A press inside the panel must not move the caret, or the page selection is
  // gone by the time the click lands. The slotted field is exempt: it needs focus.
  const onPanelPointerDown: DomListener = (event) => {
    if (event.target !== field) event.preventDefault();
  };
  const onPanelClick: DomListener = (event) => {
    const target = elementOf(event.target)?.closest("button[data-action]") as DomButton | null;
    const action = target?.getAttribute("data-action");
    if (action && !target!.disabled) handlers[action]?.();
  };
  panel.addEventListener("mousedown", onPanelPointerDown);
  panel.addEventListener("click", onPanelClick);

  // Escape cancels from anywhere while a card is open; Enter in the field
  // submits, Shift+Enter starts a new line.
  const onCardKeyDown: DomListener = (raw) => {
    if (mode.kind !== "compose" && mode.kind !== "annotation") return;
    const event = raw as DomKeyboardEvent;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && event.target === field) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
  };
  web.window.addEventListener("keydown", onCardKeyDown, true);

  const sync = () => {
    pending = 0;
    if (mode.kind === "compose" || mode.kind === "annotation") return;
    // Copying can move the page selection; the confirmation stays put.
    if (mode.kind === "toolbar" && mode.copied) return;
    const selected = readSelection(host, actions.owns);
    if (selected) showToolbar(selected);
    else if (mode.kind === "toolbar") hide();
  };
  const schedule = (delay = 0) => {
    web.window.clearTimeout(pending);
    pending = web.window.setTimeout(sync, delay);
  };
  const inside = (event: DomEvent) => event.target !== null && host.contains(event.target);

  let pointerDown = false;
  // A click outside a card closes it and keeps what it holds: a new
  // annotation is added, an edited comment saved. "Ask in new chat" only
  // closes, so a stray click never starts an agent. Escape and Cancel discard.
  const onPointerDown: DomListener = (event) => {
    pointerDown = true;
    if (mode.kind === "hidden" || inside(event)) return;
    if (mode.kind === "toolbar" || (mode.kind === "compose" && mode.intent === "ask")) hide();
    else submit();
  };
  const onPointerUp: DomListener = (event) => {
    pointerDown = false;
    if (!inside(event)) schedule();
  };
  // Show on release, not while dragging; hide as soon as the selection goes.
  // Selections made without a pointer drag (keyboard, a touch long-press)
  // show the toolbar once they settle.
  const onSelectionChange: DomListener = () => {
    const selection = web.window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (mode.kind === "toolbar" && !mode.copied) hide();
      return;
    }
    if (!pointerDown && (mode.kind === "hidden" || mode.kind === "toolbar")) schedule(SELECTION_SETTLE_MS);
  };
  const onViewportChange: DomListener = () => {
    if (mode.kind === "toolbar") schedule();
    else if (mode.kind !== "hidden") placeCard();
  };

  const { document, window } = web;
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  // A tab switch, navigation, or archive can take the chat away under a card.
  let watchFrame = 0;
  const watchCard = () => {
    watchFrame = 0;
    if (cardChat && !(cardChat.isConnected && isVisible(cardChat))) hide();
  };
  const cardObserver = new web.MutationObserver(() => {
    if (cardChat && watchFrame === 0) watchFrame = window.requestAnimationFrame(watchCard);
  });
  cardObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  return {
    showAnnotation,
    dispose() {
      window.clearTimeout(pending);
      window.clearTimeout(flashTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("keydown", onCardKeyDown, true);
      cardObserver.disconnect();
      window.cancelAnimationFrame(watchFrame);
      draft?.clear();
      web.CSS?.highlights?.delete(DRAFT_HIGHLIGHT);
      host.remove();
    },
  };
}

/**
 * The live selection, or null unless it is non-empty, both ends sit in the same
 * chat transcript, and that chat belongs to a known agent.
 */
function readSelection(ignore: DomElement, owns: (agentId: string) => boolean): Selected | null {
  const selection = web.window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const anchorText = selection.toString();
  if (!anchorText.trim()) return null;

  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || ignore.contains(start)) return null;
  const transcript = start.closest(CHAT_SCROLL);
  if (!transcript || end.closest(CHAT_SCROLL) !== transcript) return null;
  const agentId = agentIdAround(transcript);
  if (!agentId || !owns(agentId)) return null;

  const rects = range.getClientRects();
  const bounds = range.getBoundingClientRect();
  const first = rects.length > 0 ? rects[0]! : bounds;
  const last = rects.length > 0 ? rects[rects.length - 1]! : bounds;
  if (first.width === 0 && first.height === 0) return null;

  return {
    passage: {
      ...readPassage(selection, range, start),
      agentId,
      transcript,
      anchorText,
      anchor: rowAnchor(start),
    },
    range: range.cloneRange(),
    first,
    last,
    anchor: start,
  };
}

function createDraftHighlight(): DomHighlight | null {
  const { Highlight, CSS } = web;
  if (!Highlight || !CSS?.highlights) return null;
  const highlight = new Highlight();
  CSS.highlights.set(DRAFT_HIGHLIGHT, highlight);
  return highlight;
}
