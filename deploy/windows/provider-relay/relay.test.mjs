import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRelay } from './server.mjs';

test('fixed relay preserves multipart, auth, query, errors, and streams before completion', async () => {
  let observed;
  let finishStream;
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      finishStream = () => res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(422, { 'Content-Type': 'application/json', 'X-Test-Upstream': 'preserved' });
      res.end('{"error":"mock unsupported model"}');
    }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  let calls = 0;
  const relay = createRelay((options, callback) => {
    calls++;
    assert.equal(options.hostname, 'api.niumatoken.com');
    assert.equal(options.rejectUnauthorized, true);
    return http.request({ ...options, hostname: '127.0.0.1', port: mock.address().port }, callback);
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const base = `http://127.0.0.1:${relay.address().port}`;
  try {
    const body = Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="test.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\x01binary\r\n--test-boundary--\r\n');
    const result = await fetch(base + '/v1/images/edits?size=auto', { method: 'POST', headers: { Authorization: 'Bearer synthetic-test-only', 'Content-Type': 'multipart/form-data; boundary=test-boundary', Cookie: 'test=discard', Origin: 'http://test.invalid' }, body });
    assert.equal(result.status, 422);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.equal(await result.text(), '{"error":"mock unsupported model"}');
    assert.equal(observed.url, '/v1/images/edits?size=auto');
    assert.equal(observed.method, 'POST');
    assert.equal(observed.headers.authorization, 'Bearer synthetic-test-only');
    assert.equal(observed.headers['content-type'], 'multipart/form-data; boundary=test-boundary');
    assert.equal(observed.headers.cookie, undefined);
    assert.equal(observed.headers.origin, undefined);
    assert.deepEqual(observed.body, body);
    const stream = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"stream":true}' });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
    assert.equal(observed.body.toString(), '{"stream":true}');
    finishStream();
    assert.match(new TextDecoder().decode((await reader.read()).value), /DONE/);
    await reader.cancel();
    assert.equal((await fetch(base + '/https://example.com/v1/models')).status, 404);
    const oversized = await new Promise((resolve, reject) => {
      const req = http.request(base + '/v1/images/edits', { method: 'POST', headers: { 'Content-Length': 104857601 } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.flushHeaders();
    });
    assert.equal(oversized, 413);
    assert.equal(calls, 2);
  } finally {
    finishStream?.();
    relay.closeAllConnections(); mock.closeAllConnections();
    await Promise.all([new Promise(r => relay.close(r)), new Promise(r => mock.close(r))]);
  }
});
