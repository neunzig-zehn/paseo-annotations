/*
 * Pending annotations join the next message sent from the agent's composer.
 *
 * Paseo has no hook before a message is sent, so this listens in the capture
 * phase, ahead of the composer: on Enter, or a press of the send button, the
 * annotations are appended to the message box through the browser's editing
 * path. The composer then reads its live text and sends it. One task later the
 * outcome is visible: an emptied composer means the message went out; text
 * still in place means the key did something else (a newline on a narrow
 * layout, an autocomplete pick, a busy composer) and the block is taken out.
 */

import type { Annotation } from "../../shared/annotations";
import { formatAnnotations, paragraphAfter } from "../format";
import { logError } from "../log";
import type { AnnotationStore } from "../store";
import {
  COMPOSER,
  COMPOSER_ROOT,
  agentIdAround,
  deleteFromComposer,
  elementOf,
  insertIntoComposer,
  web,
  type DomButton,
  type DomKeyboardEvent,
  type DomListener,
  type DomTextArea,
} from "./dom";

export function installSendHook(store: AnnotationStore): () => void {
  const attach = (input: DomTextArea) => {
    if (input.readOnly || input.disabled) return;
    // Slash commands run in the app and never reach the agent.
    if (input.value.trimStart().startsWith("/")) return;
    const agentId = agentIdAround(input);
    if (!agentId) return;
    const annotations = store.pending(agentId);
    if (annotations.length === 0) return;
    const block = paragraphAfter(input.value, formatAnnotations(annotations));
    if (!insertIntoComposer(input, input.value.length, block)) return;
    web.window.setTimeout(() => settle(input, agentId, annotations, block), 0);
  };

  const settle = (input: DomTextArea, agentId: string, annotations: Annotation[], block: string) => {
    const at = input.value.lastIndexOf(block);
    if (at >= 0) {
      deleteFromComposer(input, at, at + block.length);
      return;
    }
    const ids = annotations.map((annotation) => annotation.id);
    store.markSent(agentId, ids).catch((error: unknown) => logError("Could not mark annotations sent", error));
  };

  const onKeyDown: DomListener = (raw) => {
    const event = raw as DomKeyboardEvent;
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return;
    const target = elementOf(event.target);
    // A well-known element: the selector matches only the composer's textarea.
    if (target?.matches(COMPOSER)) attach(target as DomTextArea);
  };

  /** The send button is the composer's last button, shown only while it holds text. */
  const onClick: DomListener = (event) => {
    const pressed = elementOf(event.target)?.closest("button") as DomButton | null;
    const root = pressed?.closest(COMPOSER_ROOT);
    if (!pressed || !root || pressed.disabled) return;
    const buttons = root.querySelectorAll("button");
    if (buttons[buttons.length - 1] !== pressed) return;
    const input = root.querySelector(COMPOSER) as DomTextArea | null;
    if (input?.value.trim()) attach(input);
  };

  web.document.addEventListener("keydown", onKeyDown, true);
  web.document.addEventListener("click", onClick, true);
  return () => {
    web.document.removeEventListener("keydown", onKeyDown, true);
    web.document.removeEventListener("click", onClick, true);
  };
}
