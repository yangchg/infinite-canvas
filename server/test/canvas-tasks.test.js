import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { digest } from '../src/password.js';
import { mergeCanvas } from '../src/task-merge.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const origin = 'http://localhost:3000';
const blank = { category: '通用', description: '', nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
const node = (id, type, metadata = {}) => ({ id, type, title: id, position: { x: 20, y: 40 }, width: 100, height: 100, metadata });
const edge = (a, b) => ({ id: `${a}-${b}`, fromNodeId: a, toNodeId: b });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, generate = async () => png, extra = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'canvas-tasks-'));
    let app = await createApp({ directory, origin, webRoot: join(directory, 'missing'), tasks: { generate, ...extra } });
    await app.ready();
    app.db.exec("INSERT INTO users VALUES('owner','owner','Owner','unused',1,0),('other','other','Other','unused',0,0); INSERT INTO projects VALUES('project','Project',0,0); INSERT INTO members VALUES('project','other');");
    for (const user of ['owner', 'other']) app.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(user), user, Date.now() + 86400000);
    app.db.prepare('INSERT INTO shared_models VALUES(?,?)').run('model', JSON.stringify({ name: 'Mock', model: 'gpt-image-test', apiFormat: 'openai', capability: 'image', enabled: true, apiKey: 'hidden-secret', baseUrl: 'https://example.invalid' }));
    const send = (method, path, payload, user = 'owner', headers = {}) => app.inject({ method, url: `/api${path}`, headers: { origin, cookie: `canvas_session=${user}`, 'x-csrf-token': digest(`${user}:csrf`), ...headers }, ...(payload === undefined ? {} : { payload }) });
    await send('PUT', '/files/image:old', Buffer.from('old image'), 'owner', { 'content-type': 'application/octet-stream', 'x-file-type': 'image/png' });
    const config = (id, replacementOutputId) => node(id, 'config', { model: 'server-model::gpt-image-test', modelSource: 'server', generationMode: 'image', replacementOutputId });
    const content = { ...blank, nodes: [node('start', 'pipeline'), config('a', 'out'), node('out', 'image', { storageKey: 'image:old', content: 'old' }), config('b'), node('final', 'image', { storageKey: 'image:old', content: 'old' }), config('ignored')], connections: [edge('start','a'), edge('a','out'), edge('out','b'), edge('b','final'), edge('final','ignored')] };
    const save = (data, revision) => send('PUT', '/canvases/canvas', { projectId: 'project', title: 'Test', revision, content: data });
    assert.equal((await save(content, 0)).statusCode, 200);
    const step = (nodeId, targetId, references = []) => ({ nodeId, targetId, model: 'server-model::gpt-image-test', prompt: 'new image', displayPrompt: 'new image', count: 1, references, parameters: {}, metadata: { model: 'server-model::gpt-image-test', size: '1:1', quality: 'low' } });
    const submit = (steps = [step('a', 'out')], entryId, runId = randomUUID(), revision = 1) => send('POST', '/canvases/canvas/tasks', { steps, entryId, runId, revision });
    const tasks = async () => (await send('GET', '/canvases/canvas/tasks')).json();
    const wait = async (predicate = (items) => items[0] && !['queued','running','canceling'].includes(items[0].state)) => {
        for (;;) { const items = await tasks(); if (predicate(items)) return items; await new Promise(setImmediate); }
    };
    const read = async () => (await send('GET', '/canvases/canvas')).json();
    const restart = async (nextGenerate = generate) => { await app.close(); app = await createApp({ directory, origin, webRoot: join(directory,'missing'), tasks: { generate: nextGenerate, ...extra } }); await app.ready(); };
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    return { send, content, save, step, submit, tasks, wait, read, restart, db: () => app.db, listen: () => app.listen({ host: '127.0.0.1', port: 0 }) };
}

