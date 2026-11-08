import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { downloadTaskImage } from '../src/task-download.js';
import { generateTaskImage } from '../src/task-images.js';

test('background image downloads follow checked redirects without forwarding credentials', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/v1/images/generations') { request.resume(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ url: `${origin}/redirect` }] })); }
    else if (request.url === '/redirect') { response.writeHead(302, { location: '/image' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else response.end('image bytes');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await generateTaskImage({ model: 'gpt-image-test', apiFormat: 'openai', baseUrl: origin, apiKey: 'test-secret' }, { prompt: 'test', parameters: {} }, [], new AbortController().signal, () => {});
  assert.equal(result.toString(), 'image bytes');
  assert.equal(requests[0].authorization, 'Bearer test-secret');
  assert.equal(requests[1].authorization, undefined);
  assert.equal(requests[2].authorization, undefined);
  await assert.rejects(downloadTaskImage(`${origin}/image`, 'https://provider.example'), /内部网络/);
  await assert.rejects(downloadTaskImage(`${origin}/loop`, origin), /地址无效/);
  await assert.rejects(downloadTaskImage('file:///private', origin), /地址无效/);
});
