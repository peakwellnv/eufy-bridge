import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { mountRecordings } from './recordings-routes.js';
import { MediaError } from './media.js';

test('real server protects both recordings routes; default off preserves 404 and health', async () => {
  for (const flag of ['', 'true']) {
    const directory = await mkdtemp(join(tmpdir(), 'recordings-auth-'));
    // The existing server logs configured PORT, so capture the actual listening
    // port through a preloaded shim in the child without changing server behavior.
    const preload = join(directory, 'port.cjs');
    await writeFile(preload, `const http=require('node:http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){this.once('listening',()=>console.log('TEST_PORT='+this.address().port));return listen.apply(this,args)};`);
    const server = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: new URL('./', import.meta.url),
      env: { ...process.env, PORT: '0', BRIDGE_HOST: '127.0.0.1', BRIDGE_AUTH_TOKEN: 'test-recordings-token',
        RECORDINGS_ENABLED: flag, EUFY_EMAIL: '', EUFY_PASSWORD: '', EUFY_SESSION_PATH: join(directory, 'session.json') } });
    server.stderr.resume();
    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Server startup timed out')), 10000);
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.once('exit', () => { clearTimeout(timer); reject(Error('Server exited before listening')); });
        server.stdout.on('data', chunk => { const match = /TEST_PORT=(\d+)/.exec(chunk.toString());
          if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      });
      const base = `http://127.0.0.1:${port}`;
      const auth = { Authorization: 'Bearer test-recordings-token' };
      for (const path of ['/recordings', '/recording/' + 'a'.repeat(64)]) {
        for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
          const res = await fetch(base + path, { headers });
          assert.equal(res.status, 401);
          assert.equal(res.headers.get('cache-control'), 'no-store');
          assert.deepEqual(await res.json(), { error: 'unauthorized' });
        }
      }
      const list = await fetch(base + '/recordings', { headers: auth });
      assert.equal(list.status, flag ? 503 : 404);
      const download = await fetch(base + '/recording/' + 'a'.repeat(64), { headers: auth });
      assert.equal(download.status, 404);
      assert.equal((await fetch(base + '/health', { headers: auth })).status, 200);
      if (flag) assert.deepEqual(await list.json(), { error: 'Camera login is not ready' });
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit'); server.kill(); await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('recordings routes return video MIME, no-store and safe JSON errors', async () => {
  const app = express();
  let failure;
  const bytes = Buffer.from('test payload');
  mountRecordings(app, {
    listRecordings: async () => { if (failure) throw failure; return { recordings: [], possiblyTruncated: false }; },
    downloadRecording: async () => bytes,
  }, true);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + '/recording/test');
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    failure = new MediaError('Try later', 429);
    const rate = await fetch(base + '/recordings');
    assert.equal(rate.status, 429); assert.deepEqual(await rate.json(), { error: 'Try later' });
    failure = Error('DO_NOT_EXPOSE');
    const bad = await fetch(base + '/recordings');
    assert.equal(bad.status, 502); assert.deepEqual(await bad.json(), { error: 'Recordings service unavailable' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
