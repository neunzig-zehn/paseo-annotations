import type { PluginClientContext } from "@getpaseo/plugin/client";
import { logError } from "./log";

export interface AgentObserver {
  upsert(agent: { id: string; workspaceId: string }): void;
  remove(agentId: string): void;
}

/**
 * The agents on this installation's host. With the plugin installed on
 * several hosts, each installation acts only on chats whose agent it knows, so
 * one selection gets one toolbar and annotations reach the right daemon.
 */
export interface AgentDirectory {
  has(agentId: string): boolean;
  dispose(): void;
}

export function observeAgents(client: PluginClientContext, observer: AgentObserver): AgentDirectory {
  const known = new Set<string>();
  const lifetime = new AbortController();

  const upsert = (agent: { id: string; workspaceId?: string | null }) => {
    if (!agent.workspaceId) return;
    known.add(agent.id);
    observer.upsert({ id: agent.id, workspaceId: agent.workspaceId });
  };
  const remove = (agentId: string) => {
    known.delete(agentId);
    observer.remove(agentId);
  };

  // An owned list subscription delivers existing agents, then updates, and a
  // fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const live = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...known]) if (!live.has(agentId)) remove(agentId);
          for (const { agent } of entries) upsert(agent);
        },
        update: (message) => {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent);
          else remove(update.agentId);
        },
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) logError("Agent observation failed", error);
    });

  return {
    has: (agentId) => known.has(agentId),
    dispose() {
      lifetime.abort();
      known.clear();
    },
  };
}
