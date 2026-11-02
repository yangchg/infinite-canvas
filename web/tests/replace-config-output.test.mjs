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
        AbortController, clearTimeout, setTimeout,
        CanvasNodeType: { Config: 'config', Image: 'image', Text: 'text', Video: 'video', Audio: 'audio', Group: 'group' },
        NODE_STATUS_SUCCESS: 'success',
        nodesRef: { current: nodes }, connectionsRef: { current: connections },
        generationRequestsRef: { current: new Map() },
        historyCommitTimerRef: { current: null }, historyRef: { current: { past: [], future: [] } }, lastHistoryRef: { current: null },
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
    for (const path of ['lib/canvas/canvas-resource-references.ts', 'components/canvas/canvas-node-generation.ts', 'lib/canvas/canvas-node-factory.ts', 'lib/canvas/canvas-node-size.ts']) {
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
