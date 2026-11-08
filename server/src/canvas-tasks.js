import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { digest } from './password.js';
import { transaction } from './database.js';
import { mergeCanvas, sameCanvasValue } from './task-merge.js';
import { planPipeline } from './canvas-pipeline.js';
import { generateTaskImage } from './task-images.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const same = sameCanvasValue;
const active = (task) => ['queued', 'running', 'canceling'].includes(task.state);
const now = () => new Date().toISOString();
const id = z.string().min(1);
const schema = z.object({ runId: id, revision: z.number().int(), entryId: id.optional(), steps: z.array(z.object({
  nodeId: id, targetId: id.optional(), model: id, prompt: z.string().trim().min(1), displayPrompt: z.string(), systemPrompt: z.string().optional(), count: z.number().int().min(1).max(15),
  references: z.array(z.object({ nodeId: id, storageKey: id.optional() })),
  parameters: z.object({ size: z.string().optional(), quality: z.string().optional(), background: z.literal('transparent').optional() }),
  gemini: z.object({ imageConfig: z.object({ aspectRatio: z.string().optional(), imageSize: z.string().optional() }).optional() }).default({}),
  metadata: z.object({ model: id, size: z.string(), quality: z.string(), background: z.string().optional() }),
})).min(1) });

export function rebaseTaskEdits(db, canvasId, revision, content, latestRevision) {
  let value = content, current = revision;
  while (current < latestRevision) {
    const patch = db.prepare('SELECT * FROM task_canvas_changes WHERE canvasId=? AND revision=?').get(canvasId, current);
    if (!patch) fail(409, '服务器已有更新，当前草稿未覆盖服务器；请导出草稿后刷新比较');
    value = mergeCanvas(JSON.parse(patch.beforeContent), value, JSON.parse(patch.afterContent));
    current++;
  }
  if (current !== latestRevision) fail(409, '画布版本已变化');
  return value;
}

