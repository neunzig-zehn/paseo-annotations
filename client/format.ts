/**
 * Text shaping for annotations. Pure functions, no DOM and no React Native.
 *
 * `normalize` and the conversation-context budget are adapted from
 * paseo-quote; see NOTICE.md.
 */

import type { Annotation } from "../shared/annotations";

/**
 * Every annotation as a block in the shape Paseo sends annotated browser
 * elements in (`<browser-element …> … feedback: …`), so the agent reads both
 * kinds of annotation the same way.
 */
export function formatAnnotations(annotations: readonly Annotation[]): string {
  return annotations
    .map(({ quote, code, anchor, comment }) => {
      const from = anchor && anchor.role !== "other" ? ` from="${anchor.role}"` : "";
      const parts = [`text: ${JSON.stringify(code ? normalize(quote) : normalize(quote).trim())}`];
      if (code) parts.push(`code: ${code.language ?? "true"}`);
      const feedback = comment.trim();
      if (feedback) parts.push(`feedback: ${feedback.replace(/\n/g, "\n  ")}`);
      return [`<chat-selection${from}>`, ...parts.map((part) => `  ${part}`), `</chat-selection>`].join("\n");
    })
    .join("\n\n");
}

/** Where `block` lands after `existing` text: always its own paragraph. */
export function paragraphAfter(existing: string, block: string): string {
  if (!existing.trim()) return block;
  if (existing.endsWith("\n\n")) return block;
  if (existing.endsWith("\n")) return `\n${block}`;
  return `\n\n${block}`;
}

/** Letters and digits only, lowercased: rendered text against its Markdown source. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function annotationLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

/**
 * One short line of the passage, for lists and titles. Selected list items
 * bring their rendered markers along on lines of their own; those go.
 */
export function excerpt(text: string, limit: number): string {
  const line = text
    .replace(/^\s*(?:[•◦▪‣·]|\d+[.)])\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

const CONTEXT_TURNS = 8;
const TURN_LIMIT = 6_000;
const CONTEXT_LIMIT = 30_000;

/**
 * Instructions for a new chat started from an annotation. Paseo cannot fork a
 * conversation, so the recent turns of the original chat travel here, together
 * with the turn the passage came from when it is older than those.
 */
export function buildNewChatSystemPrompt(turns: readonly ChatTurn[], anchorText: string): string {
  const needle = squash(anchorText).slice(0, 80);
  const sourceIndex =
    needle.length >= 8 ? turns.findLastIndex((turn) => squash(turn.text).includes(needle)) : -1;
  const recent = turns.slice(-CONTEXT_TURNS);
  const source = sourceIndex >= 0 ? turns[sourceIndex] : undefined;
  const picked = source && !recent.includes(source) ? [source, ...recent] : recent;

  let budget = CONTEXT_LIMIT;
  const rendered: string[] = [];
  for (const turn of [...picked].reverse()) {
    const text = clip(turn.text, TURN_LIMIT);
    if (text.length > budget) break;
    budget -= text.length;
    rendered.unshift(`<${turn.role}>\n${text}\n</${turn.role}>`);
  }

  return [
    "This chat was started from another conversation in the same workspace.",
    "The user annotated a passage from that conversation and asks about it here.",
    "The quoted passage and the user's question arrive in their first message.",
    "",
    "Recent turns of the original conversation, oldest first:",
    "<original_conversation>",
    rendered.join("\n\n"),
    "</original_conversation>",
  ].join("\n");
}

function normalize(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = Math.floor(limit * 0.6);
  return `${trimmed.slice(0, head)}\n[…]\n${trimmed.slice(-(limit - head))}`;
}
