import { z } from "zod";

export const categorySchema = z.enum(["通用", "场景原画", "角色原画", "UI", "3D场景", "3D角色", "特效", "动作"]);

export const contentSchema = z.object({
  category: categorySchema.default("通用"),
  nodes: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), position: z.object({ x: z.number(), y: z.number() }), width: z.number(), height: z.number(), metadata: z.record(z.string(), z.unknown()).optional() })),
  connections: z.array(z.object({ id: z.string(), fromNodeId: z.string(), toNodeId: z.string() })),
  chatSessions: z.array(z.unknown()).default([]), activeChatId: z.string().nullable().default(null),
  backgroundMode: z.enum(["lines", "dots", "blank"]).default("lines"), showImageInfo: z.boolean().default(false),
  viewport: z.object({ x: z.number(), y: z.number(), k: z.number().positive() }).default({ x: 0, y: 0, k: 1 }),
});

export function fileKeys(value, result = new Set()) {
  if (value && typeof value === "object") {
    if (typeof value.storageKey === "string") result.add(value.storageKey);
    Object.values(value).forEach((child) => fileKeys(child, result));
  }
  return result;
}

// Blob URLs are browser-local. Resolve media using authenticated storage keys instead.
export function cleanContent(value) {
  if (typeof value === "string" && value.startsWith("blob:")) return "";
  if (Array.isArray(value)) return value.map(cleanContent);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cleanContent(child)]));
  return value;
}

export function publishContent(content) {
  const result = structuredClone(content);
  result.chatSessions = [];
  result.activeChatId = null;
  // Config credentials live outside the canvas. Reject embedded credential fields from plugins/imports.
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)$/i.test(key) && child) throw Object.assign(new Error("画布含凭据字段，请移除后再发布"), { statusCode: 400 });
      inspect(child);
    }
  };
  inspect(result);
  return result;
}
