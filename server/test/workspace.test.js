import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { createApp } from "../src/app.js";
import { database } from "../src/database.js";
import { createServer } from "node:http";
import { workspaceApi, setWorkspaceCsrf } from "../../web/src/services/api/workspace.ts";

const origin = "http://localhost:3000";
const blank = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };

test("RunningHub configuration requires admin and a key before enabling, keeps secrets private", async (t) => {
  const { send, admin, owner } = await fixture(t);
  const settings = { name: "RH", model: "2093181040868290562", capability: "image", apiFormat: "runninghub", baseUrl: "https://www.runninghub.cn", enabled: false,
    runninghub: {"inputs":[{"id":"prompt","nodeId":"5622","field":"value","label":"提示词","type":"text","required":true},{"id":"image","nodeId":"5650","field":"image","label":"图片","type":"image","required":true}],"outputNodes":["5712"]} };
  assert.equal((await send(owner, "PUT", "/admin/models/new", settings)).statusCode, 403);
  const saved = await send(admin, "PUT", "/admin/models/new", settings);
  assert.equal(saved.statusCode, 200, saved.body);
  const id = saved.json().id;
  assert.deepEqual((await send(owner, "GET", "/models")).json(), []);
  assert.equal((await send(admin, "PUT", `/admin/models/${id}`, { ...settings, enabled: true })).statusCode, 400);
  assert.equal((await send(admin, "PUT", "/admin/runninghub/settings", { apiKey: "rh-secret" })).statusCode, 200);
  assert.equal((await send(admin, "PUT", `/admin/models/${id}`, { ...settings, enabled: true })).statusCode, 200);
  assert.equal((await send(admin, "GET", "/admin/models")).body.includes("rh-secret"), false);
  assert.deepEqual((await send(owner, "GET", "/models")).json()[0].runninghub, settings.runninghub);
  const path = `/model-gateway/${id}/v1/images/edits`;
  assert.equal((await send(owner, "POST", path, {}, { "x-csrf-token": "wrong" })).statusCode, 403);
  assert.equal((await send(owner, "POST", path.replace("edits", "generations"), {})).statusCode, 400);
  const form = new FormData(); form.set("model", "wrong");
  const encoded = new Response(form);
  assert.equal((await send(owner, "POST", path, Buffer.from(await encoded.arrayBuffer()), { "content-type": encoded.headers.get("content-type") })).statusCode, 400);
});

test("ComfyUI gateway maps inputs, hides workflow and rejects unsupported requests", async (t) => {
  const { send, admin, owner } = await fixture(t);
  let submitted;
  let count = 0;
  const upstream = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/prompt") {
      count++;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      submitted = JSON.parse(Buffer.concat(chunks));
      res.end(JSON.stringify({ prompt_id: "task" }));
    } else if (req.url === "/history/task") {
      res.end(JSON.stringify({ task: { status: { completed: true }, outputs: { "9": { images: [{ filename: "result.png", type: "output" }] } } } }));
    } else if (req.url.startsWith("/view?")) { res.end("image-bytes"); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const settings = { name: "Comfy", model: "workflow-test", capability: "image", apiFormat: "comfyui", baseUrl: `http://127.0.0.1:${upstream.address().port}`, enabled: true,
    comfy: { promptNode: "67", sizeNode: "68", outputNode: "9", workflow: {
      "67": { class_type: "CLIPTextEncode", inputs: { text: "original" } },
      "68": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "9": { class_type: "SaveImage", inputs: {} },
    } } };
  assert.equal((await send(owner, "PUT", "/admin/models/new", settings)).statusCode, 403);
  const saved = await send(admin, "PUT", "/admin/models/new", settings);
  assert.equal(saved.statusCode, 200, saved.body);
  const id = saved.json().id;
  assert.equal((await send(owner, "GET", "/models")).body.includes('"workflow"'), false);
  const path = `/model-gateway/${id}/v1/images/generations`;
  assert.equal((await send(owner, "POST", path, { model: settings.model, prompt: "test" }, { "x-csrf-token": "wrong" })).statusCode, 403);
  assert.equal((await send(owner, "POST", path, { model: "wrong", prompt: "test" })).statusCode, 400);
  assert.equal((await send(owner, "POST", path.replace("generations", "edits"), {})).statusCode, 400);
  assert.equal(count, 0);
  const result = await send(owner, "POST", path, { model: settings.model, prompt: "new prompt", size: "768x1024", n: 2 });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(Buffer.from(result.json().data[0].b64_json, "base64").toString(), "image-bytes");
  assert.equal(submitted.prompt["67"].inputs.text, "new prompt");
  assert.deepEqual(submitted.prompt["68"].inputs, { width: 768, height: 1024, batch_size: 2 });
  assert.equal(count, 1);
  const persisted = (await send(admin, "GET", "/admin/models")).json().find((m) => m.id === id);
  assert.equal(persisted.comfy.workflow["67"].inputs.text, "original");
});

