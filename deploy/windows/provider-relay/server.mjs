import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Loopback-only fixed upstream. No credentials, URLs or bodies are logged.
const upstream = new URL('https://api.niumatoken.com');
const maxBytes = 100 * 1024 * 1024;
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers) {
  const result = { ...headers };
  for (const name of [...hopHeaders, ...(headers.connection || '').split(',').map(s => s.trim().toLowerCase())]) delete result[name];
  return result;
}

export function createRelay(request = https.request, log = record => console.log(JSON.stringify(record))) {
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"service":"canvas-fixed-provider-relay"}');
  }
  // This process is not a general HTTP proxy; even an absolute-form URL is rejected.
  if (!req.url.startsWith('/v1/')) { res.writeHead(404); return res.end(); }
  const started = performance.now();
  const incomingId = req.headers['x-canvas-request-id'];
  const requestId = typeof incomingId === 'string' && /^[a-f0-9]{32}$/.test(incomingId) ? incomingId : randomUUID();
  const diagnostic = { requestId, source: 'relay', status: 0, upstreamStatus: null, headersMs: null, errorCode: null };
  res.setHeader('X-Canvas-Request-Id', requestId);
  res.setHeader('X-Canvas-Relay-Origin', 'relay');
  res.once('close', () => log({ ...diagnostic, status: res.statusCode, elapsedMs: Math.round(performance.now() - started), completed: res.writableFinished }));
  if (Number(req.headers['content-length']) > maxBytes) { res.writeHead(413); return res.end(); }
  const headers = cleanHeaders(req.headers);
  headers.host = upstream.host;
  delete headers.cookie; delete headers.origin; delete headers.referer;
  let bytes = 0, remoteResponse;
  const fail = (status, code) => {
    diagnostic.errorCode = code || diagnostic.errorCode;
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: status === 504 ? 'Fixed provider upstream timeout' : status === 413 ? 'Request body exceeds 100 MiB' : 'Fixed provider connection failed', code: diagnostic.errorCode, request_id: requestId, source: 'relay' } }));
  };
  const remote = request({ hostname: upstream.hostname, port: 443, path: req.url,
    method: req.method, headers, rejectUnauthorized: true }, response => {
    remoteResponse = response;
    diagnostic.source = 'upstream';
    diagnostic.upstreamStatus = response.statusCode;
    diagnostic.headersMs = Math.round(performance.now() - started);
    const responseHeaders = cleanHeaders(response.headers);
    responseHeaders['x-canvas-request-id'] = requestId;
    responseHeaders['x-canvas-relay-origin'] = 'upstream';
    // Retain same-provider redirects within the same-origin relay path.
    const location = responseHeaders.location;
    if (location?.startsWith(`${upstream.origin}/`)) responseHeaders.location = `/relay/provider/${location.slice(upstream.origin.length + 1)}`;
    else if (location?.startsWith('/v1/')) responseHeaders.location = `/relay/provider${location}`;
    res.writeHead(response.statusCode, responseHeaders);
    response.on('error', error => { diagnostic.errorCode = error.code || 'UPSTREAM_RESPONSE_ERROR'; res.destroy(); });
    response.pipe(res);
  });
  const connectTimer = setTimeout(() => { fail(504, 'UPSTREAM_CONNECT_TIMEOUT'); remote.destroy(); }, 30_000);
  remote.once('socket', socket => {
    if (!socket.connecting) clearTimeout(connectTimer);
    socket.once('secureConnect', () => clearTimeout(connectTimer));
  });
  remote.on('close', () => clearTimeout(connectTimer));
  remote.setTimeout(300_000, () => { fail(504, 'UPSTREAM_IDLE_TIMEOUT'); remote.destroy(); });
  remote.on('error', error => fail(502, diagnostic.errorCode || error.code || 'UPSTREAM_CONNECTION_ERROR'));
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { req.unpipe(remote); fail(413); remote.destroy(); req.resume(); }
  });
  req.on('aborted', () => remote.destroy());
  req.on('error', () => remote.destroy());
  res.on('close', () => { remote.destroy(); remoteResponse?.destroy(); });
  req.pipe(remote);
});
// Idle limits, not a total-duration limit: long active SSE streams can continue.
server.requestTimeout = 0;
server.setTimeout(300_000, socket => socket.destroy());
server.on('error', error => { console.error(`Provider relay failed (${error.code || 'unknown'})`); process.exitCode = 1; });
return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRelay().listen(17373, '127.0.0.1');
}
