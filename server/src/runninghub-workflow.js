import { z } from "zod";

const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function runningHubWorkflowId(source) {
  const value = z.string().trim().min(1).parse(source);
  if (/^\d+$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { invalid("请输入 RunningHub 工作流链接或数字 ID"); }
  if (url.protocol !== "https:" || !["www.runninghub.cn", "runninghub.cn"].includes(url.hostname) || url.username || url.password || url.port) invalid("请使用 RunningHub 中国站工作流链接");
  const id = /^\/(?:workflow-detail|workflow)\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (!id) invalid("链接中没有工作流 ID，请复制工作流详情链接或直接填写 ID");
  return id;
}

export function runningHubWorkflowChoices(input) {
  let workflow = input;
  if (typeof workflow === "string") {
    try { workflow = JSON.parse(workflow); } catch { invalid("工作流 JSON 格式不正确"); }
  }
  const node = z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()), _meta: z.object({ title: z.string().optional() }).optional() });
  const parsed = z.record(z.string().regex(/^\d+(?::\d+)*$/), node).safeParse(workflow);
  if (!parsed.success || !Object.keys(parsed.data).length) invalid("请导入 API 格式工作流 JSON，不能使用编辑器格式");
  const prompts = [], advancedTexts = [], images = [], outputs = [];
  for (const [nodeId, item] of Object.entries(parsed.data)) {
    const label = `${item._meta?.title || item.class_type}（${nodeId}）`;
    for (const [field, value] of Object.entries(item.inputs)) {
      if (typeof value !== "string") continue;
      const choice = { nodeId, field, label: `${label} · ${field}` };
      if (field === "image" && /LoadImage/i.test(item.class_type)) images.push(choice);
      else if (["text", "text_g", "text_l", "prompt", "positive", "negative", "value", "string"].includes(field)) {
        // Field names alone also match expressions and cached display output.
        if (/math|expression|formula|show|display|preview/i.test(item.class_type)) continue;
        const explicitPrompt = ["prompt", "positive", "negative"].includes(field) ||
          (/CLIPTextEncode|TextEncode/i.test(item.class_type) && ["text", "text_g", "text_l"].includes(field));
        (explicitPrompt ? prompts : advancedTexts).push(choice);
      }
    }
    if (["SaveImage", "PreviewImage"].includes(item.class_type)) outputs.push({ nodeId, label });
  }
  return { prompts, advancedTexts, images, outputs };
}

export async function readRunningHubWorkflow(workflowId, apiKey, signal, fetcher = fetch) {
  if (!apiKey) invalid("请先在 RunningHub 设置中保存全局 API Key");
  let response, result;
  try {
    response = await fetcher("https://www.runninghub.cn/api/openapi/getJsonApiFormat", {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ apiKey, workflowId }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    result = await response.json();
  } catch { throw Object.assign(new Error("无法读取 RunningHub 工作流，请检查网络、Key 和工作流访问权限，也可导入 API JSON"), { statusCode: 502 }); }
  if (result.code !== 0 || !result.data?.prompt) throw Object.assign(new Error("RunningHub 未返回工作流，请检查 Key、工作流 ID 和访问权限"), { statusCode: 502 });
  const choices = runningHubWorkflowChoices(result.data.prompt);
  // Optional public-site metadata: never send the API key, or fail node reading if unavailable.
  try {
    const detail = await fetcher("https://www.runninghub.cn/api/portal/workflow/detail", {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId }),
    });
    if (!detail.ok) { await detail.body?.cancel(); return choices; }
    const metadata = await detail.json();
    if (metadata.code === 0 && typeof metadata.data?.name === "string" && metadata.data.name.trim()) {
      return { ...choices, name: metadata.data.name.trim() };
    }
  } catch { /* The public detail endpoint may be unavailable or require login. */ }
  return choices;
}