test("shared models protect credentials, proxy generation and isolate video tasks", async (t) => {
  const { send, admin, owner, member } = await fixture(t);
  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === "/v1/responses") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'); }
    else if (req.url === "/v1/videos") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "job-1", status: "queued" })); }
    else if (req.url === "/v1/videos/job-1/content") { res.setHeader("content-type", "video/mp4"); res.end("video-bytes"); }
    else if (req.url === "/v1/videos/job-1") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "job-1", status: "completed" })); }
    else if (req.url?.endsWith(":predictLongRunning")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name: "models/movie/operations/job-2" })); }
    else if (req.url === "/v1beta/models/movie/operations/job-2") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `http://127.0.0.1:${upstream.address().port}/media?key=secret-test` } }] } } })); }
    else if (req.url === "/media") { res.end("gemini-video"); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ b64_json: "image" }] })); }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const settings = { name: "Shared", model: "test-model", capability: "text", apiFormat: "openai", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "secret-test", enabled: true };
  assert.equal((await send(null, "GET", "/models")).statusCode, 401);
  assert.equal((await send(owner, "PUT", "/admin/models/new", settings)).statusCode, 403);
  const { id } = (await send(admin, "PUT", "/admin/models/new", settings)).json();
  const publicList = await send(owner, "GET", "/models");
  assert.equal(publicList.statusCode, 200);
  assert.equal(publicList.body.includes("secret-test"), false);
  assert.equal(publicList.body.includes("baseUrl"), false);
  assert.equal((await send(admin, "GET", "/admin/models")).body.includes("secret-test"), false);
  const path = `/model-gateway/${id}`;
  assert.equal((await send(owner, "POST", `${path}/v1/responses`, { model: "other" })).statusCode, 400);
  assert.equal((await send(owner, "POST", `${path}/v1/responses`, { model: "test-model" }, { "x-csrf-token": "wrong" })).statusCode, 403);
  assert.equal((await send(owner, "POST", `${path}/v1/unknown`, { model: "test-model" })).statusCode, 400);
  const stream = await send(owner, "POST", `${path}/v1/responses`, { model: "test-model", stream: true });
  assert.equal(stream.statusCode, 200, stream.body);
  assert.match(stream.body, /hello/);
  assert.equal(calls.at(-1).headers.authorization, "Bearer secret-test");
  assert.equal(calls.at(-1).headers.cookie, undefined);
  await send(admin, "PUT", `/admin/models/${id}`, { ...settings, capability: "image", apiKey: "" });
  const form = new FormData(); form.append("model", "test-model"); form.append("image", new Blob(["image-bytes"]), "ref.png");
  const encoded = new Response(form);
  const edited = await send(owner, "POST", `${path}/v1/images/edits`, Buffer.from(await encoded.arrayBuffer()), { "content-type": encoded.headers.get("content-type") });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.match(calls.at(-1).body, /image-bytes/);
  assert.equal(calls.at(-1).headers.authorization, "Bearer secret-test");
  await send(admin, "PUT", `/admin/models/${id}`, { ...settings, capability: "video" });
  assert.equal((await send(owner, "POST", `${path}/v1/videos`, { model: "test-model" })).statusCode, 200);
  assert.equal((await send(member, "GET", `${path}/v1/videos/job-1`)).statusCode, 403);
  assert.equal((await send(owner, "GET", `${path}/v1/videos/job-1`)).statusCode, 200);
  assert.equal((await send(owner, "GET", `${path}/v1/videos/job-1/content`)).body, "video-bytes");
  const gemini = (await send(admin, "PUT", "/admin/models/new", { ...settings, model: "movie", capability: "video", apiFormat: "gemini" })).json().id;
  const gp = `/model-gateway/${gemini}`;
  assert.equal((await send(owner, "POST", `${gp}/v1beta/models/movie:predictLongRunning`, {})).statusCode, 200);
  assert.equal(calls.at(-1).headers["x-goog-api-key"], "secret-test");
  const poll = await send(owner, "GET", `${gp}/v1beta/models/movie/operations/job-2`);
  assert.equal(poll.statusCode, 200, poll.body);
  assert.equal(poll.body.includes("secret-test"), false);
  const download = poll.json().response.generateVideoResponse.generatedSamples[0].video.uri.replace(/^\/api/, "");
  assert.equal((await send(member, "GET", download)).statusCode, 404);
  assert.equal((await send(owner, "GET", download)).body, "gemini-video");
  await send(admin, "PUT", `/admin/models/${id}`, { ...settings, enabled: false });
  assert.equal((await send(owner, "POST", `${path}/v1/responses`, { model: "test-model" })).statusCode, 404);
  assert.equal((await send(owner, "DELETE", `/admin/models/${id}`)).statusCode, 403);
  assert.equal((await send(admin, "DELETE", `/admin/models/${id}`)).statusCode, 200);
});