async function selectionFixture(t) {
    const calls = [];
    const f = await fixture(t, async (...args) => { calls.push(args); return png; });
    f.content.nodes.find((item) => item.id === 'a').metadata.confirmImageSelection = true;
    assert.equal((await f.save(f.content, 1)).statusCode, 200);
    const first = { ...f.step('a', 'out'), count: 2 };
    const response = await f.submit([first, f.step('b', undefined, [{ nodeId: 'out', storageKey: 'image:old' }])], 'start', randomUUID(), 2);
    assert.equal(response.statusCode, 202, response.body);
    const [task] = await f.wait();
    assert.equal(task.state, 'waiting_selection');
    assert.equal(calls.length, 2);
    return { ...f, calls, task, select: (imageId, user) => f.send('POST', `/tasks/${task.id}/select/a`, { imageId }, user) };
}

test('manual selection survives restart, freezes selected image and resumes exactly once', { timeout: 10000 }, async (t) => {
    const f = await selectionFixture(t);
    assert.equal(f.task.steps[1].state, 'queued');
    const before = await f.read();
    assert.equal(before.nodes.find((node) => node.id === 'out').metadata.images.length, 2);
    assert.equal((await f.submit([f.step('a', 'out')], undefined, randomUUID(), before.revision)).statusCode, 409);
    assert.equal((await f.select('invalid')).statusCode, 400);
    assert.equal((await f.select(f.task.steps[0].outputs[1].id, 'other')).statusCode, 403);
    const downstream = deferred(), started = deferred();
    let downstreamCalls = 0;
    await f.restart(async () => { downstreamCalls++; started.resolve(); await downstream.promise; return png; });
    assert.equal((await f.tasks())[0].state, 'waiting_selection');
    assert.equal(downstreamCalls, 0);
    const selected = f.task.steps[0].outputs[1];
    const responses = await Promise.all([f.select(selected.id), f.select(selected.id)]);
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    await started.promise;
    assert.equal(downstreamCalls, 1);
    assert.equal((await f.select(f.task.steps[0].outputs[0].id)).statusCode, 409);
    // A later display-only change must not change this run's selected input.
    const current = await f.read();
    const output = current.nodes.find((node) => node.id === 'out');
    assert.equal(output.metadata.primaryImageId, selected.id);
    output.metadata.primaryImageId = f.task.steps[0].outputs[0].id;
    assert.equal((await f.save(current, current.revision)).statusCode, 200);
    downstream.resolve();
    const [done] = await f.wait((tasks) => tasks[0].state === 'success');
    assert.equal(done.steps[0].selectedImageId, selected.id);
    assert.equal(downstreamCalls, 1);
    const final = (await f.read()).nodes.at(-1);
    assert.deepEqual(final.metadata.references, [`/api/files/${encodeURIComponent(selected.storageKey)}`]);
    assert.deepEqual((await f.read()).connections.slice(0, before.connections.length), before.connections);
});

test('waiting selection can be canceled durably without executing downstream', { timeout: 10000 }, async (t) => {
    const f = await selectionFixture(t);
    const canceled = await f.send('POST', `/tasks/${f.task.id}/cancel`);
    assert.equal(canceled.json().state, 'canceled');
    assert.equal(canceled.json().steps[1].state, 'skipped');
    assert.equal((await f.select(f.task.steps[0].outputs[0].id)).statusCode, 409);
    await f.restart();
    assert.equal((await f.tasks())[0].state, 'canceled');
    assert.equal(f.calls.length, 2);
    const undo = await f.send('POST', `/tasks/${f.task.id}/undo/a`);
    assert.equal(undo.statusCode, 200, undo.body);
    assert.equal((await f.read()).nodes.find((node) => node.id === 'out').metadata.storageKey, 'image:old');
});

test('confirmation rejects changed output metadata or disconnected workflow', { timeout: 10000 }, async (t) => {
    const f = await selectionFixture(t);
    const original = await f.read();
    const changed = structuredClone(original);
    changed.nodes.find((node) => node.id === 'out').metadata.prompt = 'edited';
    assert.equal((await f.save(changed, original.revision)).statusCode, 200);
    assert.equal((await f.select(f.task.steps[0].outputs[0].id)).statusCode, 409);
    original.connections = original.connections.filter((edge) => !(edge.fromNodeId === 'out' && edge.toNodeId === 'b'));
    assert.equal((await f.save(original, original.revision + 1)).statusCode, 200);
    assert.equal((await f.select(f.task.steps[0].outputs[0].id)).statusCode, 409);
    assert.equal(f.calls.length, 2);
});

