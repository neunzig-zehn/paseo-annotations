import type { PluginClientContext } from "@getpaseo/plugin/client";
import { observeAgents } from "./client/agents";
import { createComposerPills } from "./client/pill";
import { AnnotationStore } from "./client/store";
import { installWebAnnotations } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const store = new AnnotationStore(client.rpc.bind(client));
  void store.load();
  const pills = createComposerPills(client, store);
  const agents = observeAgents(client, pills);
  const removeWeb = installWebAnnotations(client, store, agents);
  return () => {
    removeWeb();
    agents.dispose();
    pills.dispose();
  };
}
