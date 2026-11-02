import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Exercise the actual page handler and graph/reference helpers without paid API calls.
const src = new URL('../src/', import.meta.url);
const page = readFileSync(new URL('pages/canvas/project.tsx', src), 'utf8');
const handler = page.slice(page.indexOf('    const handleReplaceOutput ='), page.indexOf('    const handleGenerateNode ='));
const node = (id, type, metadata = {}) => ({ id, type, title: id, position: { x: 10, y: 20 }, width: 240, height: 180, metadata });
const edge = (fromNodeId, toNodeId) => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });

function setup({ fail = false, count = 1, beforeReturn = () => {}, referenced = false } = {}) {
    const nodes = [node('config', 'config', { composerContent: referenced ? '@[node:ref] current prompt' : 'current prompt' }), node('output', 'image', { content: 'old', storageKey: 'old-key' }), node('other', 'image', { content: 'other-old' }), node('downstream', 'config'), node('ref', 'image', { content: 'reference', storageKey: 'ref-key' })];
    const connections = [edge('config', 'output'), edge('config', 'other'), edge('output', 'downstream'), ...(referenced ? [edge('ref', 'config')] : [])];
    const calls = [];
    const notices = [];
    let sequence = 0;
    const context = vm.createContext({
        modelOptionName: (value) => value, AbortController, Error, clearTimeout, setTimeout,
        CanvasNodeType: { Pipeline: 'pipeline', Config: 'config', Image: 'image', Text: 'text', Video: 'video', Audio: 'audio', Group: 'group' },
        NODE_STATUS_SUCCESS: 'success',
        nodesRef: { current: nodes }, connectionsRef: { current: connections },
        generationRequestsRef: { current: new Map() },
        pipelineRunRef: { current: null },
        historyCommitTimerRef: { current: null }, historyRef: { current: { past: [], future: [] } }, lastHistoryRef: { current: null },
        beginNotification: (id, details) => (outcome) => { context.notificationOutcome = outcome; context.notificationDetails = { ...details }; },
        effectiveConfig: {}, useCallback: (fn) => fn, isAiConfigReady: () => true, openConfigDialog: () => {},
        buildGenerationConfig: () => ({ model: 'chosen-model', count: String(count), size: '1024x1024', quality: 'high' }),
        getGenerationCount: Number, getNodeDefinition: () => undefined,
        i18n: { t: (key) => key }, imageReferenceLabel: (index) => `Image ${index + 1}`, t: (key) => key,
        nanoid: () => `new-${++sequence}`,
        message: { error: (value) => notices.push(value), info: (value) => notices.push(value) },
        isGenerationCanceled: (error) => error.name === 'AbortError',
        setRunningNodeId: () => {}, setHistoryState: () => {},
        uploadImage: async (data) => ({ url: data, storageKey: `${data}-key`, width: 512, height: 256, bytes: 12, mimeType: 'image/png' }),
    });
    for (const path of ['lib/canvas/canvas-resource-references.ts', 'components/canvas/canvas-node-generation.ts', 'lib/canvas/canvas-node-factory.ts', 'lib/canvas/canvas-node-size.ts', 'lib/canvas/canvas-pipeline.ts', 'lib/canvas/canvas-notifications.ts']) {
        const source = readFileSync(new URL(path, src), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
        vm.runInContext(stripTypeScriptTypes(source), context);
    }
    context.hydrateNodeGenerationContext = async (value) => value;
    context.createHistoryEntry = () => ({ nodes: context.nodesRef.current, connections: context.connectionsRef.current });
    context.setNodes = (next) => { context.nodesRef.current = typeof next === 'function' ? next(context.nodesRef.current) : next; };
    context.startGenerationRequest = (targetNodeId, originNodeId, runningNodeId, controller = new AbortController()) => {
        context.generationRequestsRef.current.set(targetNodeId, { controller });
        return controller;
    };
    context.finishGenerationRequest = (id, controller) => {
        if (context.generationRequestsRef.current.get(id)?.controller === controller) context.generationRequestsRef.current.delete(id);
    };
    const request = async (config, prompt, refs, options) => {
        calls.push({ config, prompt, refs });
        await beforeReturn(context);
        if (fail) throw new Error('generation failed');
        return [{ dataUrl: `new-image-${calls.length}` }];
    };
    context.requestGeneration = (config, prompt, options) => request(config, prompt, [], options);
    context.requestEdit = request;
    vm.runInContext(stripTypeScriptTypes(handler) + '\nglobalThis.replace = handleReplaceOutput;', context);
    context.applyHistory = (entry) => { context.setNodes(entry.nodes); context.lastHistoryRef.current = entry; };
    const undoRedo = page.slice(page.indexOf('    const undoCanvas ='), page.indexOf('\n    const ', page.indexOf('    const redoCanvas =') + 12));
    vm.runInContext(stripTypeScriptTypes(undoRedo) + '\nglobalThis.undo = undoCanvas; globalThis.redo = redoCanvas;', context);
    return { context, nodes, connections, calls, notices };
}

test('replaces only explicit output; preserves topology/position; next downstream run reads new image; undo/redo', async () => {
    const { context, nodes, connections, calls } = setup({ referenced: true, count: 2 });
    await context.replace('config', 'output');
    const after = context.nodesRef.current;
    assert.equal(after.length, nodes.length);
    assert.equal(context.connectionsRef.current, connections);
    assert.equal(after[1].id, nodes[1].id);
    assert.equal(after[1].position, nodes[1].position);
    assert.equal(after[2], nodes[2]);
    assert.equal(after[1].metadata.images.length, 2);
    assert.equal(after[1].metadata.model, 'chosen-model');
    assert.equal(after[1].metadata.quality, 'high');
    assert.match(after[1].metadata.prompt, /current prompt/);
    assert.equal(calls.length, 2); // No downstream generation.
    assert.equal(calls[0].refs[0].dataUrl, 'reference');
    const downstream = () => context.buildNodeGenerationContext('downstream', context.nodesRef.current, connections, 'next');
    assert.equal(downstream().referenceImages[0].dataUrl, after[1].metadata.content);
    assert.equal(downstream().referenceImages[0].storageKey, after[1].metadata.storageKey);
    assert.equal(context.historyRef.current.past.length, 1);
    context.undo();
    assert.equal(downstream().referenceImages[0].dataUrl, 'old');
    context.redo();
    assert.equal(downstream().referenceImages[0].dataUrl, after[1].metadata.content);
});

test('failure preserves original nodes and history', async () => {
    const { context, nodes, notices } = setup({ fail: true });
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current, nodes);
    assert.equal(context.historyRef.current.past.length, 0);
    assert.equal(notices.length, 1);
    assert.equal(context.generationRequestsRef.current.size, 0);
});

