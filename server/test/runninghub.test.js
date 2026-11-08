import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateRunningHub, runningHubResultUrl, runningHubSchema } from "../src/runninghub.js";
import { runningHubWorkflowChoices, runningHubWorkflowId } from "../src/runninghub-workflow.js";
import { resolveRunningHubBindings } from '../src/runninghub-inputs.js';

const config = { ...JSON.parse(readFileSync(new URL("../examples/runninghub-draft-detail.json", import.meta.url))), apiKey: "private-test-key" };

test('dynamic bindings preserve slot identity, empty text and defaults, and reject disconnected inputs', () => {
  const mapping = { inputs: [
    { id: 'person', nodeId: '1', field: 'image', label: '人物', type: 'image', required: true },
    { id: 'style', nodeId: '2', field: 'image', label: '风格', type: 'image', required: true },
    { id: 'positive', nodeId: '3', field: 'text', label: '正向', type: 'text', required: true },
    { id: 'negative', nodeId: '4', field: 'text', label: '反向', type: 'text', required: false },
    { id: 'default', nodeId: '5', field: 'text', label: '默认', type: 'text', required: false, defaultValue: 'saved' },
    { id: 'omit', nodeId: '6', field: 'text', label: '保留', type: 'text', required: false },
  ], outputNodes: ['7'] };
  const node = { id: 'config', metadata: { runninghubBindings: { person: { mode: 'node', nodeId: 'image' }, style: { mode: 'node', nodeId: 'image' }, positive: { mode: 'node', nodeId: 'text' }, negative: { mode: 'text', value: '' } } } };
  const snapshot = { nodes: [{ id: 'image', type: 'image', metadata: {} }, { id: 'text', type: 'text', metadata: { content: 'hello' } }], connections: [{ fromNodeId: 'text', toNodeId: 'config' }, { fromNodeId: 'image', toNodeId: 'config' }] };
  const result = resolveRunningHubBindings(mapping, node, snapshot);
  assert.deepEqual(result.values, { person: { imageIndex: 0 }, style: { imageIndex: 0 }, positive: 'hello', negative: '', default: 'saved' });
  assert.equal(result.references.length, 1);
  snapshot.connections.pop();
  assert.throws(() => resolveRunningHubBindings(mapping, node, snapshot), /人物.*断开/);
  assert.throws(() => resolveRunningHubBindings(mapping, { id: 'config' }, snapshot), /人物/);
  assert.throws(() => runningHubSchema.parse({ ...mapping, inputs: [mapping.inputs[0], mapping.inputs[0]] }), /重复/);
});