test('single-image manual step continues automatically and missing fixed output is rejected', { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    f.content.nodes.find((item) => item.id === 'a').metadata.confirmImageSelection = true;
    assert.equal((await f.save(f.content, 1)).statusCode, 200);
    const response = await f.submit([f.step('a', 'out'), f.step('b')], 'start', randomUUID(), 2);
    assert.equal(response.statusCode, 202, response.body);
    assert.equal((await f.wait())[0].state, 'success');
    const current = await f.read();
    current.nodes.find((item) => item.id === 'a').metadata.replacementOutputId = '';
    assert.equal((await f.save(current, current.revision)).statusCode, 200);
    const rejected = await f.submit([f.step('a')], 'start', randomUUID(), current.revision + 1);
    assert.equal(rejected.statusCode, 400, rejected.body);
});

test('pipeline fills an empty output and feeds its generated image to the next step', { timeout: 10000 }, async (t) => {
    const inputs = [];
    const f = await fixture(t, async (...args) => { inputs.push(args); return png; });
    f.content.nodes.find((item) => item.id === 'out').metadata = {};
    assert.equal((await f.save(f.content, 1)).statusCode, 200);
    const result = await f.submit([f.step('a', 'out'), f.step('b', undefined, [{ nodeId: 'out' }])], 'start', randomUUID(), 2);
    assert.equal(result.statusCode, 202, result.body);
    const [task] = await f.wait();
    assert.equal(task.state, 'success');
    const updated = await f.read();
    assert.ok(updated.nodes.find((item) => item.id === 'out').metadata.storageKey);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0][2].length, 0);
    assert.deepEqual(inputs[1][2][0].bytes, png);
    assert.ok(updated.connections.some((item) => item.fromNodeId === 'out' && item.toNodeId === 'b'));
    assert.equal(task.steps[1].outputs.length, 1);
});

test('missing reference storage is rejected without a preceding producer', { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const result = await f.submit([f.step('b', undefined, [{ nodeId: 'out' }])]);
    assert.equal(result.statusCode, 400);
});

