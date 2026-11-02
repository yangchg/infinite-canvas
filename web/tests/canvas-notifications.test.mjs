import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const context = vm.createContext({ CanvasNodeType: { DingTalk: 'dingtalk', Config: 'config', Pipeline: 'pipeline', Image: 'image' } });
for (const file of ['canvas-notifications', 'canvas-node-geometry', 'canvas-pipeline']) {
    vm.runInContext(stripTypeScriptTypes(readFileSync(new URL(`../src/lib/canvas/${file}.ts`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')), context);
}
const nodes = [{ id: 'c', type: 'config' }, { id: 'n', type: 'dingtalk' }, { id: 'i', type: 'image' }, { id: 'p', type: 'pipeline' }];
test('only directly linked config notifications are selected; cancel is opt-in', () => {
    const edges = [{ fromNodeId: 'c', toNodeId: 'n' }];
    assert.equal(context.notificationTargets('c', nodes, edges).length, 1);
    assert.equal(context.notificationTargets('i', nodes, edges).length, 0);
    assert.equal(context.notificationEnabled(nodes[1], { status: 'success' }), true);
    assert.equal(context.notificationEnabled(nodes[1], { status: 'failure' }), true);
    assert.equal(context.notificationEnabled(nodes[1], { status: 'canceled' }), false);
});
test('notification links never become references or pipeline generation steps', () => {
    const { normalizeConnection, planPipeline } = context;
    assert.equal(normalizeConnection('n', 'c', nodes, 'target').fromNodeId, 'c');
    assert.equal(normalizeConnection('p', 'n', nodes, 'source'), null);
    assert.equal(normalizeConnection('n', 'i', nodes, 'target'), null);
    const steps = planPipeline('p', nodes, [{ fromNodeId: 'p', toNodeId: 'c' }, { fromNodeId: 'c', toNodeId: 'n' }]);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].nodeId, 'c');
});
