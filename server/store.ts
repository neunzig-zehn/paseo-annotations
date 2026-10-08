import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { annotationSchema, type Annotation } from "../shared/annotations";

// Not `<home>/plugins/<id>`: Paseo keeps npm and Git installations there and
// deletes that directory when such a plugin is removed.
const stateDir = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "annotations");
const filePath = join(stateDir, "annotations.json");

const fileSchema = z.object({ version: z.literal(1), annotations: z.array(annotationSchema) });

/**
 * Annotations for every agent on this daemon, in one JSON file. Reads come from
 * memory after the first load; writes run one at a time and replace the file
 * atomically, so a crash leaves the previous version intact.
 */
export class AnnotationStore {
  private loaded: Promise<Map<string, Annotation>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async all(): Promise<Annotation[]> {
    const all = await this.load();
    return [...all.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  save(annotations: readonly Annotation[]): Promise<void> {
    return this.mutate((all) => {
      for (const annotation of annotations) all.set(annotation.id, annotation);
    });
  }

  remove(ids: readonly string[]): Promise<void> {
    return this.mutate((all) => {
      for (const id of ids) all.delete(id);
    });
  }

  private mutate(change: (all: Map<string, Annotation>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.load();
      change(all);
      await persist(all);
    });
    // A failed write must not wedge every later one.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private load(): Promise<Map<string, Annotation>> {
    this.loaded ??= readAll().catch((error: unknown) => {
      this.loaded = null;
      throw error;
    });
    return this.loaded;
  }
}

async function readAll(): Promise<Map<string, Annotation>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed = fileSchema.parse(JSON.parse(raw));
  return new Map(parsed.annotations.map((annotation) => [annotation.id, annotation]));
}

async function persist(all: Map<string, Annotation>): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const body: z.infer<typeof fileSchema> = { version: 1, annotations: [...all.values()] };
  await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}
