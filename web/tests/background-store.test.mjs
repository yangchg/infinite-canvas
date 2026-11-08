import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { canvasContent, mergeCanvas, sameCanvasValue } from '../../server/src/task-merge.js';

test('background sync preserves edits made while save is in flight and persists merged results', async () => {
    let state, release, started;
    const saving = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const base = { id: 'canvas', revision: 1, title: 'test', nodes: [{ id: 'image', position: { x: 0, y: 0 }, metadata: { storageKey: 'old', content: 'blob:old' } }], connections: [] };
    let server = { ...base, nodes: [{ ...base.nodes[0], metadata: { storageKey: 'new', content: '/api/files/new' } }] };
    let puts = 0, events = 0;
    const create = (initializer) => {
        const set = (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
        const get = () => state;
        state = initializer(set, get);
        return { setState: set, getState: get };
    };
    const context = vm.createContext({ create, canvasContent, mergeCanvas, sameCanvasValue, nanoid: () => 'id',
        setTimeout: () => 1, clearTimeout: () => {}, window: { addEventListener() {} }, sessionStorage: {},
        useSessionStore: { getState: () => ({ user: { id: 'user' } }) }, setWorkspaceCsrf() {}, jsonBody: JSON.stringify,
        hydrateModule: { hydrateCanvasImages: async (nodes) => nodes }, canvasCategories: ['通用'],
        workspaceApi: async (url, options) => {
            if (url === '/auth/me') return { user: { id: 'user' }, csrf: 'csrf' };
            if (!options) return { ...server, revision: 2 };
            const input = JSON.parse(options.body);
            puts++;
            if (puts === 1) { started(); await gate; server = mergeCanvas(canvasContent(base), canvasContent(input.content), canvasContent(server)); }
            else server = canvasContent(input.content);
            return { revision: puts + 2, number: '00001', content: server };
        },
    });
    const source = readFileSync(new URL('../src/stores/canvas/use-canvas-store.ts', import.meta.url), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
        .replace('await import("@/lib/canvas/canvas-generation-helpers")', 'hydrateModule');
    vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.store = useCanvasStore;', context);
    const store = context.store;
    store.getState().accept(base);
    context.onCanvasRemoteChange(() => { events++; });
    const sync = store.getState().syncProject('canvas');
    await saving;
    store.getState().updateProject('canvas', { nodes: [{ ...base.nodes[0], position: { x: 42, y: 0 } }] });
    release(); await sync;
    assert.equal(puts, 2);
    assert.equal(events, 1);
    assert.equal(server.nodes[0].metadata.storageKey, 'new');
    assert.equal(server.nodes[0].position.x, 42);
    assert.equal(store.getState().projects[0].nodes[0].metadata.storageKey, 'new');
    assert.equal(store.getState().dirty, false);
});
