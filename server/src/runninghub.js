import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
export const runningHubSchema = z.object({
  promptNode: z.string().regex(/^\d+(?::\d+)*$/), promptField: z.string().min(1),
  imageNode: z.string().regex(/^\d+(?::\d+)*$/), imageField: z.string().min(1),
  outputNode: z.string().regex(/^\d+(?::\d+)*$/),
});

export function runningHubResultUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(["rh-images.xiaoyaoyou.com", "rh-images-tos.xiaoyaoyou.com"].includes(url.hostname) || url.hostname.endsWith(".tos-cn-beijing.volces.com"))) {
    fail(502, "RunningHub 返回了未支持的图片下载域名，请联系管理员");
  }
  return url;
}

export async function generateRunningHub(config, form, signal, onSubmitted, fetcher = fetch, resumeTaskId) {
  const images = [...form.getAll("image"), ...form.getAll("image[]")];
  if (images.length !== 1 || !(images[0] instanceof Blob) || !images[0].type.startsWith("image/")) fail(400, "草稿细化需要且仅支持 1 张参考图片");
  if (Number(form.get("n") || 1) !== 1) fail(400, "草稿细化每次生成 1 张图片，请将生成数量设为 1");
  const prompt = form.get("prompt");
  if (typeof prompt !== "string" || !prompt.trim()) fail(400, "请输入草稿细化提示词");
  if (!config.apiKey) fail(400, "请管理员配置 RunningHub API Key 后启用模型");
  const call = async (path, body) => {
    const multipart = body instanceof FormData;
    const response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}/task/openapi/${path}`, {
      method: "POST", signal, redirect: "error",
      headers: multipart ? {} : { "Content-Type": "application/json" },
      body: multipart ? body : JSON.stringify({ ...body, apiKey: config.apiKey }),
    });
    if (!response.ok) { await response.body?.cancel(); fail(502, `RunningHub 请求失败（HTTP ${response.status}）`); }
    return response.json();
  };
  const check = (result) => {
    if (result.code !== 0) {
      const messages = { 433: "API Key 无效", 435: "余额不足", 803: "任务队列已满", 805: "任务执行失败" };
      fail(502, `RunningHub：${messages[result.code] || "接口返回错误"}（${Number(result.code)}），请查看平台任务记录，不会自动重提`);
    }
    return result.data;
  };
  const mapping = config.runninghub;
  let taskId = resumeTaskId;
  if (!taskId) {
    const upload = new FormData();
    upload.set("apiKey", config.apiKey); upload.set("fileType", "input"); upload.set("file", images[0], "draft.png");
    const uploaded = check(await call("upload", upload));
    if (!uploaded?.fileName) fail(502, "RunningHub 未返回上传文件名");
    const task = check(await call("create", { workflowId: config.model, nodeInfoList: [
      { nodeId: mapping.promptNode, fieldName: mapping.promptField, fieldValue: prompt },
      { nodeId: mapping.imageNode, fieldName: mapping.imageField, fieldValue: uploaded.fileName },
    ] }));
    if (!task?.taskId) fail(502, "RunningHub 未返回任务 ID，请先检查平台任务记录");
    taskId = String(task.taskId);
    onSubmitted(taskId);
  }
  while (true) {
    const result = await call("outputs", { taskId });
    if ([804, 813].includes(result.code)) { await delay(1000, undefined, { signal }); continue; }
    const outputs = check(result);
    const output = Array.isArray(outputs) && outputs.find((item) => String(item.nodeId) === mapping.outputNode);
    if (!output?.fileUrl) fail(502, "RunningHub 已完成，但指定输出节点没有返回图片，请检查输出节点 ID");
    const response = await fetcher(runningHubResultUrl(output.fileUrl), { signal, redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
      await response.body?.cancel(); fail(502, "RunningHub 结果下载失败，请在平台任务记录中查看图片");
    }
    return { data: [{ b64_json: Buffer.from(await response.arrayBuffer()).toString("base64") }] };
  }
}