test("canvas numbers are unique, immutable and allocated to copies and existing canvases", async (t) => {
  const { app, directory, send, admin, owner, member, projectId, save } = await fixture(t);
  const first = (await save(owner, "number-one")).json();
  const second = (await save(member, "number-two")).json();
  assert.equal(first.number, "00001");
  assert.equal(second.number, "00002");
  assert.equal((await save(owner, "number-one", 1)).json().number, first.number);
  await send(owner, "POST", "/canvases/number-one/publish", { revision: 2 });
  assert.equal((await send(member, "GET", `/projects/${projectId}/public`)).json()[0].number, first.number);
  assert.equal((await send(member, "GET", "/canvases/number-one/public")).json().number, first.number);
  const copy = (await send(member, "POST", "/canvases/number-one/use", { kind: "canvas" })).json();
  const usage = (await send(member, "POST", "/canvases/number-one/use", { kind: "usage" })).json();
  assert.equal(new Set([first.number, second.number, copy.number, usage.number]).size, 4);
  await send(admin, "PATCH", "/canvases/number-one/lifecycle", { ownerId: member.id });
  await send(member, "PATCH", "/canvases/number-one/lifecycle", { deleted: true });
  await send(member, "PATCH", "/canvases/number-one/lifecycle", { deleted: false });
  assert.equal((await send(member, "GET", "/canvases")).json().find((row) => row.id === "number-one").number, first.number);
  // Simulate an existing canvas from before numbering was introduced.
  app.db.exec("DROP TRIGGER assign_canvas_number");
  app.db.prepare("INSERT INTO canvases(id,projectId,ownerId,title,content,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run("legacy", projectId, owner.id, "existing", JSON.stringify(blank), "old", "old");
  const reopened = database(directory);
  const number = reopened.prepare("SELECT number FROM canvas_numbers WHERE canvasId='legacy'").get().number;
  reopened.close();
  const again = database(directory);
  assert.equal(again.prepare("SELECT number FROM canvas_numbers WHERE canvasId='legacy'").get().number, number);
  assert.equal(again.prepare("SELECT number FROM canvas_numbers WHERE canvasId='number-one'").get().number, 1);
  again.close();
});

test("browser request helper logs out with no body and revokes the session", async (t) => {
  const { app, owner, send } = await fixture(t);
  const originalFetch = globalThis.fetch;
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => owner.id } });
  setWorkspaceCsrf(owner.csrf);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.has("Content-Type"), false, "empty requests must not advertise a JSON body");
    const response = await app.inject({ method: options.method, url, headers: { ...Object.fromEntries(options.headers), origin, cookie: owner.cookie } });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  try {
    assert.deepEqual(await workspaceApi("/auth/logout", { method: "POST" }), { ok: true });
    assert.equal((await send(owner, "GET", "/auth/me")).statusCode, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (sessionDescriptor) Object.defineProperty(globalThis, "sessionStorage", sessionDescriptor); else delete globalThis.sessionStorage;
  }
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "canvas-accounts-"));
  const app = await createApp({ directory, origin, webRoot: join(directory, "no-web") });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const send = async (user, method, url, payload, headers = {}) => app.inject({ method, url: `/api${url}`, headers: { origin, ...(user ? { cookie: user.cookie, "x-csrf-token": user.csrf } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  const account = async (username, admin = false) => {
    const response = await send(null, "POST", "/auth/register", { username, password: "test-password", admin: true });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().user.admin, false);
    const user = { ...response.json(), id: response.json().user.id, cookie: response.headers["set-cookie"].split(";")[0] };
    if (admin) app.db.prepare("UPDATE users SET admin=1 WHERE id=?").run(user.id);
    return user;
  };
  const admin = await account("administrator", true), owner = await account("owner"), member = await account("member"), stranger = await account("stranger");
  const projectResponse = await send(admin, "POST", "/projects", { title: "Design" });
  assert.equal(projectResponse.statusCode, 200, projectResponse.body);
  const projectId = projectResponse.json().id;
  assert.equal((await send(admin, "PUT", `/projects/${projectId}/members`, { userIds: [owner.id, member.id] })).statusCode, 200);
  const save = (user, id, revision = 0, content = blank) => send(user, "PUT", `/canvases/${id}`, { projectId, title: id, revision, content });
  return { app, directory, send, account, admin, owner, member, stranger, projectId, save };
}

test("account roles, project membership and owner-only drafts are enforced server-side", async (t) => {
  const { send, admin, owner, member, stranger, projectId, save } = await fixture(t);
  assert.equal((await send(null, "GET", "/projects")).statusCode, 401);
  assert.equal((await send(owner, "POST", "/auth/logout", undefined, { "x-account-id": member.id })).statusCode, 409);
  assert.equal((await send(owner, "POST", "/projects", { title: "unauthorized" })).statusCode, 403);
  assert.deepEqual((await send(stranger, "GET", "/projects")).json(), []);
  assert.equal((await save(owner, "private")).statusCode, 200);
  assert.equal((await save(member, "private", 1)).statusCode, 403);
  assert.equal((await save(admin, "private", 1)).statusCode, 403);
  assert.equal((await save(stranger, "intrusion")).statusCode, 403);
  assert.deepEqual((await send(admin, "GET", "/canvases")).json(), []);
  assert.deepEqual((await send(member, "GET", "/canvases")).json(), []);
  assert.equal((await send(member, "GET", "/canvases/private/public")).statusCode, 404);
  assert.equal((await send(owner, "PUT", "/canvases/private", { projectId, title: "bad", revision: 1, content: blank }, { "x-csrf-token": "bad" })).statusCode, 403);
  assert.equal((await send(owner, "POST", "/auth/logout", undefined, { origin: "https://attacker.invalid" })).statusCode, 403);
});

test("publishing snapshots, immutable attachments, private usage and optimistic conflicts", async (t) => {
  const { send, owner, member, stranger, projectId, save } = await fixture(t);
  const upload = await send(owner, "PUT", "/files/image:sample", Buffer.from("picture"), { "content-type": "application/octet-stream", "x-file-type": "image/png" });
  assert.equal(upload.statusCode, 200, upload.body);
  const content = { ...blank, chatSessions: [{ secret: "private chat" }], nodes: [{ id: "node", type: "image", title: "Version one", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "image:sample", content: "blob:browser-only" } }] };
  assert.equal((await save(owner, "original", 0, content)).statusCode, 200);
  assert.equal((await send(member, "GET", "/files/image:sample")).statusCode, 404);
  const published = await send(owner, "POST", "/canvases/original/publish", { revision: 1 });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal((await send(stranger, "GET", `/projects/${projectId}/public`)).statusCode, 403);
  assert.equal((await send(member, "GET", "/files/image:sample")).statusCode, 200);
  const snapshot = (await send(member, "GET", "/canvases/original/public")).json();
  assert.deepEqual(snapshot.chatSessions, []);
  assert.equal(snapshot.nodes[0].metadata.content, "");
  const usageResponse = await send(member, "POST", "/canvases/original/use", { kind: "usage" });
  assert.equal(usageResponse.statusCode, 200, usageResponse.body);
  const usage = usageResponse.json();
  assert.equal(usage.sourceVersion, published.json().publishedId);
  assert.equal((await save(member, usage.id, 1, blank)).statusCode, 200);
  assert.equal((await send(member, "POST", `/canvases/${usage.id}/publish`, { revision: 2 })).statusCode, 400);
  assert.equal((await save(owner, "original", 1, blank)).statusCode, 200);
  assert.equal((await save(owner, "original", 1, content)).statusCode, 409);
  assert.equal((await send(member, "GET", "/canvases/original/public")).json().nodes.length, 1);
  const copy = (await send(member, "POST", "/canvases/original/use", { kind: "canvas" })).json();
  assert.equal((await send(owner, "DELETE", "/canvases/original/publish")).statusCode, 200);
  assert.equal((await send(member, "GET", "/canvases/original/public")).statusCode, 404);
  assert.equal((await send(member, "GET", "/files/image:sample")).statusCode, 200, "independent copy retains resource access");
  assert.equal((await send(member, "PUT", "/files/image:sample", Buffer.from("changed"), { "content-type": "application/octet-stream" })).statusCode, 409);
  assert.equal((await send(member, "GET", "/canvases")).json().find((item) => item.id === copy.id).nodes.length, 1);
});

test("membership removal, project archive/trash, ownership transfer and account revocation", async (t) => {
  const { send, admin, owner, member, projectId, save } = await fixture(t);
  await save(owner, "lifecycle");
  await send(owner, "POST", "/canvases/lifecycle/publish", { revision: 1 });
  assert.equal((await send(admin, "PATCH", `/projects/${projectId}`, { archived: true })).statusCode, 200);
  assert.equal((await save(owner, "lifecycle", 1)).statusCode, 409);
  assert.equal((await send(owner, "DELETE", "/canvases/lifecycle/publish")).statusCode, 409);
  assert.equal((await send(admin, "DELETE", "/canvases/lifecycle/publish")).statusCode, 200);
  await send(admin, "PATCH", `/projects/${projectId}`, { archived: false });
  await send(admin, "PATCH", "/canvases/lifecycle/lifecycle", { ownerId: member.id });
  assert.equal((await save(owner, "lifecycle", 2)).statusCode, 403);
  assert.equal((await save(member, "lifecycle", 2)).statusCode, 200);
  await send(admin, "PUT", `/projects/${projectId}/members`, { userIds: [owner.id] });
  assert.equal((await save(member, "lifecycle", 3)).statusCode, 403);
  await send(admin, "PUT", `/projects/${projectId}/members`, { userIds: [owner.id, member.id] });
  await send(member, "PATCH", "/canvases/lifecycle/lifecycle", { deleted: true });
  assert.equal((await save(member, "lifecycle", 4)).statusCode, 404);
  await send(member, "PATCH", "/canvases/lifecycle/lifecycle", { deleted: false });
  await send(admin, "PATCH", `/projects/${projectId}`, { deleted: true });
  assert.deepEqual((await send(member, "GET", "/canvases")).json(), []);
  await send(admin, "PATCH", `/projects/${projectId}`, { deleted: false });
  assert.equal((await send(member, "GET", "/canvases")).json().length, 1);
  assert.equal((await send(admin, "PATCH", `/admin/users/${admin.id}`, { disabled: true })).statusCode, 409);
  await send(admin, "PATCH", `/admin/users/${member.id}`, { disabled: true });
  assert.equal((await send(member, "GET", "/auth/me")).statusCode, 401);
  await send(admin, "PATCH", `/admin/users/${owner.id}`, { password: "new-password" });
  assert.equal((await send(owner, "GET", "/auth/me")).statusCode, 401);
});

test("expired sessions and repeated failed logins are rejected", async (t) => {
  const { app, send, owner } = await fixture(t);
  app.db.prepare("UPDATE sessions SET expires=0 WHERE userId=?").run(owner.id);
  assert.equal((await send(owner, "GET", "/auth/me")).statusCode, 401);
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await send(null, "POST", "/auth/login", { username: "missing", password: "wrong" })).statusCode, 401);
  }
  assert.equal((await send(null, "POST", "/auth/login", { username: "owner", password: "test-password" })).statusCode, 429);
});

