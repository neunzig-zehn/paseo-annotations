import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const annotationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  /** The selection as Markdown when the host could serialize it, rendered text otherwise. */
  quote: z.string().min(1),
  /** Set when the whole selection sits in one code block, code span, or tool output. */
  code: z.object({ language: z.string().nullable() }).nullable(),
  /** The selection's rendered text; finds the passage again to place its marker. */
  anchorText: z.string(),
  /**
   * The transcript row the selection starts in. Null when the passage lives in
   * another chat, as with "Ask in new chat": the chat shows no marker for it.
   */
  anchor: z
    .object({
      messageId: z.string(),
      role: z.enum(["user", "assistant", "other"]),
    })
    .nullable(),
  comment: z.string(),
  /** Pending annotations wait in the composer; sent ones went out with a message. */
  status: z.enum(["pending", "sent"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Annotation = z.infer<typeof annotationSchema>;

/** Every annotation on this daemon, oldest first. */
export const listAnnotations = defineRpc({
  name: "annotations.list",
  input: z.object({}),
  output: z.object({ annotations: z.array(annotationSchema) }),
});

/** Inserts or replaces annotations by id. */
export const saveAnnotations = defineRpc({
  name: "annotations.save",
  input: z.object({ annotations: z.array(annotationSchema).min(1) }),
  output: z.object({}),
});

export const removeAnnotations = defineRpc({
  name: "annotations.remove",
  input: z.object({ ids: z.array(z.string().min(1)).min(1) }),
  output: z.object({}),
});
