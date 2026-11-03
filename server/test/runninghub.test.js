import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateRunningHub, runningHubResultUrl } from "../src/runninghub.js";

const config = { ...JSON.parse(readFileSync(new URL("../examples/runninghub-draft-detail.json", import.meta.url))), apiKey: "private-test-key" };
function input() {
  const form = new FormData();
  form.set("prompt", "细化草稿"); form.set("n", "1");
  form.set("image[]", new Blob(["draft"], { type: "image/png" }), "draft.png");
  return form;
}
test("RunningHub uploads one reference, overrides only mapped inputs, and downloads without credentials", async () => {
  const calls = []; let recorded;
  const result = await generateRunningHub(config, input(), new AbortController().signal, (id) => { recorded = id; }, async (url, options) => {
    calls.push(String(url));
    if (String(url).endsWith("/upload")) {
      assert.equal(options.body.get("apiKey"), config.apiKey);
      assert.equal(options.body.get("fileType"), "input");
      return Response.json({ code: 0, data: { fileName: "uploaded.png" } });
    }
    if (String(url).endsWith("/create")) {
      assert.deepEqual(JSON.parse(options.body), { apiKey: config.apiKey, workflowId: config.model, nodeInfoList: [
        { nodeId: "5622", fieldName: "value", fieldValue: "细化草稿" },
        { nodeId: "5650", fieldName: "image", fieldValue: "uploaded.png" },
      ] });
      return Response.json({ code: 0, data: { taskId: "task-1" } });
    }
    if (String(url).endsWith("/outputs")) return Response.json({ code: 0, data: [
      { nodeId: "other", fileUrl: "https://bad.invalid/image.png" },
      { nodeId: "5712", fileUrl: "https://rh-images.xiaoyaoyou.com/result.png" },
    ] });
    assert.equal(options.headers, undefined); assert.equal(options.redirect, "error");
    return new Response("result", { headers: { "Content-Type": "image/png" } });
  });
  assert.equal(recorded, "task-1"); assert.equal(calls.length, 4);
  assert.equal(result.data[0].b64_json, Buffer.from("result").toString("base64"));
});
test("RunningHub rejects invalid input before upload and rejects unrelated download hosts", async () => {
  assert.equal(runningHubResultUrl("https://rh-images-tos.xiaoyaoyou.com/result.png").hostname, "rh-images-tos.xiaoyaoyou.com");
  assert.throws(() => runningHubResultUrl("https://rh-images-tos.xiaoyaoyou.com.evil.com/result.png"));
  const form = input(); form.set("n", "2");
  await assert.rejects(generateRunningHub(config, form, undefined, () => {}, () => { throw Error("must not fetch"); }), /每次生成 1 张/);
  for (const url of ["http://rh-images.xiaoyaoyou.com/a", "https://localhost/a", "https://rh-images.xiaoyaoyou.com.evil.com/a"]) assert.throws(() => runningHubResultUrl(url));
});
test("RunningHub abort during polling never resubmits the task", async () => {
  const controller = new AbortController(); let creates = 0;
  await assert.rejects(generateRunningHub(config, input(), controller.signal, () => {}, async (url) => {
    if (url.endsWith("/upload")) return Response.json({ code: 0, data: { fileName: "a.png" } });
    if (url.endsWith("/create")) { creates++; return Response.json({ code: 0, data: { taskId: "t" } }); }
    controller.abort(); return Response.json({ code: 804 });
  }), { name: "AbortError" });
  assert.equal(creates, 1);
});
