import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
export { runningHubSchema } from './runninghub-inputs.js';
import { runningHubSchema } from './runninghub-inputs.js';

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
  const parsed = runningHubSchema.safeParse(config.runninghub);
  if (!parsed.success) fail(400, '请管理员重新读取工作流并保存动态输入映射');
  const mapping = parsed.data;
  if (Number(form.get("n") || 1) !== 1) fail(400, 'RunningHub 每次执行 1 次工作流，输出数量由工作流决定');
  let values;
  try { values = z.record(z.string(), z.union([z.string(), z.object({ imageIndex: z.number().int().nonnegative() })])).parse(JSON.parse(form.get('runninghubInputs') || '{}')); }
  catch { fail(400, '工作流输入格式错误'); }
  for (const key of Object.keys(values)) if (!mapping.inputs.some((input) => input.id === key)) fail(400, '工作流输入映射已变化，请刷新模型');
  for (const input of mapping.inputs) {
    const value = values[input.id] ?? input.defaultValue;
    if (input.required && (value === undefined || (typeof value === 'string' && !value.trim()))) fail(400, `请填写或绑定「${input.label}」`);
    if (value === undefined) continue;
    if (input.type === 'text' ? typeof value !== 'string' : typeof value !== 'object' || !(images[value.imageIndex] instanceof Blob) || !images[value.imageIndex].type.startsWith('image/')) fail(400, `「${input.label}」输入类型不正确`);
    values[input.id] = value;
  }
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
  let taskId = resumeTaskId;
  if (!taskId) {
    const uploadedImages = new Map(), nodeInfoList = [];
    for (const input of mapping.inputs) {
      let value = values[input.id];
      if (value === undefined) continue;
      if (input.type === 'image') {
        const index = value.imageIndex;
        if (!uploadedImages.has(index)) {
          const upload = new FormData();
          upload.set('apiKey', config.apiKey); upload.set('fileType', 'input'); upload.set('file', images[index], `input-${index}.png`);
          const uploaded = check(await call('upload', upload));
          if (!uploaded?.fileName) fail(502, 'RunningHub 未返回上传文件名');
          uploadedImages.set(index, uploaded.fileName);
        }
        value = uploadedImages.get(index);
      }
      nodeInfoList.push({ nodeId: input.nodeId, fieldName: input.field, fieldValue: value });
    }
    const task = check(await call('create', { workflowId: config.model, nodeInfoList }));
    if (!task?.taskId) fail(502, "RunningHub 未返回任务 ID，请先检查平台任务记录");
    taskId = String(task.taskId);
    onSubmitted(taskId);
  }
  while (true) {
    const result = await call("outputs", { taskId });
    if ([804, 813].includes(result.code)) { await delay(1000, undefined, { signal }); continue; }
    const outputs = check(result);
    const selected = Array.isArray(outputs) ? mapping.outputNodes.flatMap((id) => outputs.filter((item) => String(item.nodeId) === id)) : [];
    if (!selected.length || mapping.outputNodes.some((id) => !selected.some((item) => String(item.nodeId) === id))) fail(502, '指定输出节点没有返回图片，请检查输出映射');
    const data = [];
    for (const output of selected) {
      if (!output.fileUrl) fail(502, 'RunningHub 输出缺少图片地址');
      const response = await fetcher(runningHubResultUrl(output.fileUrl), { signal, redirect: 'error' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        await response.body?.cancel(); fail(502, 'RunningHub 结果不是可下载的图片，请检查输出映射');
      }
      data.push({ b64_json: Buffer.from(await response.arrayBuffer()).toString('base64') });
    }
    return { data };
  }
}
