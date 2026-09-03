// lib/embed.js — ollama /api/embed 客户端。
//
// 仅做 HTTP 调用, 不解析、不归一化(归一化在 lib/vector.storeEmbedding 里统一处理)。
// 失败一律 reject, 让上层 worker 决定是否退避 / 落失败态。

const http = require('node:http');
const https = require('node:https');

function embed({ url, model, input, timeoutSeconds = 30 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, input, truncate: true });
    const u = new URL(url.replace(/\/+$/, '') + '/api/embed');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('ollama http ' + res.statusCode + ': ' + b.slice(0, 200)));
        }
        try { resolve(JSON.parse(b).embeddings); }
        catch (e) { reject(new Error('ollama bad json')); }
      });
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('ollama timeout')); }, timeoutSeconds * 1000);
    req.write(body); req.end();
  });
}

module.exports = { embed };