test('cancel even when provider returns successfully preserves original image', async () => {
    const { context, nodes } = setup({ beforeReturn: (ctx) => ctx.generationRequestsRef.current.get('config').controller.abort() });
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current, nodes);
    assert.equal(context.historyRef.current.past.length, 0);
});

test('missing, incoming, and non-image targets never issue a request', async () => {
    const { context, calls } = setup({ referenced: true });
    for (const id of ['', 'missing', 'ref', 'downstream']) await context.replace('config', id);
    assert.equal(calls.length, 0);
});

test('disconnected target is not overwritten after generation', async () => {
    const { context, nodes } = setup({ beforeReturn: (ctx) => { ctx.connectionsRef.current = []; } });
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current, nodes);
});

test('an edited target is not overwritten after generation', async () => {
    const { context } = setup({ beforeReturn: (ctx) => { ctx.nodesRef.current = ctx.nodesRef.current.map((item) => item.id === 'output' ? { ...item, metadata: { content: 'user-edited' } } : item); } });
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current[1].metadata.content, 'user-edited');
    assert.equal(context.historyRef.current.past.length, 0);
});

test('partial batch failure does not commit any successful image', async () => {
    const { context, nodes } = setup({ count: 2 });
    let calls = 0;
    context.requestGeneration = async () => {
        if (++calls === 2) throw new Error('second image failed');
        return [{ dataUrl: 'first-image' }];
    };
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current, nodes);
    assert.equal(context.historyRef.current.past.length, 0);
});

test('cancel during upload does not commit even if upload ignores abort', async () => {
    const { context, nodes } = setup();
    const upload = context.uploadImage;
    context.uploadImage = async (data) => {
        context.generationRequestsRef.current.get('config').controller.abort();
        return upload(data);
    };
    await context.replace('config', 'output');
    assert.equal(context.nodesRef.current, nodes);
});

function attachPipeline(context) {
    context.nodesRef.current = [node('entry', 'pipeline'), ...context.nodesRef.current.map((item) => item.id === 'config' ? { ...item, metadata: { ...item.metadata, replacementOutputId: 'output' } } : item)];
    context.connectionsRef.current = [edge('entry', 'config'), ...context.connectionsRef.current];
    context.setPipelineState = (state) => { context.pipelineState = state; };
    context.stopGenerationByRunningId = () => {};
    context.handleGenerateNode = async (id, mode, prompt, execution) => {
        const input = context.buildNodeGenerationContext(id, context.nodesRef.current, context.connectionsRef.current, prompt);
        context.downstreamInput = input.referenceImages[0];
        execution.onSuccess();
    };
    const runner = page.slice(page.indexOf('    const handleRunPipeline ='), page.indexOf('\n    useEffect(', page.indexOf('    const handleRunPipeline =')));
    vm.runInContext(stripTypeScriptTypes(runner) + '\nglobalThis.runPipeline = handleRunPipeline;', context);
}