test('idle task stream sends comment heartbeats and closes when account access is revoked', { timeout: 40000 }, async (t) => {
    const f = await fixture(t);
    const address = await f.listen();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${address}/api/canvases/canvas/task-events`, { headers: { cookie: 'canvas_session=owner' }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decode = (chunk) => new TextDecoder().decode(chunk.value);
    assert.match(decode(await reader.read()), /data:.*changed/);
    const keepalive = decode(await reader.read());
    assert.equal(keepalive, ': keepalive\n\n');
    f.db().prepare('DELETE FROM sessions WHERE userId=?').run('owner');
    assert.equal((await reader.read()).done, true);
});

test('new-output batch keeps successes in a single node when another image fails', { timeout: 10000 }, async (t) => {
    let calls = 0;
    const f = await fixture(t, async () => { if (++calls === 2) throw new Error('provider failed'); return png; });
    const step = { ...f.step('b'), count: 3 };
    assert.equal((await f.submit([step])).statusCode, 202);
    const [task] = await f.wait();
    assert.equal(task.state, 'failed');
    assert.equal(task.steps[0].outputs.length, 2);
    const updated = await f.read();
    assert.equal(updated.nodes.length, f.content.nodes.length + 1);
    assert.equal(updated.connections.length, f.content.connections.length + 1);
    assert.equal(updated.nodes.at(-1).metadata.images.length, 2);
});

test('background replacement, duplicate protection, ownership, stale autosave merge and durable undo', { timeout: 10000 }, async (t) => {
    const gate = deferred(); let calls = 0;
    const f = await fixture(t, async () => { calls++; await gate.promise; return png; });
    const first = await f.submit(); assert.equal(first.statusCode, 202, first.body);
    const taskId = first.json().id;
    assert.equal((await f.submit(undefined, undefined, taskId)).statusCode, 200);
    assert.equal((await f.submit()).statusCode, 409);
    assert.equal((await f.send('GET','/canvases/canvas/tasks',undefined,'other')).statusCode,403);
    assert.equal((await f.send('POST',`/tasks/${taskId}/cancel`,undefined,'other')).statusCode,403);
    gate.resolve(); await f.wait();
    assert.equal(calls,1);
    const updated = await f.read();
    assert.equal(updated.nodes.length,f.content.nodes.length); assert.equal(updated.connections.length,f.content.connections.length);
    const out = updated.nodes.find((n) => n.id === 'out');
    assert.notEqual(out.metadata.storageKey,'image:old'); assert.deepEqual(out.position,{x:20,y:40});
    const stale = structuredClone(f.content); stale.nodes.find((n) => n.id === 'out').position.x = 400;
    const saved = await f.save(stale,1); assert.equal(saved.statusCode,200,saved.body);
    assert.equal(saved.json().content.nodes.find((n) => n.id === 'out').metadata.storageKey,out.metadata.storageKey);
    assert.equal(saved.json().content.nodes.find((n) => n.id === 'out').position.x,400);
    const list = await f.send('GET','/canvases/canvas/tasks'); assert.equal(list.body.includes('hidden-secret'),false);
    await f.restart();
    assert.equal((await f.send('POST',`/tasks/${taskId}/undo/a`)).statusCode,200);
    const undone = (await f.read()).nodes.find((n) => n.id === 'out');
    assert.equal(undone.metadata.storageKey,'image:old'); assert.equal(undone.position.x,400);
});

test('pipeline consumes newly saved upstream bytes, counts once and stops at new-output step', { timeout: 10000 }, async (t) => {
    const calls = [];
    const f = await fixture(t, async (_model, step, images) => { calls.push(step.nodeId); if (step.nodeId === 'b') assert.deepEqual(images[0].bytes,png); return png; });
    await f.send('POST','/canvases/canvas/publish',{revision:1});
    const response = await f.submit([f.step('a','out'),f.step('b',undefined,[{nodeId:'out',storageKey:'image:old'}])],'start');
    assert.equal(response.statusCode,202,response.body);
    const [task] = await f.wait(); assert.equal(task.state,'success',task.message);
    assert.deepEqual(calls,['a','b']);
    assert.equal((await f.read()).nodes.length,f.content.nodes.length+1);
    assert.equal(f.db().prepare('SELECT COUNT(*) AS count FROM canvas_usage_runs').get().count,1);
});

test('failed and canceled replacements preserve original, stop pipeline and retain partial generated files', { timeout: 10000 }, async (t) => {
    let count=0;
    const f = await fixture(t, async () => { if (++count === 2) throw new Error('provider failure'); return png; });
    const request = f.step('a','out'); request.count=2;
    assert.equal((await f.submit([request,f.step('b')],'start')).statusCode,202);
    const [failed] = await f.wait(); assert.equal(failed.state,'failed'); assert.equal(count,2);
    assert.equal(failed.steps[0].outputs.length,1);
    assert.equal((await f.read()).nodes.find((n)=>n.id==='out').metadata.storageKey,'image:old');
    assert.equal((await f.send('GET',`/files/${encodeURIComponent(failed.steps[0].outputs[0].storageKey)}`)).statusCode,200);
    const started=deferred();
    await f.restart(async (_m,_s,_i,signal) => { started.resolve(); await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})); });
    const next=(await f.submit()).json(); await started.promise;
    await f.send('POST',`/tasks/${next.id}/cancel`); await f.wait((items)=>items.some((item)=>item.id===next.id&&item.state==='canceled'));
    assert.equal((await f.read()).nodes.find((n)=>n.id==='out').metadata.storageKey,'image:old');
});

test('edits to target prevent writeback while preserving result history', { timeout: 10000 }, async (t) => {
    const gate=deferred(); const f=await fixture(t,async()=>{await gate.promise;return png;});
    await f.submit();
    const edited=structuredClone(f.content); edited.nodes.find((n)=>n.id==='out').metadata.prompt='user edit';
    assert.equal((await f.save(edited,1)).statusCode,200);
    gate.resolve(); const [task]=await f.wait(); assert.equal(task.state,'conflict');
    assert.equal((await f.read()).nodes.find((n)=>n.id==='out').metadata.prompt,'user edit');
    assert.equal(task.steps[0].outputs.length,1);
});

test('restart resumes known upstream ID; unknown synchronous work is not retried', { timeout: 10000 }, async (t) => {
    const started=deferred();
    const f=await fixture(t,async (_m,_s,_i,signal,submitted)=>{submitted('upstream-1');started.resolve();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
    await f.submit(); await started.promise;
    let resumes=0;
    await f.restart(async (_m,_s,_i,_signal,_submitted,resumeId)=>{assert.equal(resumeId,'upstream-1');resumes++;return png;});
    assert.equal((await f.wait())[0].state,'success'); assert.equal(resumes,1);
    const second=deferred();
    await f.restart(async (_m,_s,_i,signal)=>{second.resolve();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
    const rev=(await f.read()).revision;
    await f.submit([f.step('b')],undefined,randomUUID(),rev); await second.promise;
    let retried=false;
    await f.restart(async()=>{retried=true;return png;});
    const jobs=await f.wait((items)=>items.every((item)=>!['queued','running'].includes(item.state)));
    assert.equal(retried,false); assert.ok(jobs.some((item)=>item.state==='conflict'&&item.message.includes('未知')));
});

test('background notification is server-owned and delivered once across restart', { timeout: 10000 }, async (t) => {
    const notices=[];
    const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);notices.push(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','application/json');res.end(JSON.stringify({state:'delivered',message:'sent'}));});
    await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise((resolve)=>server.close(resolve)));
    const f=await fixture(t,async()=>png,{notifyUrl:`http://127.0.0.1:${server.address().port}`});
    f.content.nodes.push(node('notice','dingtalk',{notificationChannel:'app',notificationUsers:['employee']})); f.content.connections.push(edge('a','notice'));
    await f.save(f.content,1);
    await f.submit([f.step('a','out')],undefined,randomUUID(),2);
    assert.equal((await f.wait())[0].state,'success');
    assert.equal(notices.length,1); assert.equal(notices[0].details.prompt,'new image');
    await f.restart(); assert.equal(notices.length,1);
});

