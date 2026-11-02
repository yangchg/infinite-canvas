import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const src = new URL('../src/', import.meta.url);
const context = vm.createContext({ CanvasNodeType: { Pipeline: 'pipeline', Config: 'config', Image: 'image', Text: 'text', Group: 'group' } });
for (const file of ['lib/canvas/canvas-pipeline.ts', 'lib/canvas/canvas-node-geometry.ts', 'lib/canvas/canvas-resource-references.ts', 'components/canvas/canvas-node-generation.ts']) {
    const code = readFileSync(new URL(file, src), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(stripTypeScriptTypes(code), context);
}
context.getNodeDefinition = () => undefined;
context.i18n = { t: (key) => key };
context.imageReferenceLabel = (index) => `Image ${index + 1}`;
const { planPipeline, executePipeline, normalizeConnection, buildNodeGenerationContext } = context;
const node = (id, type, metadata = {}) => ({ id, type, title: id, metadata });
const config = (id, target) => node(id, 'config', target ? { replacementOutputId: target } : {});
const image = (id) => node(id, 'image', { content: `old-${id}` });
const edge = (fromNodeId, toNodeId) => ({ fromNodeId, toNodeId });
const nodes = [node('start', 'pipeline'), config('a', 'out'), image('out'), config('b'), image('final'), config('ignored')];
const edges = [edge('start', 'a'), edge('a', 'out'), edge('out', 'b'), edge('b', 'final'), edge('final', 'ignored')];

test('replacement continues; new output stops even when existing outputs have downstream links', () => {
    assert.deepEqual(Array.from(planPipeline('start', nodes, edges), (step) => step.nodeId), ['a', 'b']);
});

test('only selected output is followed', () => {
    const graph = [...nodes, image('other')];
    const links = [...edges, edge('a', 'other'), edge('other', 'ignored')];
    assert.deepEqual(Array.from(planPipeline('start', graph, links), (step) => step.nodeId), ['a', 'b']);
});

test('new-output first step is terminal', () => {
    const graph = nodes.map((item) => item.id === 'a' ? config('a') : item);
    assert.equal(planPipeline('start', graph, edges).length, 1);
});

test('reject cycles and invalid targets before any execution', () => {
    const cycle = nodes.map((item) => item.id === 'b' ? config('b', 'final') : item);
    assert.throws(() => planPipeline('start', cycle, [...edges, edge('final', 'a')]), /循环/);
    assert.throws(() => planPipeline('start', nodes, edges.filter((item) => item.fromNodeId !== 'a')), /替换目标/);
    assert.throws(() => planPipeline('start', nodes, []), /连接/);
    assert.throws(() => planPipeline('start', [...nodes, config('c', 'out')], [...edges, edge('start', 'c'), edge('c', 'out')]), /同一个输出/);
});

test('shared downstream executes once after all replacement parents', () => {
    const graph = [...nodes, config('c', 'out-c'), image('out-c')];
    const links = [...edges, edge('start', 'c'), edge('c', 'out-c'), edge('out-c', 'b')];
    const ids = Array.from(planPipeline('start', graph, links), (step) => step.nodeId);
    assert.equal(ids.length, 3);
    assert.equal(ids.at(-1), 'b');
});

test('steps wait for committed new reference; trigger connection never enters prompt', async () => {
    let graph = structuredClone(nodes);
    const calls = [];
    await executePipeline(planPipeline('start', graph, edges), new AbortController().signal, async (step) => {
        const inputs = buildNodeGenerationContext(step.nodeId, graph, edges, 'prompt');
        calls.push(step.nodeId);
        if (step.nodeId === 'a') {
            assert.equal(inputs.referenceImages.length, 0);
            assert.equal(inputs.prompt, 'prompt');
            await Promise.resolve();
            graph = graph.map((item) => item.id === 'out' ? { ...item, metadata: { content: 'new-image', storageKey: 'new-key' } } : item);
        } else {
            assert.equal(inputs.referenceImages[0].dataUrl, 'new-image');
            assert.equal(inputs.referenceImages[0].storageKey, 'new-key');
        }
        return true;
    });
    assert.deepEqual(calls, ['a', 'b']);
});

test('failure or cancellation never starts the next paid step', async () => {
    for (const kind of ['failure', 'cancel', 'throw']) {
        const controller = new AbortController();
        const calls = [];
        await assert.rejects(executePipeline(planPipeline('start', nodes, edges), controller.signal, async (step) => {
            calls.push(step.nodeId);
            if (kind === 'cancel') controller.abort();
            if (kind === 'throw') throw new Error('provider error');
            return kind !== 'failure';
        }));
        assert.deepEqual(calls, ['a']);
    }
});

test('pipeline connects only to config; ordinary connections keep their behavior', () => {
    assert.equal(normalizeConnection('start', 'a', nodes, 'source').toNodeId, 'a');
    assert.equal(normalizeConnection('a', 'start', nodes, 'target').fromNodeId, 'start');
    assert.equal(normalizeConnection('start', 'out', nodes, 'source'), null);
    assert.equal(normalizeConnection('out', 'start', nodes, 'source'), null);
    assert.equal(normalizeConnection('out', 'b', nodes, 'source').toNodeId, 'b');
    assert.equal(normalizeConnection('a', 'b', nodes, 'source'), null);
});