test('actual page runner waits for real replacement handler before starting downstream', async () => {
    const { context } = setup();
    attachPipeline(context);
    await context.runPipeline('entry');
    assert.match(context.downstreamInput.dataUrl, /^new-image/);
    assert.match(context.downstreamInput.storageKey, /^new-image/);
    assert.equal(context.pipelineState.status, '已完成 2 个步骤');
    assert.equal(context.pipelineRunRef.current, null);
});

test('actual page runner does not call downstream after replacement failure', async () => {
    const { context, nodes } = setup({ fail: true });
    attachPipeline(context);
    await context.runPipeline('entry');
    assert.equal(context.downstreamInput, undefined);
    assert.equal(context.nodesRef.current.find((item) => item.id === 'output').metadata, nodes[1].metadata);
    assert.equal(context.pipelineState.running, false);
    assert.match(context.pipelineState.status, /generation failed/);
});

test('actual page runner stops on cancellation and preserves original image', async () => {
    const { context, nodes } = setup({ beforeReturn: (state) => state.pipelineRunRef.current.controller.abort() });
    attachPipeline(context);
    await context.runPipeline('entry');
    assert.equal(context.downstreamInput, undefined);
    assert.equal(context.nodesRef.current.find((item) => item.id === 'output').metadata, nodes[1].metadata);
    assert.equal(context.pipelineState.status, '已停止，保留已完成的结果');
    assert.equal(context.pipelineRunRef.current, null);
});

test('actual page runner checks all models before the first paid request', async () => {
    const { context, calls } = setup();
    attachPipeline(context);
    let checked = 0;
    context.isAiConfigReady = () => ++checked < 2;
    await context.runPipeline('entry');
    assert.equal(calls.length, 0);
    assert.equal(context.downstreamInput, undefined);
    assert.match(context.pipelineState.status, /所有步骤的可用模型/);
});

function attachNormalGeneration(context) {
    Object.assign(context, {
        NODE_STATUS_LOADING: 'loading', NODE_STATUS_ERROR: 'error', NODE_STATUS_IDLE: 'idle',
        NODE_DEFAULT_SIZE: { config: { width: 340, height: 240 }, image: { width: 340, height: 240 }, text: { width: 340, height: 240 } },
        completeVideoNodeTask: () => {}, setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDialogNodeId: () => {},
        isVideoTaskFailed: () => false,
        setConnections: (fn) => { context.connectionsRef.current = fn(context.connectionsRef.current); },
    });
    const normal = page.slice(page.indexOf('    const handleGenerateNode ='), page.indexOf('    const stopPipeline ='));
    vm.runInContext(stripTypeScriptTypes(normal) + '\nglobalThis.generate = handleGenerateNode;', context);
}

test('normal image generation notifies once after the entire batch, including partial failure', async () => {
    for (const fail of [false, true]) {
        const { context } = setup({ count: 2 });
        attachNormalGeneration(context);
        let sent = 0;
        context.beginNotification = () => (result) => { sent++; context.notificationOutcome = result; };
        let calls = 0;
        context.requestGeneration = async () => { if (++calls === 2 && fail) throw new Error('failed'); return [{ dataUrl: 'generated' }]; };
        await context.generate('config', 'image', 'prompt');
        assert.equal(sent, 1);
        assert.equal(context.notificationOutcome.status, fail ? 'failure' : 'success');
        assert.equal(context.notificationOutcome.succeeded, fail ? 1 : 2);
        assert.equal(context.notificationOutcome.failed, fail ? 1 : 0);
    }
});

test('reference hydration failure notifies and releases generation lock', async () => {
    const { context } = setup();
    attachNormalGeneration(context);
    context.hydrateNodeGenerationContext = async () => { throw new Error('missing reference'); };
    await context.generate('config', 'image', 'prompt');
    assert.equal(context.notificationOutcome.status, 'failure');
    assert.equal(context.generationRequestsRef.current.size, 0);
});

test('replacement notification reports success, failure and cancellation correctly', async () => {
    for (const status of ['success', 'failure', 'canceled']) {
        const { context } = setup({ fail: status === 'failure', beforeReturn: (state) => { if (status === 'canceled') state.generationRequestsRef.current.get('config').controller.abort(); } });
        await context.replace('config', 'output');
        assert.equal(context.notificationOutcome.status, status);
    }
});

test('replacement notification describes the actual assembled request and explicit output target', async () => {
    const { context } = setup();
    const expected = context.buildNodeGenerationContext('config', context.nodesRef.current, context.connectionsRef.current, context.nodesRef.current[0].metadata?.composerContent ?? context.nodesRef.current[0].metadata?.prompt ?? '').prompt.trim();
    await context.replace('config', 'output');
    assert.equal(context.notificationDetails.prompt, expected);
    assert.equal(context.notificationDetails.model, 'chosen-model');
    assert.match(context.notificationDetails.output, /替换指定图片/);
    assert.match(context.notificationDetails.parameters, /1024x1024/);
    assert.match(context.notificationDetails.references, /图片/);
});
