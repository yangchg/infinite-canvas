import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const schema = z.object({
  name: z.string().trim().min(1), model: z.string().trim().min(1),
  capability: z.enum(["image", "text", "video", "audio"]), apiFormat: z.enum(["openai", "gemini"]),
  baseUrl: z.url().refine((value) => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
  apiKey: z.string().trim().optional(), enabled: z.boolean(),
});
const publicModel = ({ id, name, model, capability, apiFormat }) => ({ id, name, model, capability, apiFormat });

export async function registerModels(app) {
  const db = app.db;
  db.exec(`CREATE TABLE IF NOT EXISTS shared_models (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_jobs (modelId TEXT NOT NULL, jobId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY(modelId,jobId,userId));
    CREATE TABLE IF NOT EXISTS model_downloads (id TEXT PRIMARY KEY, modelId TEXT NOT NULL, userId TEXT NOT NULL, url TEXT NOT NULL);`);
  const list = () => db.prepare("SELECT * FROM shared_models").all().map((row) => ({ ...JSON.parse(row.config), id: row.id }));
  const requireAdmin = (request) => { if (!request.user.admin) fail(403, "仅管理员可管理服务器模型"); };
  app.get("/api/models", async () => list().filter((row) => row.enabled).map(publicModel));
  app.get("/api/admin/models", async (request) => {
    requireAdmin(request);
    return list().map(({ apiKey, ...row }) => ({ ...row, hasKey: Boolean(apiKey) }));
  });
  app.put("/api/admin/models/:id", async (request) => {
    requireAdmin(request);
    const values = schema.parse(request.body);
    const old = list().find((row) => row.id === request.params.id);
    const apiKey = values.apiKey || old?.apiKey;
    if (!apiKey) fail(400, "请填写 API Key");
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