test('three-way merge preserves disjoint edits and blob identities, rejects target conflicts',()=>{
    const base={nodes:[node('out','image',{storageKey:'key',content:''})]};
    const local=structuredClone(base);local.nodes[0].position.x=90;local.nodes[0].metadata.content='blob:local';
    const remote=structuredClone(base);remote.nodes[0].metadata={storageKey:'new',content:'/api/files/new'};
    const merged=mergeCanvas(base,local,remote);assert.equal(merged.nodes[0].position.x,90);assert.equal(merged.nodes[0].metadata.storageKey,'new');
    local.nodes[0].metadata.storageKey='user-new';assert.throws(()=>mergeCanvas(base,local,remote),/同一内容/);
});

async function useRunningHub(f, mapping, configId = 'a') {
  const config = { name: 'RH', model: '123', apiFormat: 'runninghub', capability: 'image', enabled: true, runninghub: mapping };
  f.db().prepare('INSERT INTO shared_models VALUES(?,?)').run('rh', JSON.stringify(config));
  f.db().prepare('INSERT INTO provider_settings VALUES(?,?)').run('runninghub', 'test-key');
  f.content.nodes.find((n) => n.id === configId).metadata.model = 'server-rh::123';
}

test('RunningHub multi-output pauses for selection then feeds selected bytes without rewiring', { timeout: 10000 }, async (t) => {
  const calls = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return args[0].apiFormat === 'runninghub' ? [png, png] : png; });
  await useRunningHub(f, { inputs: [], outputNodes: ['7'] });
  f.content.nodes.find((n) => n.id === 'a').metadata.confirmImageSelection = true;
  f.content.nodes.find((n) => n.id === 'out').metadata = {};
  assert.equal((await f.save(f.content, 1)).statusCode, 200);
  const result = await f.submit([{ ...f.step('a', 'out'), model: 'server-rh::123', prompt: '' }, f.step('b', undefined, [{ nodeId: 'out' }])], 'start', randomUUID(), 2);
  assert.equal(result.statusCode, 202, result.body);
  const [waiting] = await f.wait();
  assert.equal(waiting.state, 'waiting_selection');
  assert.equal(waiting.steps[0].outputs.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].runninghubInputs, {});
  const selected = waiting.steps[0].outputs[1];
  assert.equal((await f.send('POST', '/tasks/' + waiting.id + '/select/a', { imageId: selected.id })).statusCode, 200);
  const [done] = await f.wait();
  assert.equal(done.state, 'success');
  assert.deepEqual(calls[1][2][0].bytes, png);
  assert.deepEqual((await f.read()).nodes.at(-1).metadata.references, ['/api/files/' + encodeURIComponent(selected.storageKey)]);
});

