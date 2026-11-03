import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, createReadStream } from "node:fs";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { database, transaction } from "./database.js";
import { digest, hashPassword, verifyPassword } from "./password.js";
import { contentSchema, cleanContent, fileKeys, publishContent } from "./content.js";

const name = z.string().trim().min(1);
const credentials = z.object({ username: name.regex(/^[a-zA-Z0-9_.-]+$/), password: z.string().min(1) });
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const now = () => new Date().toISOString();
const userView = (user) => ({ id: user.id, username: user.username, displayName: user.displayName, admin: Boolean(user.admin), disabled: Boolean(user.disabled) });

export async function createApp(options = {}) {
  const directory = resolve(options.directory || process.env.DATA_DIR || "data");
  const origin = options.origin || process.env.APP_ORIGIN || "http://localhost:3000";
  const origins = process.env.APP_ORIGINS?.split(",").map((value) => value.trim()) || [origin];
  const ttl = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
  const secure = origins.every((value) => value.startsWith("https:"));
  const cookieName = secure ? "__Host-canvas_session" : "canvas_session";
  const db = database(directory);
  const filesDir = join(directory, "files");
  mkdirSync(filesDir, { recursive: true });
  const app = Fastify({ bodyLimit: Number(process.env.MAX_CANVAS_BYTES || 20 * 1024 * 1024), trustProxy: process.env.TRUST_PROXY === "1" ? 1 : false });
  app.decorate("db", db);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const audit = (user, action, target) => run("INSERT INTO audit(actor,action,target,createdAt) VALUES(?,?,?,?)", user.id, action, target, now());
  const admin = (user) => { if (!user.admin) fail(403, "仅管理员可操作"); };
  const member = (user, id, write = false, includeDeleted = false) => {
    const project = get("SELECT * FROM projects WHERE id=?", id);
    if (!project || (project.deleted && !includeDeleted)) fail(404, "项目不存在");
    if (!user.admin && !get("SELECT 1 FROM members WHERE projectId=? AND userId=?", id, user.id)) fail(403, "无权访问项目");
    if (write && (project.archived || project.deleted)) fail(409, "项目已归档或删除，不能修改");
    return project;
  };
  const canvas = (user, id, { owner = false, write = false, deleted = false } = {}) => {
    const row = get("SELECT * FROM canvases WHERE id=?", id);
    if (!row || (row.deleted && !deleted)) fail(404, "画布不存在");
    member(user, row.projectId, write);
    if (owner && row.ownerId !== user.id) fail(403, "仅所有者可修改画布");
    return row;
  };
  const canvasNumber = (id) => `HB-${String(get("SELECT number FROM canvas_numbers WHERE canvasId=?", id).number).padStart(6, "0")}`;
  const serialize = (row) => ({ ...JSON.parse(row.content), id: row.id, number: canvasNumber(row.id), projectId: row.projectId, ownerId: row.ownerId,
    ownerName: get("SELECT displayName FROM users WHERE id=?", row.ownerId).displayName,
    title: row.title, revision: row.revision, publishedId: row.publishedId, deleted: Boolean(row.deleted),
    sourceId: row.sourceId, sourceVersion: row.sourceVersion, kind: row.kind, createdAt: row.createdAt, updatedAt: row.updatedAt });
  const canReadFile = (user, id) => {
    const file = get("SELECT * FROM files WHERE id=?", id);
    if (!file) return false;
    // Ownership of an upload alone never grants access to someone else's private canvas.
    if (file.ownerId === user.id && !get("SELECT 1 FROM file_refs WHERE fileId=?", id)) return true;
    return all(`SELECT c.*,r.versionId FROM file_refs r JOIN canvases c ON c.id=r.canvasId JOIN projects p ON p.id=c.projectId
      WHERE r.fileId=? AND p.deleted=0`, id).some((row) => {
      if (!user.admin && !get("SELECT 1 FROM members WHERE projectId=? AND userId=?", row.projectId, user.id)) return false;
      return (row.ownerId === user.id && row.versionId === "") || (!row.deleted && row.publishedId && row.publishedId === row.versionId);
    });
  };
  const refs = (user, id, content, version = "") => {
    const keys = fileKeys(content);
    for (const key of keys) if (!canReadFile(user, key)) fail(403, "附件不存在或无权使用，请重新上传");
    run("DELETE FROM file_refs WHERE canvasId=? AND versionId=?", id, version);
    for (const key of keys) run("INSERT INTO file_refs(fileId,canvasId,versionId) VALUES(?,?,?)", key, id, version);
  };
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ZodError ? 400 : error.statusCode || 500;
    if (status >= 500) request.log.error(error);
    reply.code(status).send({ message: error instanceof ZodError ? "请求格式不正确" : status >= 500 ? "服务端操作失败" : error.message });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    // Use the matched route rather than raw URL spelling for the authentication boundary.
    if (!(request.routeOptions.url || request.url).startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (write && !origins.includes(request.headers.origin)) fail(403, "请求来源不受信任");
    if (["/api/auth/login", "/api/auth/register"].includes(request.routeOptions.url)) return;
    const raw = request.cookies[cookieName];
    if (!raw) fail(401, "请先登录");
    const user = get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.userId WHERE s.token=? AND s.expires>? AND u.disabled=0`, digest(raw), Date.now());
    if (!user) fail(401, "登录已失效，请重新登录");
    if (write && request.headers["x-account-id"] && request.headers["x-account-id"] !== user.id) fail(409, "浏览器已切换账号，请重新登录原账号再保存");
    request.user = user;
    request.sessionToken = digest(raw);
    request.csrf = digest(`${raw}:csrf`);
    if (write && request.headers["x-csrf-token"] !== request.csrf) fail(403, "安全验证失败，请刷新页面");
  });
  app.addHook("preHandler", async (request) => {
    if (request.user && !get(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.userId WHERE s.token=? AND s.expires>? AND u.disabled=0`, request.sessionToken, Date.now())) fail(401, "登录已失效");
  });
  const startSession = (user, reply) => {
    const raw = randomBytes(32).toString("hex");
    run("DELETE FROM sessions WHERE expires<=?", Date.now());
    run("INSERT INTO sessions VALUES(?,?,?)", digest(raw), user.id, Date.now() + ttl);
    reply.setCookie(cookieName, raw, { path: "/", httpOnly: true, sameSite: "strict", secure, maxAge: ttl / 1000 });
    return { user: userView(user), csrf: digest(`${raw}:csrf`) };
  };
  const authRate = { config: { rateLimit: { max: Number(process.env.AUTH_ATTEMPTS_PER_MINUTE || 10), timeWindow: "1 minute", skipOnError: false } } };
  app.post("/api/auth/register", authRate, async (request, reply) => {
    const { username, password } = credentials.parse(request.body);
    const displayName = name.parse(request.body.displayName || username);
    const hashed = await hashPassword(password);
    if (get("SELECT 1 FROM users WHERE username=?", username)) fail(409, "用户名已存在");
    const id = randomUUID();
    run("INSERT INTO users(id,username,displayName,password) VALUES(?,?,?,?)", id, username, displayName, hashed);
    return startSession(get("SELECT * FROM users WHERE id=?", id), reply);
  });
  const failures = new Map();
  app.post("/api/auth/login", async (request, reply) => {
    const timestamp = Date.now();
    for (const [ip, value] of failures) if (value.until <= timestamp) failures.delete(ip);
    const failure = failures.get(request.ip) || { count: 0, until: timestamp + 60_000 };
    if (failure.count >= Number(process.env.AUTH_ATTEMPTS_PER_MINUTE || 10)) fail(429, "登录失败次数过多，请一分钟后再试");
    failure.count += 1;
    failures.set(request.ip, failure);
    const { username, password } = credentials.parse(request.body);
    const user = get("SELECT * FROM users WHERE username=?", username);
    if (!user || user.disabled || !(await verifyPassword(password, user.password))) fail(401, "账号或密码错误，或账号已禁用");
    // Account may have been disabled while deriving the password.
    const current = get("SELECT * FROM users WHERE id=?", user.id);
    if (current.disabled || current.password !== user.password) fail(401, "账号状态已变化，请重新登录");
    failures.delete(request.ip);
    return startSession(current, reply);
  });
  app.get("/api/auth/me", async (request) => ({ user: userView(request.user), csrf: request.csrf }));
  app.post("/api/auth/logout", async (request, reply) => {
    run("DELETE FROM sessions WHERE token=?", request.sessionToken);
    reply.clearCookie(cookieName, { path: "/", secure });
    return { ok: true };
  });
  app.post("/api/auth/password", async (request) => {
    const body = z.object({ currentPassword: z.string(), password: z.string().min(1) }).parse(request.body);
    if (!(await verifyPassword(body.currentPassword, request.user.password))) fail(403, "当前密码不正确");
    const password = await hashPassword(body.password);
    transaction(db, () => {
      if (get("SELECT password FROM users WHERE id=?", request.user.id).password !== request.user.password) fail(409, "密码已变化");
      run("UPDATE users SET password=? WHERE id=?", password, request.user.id);
      run("DELETE FROM sessions WHERE userId=?", request.user.id);
    });
    return { ok: true };
  });
  app.get("/api/admin/users", async (request) => { admin(request.user); return all("SELECT * FROM users ORDER BY username").map(userView); });
  app.patch("/api/admin/users/:id", async (request) => {
    admin(request.user);
    const body = z.object({ admin: z.boolean().optional(), disabled: z.boolean().optional(), displayName: name.optional(), password: z.string().min(1).optional() }).parse(request.body);
    const password = body.password ? await hashPassword(body.password) : null;
    return transaction(db, () => {
      admin(get("SELECT * FROM users WHERE id=?", request.user.id));
      const target = get("SELECT * FROM users WHERE id=?", request.params.id);
      if (!target) fail(404, "用户不存在");
      if (target.admin && !target.disabled && (body.admin === false || body.disabled === true) && get("SELECT COUNT(*) AS count FROM users WHERE admin=1 AND disabled=0").count <= 1) fail(409, "必须保留至少一个可用管理员");
      run("UPDATE users SET admin=?,disabled=?,displayName=?,password=? WHERE id=?", Number(body.admin ?? Boolean(target.admin)), Number(body.disabled ?? Boolean(target.disabled)), body.displayName ?? target.displayName, password ?? target.password, target.id);
      if (password || body.disabled || body.admin !== undefined) run("DELETE FROM sessions WHERE userId=?", target.id);
      audit(request.user, "user.update", target.id);
      return userView(get("SELECT * FROM users WHERE id=?", target.id));
    });
  });
  app.get("/api/projects", async (request) => request.user.admin ? all("SELECT * FROM projects") : all("SELECT p.* FROM projects p JOIN members m ON m.projectId=p.id WHERE m.userId=? AND p.deleted=0", request.user.id));
  app.post("/api/projects", async (request) => {
    admin(request.user);
    const title = name.parse(request.body.title), id = randomUUID();
    transaction(db, () => { run("INSERT INTO projects(id,title) VALUES(?,?)", id, title); audit(request.user, "project.create", id); });
    return get("SELECT * FROM projects WHERE id=?", id);
  });
  app.patch("/api/projects/:id", async (request) => {
    admin(request.user);
    const body = z.object({ title: name.optional(), archived: z.boolean().optional(), deleted: z.boolean().optional() }).parse(request.body);
    const project = member(request.user, request.params.id, false, true);
    transaction(db, () => {
      run("UPDATE projects SET title=?,archived=?,deleted=? WHERE id=?", body.title ?? project.title, Number(body.archived ?? Boolean(project.archived)), Number(body.deleted ?? Boolean(project.deleted)), project.id);
      audit(request.user, "project.update", project.id);
    });
    return { ok: true };
  });
  app.get("/api/projects/:id/members", async (request) => { admin(request.user); member(request.user, request.params.id); return all("SELECT u.id,u.username,u.displayName FROM users u JOIN members m ON m.userId=u.id WHERE m.projectId=?", request.params.id); });
  app.put("/api/projects/:id/members", async (request) => {
    admin(request.user); member(request.user, request.params.id);
    const ids = z.array(z.string()).parse(request.body.userIds);
    transaction(db, () => {
      for (const id of ids) if (!get("SELECT 1 FROM users WHERE id=?", id)) fail(400, "成员不存在");
      run("DELETE FROM members WHERE projectId=?", request.params.id);
      for (const id of new Set(ids)) run("INSERT INTO members VALUES(?,?)", request.params.id, id);
      audit(request.user, "project.members", request.params.id);
    });
    return { ok: true };
  });
  app.get("/api/canvases", async (request) => all(`SELECT c.* FROM canvases c JOIN projects p ON p.id=c.projectId WHERE c.ownerId=? AND p.deleted=0
    AND (?=1 OR EXISTS(SELECT 1 FROM members m WHERE m.projectId=p.id AND m.userId=?)) ORDER BY c.updatedAt DESC`, request.user.id, request.user.admin, request.user.id).map(serialize));
  app.get("/api/projects/:id/public", async (request) => {
    member(request.user, request.params.id);
    return all(`SELECT c.id,c.projectId,c.ownerId,u.displayName AS ownerName,v.title,v.id AS publishedId,v.createdAt AS updatedAt
      FROM canvases c JOIN versions v ON v.id=c.publishedId JOIN users u ON u.id=c.ownerId WHERE c.projectId=? AND c.deleted=0`, request.params.id).map((row) => ({ ...row, number: canvasNumber(row.id) }));
  });
  app.get("/api/canvases/:id/public", async (request) => {
    const row = canvas(request.user, request.params.id);
    if (!row.publishedId) fail(404, "画布未发布");
    const version = get("SELECT * FROM versions WHERE id=?", row.publishedId);
    return { ...serialize({ ...row, content: version.content, title: version.title }), updatedAt: version.createdAt };
  });
  app.put("/api/canvases/:id", async (request) => {
    const body = z.object({ projectId: z.string(), title: name, revision: z.number().int().nonnegative(), content: contentSchema }).parse(request.body);
    const content = cleanContent(body.content), id = name.regex(/^[a-zA-Z0-9_-]+$/).parse(request.params.id);
    return transaction(db, () => {
      member(request.user, body.projectId, true);
      const existing = get("SELECT * FROM canvases WHERE id=?", id);
      if (existing) {
        canvas(request.user, id, { owner: true, write: true });
        if (existing.projectId !== body.projectId) fail(400, "不支持跨项目移动");
        if (existing.revision !== body.revision) fail(409, "服务器已有更新，当前草稿未覆盖服务器；请导出草稿后刷新比较");
        run("UPDATE canvases SET title=?,content=?,revision=revision+1,updatedAt=? WHERE id=?", body.title, JSON.stringify(content), now(), id);
      } else {
        if (body.revision !== 0) fail(409, "画布版本不存在");
        run("INSERT INTO canvases(id,projectId,ownerId,title,content,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)", id, body.projectId, request.user.id, body.title, JSON.stringify(content), now(), now());
      }
      refs(request.user, id, content);
      return { revision: get("SELECT revision FROM canvases WHERE id=?", id).revision, number: canvasNumber(id) };
    });
  });
  app.post("/api/canvases/:id/publish", async (request) => transaction(db, () => {
    const row = canvas(request.user, request.params.id, { owner: true, write: true });
    if (row.kind !== "canvas") fail(400, "使用记录不能发布，请先复制为自己的画布");
    if (row.revision !== request.body.revision) fail(409, "版本已变化，请刷新后发布");
    const content = publishContent(JSON.parse(row.content)), id = randomUUID();
    run("INSERT INTO versions VALUES(?,?,?,?,?)", id, row.id, row.title, JSON.stringify(content), now());
    refs(request.user, row.id, content, id);
    run("UPDATE canvases SET publishedId=? WHERE id=?", id, row.id);
    audit(request.user, "canvas.publish", row.id);
    return { publishedId: id };
  }));
  app.delete("/api/canvases/:id/publish", async (request) => {
    const row = canvas(request.user, request.params.id, { write: !request.user.admin });
    if (row.ownerId !== request.user.id) admin(request.user);
    transaction(db, () => { run("UPDATE canvases SET publishedId=NULL WHERE id=?", row.id); audit(request.user, "canvas.unpublish", row.id); });
    return { ok: true };
  });
  app.post("/api/canvases/:id/use", async (request) => transaction(db, () => {
    const row = canvas(request.user, request.params.id, { write: true });
    if (!row.publishedId) fail(404, "画布未发布");
    const version = get("SELECT * FROM versions WHERE id=?", row.publishedId);
    const kind = z.enum(["usage", "canvas"]).parse(request.body.kind);
    const id = randomUUID();
    run("INSERT INTO canvases(id,projectId,ownerId,title,content,sourceId,sourceVersion,kind,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)", id, row.projectId, request.user.id, version.title, version.content, row.id, version.id, kind, now(), now());
    refs(request.user, id, JSON.parse(version.content));
    return serialize(get("SELECT * FROM canvases WHERE id=?", id));
  }));
  app.patch("/api/canvases/:id/lifecycle", async (request) => transaction(db, () => {
    const row = canvas(request.user, request.params.id, { deleted: true, write: !request.user.admin });
    const body = z.object({ deleted: z.boolean().optional(), ownerId: z.string().optional() }).parse(request.body);
    if (body.ownerId) {
      admin(request.user);
      const target = get("SELECT * FROM users WHERE id=? AND disabled=0", body.ownerId);
      if (!target) fail(400, "新所有者不存在或已禁用");
      member(target, row.projectId);
      run("UPDATE canvases SET ownerId=?,revision=revision+1 WHERE id=?", target.id, row.id);
    } else if (row.ownerId !== request.user.id) admin(request.user);
    if (body.deleted !== undefined) run("UPDATE canvases SET deleted=?,publishedId=NULL,revision=revision+1 WHERE id=?", Number(body.deleted), row.id);
    audit(request.user, "canvas.lifecycle", row.id);
    return { ok: true };
  }));
  app.get("/api/admin/canvases", async (request) => {
    admin(request.user);
    return all("SELECT c.id,c.title,c.projectId,c.ownerId,c.deleted,c.publishedId,u.displayName AS ownerName FROM canvases c JOIN users u ON u.id=c.ownerId").map((row) => ({ ...row, number: canvasNumber(row.id) }));
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: Number(process.env.MAX_FILE_BYTES || 100 * 1024 * 1024) }, (request, body, done) => done(null, body));
  app.put("/api/files/:id", { bodyLimit: Number(process.env.MAX_FILE_BYTES || 100 * 1024 * 1024) }, async (request) => {
    const id = z.string().regex(/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/).parse(request.params.id);
    if (!Buffer.isBuffer(request.body)) fail(400, "请上传二进制文件");
    const existing = get("SELECT * FROM files WHERE id=?", id);
    if (existing) {
      if (!canReadFile(request.user, id)) fail(403, "附件标识已被占用");
      if (digest(await readFile(join(filesDir, digest(id)))) !== digest(request.body)) fail(409, "附件标识对应的内容不同，请重新导入为新附件");
      return { id }; // Immutable IDs preserve published snapshots.
    }
    const path = join(filesDir, digest(id));
    await writeFile(path, request.body, { flag: "wx" });
    try {
      if (!get("SELECT 1 FROM sessions s JOIN users u ON u.id=s.userId WHERE s.token=? AND s.expires>? AND u.disabled=0", request.sessionToken, Date.now())) fail(401, "登录已失效");
      run("INSERT INTO files VALUES(?,?,?,?)", id, request.user.id, String(request.headers["x-file-type"] || "application/octet-stream"), request.body.length);
    } catch (error) { await unlink(path); throw error; }
    return { id };
  });
  app.get("/api/files/:id", async (request, reply) => {
    if (!canReadFile(request.user, request.params.id)) fail(404, "附件不存在或无权访问");
    // Always download as bytes; client creates a blob URL after authorization.
    reply.type("application/octet-stream").header("Content-Disposition", "attachment");
    reply.header("X-File-Type", get("SELECT mime FROM files WHERE id=?", request.params.id).mime);
    return reply.send(createReadStream(join(filesDir, digest(request.params.id))));
  });
  const webRoot = options.webRoot || resolve("../web/dist");
  if (existsSync(webRoot)) {
    await app.register(serveStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ message: "接口不存在" }) : reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => db.close());
  return app;
}
