import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
export const comfySchema = z.object({
  workflow: z.record(z.string(), z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) })),
  promptNode: z.string().min(1), sizeNode: z.string().min(1), outputNode: z.string().min(1),
}).superRefine((value, ctx) => {
  for (const [field, type] of [["promptNode", "CLIPTextEncode"], ["sizeNode", "EmptySD3LatentImage"], ["outputNode", "SaveImage"]]) {
    if (value.workflow[value[field]]?.class_type !== type) ctx.addIssue({ code: "custom", message: `${field} 必须指向 ${type} 节点`, path: [field] });
  }
});

// This adapter accepts the configured text-to-image workflow only, never a user's graph or URL.
export async function generateComfy(config, input, signal, onSubmitted = () => {}, resumeTaskId) {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) fail(400, "请输入提示词");
  const n = input.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 15) fail(400, "生成数量应为 1 至 15");
  const workflow = structuredClone(config.comfy.workflow);
  workflow[config.comfy.promptNode].inputs.text = input.prompt;
  const latent = workflow[config.comfy.sizeNode].inputs;
  latent.batch_size = n;
  if (input.size && input.size !== "auto") {
    const size = /^(\d+)x(\d+)$/.exec(input.size);
    if (!size || !Number.isSafeInteger(Number(size[1])) || !Number.isSafeInteger(Number(size[2])) || Number(size[1]) <= 0 || Number(size[2]) <= 0) fail(400, "ComfyUI 尺寸格式应为宽x高");
    latent.width = Number(size[1]); latent.height = Number(size[2]);
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  const call = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET", signal, redirect: "error",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); fail(502, `ComfyUI 返回 ${response.status}，请检查工作流、模型文件和节点配置`); }
    return response;
  };
  let id = resumeTaskId;
  if (!id) {
    const submitted = await (await call("/prompt", { prompt: workflow, client_id: randomUUID() })).json();
    if (!submitted.prompt_id || submitted.error) fail(502, "ComfyUI 未接受工作流，请检查节点及模型配置");
    id = submitted.prompt_id;
    onSubmitted(id);
  }
  while (true) {
    const history = await (await call(`/history/${encodeURIComponent(id)}`)).json();
    const result = history[id];
    if (result?.status?.status_str === "error") fail(502, "ComfyUI 执行失败，请查看 ComfyUI 任务记录");
    if (result?.status?.completed) {
      const images = result.outputs?.[config.comfy.outputNode]?.images;
      if (!images?.length) fail(502, "ComfyUI 已完成，但指定输出节点没有图片");
      const data = [];
      for (const image of images) {
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
        const response = await call(`/view?${query}`);
        data.push({ b64_json: Buffer.from(await response.arrayBuffer()).toString("base64") });
      }
      return { data };
    }
    await delay(1000, undefined, { signal });
  }
}
