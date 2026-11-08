import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

// Resolve once and pin the checked addresses to the connection, including redirects.
export async function downloadTaskImage(address, modelOrigin, signal, visited = new Set()) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || visited.has(url.href)) throw new Error('图片下载地址无效');
  visited.add(url.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || (url.origin !== modelOrigin && addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast'))) throw new Error('模型返回的图片地址不能访问内部网络');
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    }, resolve);
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadTaskImage(new URL(response.headers.location, url).href, modelOrigin, signal, visited);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`图片下载返回 HTTP ${response.statusCode}`); }
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}
