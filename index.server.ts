import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AnnotationStore } from "./server/store";
import { listAnnotations, removeAnnotations, saveAnnotations } from "./shared/annotations";

export default function contribute(server: PluginServerContext) {
  const store = new AnnotationStore();
  server.handle(listAnnotations, async () => ({ annotations: await store.all() }));
  server.handle(saveAnnotations, async ({ annotations }) => {
    await store.save(annotations);
    return {};
  });
  server.handle(removeAnnotations, async ({ ids }) => {
    await store.remove(ids);
    return {};
  });
  return () => {};
}
