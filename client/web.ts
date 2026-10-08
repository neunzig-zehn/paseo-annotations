import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import type { Annotation } from "../shared/annotations";
import { startNewChat, type SendBehavior } from "./actions";
import type { AgentDirectory } from "./agents";
import type { AnnotationStore } from "./store";
import {
  COMPOSER,
  agentIdAround,
  composerAround,
  currentServerId,
  isVisible,
  isWebDom,
  openAgentTab,
  readSendBehavior,
  web,
  type DomElement,
} from "./web/dom";
import { installMarkers, type Markers } from "./web/markers";
import { installPopover, type Passage } from "./web/popover";
import { installSendHook } from "./web/send-hook";
import { installPageStyle } from "./web/theme";

/** How long a newly opened chat may take to show its composer. */
const COMPOSER_WAIT_MS = 4000;

/** The installed chat markers, for the composer pill's "show in chat". */
let installedMarkers: Markers | null = null;

/**
 * The chat-side features: the selection toolbar, comment cards, chat markers,
 * and annotations joining sent messages. Web and desktop only; elsewhere the
 * composer pill is the whole plugin. Returns cleanup.
 */
export function installWebAnnotations(
  client: PluginClientContext,
  store: AnnotationStore,
  agents: AgentDirectory,
): () => void {
  if (Platform.OS !== "web" || !isWebDom()) return () => {};

  const toAnnotation = (passage: Passage, agentId: string, comment: string) => ({
    agentId,
    quote: passage.quote,
    code: passage.code,
    anchorText: passage.anchorText,
    anchor: agentId === passage.agentId ? passage.anchor : null,
    comment,
  });

  const removePageStyle = installPageStyle();
  let markers: Markers | null = null;
  const popover = installPopover({
    owns: (agentId) => agents.has(agentId),
    async add(passage, comment) {
      await store.add(toAnnotation(passage, passage.agentId, comment));
      // Back to the message box, unless a click outside the card put focus elsewhere.
      const active = web.document.activeElement;
      const fromCard =
        !active || active === web.document.body || active.getAttribute("data-paseo-annotations-field") !== null;
      if (fromCard) composerAround(passage.transcript)?.focus({ preventScroll: true });
    },
    async ask(passage, comment) {
      const serverId = currentServerId();
      if (!serverId) throw new Error("Could not tell which host this chat is on.");
      const chat = await startNewChat(client.paseo, {
        sourceAgentId: passage.agentId,
        anchorText: passage.anchorText,
        comment,
      });
      await store.add(toAnnotation(passage, chat.agentId, comment));
      openAgentTab({ serverId, workspaceId: chat.workspaceId, agentId: chat.agentId });
      focusComposerWhenShown(chat.agentId);
    },
    save: (annotation, comment) => store.setComment(annotation, comment),
    remove: (annotation) => store.remove(annotation.agentId, [annotation.id]),
    closed: (annotation) => markers?.release(annotation.id),
  });
  const installed = installMarkers(store, popover.showAnnotation);
  markers = installed;
  installedMarkers = installed;
  const removeSendHook = installSendHook(store);

  return () => {
    if (installedMarkers === installed) installedMarkers = null;
    removeSendHook();
    installed.dispose();
    popover.dispose();
    removePageStyle();
  };
}

/**
 * Shows an annotated passage in the chat and opens its card there; false when
 * the passage is not on screen or this client has no chat DOM.
 */
export function editAnnotationInChat(annotation: Annotation): boolean {
  return installedMarkers?.reveal(annotation, { edit: true }) ?? false;
}

/**
 * Hides the element that contains `node`. The composer pill reserves an icon
 * slot; Tasks and Subagents have none, so on the web the slot is removed.
 */
export function collapseParent(node: unknown): void {
  if (Platform.OS !== "web" || !isWebDom()) return;
  if (!node || typeof node !== "object" || !("parentElement" in node)) return;
  // On React Native Web a view's ref is its DOM element.
  const element = node as DomElement;
  element.parentElement?.style.setProperty("display", "none");
}

/** Settings → Sending → Default send where the app stores it; its default elsewhere. */
export function defaultSendBehavior(): SendBehavior {
  return Platform.OS === "web" && isWebDom() ? readSendBehavior() : "steer";
}

/** Focuses the agent's composer once its tab is showing, or gives up quietly. */
function focusComposerWhenShown(agentId: string): void {
  const deadline = Date.now() + COMPOSER_WAIT_MS;
  const attempt = () => {
    const input = Array.from(web.document.querySelectorAll(COMPOSER)).find(
      (element) => isVisible(element) && agentIdAround(element) === agentId,
    );
    if (input) input.focus({ preventScroll: true });
    else if (Date.now() < deadline) web.window.requestAnimationFrame(attempt);
  };
  web.window.requestAnimationFrame(attempt);
}
