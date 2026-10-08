/*
 * Annotated passages in the chat, drawn the way Paseo marks annotated browser
 * elements: a numbered blue badge at the passage while its annotation waits
 * for the next message. The text itself is tinted through the CSS Custom
 * Highlight API, so the app's markup is never touched, and clicking the badge
 * or the tinted text opens the annotation.
 *
 * Passages are found again by their text, preferring the transcript rows of
 * the message they came from. Rows outside the app's render window are not in
 * the DOM; their badges appear when the user scrolls them back in.
 */

import type { Annotation } from "../../shared/annotations";
import type { AnnotationStore } from "../store";
import {
  MESSAGE_ID_ATTRIBUTE,
  MESSAGE_ROW,
  USER_MESSAGE,
  agentIdAround,
  elementOf,
  findPassage,
  visibleTranscripts,
  web,
  type DomButton,
  type DomElement,
  type DomHighlight,
  type DomListener,
  type DomMouseEvent,
  type DomRange,
  type DomRect,
} from "./dom";
import { BADGE_COLOR, createLayer } from "./theme";

/** Paseo's browser annotation badge: 18px tall, 600 11px numerals, white on blue. */
const BADGE_SIZE = 18;

const BADGE_CSS = `
:host { all: initial; }
.badge {
  position: fixed;
  box-sizing: border-box;
  min-width: ${BADGE_SIZE}px;
  height: ${BADGE_SIZE}px;
  margin: 0;
  padding: 0 4px;
  border: 0;
  border-radius: 9px;
  background: ${BADGE_COLOR};
  color: #fff;
  font: 600 11px/${BADGE_SIZE}px -apple-system, system-ui, sans-serif;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  pointer-events: auto;
}
`;

interface Located {
  range: DomRange;
  /** The transcript rows searched, so a cached miss expires when they change. */
  signature: string;
}

interface Visible {
  annotation: Annotation;
  range: DomRange;
  /** The transcript, whose font and theme an opened card takes. */
  reference: DomElement;
}

export interface Markers {
  /**
   * Scrolls the chat to the annotated passage and emphasizes it, briefly or,
   * with `edit`, while its card is open; false when the passage is not on screen.
   */
  reveal(annotation: Annotation, options?: { edit?: boolean }): boolean;
  /** The annotation's card closed: drop the emphasis its opening added. */
  release(annotationId: string): void;
  dispose(): void;
}

/** How long a revealed passage stays emphasized. */
const REVEAL_MS = 1600;

