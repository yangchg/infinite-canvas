import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { comfySchema, generateComfy } from "./comfyui.js";
import { runningHubSchema, generateRunningHub } from "./runninghub.js";
import { transaction } from "./database.js";
import { runningHubWorkflowId, runningHubWorkflowChoices, readRunningHubWorkflow } from "./runninghub-workflow.js";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const schema = z.object({
  name: z.string().trim().min(1), model: z.string().trim().min(1),
  capability: z.enum(["image", "text", "video", "audio"]), apiFormat: z.enum(["openai", "gemini", "comfyui", "runninghub"]),
  runninghub: runningHubSchema.optional(),
  tags: z.array(z.string()).optional().transform(tags => [...new Set((tags || []).map(tag => tag.trim()).filter(Boolean))]),
  comfy: comfySchema.optional(),
  baseUrl: z.url().refine((value) => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
  apiKey: z.string().trim().optional(), enabled: z.boolean(),
});
const publicModel = ({ id, name, model, capability, apiFormat, runninghub, tags }) => ({ id, name, model, capability, apiFormat, ...(apiFormat === "runninghub" ? { runninghub, tags: tags || [] } : {}) });

export async function registerModels(app) {
  const db = app.db;
  db.exec(`CREATE TABLE IF NOT EXISTS shared_models (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_settings (provider TEXT PRIMARY KEY, apiKey TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_jobs (modelId TEXT NOT NULL, jobId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY(modelId,jobId,userId));
    CREATE TABLE IF NOT EXISTS model_downloads (id TEXT PRIMARY KEY, modelId TEXT NOT NULL, userId TEXT NOT NULL, url TEXT NOT NULL);`);
  const list = () => db.prepare("SELECT * FROM shared_models").all().map((row) => ({ ...JSON.parse(row.config), id: row.id }));
  const requireAdmin = (request) => { if (!request.user.admin) fail(403, "仅管理员可管理服务器模型"); };
  const runningHubKey = () => db.prepare("SELECT apiKey FROM provider_settings WHERE provider='runninghub'").get()?.apiKey;
  const saveRunningHubKey = (apiKey) => transaction(db, () => {
    db.prepare("INSERT INTO provider_settings(provider,apiKey) VALUES('runninghub',?) ON CONFLICT(provider) DO UPDATE SET apiKey=excluded.apiKey").run(apiKey);
    for (const { id, apiKey: oldKey, ...row } of list().filter((item) => item.apiFormat === "runninghub")) {
      db.prepare("UPDATE shared_models SET config=? WHERE id=?").run(JSON.stringify(row), id);
    }
  });
  const legacyKeys = [...new Set(list().filter((row) => row.apiFormat === "runninghub" && row.apiKey).map((row) => row.apiKey))];
  if (!runningHubKey() && legacyKeys.length === 1) saveRunningHubKey(legacyKeys[0]);
  app.get("/api/admin/runninghub/settings", async (request) => {
    requireAdmin(request);
    return { hasKey: Boolean(runningHubKey()), needsSetup: !runningHubKey() && legacyKeys.length > 1 };
  });
  app.put("/api/admin/runninghub/settings", async (request) => {
    requireAdmin(request);
    const { apiKey } = z.object({ apiKey: z.string().trim().min(1) }).parse(request.body);
    saveRunningHubKey(apiKey);
    return { hasKey: true };
  });
  app.post("/api/admin/runninghub/workflow", async (request) => {
    requireAdmin(request);
    const body = z.object({ source: z.string(), workflow: z.unknown().optional() }).parse(request.body);
    const workflowId = runningHubWorkflowId(body.source);
    const choices = body.workflow === undefined
      ? await readRunningHubWorkflow(workflowId, runningHubKey(), AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000)))
      : runningHubWorkflowChoices(body.workflow);
    return { workflowId, ...choices };
  });
  app.get("/api/models", async () => list().filter((row) => row.enabled).map(publicModel));
  app.get("/api/admin/models", async (request) => {
    requireAdmin(request);
    return list().map(({ apiKey, ...row }) => ({ ...row, hasKey: Boolean(row.apiFormat === "runninghub" ? runningHubKey() : apiKey) }));
  });
  app.put("/api/admin/models/:id", async (request) => {
    requireAdmin(request);
    const values = schema.parse(request.body);
    const old = list().find((row) => row.id === request.params.id);
    const apiKey = values.apiFormat === "runninghub" ? undefined : values.apiKey || old?.apiKey;
    if (values.apiFormat === "comfyui") {
      if (values.capability !== "image" || !values.comfy) fail(400, "ComfyUI 需配置图片工作流和输入输出节点");
    } else if (values.apiFormat === "runninghub") {
      values.model = runningHubWorkflowId(values.model);
      if (values.capability !== "image" || !values.runninghub || !/^\d+$/.test(values.model)) fail(400, "请配置 RunningHub 图片工作流 ID 和节点映射");
      if (values.baseUrl.replace(/\/+$/, "") !== "https://www.runninghub.cn") fail(400, "RunningHub 地址请填写 https://www.runninghub.cn");
      if (values.enabled && !runningHubKey()) fail(400, "启用 RunningHub 前请在设置中保存全局 API Key");
    } else if (!apiKey) fail(400, "请填写 API Key");
    if (values.apiFormat !== "runninghub") delete values.tags;
    const id = old?.id || randomUUID();
    db.prepare("INSERT INTO shared_models(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config").run(id, JSON.stringify({ ...values, apiKey }));
    return { id };
  });
  app.delete("/api/admin/models/:id", async (request) => {
    requireAdmin(request);
    db.prepare("DELETE FROM shared_models WHERE id=?").run(request.params.id);
    return { ok: true };
  });
  await app.register(async (gateway) => {
    gateway.removeAllContentTypeParsers();
    gateway.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    gateway.route({ method: ["POST", "GET"], url: "/api/model-gateway/:id/*", bodyLimit: Number(process.env.MODEL_MAX_BYTES || 100 * 1024 * 1024), handler: async (request, reply) => {
      const config = list().find((row) => row.id === request.params.id && row.enabled);
      if (!config) fail(404, "服务器模型已停用或删除，请重新选择");
      const path = request.params["*"];
      if (config.apiFormat === "runninghub") {
        config.apiKey = runningHubKey();
        if (request.method !== "POST" || !["v1/images/edits", "v1/images/generations"].includes(path)) fail(400, "不支持的工作流请求");
        let form;
        try { form = await new Response(request.body, { headers: { "Content-Type": request.headers["content-type"] || "" } }).formData(); }
        catch { fail(400, "请通过画布生成配置提交工作流输入"); }
        if (form.get("model") !== config.model) fail(400, "模型与配置不一致");
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000));
        const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
        let taskId;
        reply.raw.once("close", abort);
        try {
          return await generateRunningHub(config, form, AbortSignal.any([controller.signal, timeout]), (id) => {
            taskId = id;
            db.prepare("INSERT OR IGNORE INTO model_jobs(modelId,jobId,userId) VALUES(?,?,?)").run(config.id, id, request.user.id);
          });
        } catch (error) {
          if (error.statusCode) throw error;
          fail(timeout.aborted ? 504 : 502, `RunningHub ${timeout.aborted ? "等待超时" : "连接中断或返回异常"}；${taskId ? `任务 ${taskId}` : "任务可能已提交"}可能仍运行并计费，请先查看平台任务记录，避免重复提交`);
        } finally { reply.raw.removeListener("close", abort); }
      }
      if (config.apiFormat === "comfyui") {
        if (request.method !== "POST" || path !== "v1/images/generations") fail(400, "此 ComfyUI 工作流仅支持文生图，不支持参考图或其他生成类型");
        let input;
        try { input = JSON.parse(request.body.toString()); } catch { fail(400, "请求格式不正确"); }
        if (input?.model !== config.model) fail(400, "模型与配置不一致");
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000));
        const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
        reply.raw.once("close", abort);
        try { return await generateComfy(config, input, AbortSignal.any([controller.signal, timeout])); }
        catch (error) {
          if (timeout.aborted) fail(504, "ComfyUI 等待超时，任务可能仍在执行，请先查看 ComfyUI 记录，避免重复提交");
          if (error.statusCode) throw error;
          fail(502, "ComfyUI 连接中断或返回异常；任务可能已提交，请先查看 ComfyUI 记录");
        } finally { reply.raw.removeListener("close", abort); }
      }
      const gemini = config.apiFormat === "gemini";
      const version = gemini ? "v1beta" : "v1";
      const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/, "");
      let url = `${base}/${path}`;
      const headers = gemini ? { "x-goog-api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` };
      let body;
      let isJob = false;
      if (request.method === "POST") {
        const endpoints = { image: ["images/generations", "images/edits"], text: ["chat/completions", "responses"], audio: ["audio/speech"], video: ["videos"] };
        const action = config.capability === "video" ? "predictLongRunning" : "(?:generateContent|streamGenerateContent)";
        const allowed = gemini
          ? new RegExp(`^v1beta/models/([^/]+):(${action})$`).exec(path)
          : endpoints[config.capability].includes(path.replace(/^v1\//, "")) && path.startsWith("v1/");
        if (!allowed || (gemini && decodeURIComponent(allowed[1]) !== config.model.replace(/^models\//, ""))) fail(400, "该模型不支持此请求");
        const contentType = request.headers["content-type"] || "";
        if (contentType.startsWith("multipart/form-data") && !gemini) {
          const form = await new Response(request.body, { headers: { "Content-Type": contentType } }).formData();
          if (form.get("model") !== config.model) fail(400, "模型与配置不一致");
          form.set("model", config.model);
          body = form;
        } else {
          let data;
          try { data = JSON.parse(request.body.toString()); } catch { fail(400, "请求格式不正确"); }
          if (!gemini && data.model !== config.model) fail(400, "模型与配置不一致");
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(data);
        }
        if (gemini && path.endsWith(":streamGenerateContent")) url += "?alt=sse";
        isJob = config.capability === "video";
      } else if (path.startsWith("download/")) {
        const download = db.prepare("SELECT url FROM model_downloads WHERE id=? AND modelId=? AND userId=?").get(path.slice(9), config.id, request.user.id);
        if (!download) fail(404, "生成结果不存在或无权访问");
        url = download.url;
      } else {
        if (config.capability !== "video" || !path.startsWith(`${version}/`)) fail(400, "不支持的查询");
        const jobId = gemini ? path.slice(version.length + 1) : path.replace(/^v1\/videos\//, "").replace(/\/content$/, "");
        if (!db.prepare("SELECT 1 FROM model_jobs WHERE modelId=? AND jobId=? AND userId=?").get(config.id, jobId, request.user.id)) fail(403, "无权访问该生成任务");
        isJob = !path.endsWith("/content");
      }
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000));
      const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once("close", abort);
      let upstream;
      try { upstream = await fetch(url, { method: request.method, headers, body, signal: AbortSignal.any([controller.signal, timeout]), redirect: "error" }); }
      catch { fail(timeout.aborted ? 504 : 502, timeout.aborted ? "模型请求超时，请稍后重试" : "服务器无法连接模型服务，请联系管理员检查配置"); }
      if (!upstream.ok) { await upstream.body?.cancel(); return reply.code(upstream.status).send({ error: { message: `模型服务返回 ${upstream.status}，请检查配置或稍后重试` } }); }
      if (isJob) {
        const data = await upstream.json();
        const value = data.data || data;
        if (request.method === "POST") {
          const jobId = gemini ? value.name : value.id;
          if (jobId) db.prepare("INSERT OR IGNORE INTO model_jobs(modelId,jobId,userId) VALUES(?,?,?)").run(config.id, jobId, request.user.id);
        }
        // Gemini result downloads need the server credential too. Issue an owner-bound URL.
        const video = value.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
        if (gemini && video?.uri) {
          const target = new URL(video.uri);
          if (target.origin !== new URL(base).origin) fail(502, "模型返回了不受信任的下载地址");
          target.searchParams.delete("key");
          const id = randomUUID();
          db.prepare("INSERT INTO model_downloads(id,modelId,userId,url) VALUES(?,?,?,?)").run(id, config.id, request.user.id, target.href);
          video.uri = `/api/model-gateway/${config.id}/download/${id}`;
        }
        return data;
      }
      reply.header("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      return reply.send(Readable.fromWeb(upstream.body));
    } });
  });
}
