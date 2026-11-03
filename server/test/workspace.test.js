import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { createApp } from "../src/app.js";
import { database } from "../src/database.js";
import { workspaceApi, setWorkspaceCsrf } from "../../web/src/services/api/workspace.ts";

const origin = "http://localhost:3000";
const blank = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };

test("canvas numbers are unique, immutable and allocated to copies and existing canvases", async (t) => {
  const { app, directory, send, admin, owner, member, projectId, save } = await fixture(t);
  const first = (await save(owner, "number-one")).json();
  const second = (await save(member, "number-two")).json();
  assert.equal(first.number, "HB-000001");
  assert.equal(second.number, "HB-000002");
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
