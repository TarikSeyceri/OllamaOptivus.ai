// Security regression tests (black-box): secure defaults, authentication, input validation,
// upload hardening and path containment.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startApp, TEST_TOKEN, waitForExit } from './helpers/harness.mjs';

const MP4_HEADER = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

describe('startup refuses insecure configurations', () => {
  const cases = [
    ['no token', { HTTP_BEARER_TOKEN: '' }],
    ['the published default token', { HTTP_BEARER_TOKEN: 'mysecrettoken' }],
    ['a short token', { HTTP_BEARER_TOKEN: 'short-token' }],
    ['AUTH_DISABLED outside development', { AUTH_DISABLED: 'true' }],
  ];
  for (const [name, env] of cases) {
    it(`exits with ${name}`, async () => {
      const app = await startApp({ env, waitForReady: false });
      try {
        const code = await waitForExit(app);
        assert.notEqual(code, 0, app.logs());
      } finally {
        await app.stop();
      }
    });
  }
});

describe('authentication', () => {
  it('accepts every token of a comma-separated list (key rotation)', async () => {
    const second = 'second-token-0123456789abcdef0123456789abcd';
    const app = await startApp({ env: { HTTP_BEARER_TOKEN: `${TEST_TOKEN}, ${second}` } });
    try {
      assert.equal((await app.request('GET', '/videos', { token: TEST_TOKEN })).status, 200);
      assert.equal((await app.request('GET', '/videos', { token: second })).status, 200);
      assert.equal((await app.request('GET', '/videos', { token: `${second}x` })).status, 401);
    } finally {
      await app.stop();
    }
  });

  it('allows AUTH_DISABLED only in development', async () => {
    const app = await startApp({ env: { NODE_ENV: 'development', AUTH_DISABLED: 'true', HTTP_BEARER_TOKEN: '' } });
    try {
      assert.equal((await app.request('GET', '/videos', { token: null })).status, 200);
    } finally {
      await app.stop();
    }
  });
});

describe('hardened request handling', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(async () => {
    await app?.stop();
  });

  it('sets security headers and hides the framework', async () => {
    const res = await app.request('GET', '/');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('survives malformed /process input instead of crashing', async () => {
    for (const videoFilePath of [123, {}, [], true]) {
      const res = await app.request('POST', '/process', { json: { videoFilePath } });
      assert.equal(res.status, 400, JSON.stringify(videoFilePath));
      assert.equal(res.body.success, false);
    }
    assert.equal((await app.request('GET', '/')).status, 200, 'server is still alive');
  });

  it('treats inherited object keys as an unknown language', async () => {
    const up = await app.upload('/upload', { filename: 'proto.mp4' });
    for (const language of ['constructor', '__proto__', 'toString']) {
      const res = await app.request('POST', '/process', {
        json: { videoFilePath: up.body.payload.videoFilePath, language, noPrompting: true },
      });
      assert.equal(res.status, 200, `${language}: ${JSON.stringify(res.body)}`);
    }
    assert.equal({}.videoExplanation, undefined, 'Object.prototype is untouched');
  });

  it('answers malformed JSON with a JSON 400', async () => {
    const res = await app.request('POST', '/process', { body: '{"videoFilePath":', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await app.request('GET', '/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });

  it('rejects a non-MP4 payload disguised as .mp4 (magic bytes) and stores nothing', async () => {
    const res = await app.upload('/upload', { buffer: Buffer.from('#!/bin/sh\necho pwned\n'), filename: 'evil.mp4' });
    assert.equal(res.status, 415);
    assert.equal(res.body.success, false);
    const leftovers = (await readdir(app.env.VIDEOS_DIR)).filter((f) => f.includes('evil') || f.endsWith('.part'));
    assert.deepEqual(leftovers, []);
  });

  it('rejects other file types with a JSON 415', async () => {
    const res = await app.upload('/upload', { buffer: Buffer.from('hello'), filename: 'notes.txt', type: 'text/plain' });
    assert.equal(res.status, 415);
    assert.equal(res.body.success, false);
  });

  it('sanitizes upload file names', async () => {
    const res = await app.upload('/upload', { filename: '..\\..\\evil<name>.mp4' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = res.body.payload.videoFilePath;
    assert.equal(path.dirname(path.resolve(app.dataDir, stored)), path.resolve(app.env.VIDEOS_DIR));
    assert.doesNotMatch(path.basename(stored), /[<>\\/]|\.\./);
  });

  it('blocks prefix look-alike directories', async () => {
    const sneaky = path.join(`${app.env.VIDEOS_DIR}2`, 'data', 'videos', 'x.mp4');
    await mkdir(path.dirname(sneaky), { recursive: true });
    await writeFile(sneaky, MP4_HEADER);
    const res = await app.request('POST', '/process', { json: { videoFilePath: sneaky, noPrompting: true } });
    assert.equal(res.status, 403);
  });

  it('blocks symlinks that escape the videos directory', async (t) => {
    const outside = path.join(app.dataDir, 'outside', 'secret.mp4');
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, MP4_HEADER);
    const link = path.join(app.env.VIDEOS_DIR, 'link.mp4');
    try {
      await symlink(outside, link);
    } catch {
      t.skip('creating symlinks is not permitted on this machine');
      return;
    }
    const res = await app.request('POST', '/process', { json: { videoFilePath: link, noPrompting: true } });
    assert.equal(res.status, 403);
  });
});

describe('limits', () => {
  it('rejects oversized uploads with a JSON 413', async () => {
    const app = await startApp({ env: { VIDEO_FILE_MAX_UPLOAD_SIZE: '1000' } });
    try {
      const res = await app.upload('/upload', { filename: 'big.mp4' });
      assert.equal(res.status, 413);
      assert.equal(res.body.success, false);
    } finally {
      await app.stop();
    }
  });

  it('rate-limits with a JSON 429', async () => {
    const app = await startApp({ env: { HTTP_RATE_LIMIT_MAX_REQUESTS: '2' } });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await app.request('GET', '/videos')).status);
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      await app.stop();
    }
  });

  it('writes nothing to disk when uploads are disabled (PROCESSING_ONLY)', async () => {
    const app = await startApp({ env: { PROCESSING_ONLY: 'true' } });
    try {
      const res = await app.upload('/upload', { filename: 'blocked.mp4' });
      assert.equal(res.status, 403);
      const files = existsSync(app.env.VIDEOS_DIR) ? await readdir(app.env.VIDEOS_DIR) : [];
      assert.deepEqual(files, []);
    } finally {
      await app.stop();
    }
  });
});