export function registerCanvasTasks(app, { canvas, refs, canReadFile, serialize, filesDir, cookieName, generate = generateTaskImage, notifyUrl = process.env.DINGTALK_NOTIFY_URL }) {
  const db = app.db;
  db.exec(`CREATE TABLE IF NOT EXISTS canvas_tasks (id TEXT PRIMARY KEY, canvasId TEXT NOT NULL REFERENCES canvases(id), actor TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_canvas_changes (canvasId TEXT NOT NULL REFERENCES canvases(id), revision INTEGER NOT NULL, beforeContent TEXT NOT NULL, afterContent TEXT NOT NULL, PRIMARY KEY(canvasId,revision));
    CREATE TABLE IF NOT EXISTS task_files (taskId TEXT NOT NULL REFERENCES canvas_tasks(id), fileId TEXT NOT NULL REFERENCES files(id), PRIMARY KEY(taskId,fileId));`);
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const workers = new Map();
  let closing = false;
  const streams = new Set();
  const shutdown = new AbortController();
  const all = () => db.prepare('SELECT data FROM canvas_tasks').all().map((row) => JSON.parse(row.data));
  const get = (taskId) => { const row = db.prepare('SELECT data FROM canvas_tasks WHERE id=?').get(taskId); if (!row) fail(404, '任务不存在'); return JSON.parse(row.data); };
  const view = (task) => ({ id: task.id, canvasId: task.canvasId, entryId: task.entryId, state: task.state, message: task.message,
    createdAt: task.createdAt, updatedAt: task.updatedAt, steps: task.steps.map((step) => ({ nodeId: step.nodeId, targetId: step.targetId, title: step.title, state: step.state, message: step.message, outputs: step.outputs, undone: step.undone, canUndo: Boolean(step.after && !step.undone), notifications: step.notifications })) });
  const save = (task) => {
    if (get(task.id).cancelRequested) { task.cancelRequested = true; if (active(task)) task.state = "canceling"; }
    task.updatedAt = now();
    db.prepare('UPDATE canvas_tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
    events.emit(task.canvasId);
  };
  const userFor = (task) => {
    const user = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(task.actor);
    if (!user) fail(403, '账号已停用，任务已停止');
    return user;
  };
  const owned = (request) => {
    const task = get(request.params.taskId);
    if (task.actor !== request.user.id) fail(403, '无权访问该任务');
    canvas(request.user, task.canvasId, { owner: true });
    return task;
  };
  const check = (task, step) => {
    const user = userFor(task), row = canvas(user, task.canvasId, { owner: true, write: true });
    const content = JSON.parse(row.content);
    if (!content.nodes.some((node) => node.id === step.nodeId && node.type === 'config')) fail(409, '生成配置已删除，任务停止');
    if (task.entryId && !same(planPipeline(task.entryId, content.nodes, content.connections), task.plan)) fail(409, '流水线连线或替换目标已变化，任务停止');
    if (step.targetId) {
      const target = content.nodes.find((node) => node.id === step.targetId);
      if (target?.type !== 'image' || !same(target.metadata, step.before.metadata) || !content.connections.some((edge) => edge.fromNodeId === step.nodeId && edge.toNodeId === step.targetId)) fail(409, '替换目标已修改或断开，结果保留在任务中，未覆盖原图');
    }
    const currentModel = db.prepare('SELECT config FROM shared_models WHERE id=?').get(step.modelId);
    if (!currentModel || !JSON.parse(currentModel.config).enabled) fail(409, '模型已停用或删除，任务停止');
    return { row, content, user };
  };
  const commit = (row, content, user) => {
    refs(user, row.id, content);
    db.prepare('INSERT INTO task_canvas_changes VALUES(?,?,?,?)').run(row.id, row.revision, row.content, JSON.stringify(content));
    db.prepare('UPDATE canvases SET content=?,revision=revision+1,updatedAt=? WHERE id=?').run(JSON.stringify(content), now(), row.id);
  };
  async function notifications(task, step, status) {
    if (closing) return;
    const targets = task.snapshot.nodes.filter((node) => node.type === 'dingtalk' && task.snapshot.connections.some((edge) => edge.fromNodeId === step.nodeId && edge.toNodeId === node.id));
    step.notifications ||= [];
    for (const target of targets) {
      const settings = target.metadata || {};
      if (!(status === 'success' ? settings.notifySuccess !== false : status === 'failure' ? settings.notifyFailure !== false : settings.notifyCanceled === true)) continue;
      const eventId = `${task.id}:${step.nodeId}:${target.id}`;
      if (step.notifications.some((item) => item.eventId === eventId)) continue;
      const record = { nodeId: target.id, eventId, state: 'unknown', message: '通知结果未知' };
      step.notifications.push(record);
      save(task); // Durable event identity before attempting delivery; never replay a possibly delivered event.
      if (!notifyUrl) { record.state = 'failed'; record.message = '后台未配置钉钉通知地址'; save(task); continue; }
      try {
        const response = await fetch(`${notifyUrl.replace(/\/$/, '')}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000))]), body: JSON.stringify({
            eventId: record.eventId, channel: settings.notificationChannel, users: settings.notificationUsers || [], status,
            canvas: task.title, node: step.title, succeeded: step.outputs.length, failed: status === 'failure' ? Math.max(0, step.count - step.outputs.length) : 0,
            elapsedSeconds: Math.round((Date.now() - Date.parse(step.startedAt || task.createdAt)) / 1000),
            details: { kind: '图片', model: step.modelConfig.name, output: step.targetId ? `替换指定图片：${step.before.title}` : '新增输出',
              prompt: step.displayPrompt, parameters: `尺寸 ${step.metadata.size} · 质量 ${step.metadata.quality} · 数量 ${step.count}`, references: `图片 ${step.references.length} 张` },
          }) });
        const result = await response.json();
        Object.assign(record, response.ok ? { state: result.state, message: result.message } : { state: 'failed', message: result.error || '通知服务拒绝请求' });
      } catch { record.message = '通知结果未知，请查询通知服务记录，未自动重发'; }
      save(task);
    }
  }
  async function run(taskId, controller) {
    let task = get(taskId), step;
    try {
      if (task.cancelRequested) controller.abort();
      controller.signal.throwIfAborted();
      task.state = 'running'; save(task);
      for (step of task.steps) {
        controller.signal.throwIfAborted();
        if (step.state === 'success') { await notifications(task, step, 'success'); continue; }
        check(task, step);
        controller.signal.throwIfAborted();
        if (step.jobs.some((job) => job.dispatching && !job.upstreamId && !job.output)) fail(409, '服务重启时生成结果未知；未自动重新提交，请先核对供应商任务记录');
        step.state = 'running'; step.startedAt ||= now(); save(task);
        const generated = await Promise.allSettled(step.jobs.map(async (job) => {
          if (job.output) return;
          check(task, step);
          controller.signal.throwIfAborted();
          const images = await Promise.all(step.references.map(async (reference) => {
            const produced = task.steps.find((previous) => previous.targetId === reference.nodeId && previous.state === 'success');
            const key = produced?.outputs[0]?.storageKey || reference.storageKey;
            if (!canReadFile(userFor(task), key)) fail(403, '参考图片无权访问');
            const file = db.prepare('SELECT mime FROM files WHERE id=?').get(key);
            return { mime: file.mime, bytes: await readFile(join(filesDir, digest(key))) };
          }));
          if (job.dispatching && !job.upstreamId) fail(409, '服务重启时生成结果未知；未自动重新提交，请先核对供应商任务记录');
          job.dispatching = true;
          transaction(db, () => {
            if (!task.counted) {
              const row = canvas(userFor(task), task.canvasId, { owner: true, write: true });
              const sourceId = row.kind === 'usage' ? row.sourceId : row.publishedId ? row.id : null;
              if (sourceId) {
                const source = canvas(userFor(task), sourceId);
                if (source.publishedId) db.prepare('INSERT OR IGNORE INTO canvas_usage_runs VALUES(?,?,?)').run(sourceId, task.actor, task.id);
              }
              task.counted = true;
            }
            save(task);
          });
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 300_000))]);
          const bytes = await generate(step.modelConfig, step, images, signal, (upstreamId) => { job.upstreamId = upstreamId; save(task); }, job.upstreamId);
          const dimensions = imageSize(bytes);
          if (!dimensions.width || !dimensions.height || !['png', 'jpg', 'webp', 'gif', 'avif'].includes(dimensions.type)) throw new Error('生成结果不是支持的图片');
          const storageKey = `image:${randomUUID()}`, mimeType = `image/${dimensions.type === 'jpg' ? 'jpeg' : dimensions.type}`;
          await writeFile(join(filesDir, digest(storageKey)), bytes, { flag: 'wx' });
          transaction(db, () => {
            db.prepare('INSERT INTO files VALUES(?,?,?,?)').run(storageKey, task.actor, mimeType, bytes.length);
            db.prepare('INSERT INTO task_files VALUES(?,?)').run(task.id, storageKey);
            job.output = { id: randomUUID(), status: 'success', content: `/api/files/${encodeURIComponent(storageKey)}`, storageKey, naturalWidth: dimensions.width, naturalHeight: dimensions.height, bytes: bytes.length, mimeType };
            step.outputs = step.jobs.flatMap((item) => item.output ? [item.output] : []);
            job.dispatching = false; delete job.upstreamId; save(task);
          });
        }));
        const failure = generated.find((item) => item.status === 'rejected');
        if (failure && (step.targetId || !step.outputs.length)) throw failure.reason;
        controller.signal.throwIfAborted();
        transaction(db, () => {
          const { row, content, user } = check(task, step);
          const source = content.nodes.find((node) => node.id === step.nodeId);
          const primary = step.outputs[0];
          const metadata = { ...step.metadata, ...primary, count: step.count, images: step.outputs, primaryImageId: primary.id, prompt: step.displayPrompt,
            modelSource: 'server', generationType: step.references.length ? 'edit' : 'generation', references: step.references.map((reference) => {
              const previous = task.steps.find((item) => item.targetId === reference.nodeId && item.state === 'success');
              return `/api/files/${encodeURIComponent(previous?.outputs[0]?.storageKey || reference.storageKey)}`;
            }) };
          delete metadata.id;
          if (step.targetId) {
            const target = content.nodes.find((node) => node.id === step.targetId);
            const scale = Math.min(1, target.width / primary.naturalWidth, target.height / primary.naturalHeight);
            Object.assign(target, { width: primary.naturalWidth * scale, height: primary.naturalHeight * scale, metadata: { ...target.metadata, ...metadata, errorDetails: undefined } });
            step.after = structuredClone(target);
          } else {
            // Match the existing image-node batch presentation and default 340 × 240 frame.
            const scale = Math.min(1, 340 / primary.naturalWidth, 240 / primary.naturalHeight);
            const width = primary.naturalWidth * scale, height = primary.naturalHeight * scale;
            const node = { id: `image-${randomUUID()}`, type: 'image', title: step.displayPrompt.slice(0, 32), width, height,
              position: { x: source.position.x + 340 + 96 + (340 - width) / 2, y: source.position.y + (240 - height) / 2 }, metadata };
            content.nodes.push(node); content.connections.push({ id: randomUUID(), fromNodeId: step.nodeId, toNodeId: node.id });
          }
          commit(row, content, user);
          step.state = failure ? 'failed' : 'success'; save(task);
        });
        if (failure) throw failure.reason;
        await notifications(task, step, 'success');
      }
      controller.signal.throwIfAborted();
      task.state = 'success'; task.message = '已完成，结果已保存到画布'; save(task);
    } catch (error) {
      if (closing) return; // Keep the checkpoint for restart reconciliation.
      const canceled = controller.signal.aborted;
      task.state = canceled ? 'canceled' : error.statusCode === 409 ? 'conflict' : 'failed';
      task.message = canceled ? '已停止后续执行，供应商已提交的任务可能仍运行并计费' : error.message;
      if (step && step.state !== 'success') { step.state = task.state; step.message = task.message; }
      for (const pending of task.steps) if (pending.state === 'queued') pending.state = 'skipped';
      save(task);
      if (step && step.state !== 'success') await notifications(task, step, canceled ? 'canceled' : 'failure');
    }
  }
  const start = (taskId) => {
    if (workers.has(taskId) || closing) return;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => run(taskId, controller)).finally(() => workers.delete(taskId));
    workers.set(taskId, { controller, promise });
  };
  app.post('/api/canvases/:id/tasks', async (request, reply) => {
    const input = schema.parse(request.body);
    const row = canvas(request.user, request.params.id, { owner: true, write: true });
    const existing = db.prepare('SELECT data FROM canvas_tasks WHERE id=?').get(input.runId);
    if (existing) {
      const task = JSON.parse(existing.data);
      if (task.actor !== request.user.id || task.canvasId !== row.id) fail(409, '运行标识已被使用');
      return view(task);
    }
    if (row.revision !== input.revision) fail(409, '画布已变化，请同步后再提交');
    const snapshot = JSON.parse(row.content);
    const plan = input.entryId ? planPipeline(input.entryId, snapshot.nodes, snapshot.connections) : input.steps.map(({ nodeId, targetId }) => ({ nodeId, ...(targetId ? { targetId } : {}) }));
    if ((!input.entryId && input.steps.length !== 1) || !same(plan, input.steps.map(({ nodeId, targetId }) => ({ nodeId, ...(targetId ? { targetId } : {}) })))) fail(400, '任务步骤与流水线不一致');
    const locks = new Set(input.steps.flatMap((step) => [step.nodeId, step.targetId].filter(Boolean)));
    if (all().some((task) => task.canvasId === row.id && active(task) && task.steps.some((step) => locks.has(step.nodeId) || locks.has(step.targetId)))) fail(409, '相关配置或输出图片已有后台任务，请等待完成或停止');
    const steps = input.steps.map((step) => {
      const node = snapshot.nodes.find((item) => item.id === step.nodeId);
      if (node?.type !== 'config' || (node.metadata?.generationMode || 'image') !== 'image' || (node.metadata?.model && node.metadata.model !== step.model)) fail(400, '后台执行仅支持当前配置的服务器图片模型');
      const modelId = /^server-([^:]+)::/.exec(step.model)?.[1];
      const stored = modelId && db.prepare('SELECT config FROM shared_models WHERE id=?').get(modelId);
      if (!stored) fail(400, '服务器模型不存在');
      const modelConfig = JSON.parse(stored.config);
      if (!modelConfig.enabled || modelConfig.capability !== 'image' || step.model !== `server-${modelId}::${modelConfig.model}`) fail(400, '服务器图片模型不可用');
      if (modelConfig.apiFormat === 'runninghub') {
        modelConfig.apiKey = db.prepare("SELECT apiKey FROM provider_settings WHERE provider='runninghub'").get()?.apiKey;
        if (!modelConfig.apiKey || step.references.length !== 1 || step.count !== 1) fail(400, 'RunningHub 需要全局 Key、1 张参考图及单张输出');
      }
      if (modelConfig.apiFormat === 'comfyui' && step.references.length) fail(400, '当前 ComfyUI 不支持参考图');
      const before = step.targetId ? snapshot.nodes.find((item) => item.id === step.targetId) : undefined;
      if (step.targetId && (before?.type !== 'image' || !snapshot.connections.some((edge) => edge.fromNodeId === step.nodeId && edge.toNodeId === step.targetId))) fail(400, '替换目标必须是直接连接的输出图片');
      for (const reference of step.references) {
        const image = snapshot.nodes.find((item) => item.id === reference.nodeId);
        const upstream = plan.slice(0, plan.findIndex((item) => item.nodeId === step.nodeId)).some((item) => item.targetId === reference.nodeId);
        if (upstream && image?.type === 'image' && !reference.storageKey && !image.metadata?.storageKey) continue;
        if (!image || !reference.storageKey || image.metadata?.storageKey !== reference.storageKey || !canReadFile(request.user, reference.storageKey)) fail(400, '参考图必须先保存到服务器');
      }
      return { ...step, metadata: { ...step.metadata, model: step.model }, modelId, modelConfig, title: node.title, before, state: 'queued', outputs: [], jobs: Array.from({ length: step.count }, () => ({})) };
    });
    const task = { id: input.runId, canvasId: row.id, actor: request.user.id, title: row.title, entryId: input.entryId, plan, snapshot, steps, state: 'queued', createdAt: now(), updatedAt: now() };
    db.prepare('INSERT INTO canvas_tasks VALUES(?,?,?,?)').run(task.id, row.id, task.actor, JSON.stringify(task));
    events.emit(row.id); start(task.id);
    return reply.code(202).send(view(task));
  });
  app.get('/api/canvases/:id/tasks', async (request) => {
    canvas(request.user, request.params.id, { owner: true });
    return all().filter((task) => task.canvasId === request.params.id && task.actor === request.user.id).map(view);
  });
  app.get('/api/canvases/:id/task-events', async (request, reply) => {
    canvas(request.user, request.params.id, { owner: true });
    streams.add(reply.raw);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const update = (heartbeat = false) => {
      try {
        canvas(userFor({ actor: request.user.id }), request.params.id, { owner: true });
        if (!db.prepare('SELECT 1 FROM sessions WHERE token=? AND userId=? AND expires>?').get(digest(request.cookies[cookieName]), request.user.id, Date.now())) { reply.raw.end(); return; }
        // SSE comments keep the proxy connection alive without causing browser refreshes.
        reply.raw.write(heartbeat ? ': keepalive\n\n' : `data: ${JSON.stringify({ changed: true })}\n\n`);
      } catch { reply.raw.end(); }
    };
    const heartbeat = setInterval(() => update(true), 15_000);
    heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); events.off(request.params.id, update); streams.delete(reply.raw); };
    reply.raw.on('close', cleanup);
    events.on(request.params.id, update); update();
  });
  app.post('/api/tasks/:taskId/cancel', async (request) => {
    const task = owned(request);
    if (active(task)) {
      workers.get(task.id)?.controller.abort();
      task.cancelRequested = true; task.state = 'canceling'; task.message = '已请求停止，供应商任务可能仍运行并计费'; save(task);
    }
    return view(task);
  });
  app.post('/api/tasks/:taskId/undo/:nodeId', async (request) => {
    const task = owned(request), step = task.steps.find((item) => item.nodeId === request.params.nodeId);
    if (!step?.after || step.undone || active(task)) fail(409, '任务未结束或没有可撤销的替换');
    if (all().some((item) => item.canvasId === task.canvasId && active(item) && item.steps.some((next) => next.targetId === step.targetId || next.nodeId === step.nodeId))) fail(409, '目标正在生成，暂不能撤销');
    return transaction(db, () => {
      const row = canvas(request.user, task.canvasId, { owner: true, write: true }), content = JSON.parse(row.content);
      const target = content.nodes.find((node) => node.id === step.targetId);
      if (!target || !same(target.metadata, step.after.metadata)) fail(409, '目标图片已变化，未覆盖更新内容');
      target.metadata = step.before.metadata;
      if (target.width === step.after.width && target.height === step.after.height) { target.width = step.before.width; target.height = step.before.height; }
      commit(row, content, request.user); step.undone = true; save(task);
      return serialize(db.prepare('SELECT * FROM canvases WHERE id=?').get(task.canvasId));
    });
  });
  app.addHook('onReady', async () => { for (const task of all()) if (active(task)) start(task.id); });
  const close = async () => { closing = true; shutdown.abort(); for (const stream of streams) stream.end(); for (const worker of workers.values()) worker.controller.abort(); await Promise.allSettled([...workers.values()].map((worker) => worker.promise)); };
  app.addHook('preClose', close);
  return { close };
}