test('RunningHub binds pending upstream image and freezes named text inputs; retry reuses saved input', { timeout: 10000 }, async (t) => {
  const calls = [];
  const f = await fixture(t, async (...args) => { calls.push(args); return args[0].apiFormat === 'runninghub' ? [png, png] : png; });
  await useRunningHub(f, { inputs: [
    { id: 'image', nodeId: '8', field: 'image', type: 'image', required: true, label: '图片' },
    { id: 'text', nodeId: '9', field: 'text', type: 'text', required: true, label: '文本' },
  ], outputNodes: ['7'] }, 'b');
  const b = f.content.nodes.find((n) => n.id === 'b');
  b.metadata.runninghubBindings = { image: { mode: 'node', nodeId: 'out' }, text: { mode: 'text', value: 'frozen' } };
  f.content.nodes.find((n) => n.id === 'out').metadata = {};
  f.content.nodes = f.content.nodes.filter((n) => n.id !== 'ignored');
  f.content.connections = f.content.connections.filter((e) => e.toNodeId !== 'ignored');
  b.metadata.replacementOutputId = 'final';
  assert.equal((await f.save(f.content, 1)).statusCode, 200);
  const response = await f.submit([f.step('a', 'out'), { ...f.step('b', 'final'), model: 'server-rh::123', prompt: '', references: [{ nodeId: 'spoof', storageKey: 'spoof' }] }], 'start', randomUUID(), 2);
  assert.equal(response.statusCode, 202, response.body);
  const [task] = await f.wait();
  assert.equal(task.state, 'success');
  assert.deepEqual(calls[1][1].runninghubInputs, { image: { imageIndex: 0 }, text: 'frozen' });
  assert.deepEqual(calls[1][2][0].bytes, png);
  const current = await f.read();
  assert.equal(current.nodes.find((n) => n.id === 'final').metadata.images.length, 2);
  current.nodes.find((n) => n.id === 'b').metadata.runninghubBindings.text.value = 'changed';
  assert.equal((await f.save(current, current.revision)).statusCode, 200);
  const payload = { targetId: 'final', runId: randomUUID(), revision: current.revision + 1 };
  const path = '/tasks/' + task.id + '/retry/b';
  assert.equal((await f.send('POST', path, payload, 'other')).statusCode, 403);
  const retry = await f.send('POST', path, payload);
  assert.equal(retry.statusCode, 202, retry.body);
  const tasks = await f.wait((items) => items.find((item) => item.id === payload.runId)?.state === 'success');
  assert.equal(tasks.find((item) => item.id === payload.runId).steps.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1].runninghubInputs.text, 'frozen');
  assert.deepEqual(calls[2][2][0].bytes, png);
  assert.equal((await f.send('POST', path, payload)).statusCode, 200);
  assert.equal(calls.length, 3);
});
