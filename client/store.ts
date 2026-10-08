import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  listAnnotations,
  removeAnnotations,
  saveAnnotations,
  type Annotation,
} from "../shared/annotations";
import { logError } from "./log";

type Rpc = PluginClientContext["rpc"];

const EMPTY: readonly Annotation[] = [];

export type NewAnnotation = Pick<
  Annotation,
  "agentId" | "quote" | "code" | "anchorText" | "anchor" | "comment"
>;

/**
 * The client's copy of the daemon's annotations, grouped by agent.
 *
 * Changes apply locally first, so the composer pill and the chat markers follow
 * at once, then persist on the daemon. A failed write reloads from the daemon
 * and rethrows for the caller to report.
 */
export class AnnotationStore {
  private byAgent = new Map<string, readonly Annotation[]>();
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  constructor(private readonly rpc: Rpc) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The agent's annotations, oldest first. The array is replaced on every change. */
  get(agentId: string): readonly Annotation[] {
    return this.byAgent.get(agentId) ?? EMPTY;
  }

  /** Annotations still waiting to go out with the agent's next message. */
  pending(agentId: string): Annotation[] {
    return this.get(agentId).filter((annotation) => annotation.status === "pending");
  }

  /** Reads every annotation from the daemon; concurrent calls share one request. */
  load(): Promise<void> {
    this.loading ??= this.rpc(listAnnotations, {})
      .then(({ annotations }) => {
        const byAgent = new Map<string, Annotation[]>();
        for (const annotation of annotations) {
          const list = byAgent.get(annotation.agentId);
          if (list) list.push(annotation);
          else byAgent.set(annotation.agentId, [annotation]);
        }
        this.byAgent = byAgent;
        this.notify();
      })
      .catch((error: unknown) => logError("Could not load annotations", error))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async add(input: NewAnnotation): Promise<Annotation> {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      ...input,
      id: randomId(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.set(input.agentId, [...this.get(input.agentId), annotation]);
    await this.persist(() => this.rpc(saveAnnotations, { annotations: [annotation] }));
    return annotation;
  }

  async setComment(annotation: Annotation, comment: string): Promise<void> {
    if (annotation.comment === comment) return;
    await this.replace(annotation.agentId, [annotation.id], (current) => ({ ...current, comment }));
  }

  async markSent(agentId: string, ids: readonly string[]): Promise<void> {
    await this.replace(agentId, ids, (current) => ({ ...current, status: "sent" }));
  }

  async remove(agentId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    this.set(
      agentId,
      this.get(agentId).filter((annotation) => !drop.has(annotation.id)),
    );
    await this.persist(() => this.rpc(removeAnnotations, { ids: [...ids] }));
  }

  private async replace(
    agentId: string,
    ids: readonly string[],
    change: (annotation: Annotation) => Annotation,
  ): Promise<void> {
    const targets = new Set(ids);
    const updatedAt = new Date().toISOString();
    const changed: Annotation[] = [];
    const next = this.get(agentId).map((annotation) => {
      if (!targets.has(annotation.id)) return annotation;
      const updated = { ...change(annotation), updatedAt };
      changed.push(updated);
      return updated;
    });
    if (changed.length === 0) return;
    this.set(agentId, next);
    await this.persist(() => this.rpc(saveAnnotations, { annotations: changed }));
  }

  private async persist(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      void this.load();
      throw error;
    }
  }

  private set(agentId: string, annotations: readonly Annotation[]): void {
    const next = new Map(this.byAgent);
    next.set(agentId, annotations);
    this.byAgent = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

// Annotations are only created from a chat selection, on the web, where `crypto` exists.
declare const crypto: { getRandomValues(array: Uint8Array): Uint8Array };

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ann_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
