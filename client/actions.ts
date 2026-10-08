import type { PluginClientContext } from "@getpaseo/plugin/client";
import { buildNewChatSystemPrompt, excerpt, type ChatTurn } from "./format";
import { logError } from "./log";

type PaseoApi = PluginClientContext["paseo"];

/** Settings → Sending → Default send: what sending does while the agent runs. */
export type SendBehavior = "interrupt" | "steer" | "queue";

/** Long enough for any turn; the wait ends early when the agent needs attention. */
const QUEUE_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Sends `text` as an ordinary user message, the way the composer would with
 * the user's Default send setting. A queued message waits in this client until
 * the current turn ends, and is lost if the app reloads first.
 */
export async function sendMessage(
  paseo: PaseoApi,
  agentId: string,
  text: string,
  behavior: SendBehavior,
): Promise<"sent" | "queued"> {
  const agent = paseo.agents.ref(agentId);
  if (behavior === "queue") {
    const status = (await agent.refresh())?.agent.status;
    if (status === "running" || status === "initializing") {
      void agent
        .waitForFinish(QUEUE_WAIT_MS)
        .then(() => agent.send(text, { activeTurnBehavior: "interrupt" }))
        .catch((cause: unknown) => logError("Queued message was not sent", cause));
      return "queued";
    }
  }
  await agent.send(text, { activeTurnBehavior: behavior === "steer" ? "steer" : "interrupt" });
  return "sent";
}

export interface NewChat {
  agentId: string;
  workspaceId: string;
}

/**
 * Creates an idle agent beside `sourceAgentId`: same workspace, provider,
 * model, mode, and thinking level. It sends nothing; the recent conversation
 * travels as instructions so the annotation the user sends later has context.
 */
export async function startNewChat(
  paseo: PaseoApi,
  input: { sourceAgentId: string; anchorText: string; comment: string },
): Promise<NewChat> {
  const source = paseo.agents.ref(input.sourceAgentId);
  const [refetched, turns] = await Promise.all([
    source.refresh(),
    readTurns(paseo, input.sourceAgentId, 120),
  ]);
  const snapshot = refetched?.agent ?? source.current();
  if (!snapshot) throw new Error("The original chat is not available.");
  const workspaceId = snapshot.workspaceId;
  if (!workspaceId) throw new Error("The original chat has no workspace.");

  const model = snapshot.model ?? snapshot.runtimeInfo?.model ?? null;
  const created = await paseo.workspaces.ref(workspaceId).agents.create({
    config: {
      provider: model ? `${snapshot.provider}/${model}` : snapshot.provider,
      modeId: snapshot.currentModeId ?? undefined,
      thinkingOptionId: snapshot.thinkingOptionId ?? undefined,
      systemPrompt: buildNewChatSystemPrompt(turns, input.anchorText),
    },
    title: excerpt(input.comment || input.anchorText, 48),
  });
  return { agentId: created.id, workspaceId };
}

/**
 * The conversation as user and assistant turns. The projected timeline merges
 * streamed chunks; text split by tool calls is joined back into one turn.
 */
async function readTurns(paseo: PaseoApi, agentId: string, limit: number): Promise<ChatTurn[]> {
  const page = await paseo.agents
    .ref(agentId)
    .timeline.refetch({ direction: "tail", limit, projection: "projected" });
  const turns: ChatTurn[] = [];
  for (const { item } of page.entries) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const role = item.type === "user_message" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${item.text}`;
    else turns.push({ role, text: item.text });
  }
  return turns;
}