test("configured JSON and attachment size boundaries preserve existing data", async (t) => {
  const previousCanvas = process.env.MAX_CANVAS_BYTES, previousFile = process.env.MAX_FILE_BYTES;
  process.env.MAX_CANVAS_BYTES = "2048";
  process.env.MAX_FILE_BYTES = "16";
  let fixtureData;
  try { fixtureData = await fixture(t); }
  finally {
    if (previousCanvas === undefined) delete process.env.MAX_CANVAS_BYTES; else process.env.MAX_CANVAS_BYTES = previousCanvas;
    if (previousFile === undefined) delete process.env.MAX_FILE_BYTES; else process.env.MAX_FILE_BYTES = previousFile;
  }
  const { send, owner, save } = fixtureData;
  assert.equal((await save(owner, "limits")).statusCode, 200);
  assert.equal((await save(owner, "limits", 1, { ...blank, chatSessions: ["x".repeat(2048)] })).statusCode, 413);
  assert.equal((await send(owner, "GET", "/canvases")).json()[0].revision, 1);
  assert.equal((await send(owner, "PUT", "/files/file:small", Buffer.alloc(16), { "content-type": "application/octet-stream" })).statusCode, 200);
  assert.equal((await send(owner, "PUT", "/files/file:large", Buffer.alloc(17), { "content-type": "application/octet-stream" })).statusCode, 413);
});

