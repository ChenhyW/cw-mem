const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { embed } = require('../lib/embed');

function fakeOllama(statusCode, respBody) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const body = JSON.parse(b);
        const n = Array.isArray(body.input) ? body.input.length : 1;
        res.writeHead(statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respBody || { model: body.model, embeddings: Array.from({length:n}, () => [0.1,0.2,0.3]) }));
      });
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('embed single string returns one vector', async () => {
  const s = await fakeOllama(); try {
    const vecs = await embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: 'hello', timeoutSeconds: 5 });
    assert.equal(vecs.length, 1);
    assert.deepEqual(vecs[0], [0.1,0.2,0.3]);
  } finally { s.close(); }
});

test('embed array returns N vectors in order', async () => {
  const s = await fakeOllama(); try {
    const vecs = await embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: ['a','b'], timeoutSeconds: 5 });
    assert.equal(vecs.length, 2);
  } finally { s.close(); }
});

test('embed rejects on non-200', async () => {
  const s = await fakeOllama(500, {}); try {
    await assert.rejects(() => embed({ url: `http://127.0.0.1:${s.address().port}`, model: 'm', input: 'x', timeoutSeconds: 5 }));
  } finally { s.close(); }
});
