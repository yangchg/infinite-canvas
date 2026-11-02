import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNotifier, createNotificationServer } from './server.mjs';

const config = { allowedOrigins: ['http://localhost:3000'], channels: [{ id: 'app', name: 'App', appKey: 'secret-key', appSecret: 'secret-value', agentId: 123, users: [{ id: 'u1', name: 'User' }] }] };
const input = { eventId: 'run1', channel: 'app', users: ['u1'], canvas: 'Canvas', node: 'Config', status: 'success', succeeded: 2, failed: 0, elapsedSeconds: 3 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('app credentials stay server-side; token caching and deduplication cover concurrent sends and restart', async () => {
    const calls = [];
    const records = new Map();
    const fetchImpl = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response(url.includes('accessToken') ? { accessToken: 'token', expireIn: 7200 } : { errcode: 0, task_id: 42 });
    };
    const notifier = createNotifier(config, { fetchImpl, records });
    assert.equal(JSON.stringify(notifier.channels()).includes('secret'), false);
    const results = await Promise.all([notifier.send(input), notifier.send(input)]);
    assert.equal(results[0].state, 'submitted');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.userid_list, 'u1');
    assert.equal(calls[1].body.agent_id, 123);
    assert.equal(calls[1].body.to_all_user, false);
    await notifier.send({ ...input, eventId: 'run2' });
    assert.equal(calls.length, 3);
    await createNotifier(config, { fetchImpl, records }).send(input);
    assert.equal(calls.length, 3);
});

test('asynchronous acceptance is not delivery; pending, delivered, and forbidden results are distinguished', async () => {
    let info = {};
    const notifier = createNotifier(config, { fetchImpl: async (url) => response(url.includes('accessToken') ? { accessToken: 't', expireIn: 1 } : url.includes('getsendresult') ? { errcode: 0, send_result: info } : { errcode: 0, task_id: 1 }) });
    await notifier.send(input);
    assert.equal((await notifier.result('run1')).state, 'submitted');
    info = { unread_user_id_list: ['u1'] };
    assert.equal((await notifier.result('run1')).state, 'delivered');
    await notifier.send({ ...input, eventId: 'run2' });
    info = { forbidden_user_id_list: ['u1'] };
    assert.equal((await notifier.result('run2')).state, 'failed');
});

test('unknown network outcomes never retry; invalid users and persistence failure send nothing', async () => {
    let sends = 0;
    const fetchImpl = async (url) => { if (url.includes('accessToken')) return response({ accessToken: 't', expireIn: 1 }); sends++; throw new Error('connection reset'); };
    const notifier = createNotifier(config, { fetchImpl });
    await assert.rejects(notifier.send({ ...input, users: ['outsider'] }));
    assert.equal(sends, 0);
    assert.equal((await notifier.send(input)).state, 'unknown');
    await notifier.send(input);
    assert.equal(sends, 1);
    await assert.rejects(createNotifier(config, { fetchImpl, save: async () => { throw new Error('disk full'); } }).send(input));
    assert.equal(sends, 1);
});

test('same-origin HTTP API rejects cross-site requests and does not expose secrets', async () => {
    const server = createNotificationServer(config, createNotifier(config, { fetchImpl: async () => { throw new Error('must not call'); } }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        const channels = await (await fetch(`${url}/channels`)).text();
        assert.equal(channels.includes('secret'), false);
        const denied = await fetch(`${url}/send`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        assert.equal(denied.status, 403);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