test("credential fields are rejected on publication and database backup can be restored", async (t) => {
  const { app, directory, send, owner, member, save } = await fixture(t);
  const content = { ...blank, nodes: [{ id: "config", type: "custom", title: "private", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { apiKey: "private-key" } }] };
  await save(owner, "credentials", 0, content);
  assert.equal((await send(owner, "POST", "/canvases/credentials/publish", { revision: 1 })).statusCode, 400);
  await save(owner, "safe");
  await send(owner, "POST", "/canvases/safe/publish", { revision: 1 });
  const restored = join(directory, "restore");
  await mkdir(restored);
  await backup(app.db, join(restored, "canvas.sqlite"));
  await cp(join(directory, "files"), join(restored, "files"), { recursive: true });
  const second = await createApp({ directory: restored, origin, webRoot: join(directory, "no-web") });
  try {
    const response = await second.inject({ method: "GET", url: "/api/canvases/safe/public", headers: { cookie: member.cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().title, "safe");
  } finally { await second.close(); }
});

test("canvas categories follow published snapshots, defaults, copies and membership", async (t) => {
  const { app, send, owner, member, stranger, projectId, save } = await fixture(t);
  assert.equal((await save(owner, "legacy")).statusCode, 200);
  // Simulate an existing canvas saved before categories were introduced.
  app.db.prepare("UPDATE canvases SET content=? WHERE id=?").run(JSON.stringify(blank), "legacy");
  assert.equal((await send(owner, "GET", "/canvases")).json()[0].category, "通用");
  await send(owner, "POST", "/canvases/legacy/publish", { revision: 1 });
  assert.equal((await save(owner, "character", 0, { ...blank, category: "角色原画" })).statusCode, 200);
  await send(owner, "POST", "/canvases/character/publish", { revision: 1 });
  const list = (user, category) => send(user, "GET", `/projects/${projectId}/public${category ? `?category=${encodeURIComponent(category)}` : ""}`);
  assert.equal((await list(member)).json().length, 2);
  assert.deepEqual((await list(member, "通用")).json().map((row) => row.id), ["legacy"]);
  assert.deepEqual((await list(member, "角色原画")).json().map((row) => row.id), ["character"]);
  assert.equal((await list(stranger, "角色原画")).statusCode, 403);
  assert.equal((await list(member, "invalid")).statusCode, 400);
  assert.equal((await save(owner, "bad", 0, { ...blank, category: "invalid" })).statusCode, 400);
  await save(owner, "character", 1, { ...blank, category: "UI" });
  assert.equal((await send(member, "GET", "/canvases/character/public")).json().category, "角色原画");
  assert.equal((await list(member, "UI")).json().length, 0);
  for (const kind of ["canvas", "usage"]) {
    const copied = await send(member, "POST", "/canvases/character/use", { kind });
    assert.equal(copied.statusCode, 200, copied.body);
    assert.equal(copied.json().category, "角色原画");
  }
  await send(owner, "POST", "/canvases/character/publish", { revision: 2 });
  assert.equal((await list(member, "角色原画")).json().length, 0);
  assert.deepEqual((await list(member, "UI")).json().map((row) => row.id), ["character"]);
});

test("RunningHub global settings enforce admin, protect keys and rotate only new requests", async (t) => {
  const { app, send, admin, owner } = await fixture(t);
  const settingPath = "/admin/runninghub/settings";
  assert.equal((await send(owner, "GET", settingPath)).statusCode, 403);
  assert.equal((await send(owner, "PUT", settingPath, { apiKey: "bad" })).statusCode, 403);
  assert.equal((await send(admin, "PUT", settingPath, { apiKey: "secret-a" }, { "x-csrf-token": "wrong" })).statusCode, 403);
  assert.equal((await send(admin, "PUT", settingPath, { apiKey: " " })).statusCode, 400);
  assert.equal((await send(admin, "PUT", settingPath, { apiKey: "secret-a" })).statusCode, 200);
  assert.deepEqual((await send(admin, "GET", settingPath)).json(), { hasKey: true, needsSetup: false });
  const settings = { name: "RH", model: "https://www.runninghub.cn/workflow-detail/123", capability: "image", apiFormat: "runninghub", baseUrl: "https://www.runninghub.cn", enabled: true,
    apiKey: "ignored-per-model", runninghub: {"inputs":[{"id":"prompt","nodeId":"1","field":"text","label":"提示词","type":"text","required":true},{"id":"image","nodeId":"2","field":"image","label":"图片","type":"image","required":true}],"outputNodes":["3"]} };
  const saved = await send(admin, "PUT", "/admin/models/new", settings);
  assert.equal(saved.statusCode, 200, saved.body);
  const id = saved.json().id;
  const stored = JSON.parse(app.db.prepare("SELECT config FROM shared_models WHERE id=?").get(id).config);
  assert.equal(stored.model, "123");
  assert.equal(stored.apiKey, undefined);
  assert.equal((await send(admin, "GET", "/admin/models")).body.includes("secret-a"), false);
  assert.equal((await send(owner, "GET", "/models")).body.includes("secret-a"), false);
  let uploads = 0; const submittedKeys = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    url = String(url);
    if (url.endsWith("/upload")) {
      uploads++;
      const key = options.body.get("apiKey");
      submittedKeys.push(key);
      if (uploads === 1) assert.equal((await send(admin, "PUT", settingPath, { apiKey: "secret-b" })).statusCode, 200);
      return Response.json({ code: 0, data: { fileName: "draft.png" } });
    }
    if (url.endsWith("/create")) {
      assert.equal(JSON.parse(options.body).apiKey, submittedKeys.at(-1));
      return Response.json({ code: 0, data: { taskId: "task-" + uploads } });
    }
    if (url.endsWith("/outputs")) {
      assert.equal(JSON.parse(options.body).apiKey, submittedKeys.at(-1));
      return Response.json({ code: 0, data: [{ nodeId: "3", fileUrl: "https://rh-images.xiaoyaoyou.com/result.png" }] });
    }
    assert.equal(url, "https://rh-images.xiaoyaoyou.com/result.png");
    assert.equal(options.headers, undefined);
    return new Response("image", { headers: { "Content-Type": "image/png" } });
  });
  for (let i = 0; i < 2; i++) {
    const form = new FormData(); form.set("model", "123"); form.set("runninghubInputs", JSON.stringify({ prompt: "draft", image: { imageIndex: 0 } }));
    form.set("image", new Blob(["draft"], { type: "image/png" }), "draft.png");
    const encoded = new Response(form);
    const response = await send(owner, "POST", `/model-gateway/${id}/v1/images/edits`, Buffer.from(await encoded.arrayBuffer()), { "content-type": encoded.headers.get("content-type") });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.deepEqual(submittedKeys, ["secret-a", "secret-b"]);
});

test("RunningHub workflow import and read never submit tasks or disclose input values", async (t) => {
  const { send, admin, owner } = await fixture(t);
  const path = "/admin/runninghub/workflow";
  const workflow = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "private prompt" }, _meta: { title: "正面提示词" } },
    "2": { class_type: "LoadImage", inputs: { image: "private-file.png" } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "negative prompt" } },
  };
  assert.equal((await send(owner, "POST", path, { source: "123", workflow })).statusCode, 403);
  assert.equal((await send(admin, "POST", path, { source: "123", workflow }, { "x-csrf-token": "wrong" })).statusCode, 403);
  assert.equal((await send(admin, "POST", path, { source: "123" })).statusCode, 400);
  const imported = await send(admin, "POST", path, { source: "https://www.runninghub.cn/workflow-detail/123?from=share", workflow });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().prompts.length, 2);
  assert.equal(imported.json().images[0].field, "image");
  assert.equal(imported.json().outputs[0].nodeId, "3");
  assert.equal(imported.body.includes("private"), false);
  assert.equal((await send(admin, "POST", path, { source: "https://evil.invalid/workflow-detail/123", workflow })).statusCode, 400);
  assert.equal((await send(admin, "POST", path, { source: "123", workflow: { nodes: [] } })).statusCode, 400);
  await send(admin, "PUT", "/admin/runninghub/settings", { apiKey: "read-key" });
  let calls = 0, detailMode = "success";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    if (url === "https://www.runninghub.cn/api/portal/workflow/detail") {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "error");
      assert.deepEqual(JSON.parse(options.body), { workflowId: "123" });
      if (detailMode === "network") throw new Error("unavailable");
      if (detailMode === "http") return new Response("unavailable", { status: 503 });
      return Response.json({ code: 0, data: { name: detailMode === "success" ? " 草稿细化 " : null } });
    }
    assert.equal(url, "https://www.runninghub.cn/api/openapi/getJsonApiFormat");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { apiKey: "read-key", workflowId: "123" });
    return Response.json({ code: 0, data: { prompt: JSON.stringify(workflow) } });
  });
  const read = await send(admin, "POST", path, { source: "123" });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.body.includes("read-key"), false);
  assert.deepEqual(read.json(), { ...imported.json(), name: "草稿细化" });
  assert.equal(calls, 2);
  for (detailMode of ["network", "http", "missing"]) {
    const fallback = await send(admin, "POST", path, { source: "123" });
    assert.equal(fallback.statusCode, 200);
    assert.deepEqual(fallback.json(), imported.json());
  }
});