test('no-input workflow submits no overrides and downloads all selected outputs in configured order', async () => {
  const form = new FormData(); let creates = 0;
  const result = await generateRunningHub({ ...config, runninghub: { inputs: [], outputNodes: ['9', '8'] } }, form, undefined, () => {}, async (url, options) => {
    url = String(url);
    assert.ok(!url.endsWith('/upload'));
    if (url.endsWith('/create')) { creates++; assert.deepEqual(JSON.parse(options.body).nodeInfoList, []); return Response.json({ code: 0, data: { taskId: 'zero' } }); }
    if (url.endsWith('/outputs')) return Response.json({ code: 0, data: [{ nodeId: '8', fileUrl: 'https://rh-images.xiaoyaoyou.com/b' }, { nodeId: '9', fileUrl: 'https://rh-images.xiaoyaoyou.com/a' }, { nodeId: '9', fileUrl: 'https://rh-images.xiaoyaoyou.com/c' }] });
    return new Response(url.slice(-1), { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(creates, 1);
  assert.deepEqual(result.data.map((item) => Buffer.from(item.b64_json, 'base64').toString()), ['a', 'c', 'b']);
});

test('image-only and multiple image/text slots upload once per image and reject invalid values before submission', async () => {
  const inputs = [
    { id: 'a', nodeId: '1', field: 'image', type: 'image', required: true, label: '主体' },
    { id: 'b', nodeId: '2', field: 'image', type: 'image', required: true, label: '参考' },
    { id: 'c', nodeId: '3', field: 'image', type: 'image', required: true, label: '复用' },
  ];
  const model = { ...config, runninghub: { inputs, outputNodes: ['9'] } };
  const form = new FormData(); form.set('runninghubInputs', JSON.stringify({ a: { imageIndex: 1 }, b: { imageIndex: 0 }, c: { imageIndex: 1 } }));
  form.append('image[]', new Blob(['first'], { type: 'image/png' })); form.append('image[]', new Blob(['second'], { type: 'image/png' }));
  let uploads = 0, creates = 0;
  await generateRunningHub(model, form, undefined, () => {}, async (url, options) => {
    url = String(url);
    if (url.endsWith('/upload')) { uploads++; return Response.json({ code: 0, data: { fileName: await options.body.get('file').text() } }); }
    if (url.endsWith('/create')) { creates++; assert.deepEqual(JSON.parse(options.body).nodeInfoList.map((item) => item.fieldValue), ['second', 'first', 'second']); return Response.json({ code: 0, data: { taskId: 'multi' } }); }
    if (url.endsWith('/outputs')) return Response.json({ code: 0, data: [{ nodeId: '9', fileUrl: 'https://rh-images.xiaoyaoyou.com/a' }] });
    return new Response('image', { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(uploads, 2); assert.equal(creates, 1);
  form.set('runninghubInputs', JSON.stringify({ a: 'wrong' }));
  await assert.rejects(generateRunningHub(model, form, undefined, () => {}, () => { throw Error('must not call'); }), /主体/);
});
test("RunningHub subgraph node paths import and map without losing their IDs", () => {
  assert.equal(runningHubWorkflowId('https://www.runninghub.cn/workflow/2118551226722897921?source=workspace'), '2118551226722897921');
  const choices = runningHubWorkflowChoices(JSON.stringify({
    '8144:8143': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt' } },
    '5702:8090': { class_type: 'LoadImage', inputs: { image: 'private.png' } },
    '5702:8091:1': { class_type: 'SaveImage', inputs: { images: ['5702:8090', 0] } },
  }));
  assert.equal(choices.prompts[0].nodeId, '8144:8143');
  assert.equal(choices.images[0].nodeId, '5702:8090');
  assert.equal(choices.outputs[0].nodeId, '5702:8091:1');
  assert.equal(JSON.stringify(choices).includes('private'), false);
  assert.equal(runningHubSchema.parse({ inputs: [{ id: 'prompt', nodeId: choices.prompts[0].nodeId, field: 'text', label: '提示词', type: 'text', required: false }, { id: 'image', nodeId: choices.images[0].nodeId, field: 'image', label: '图片', type: 'image', required: true }], outputNodes: [choices.outputs[0].nodeId] }).outputNodes[0], '5702:8091:1');
  assert.throws(() => runningHubWorkflowChoices({ nodes: [], links: [] }), /API/);
});
function input() {
  const form = new FormData();
  form.set("runninghubInputs", JSON.stringify({ prompt: "细化草稿", image: { imageIndex: 0 } })); form.set("n", "1");
  form.set("image[]", new Blob(["draft"], { type: "image/png" }), "draft.png");
  return form;
}
test("RunningHub uploads one reference, overrides only mapped inputs, and downloads without credentials", async () => {
  const calls = []; let recorded;
  const result = await generateRunningHub(config, input(), new AbortController().signal, (id) => { recorded = id; }, async (url, options) => {
    url = String(url);
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
  await assert.rejects(generateRunningHub(config, form, undefined, () => {}, () => { throw Error("must not fetch"); }), /每次执行 1 次/);
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

test('text discovery separates prompts from advanced strings and excludes internal expressions/displays', () => {
 const node = (class_type, inputs) => ({ class_type, inputs });
 const result = runningHubWorkflowChoices({
  '1': node('CLIPTextEncode', { text: 'private' }),
  '2': node('StringConstantMultiline', { value: 'private' }),
  '3': node('SimpleMath+', { value: 'a / 2' }),
  '4': node('ShowText|pysssss', { text: 'private' }),
  '5': node('ShowAny', { text: 'private' }),
  '6': node('CustomPromptNode', { prompt: 'private', negative: 'private' }),
  '7:8': node('UnknownNode', { text: 'private' }),
  '9': node('CLIPTextEncodeSDXL', { text_g: 'private', text_l: 'private' }),
 });
 assert.deepEqual(result.prompts.map(x=>x.nodeId), ['1','6','6','9','9']);
 assert.deepEqual(result.advancedTexts.map(x=>x.nodeId), ['2','7:8']);
 assert.equal(JSON.stringify(result).includes('private'), false);
});