export function installMarkers(
  store: AnnotationStore,
  open: (annotation: Annotation, anchor: () => DomRect | null, reference: DomElement) => void,
): Markers {
  const { host, root } = createLayer("markers", 2147482000);
  root.innerHTML = `<style>${BADGE_CSS}</style>`;
  const highlights = createHighlights();
  const found = new Map<string, Located>();
  const misses = new Map<string, string>();
  /** Badges by annotation id, so a badge keeps its element across refreshes. */
  const badges = new Map<string, { element: DomButton; entry: Visible }>();
  /** The passages highlighted by the last refresh, for clicks on highlighted text. */
  let visible: Visible[] = [];
  let frame = 0;
  // A passage is emphasized while its badge is hovered, its card is open, or
  // it was just revealed from the composer pill.
  let hovered: string | null = null;
  let opened: string | null = null;
  let revealed: string | null = null;
  let revealTimer = 0;

  const refresh = () => {
    frame = 0;
    for (const highlight of Object.values(highlights ?? {})) highlight.clear();
    visible = [];
    const shown = new Set<string>();

    for (const transcript of visibleTranscripts()) {
      const agentId = agentIdAround(transcript);
      if (!agentId) continue;
      const annotations = store.get(agentId);
      if (annotations.length === 0) continue;
      const bounds = transcript.getBoundingClientRect();
      const signature = rowSignature(transcript);
      // Waiting annotations are numbered in the order the composer pill lists them.
      let number = 0;
      for (const annotation of annotations) {
        if (annotation.status === "pending") number += 1;
        const range = locate(transcript, annotation, signature);
        if (!range) continue;
        const entry = { annotation, range, reference: transcript };
        visible.push(entry);
        highlights?.[annotation.status].add(range);
        if (annotation.id === hovered || annotation.id === opened || annotation.id === revealed) {
          highlights?.focus.add(range);
        }
        if (annotation.status !== "pending") continue;
        const line = range.getClientRects()[0] ?? range.getBoundingClientRect();
        if (line.bottom < bounds.top || line.top > bounds.bottom) continue;
        // Pinned to the passage's first corner, as the browser badges are to an element's.
        const left = Math.max(bounds.left, line.left - BADGE_SIZE / 2);
        const top = Math.max(bounds.top, line.top - BADGE_SIZE / 2);
        showBadge(entry, number, left, top);
        shown.add(annotation.id);
      }
    }
    for (const [id, badge] of badges) {
      if (shown.has(id)) continue;
      badge.element.remove();
      badges.delete(id);
    }
  };

  const showBadge = (entry: Visible, number: number, left: number, top: number) => {
    let badge = badges.get(entry.annotation.id);
    if (!badge) {
      // A well-known element: `createElement("button")` returns a button.
      const element = web.document.createElement("button") as DomButton;
      element.setAttribute("class", "badge");
      const created = { element, entry };
      element.addEventListener("click", () => openCard(created.entry));
      element.addEventListener("mouseenter", () => {
        hovered = created.entry.annotation.id;
        schedule();
      });
      element.addEventListener("mouseleave", () => {
        hovered = null;
        schedule();
      });
      root.appendChild(element);
      badges.set(entry.annotation.id, created);
      badge = created;
    }
    badge.entry = entry;
    const label = `Annotation ${number}`;
    badge.element.textContent = String(number);
    badge.element.title = label;
    badge.element.setAttribute("aria-label", label);
    badge.element.style.setProperty("left", `${Math.round(left)}px`);
    badge.element.style.setProperty("top", `${Math.round(top)}px`);
  };

  const locate = (transcript: DomElement, annotation: Annotation, signature: string): DomRange | null => {
    const { anchor } = annotation;
    if (!anchor) return null;
    const cached = found.get(annotation.id);
    if (cached && isIntact(cached.range, annotation.anchorText)) return cached.range;
    if (misses.get(annotation.id) === signature) return null;
    const rows = Array.from(transcript.querySelectorAll(MESSAGE_ROW)).filter(
      (row) => row.getAttribute(MESSAGE_ID_ATTRIBUTE) === anchor.messageId,
    );
    // A prompt sent from this client gets a different row id after a reload,
    // so a passage in the user's own message is also looked for in every user
    // message, oldest first.
    const range =
      (rows.length > 0 ? findPassage(rows, annotation.anchorText) : null) ??
      (anchor.role === "user"
        ? findPassage(Array.from(transcript.querySelectorAll(USER_MESSAGE)), annotation.anchorText)
        : null);
    if (range) {
      found.set(annotation.id, { range, signature });
      misses.delete(annotation.id);
    } else {
      found.delete(annotation.id);
      misses.set(annotation.id, signature);
    }
    return range;
  };

  const schedule = () => {
    if (frame === 0) frame = web.window.requestAnimationFrame(refresh);
  };

  /** Opens the card below the passage; it follows the passage as the chat moves. */
  const openCard = ({ annotation, range, reference }: Visible) => {
    open(
      annotation,
      () => {
        const current = found.get(annotation.id)?.range ?? range;
        if (!current.startContainer.isConnected) return null;
        const rects = current.getClientRects();
        return rects.length > 0 ? rects[rects.length - 1]! : null;
      },
      reference,
    );
    opened = annotation.id;
    schedule();
  };

  // Clicking highlighted text opens its annotation, unless the click ends a
  // text selection or lands on a link or button.
  const onClick: DomListener = (raw) => {
    const event = raw as DomMouseEvent;
    if (web.window.getSelection()?.isCollapsed === false) return;
    const target = elementOf(event.target);
    if (!target || target.closest("a, button")) return;
    for (const entry of visible) {
      if (!entry.reference.contains(target)) continue;
      const hit = Array.from(entry.range.getClientRects()).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom,
      );
      if (hit) return openCard(entry);
    }
  };
  web.document.addEventListener("click", onClick);

  const observer = new web.MutationObserver(schedule);
  observer.observe(web.document.body, { childList: true, subtree: true, characterData: true });
  const unsubscribe = store.subscribe(schedule);
  web.window.addEventListener("scroll", schedule, true);
  web.window.addEventListener("resize", schedule);
  schedule();

  return {
    reveal(annotation, options) {
      const transcript = visibleTranscripts().find((element) => agentIdAround(element) === annotation.agentId);
      const range = transcript ? locate(transcript, annotation, rowSignature(transcript)) : null;
      const start = range ? elementOf(range.startContainer) : null;
      if (!transcript || !range || !start) return false;
      if (options?.edit) {
        // An instant scroll, so the card opens where the passage ends up.
        start.scrollIntoView({ block: "center", behavior: "auto" });
        web.window.requestAnimationFrame(() => openCard({ annotation, range, reference: transcript }));
        return true;
      }
      start.scrollIntoView({ block: "center", behavior: "smooth" });
      revealed = annotation.id;
      schedule();
      web.window.clearTimeout(revealTimer);
      revealTimer = web.window.setTimeout(() => {
        revealed = null;
        schedule();
      }, REVEAL_MS);
      return true;
    },
    release(annotationId) {
      if (opened !== annotationId) return;
      opened = null;
      schedule();
    },
    dispose() {
      web.window.clearTimeout(revealTimer);
      observer.disconnect();
      unsubscribe();
      web.window.removeEventListener("scroll", schedule, true);
      web.window.removeEventListener("resize", schedule);
      web.document.removeEventListener("click", onClick);
      web.window.cancelAnimationFrame(frame);
      for (const name of Object.keys(highlights ?? {})) web.CSS?.highlights?.delete(`paseo-annotation-${name}`);
      host.remove();
    },
  };
}

type HighlightName = Annotation["status"] | "focus";

function createHighlights(): Record<HighlightName, DomHighlight> | null {
  const { Highlight, CSS } = web;
  const registry = CSS?.highlights;
  if (!Highlight || !registry) return null;
  const highlights: Record<HighlightName, DomHighlight> = {
    pending: new Highlight(),
    sent: new Highlight(),
    focus: new Highlight(),
  };
  for (const [name, highlight] of Object.entries(highlights)) {
    registry.set(`paseo-annotation-${name}`, highlight);
  }
  return highlights;
}

/** The rendered rows, so a passage that was not found is searched again only when they change. */
function rowSignature(transcript: DomElement): string {
  const rows = transcript.querySelectorAll("[data-history-row-id]");
  if (rows.length === 0) return "0";
  const first = rows[0]!.getAttribute("data-history-row-id");
  const last = rows[rows.length - 1]!.getAttribute("data-history-row-id");
  return `${rows.length}:${first}:${last}`;
}

function isIntact(range: DomRange, anchorText: string): boolean {
  return (
    range.startContainer.isConnected &&
    range.endContainer.isConnected &&
    range.toString().replace(/\s+/g, "") === anchorText.replace(/\s+/g, "")
  );
}