test("RunningHub adopts one legacy key, requires selection for conflicts and persists the global key", async (t) => {
  for (const keys of [["same", "same"], ["one", "two"]]) {
    const directory = await mkdtemp(join(tmpdir(), "canvas-rh-migration-"));
    const initial = await createApp({ directory });
    for (const [i, apiKey] of keys.entries()) initial.db.prepare("INSERT INTO shared_models VALUES(?,?)").run(String(i), JSON.stringify({ apiFormat: "runninghub", apiKey }));
    await initial.close();
    const reopened = await createApp({ directory });
    const value = reopened.db.prepare("SELECT apiKey FROM provider_settings WHERE provider='runninghub'").get()?.apiKey;
    assert.equal(value, keys[0] === keys[1] ? "same" : undefined);
    if (value) {
      for (const row of reopened.db.prepare("SELECT config FROM shared_models").all()) assert.equal(JSON.parse(row.config).apiKey, undefined);
    }
    await reopened.close();
    const third = await createApp({ directory });
    assert.equal(third.db.prepare("SELECT apiKey FROM provider_settings WHERE provider='runninghub'").get()?.apiKey, value);
    await third.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("public usage counts deduplicate runs and exclude copies and unauthorized users", async (t) => {
  const { send, owner, member, stranger, projectId, save } = await fixture(t);
  await save(owner, "usage-source");
  await send(owner, "POST", "/canvases/usage-source/publish", { revision: 1 });
  const usage = (await send(member, "POST", "/canvases/usage-source/use", { kind: "usage" })).json();
  const copy = (await send(member, "POST", "/canvases/usage-source/use", { kind: "canvas" })).json();
  const count = async () => (await send(owner, "GET", `/projects/${projectId}/public`)).json()[0].usageCount;
  assert.equal(await count(), 0);
  const runId = crypto.randomUUID();
  for (let step = 0; step < 3; step++) assert.equal((await send(member, "POST", `/canvases/${usage.id}/usage-runs`, { runId })).statusCode, 200);
  assert.equal(await count(), 1);
  await send(member, "POST", `/canvases/${usage.id}/usage-runs`, { runId: crypto.randomUUID() });
  assert.equal(await count(), 2);
  await send(member, "POST", `/canvases/${copy.id}/usage-runs`, { runId: crypto.randomUUID() });
  assert.equal(await count(), 2);
  assert.notEqual((await send(stranger, "POST", `/canvases/${usage.id}/usage-runs`, { runId: crypto.randomUUID() })).statusCode, 200);
  assert.equal((await send(member, "POST", `/canvases/${usage.id}/usage-runs`, { runId: "invalid" })).statusCode, 400);
  await send(owner, "POST", "/canvases/usage-source/usage-runs", { runId: crypto.randomUUID() });
  assert.equal(await count(), 3);
  await send(owner, "POST", "/canvases/usage-source/publish", { revision: 1 });
  assert.equal(await count(), 3);
});


test("canvas descriptions persist and public descriptions follow published snapshots", async (t) => {
  const { send, owner, member, projectId } = await fixture(t);
  const save = (revision, description) => send(owner, "PUT", "/canvases/description-test", { projectId, title: "简介测试", revision, content: { ...blank, description } });
  assert.equal((await save(0, "第一版简介\n第二行\n第三行")).statusCode, 200);
  await send(owner, "POST", "/canvases/description-test/publish", { revision: 1 });
  await save(1, "新的简介");
  const list = (await send(member, "GET", `/projects/${projectId}/public`)).json();
  assert.equal(list[0].description, "第一版简介\n第二行\n第三行");
  const copy = (await send(member, "POST", "/canvases/description-test/use", { kind: "canvas" })).json();
  assert.equal(copy.description, list[0].description);
  await send(owner, "POST", "/canvases/description-test/publish", { revision: 2 });
  assert.equal((await send(member, "GET", `/projects/${projectId}/public`)).json()[0].description, "新的简介");
  await save(2, "");
  assert.equal((await send(owner, "GET", "/canvases")).json()[0].description, "");
});


test("public RunningHub badge follows published config nodes rather than names or draft edits", async (t) => {
  const { send, admin, owner, member, projectId } = await fixture(t);
  const model = (await send(admin, "PUT", "/admin/models/new", { name: "RH", model: "123", capability: "image", apiFormat: "runninghub", baseUrl: "https://www.runninghub.cn", enabled: false,
    runninghub: {"inputs":[{"id":"prompt","nodeId":"1","field":"text","label":"提示词","type":"text","required":true},{"id":"image","nodeId":"2","field":"image","label":"图片","type":"image","required":true}],"outputNodes":["3"]} })).json();
  const node = { id: "config", type: "config", title: "生成配置", position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { modelSource: "server", model: `server-${model.id}::123` } };
  const save = (revision, nodes) => send(owner, "PUT", "/canvases/rh-badge", { projectId, title: "RunningHub", revision, content: { ...blank, nodes } });
  const badge = async () => (await send(member, "GET", `/projects/${projectId}/public`)).json()[0].hasRunningHub;
  assert.equal((await save(0, [node])).statusCode, 200);
  await send(owner, "POST", "/canvases/rh-badge/publish", { revision: 1 });
  assert.equal(await badge(), true);
  await save(1, [{ ...node, type: "text", title: "RunningHub" }]);
  assert.equal(await badge(), true);
  await send(owner, "POST", "/canvases/rh-badge/publish", { revision: 2 });
  assert.equal(await badge(), false);
  await save(2, [{ ...node, metadata: { model: "local::RunningHub" } }]);
  await send(owner, "POST", "/canvases/rh-badge/publish", { revision: 3 });
  assert.equal(await badge(), false);
});

test('RunningHub tags normalize, persist, remain admin-only and remove independently', async (t) => {
 const { send, admin, owner } = await fixture(t);
 await send(admin, 'PUT', '/admin/runninghub/settings', { apiKey: 'tag-test-secret' });
 const settings = { name: 'Tagged', model: '123', capability: 'image', apiFormat: 'runninghub', baseUrl: 'https://www.runninghub.cn', enabled: true, runninghub: { inputs: [], outputNodes: ['1'] }, tags: [' 抠图 ', '抠图', '', '  ', '电商'] };
 assert.equal((await send(owner, 'PUT', '/admin/models/new', settings)).statusCode, 403);
 const first = (await send(admin, 'PUT', '/admin/models/new', settings)).json().id;
 const second = (await send(admin, 'PUT', '/admin/models/new', { ...settings, model: '456' })).json().id;
 assert.ok(first); assert.ok(second);
 const models = (await send(owner, 'GET', '/models')).json();
 assert.deepEqual(models.find(m => m.id === first).tags, ['抠图','电商']);
 assert.equal(JSON.stringify(models).includes('tag-test-secret'), false);
 assert.deepEqual((await send(admin, 'GET', '/admin/models')).json().find(m => m.id === first).tags, ['抠图','电商']);
 assert.equal((await send(admin, 'PUT', '/admin/models/' + first, { ...settings, tags: [] })).statusCode, 200);
 const updated = (await send(owner, 'GET', '/models')).json();
 assert.deepEqual(updated.find(m => m.id === first).tags, []);
 assert.deepEqual(updated.find(m => m.id === second).tags, ['抠图','电商']);
 assert.equal((await send(admin, 'PUT', '/admin/models/' + first, { ...settings, tags: [42] })).statusCode, 400);
});
