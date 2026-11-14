// Characterization tests for the v1 ("legacy") HTTP contract: /, /upload, /videos, /delete, /process.
// They were written against the original implementation and must keep passing in v2, so existing
// clients (and the published Postman collection) keep working after the upgrade.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_LLM_RESULT } from './fakes/fake-ollama.mjs';
import { startApp } from './helpers/harness.mjs';

describe('legacy v1 API contract', () => {
  let app;
  let videoFilePath;

  before(async () => {
    app = await startApp();
  });
  after(async () => {
    await app?.stop();
  });

  it('GET / answers without authentication', async () => {
    const res = await app.request('GET', '/', { token: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.msg, 'Ollama Optivus Server is running!');
  });

  it('rejects requests without a bearer token', async () => {
    const res = await app.request('GET', '/videos', { token: null });
    assert.equal(res.status, 401);
    assert.deepEqual({ success: res.body.success, msg: res.body.msg }, { success: false, msg: 'Unauthorized' });
  });

  it('rejects requests with a wrong bearer token', async () => {
    const res = await app.request('GET', '/videos', { token: 'not-the-right-token-but-long-enough-000000' });
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
  });

  it('POST /upload stores an .mp4 and returns its path', async () => {
    const res = await app.upload('/upload', { filename: 'call-001.mp4' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.msg, 'Video file uploaded!');
    videoFilePath = res.body.payload.videoFilePath;
    assert.equal(typeof videoFilePath, 'string');
    assert.equal(path.basename(videoFilePath), 'call-001.mp4');
    assert.ok(existsSync(path.resolve(app.dataDir, videoFilePath)), 'uploaded file exists on disk');
  });

  it('POST /upload of the same file again is idempotent', async () => {
    const res = await app.upload('/upload', { filename: 'call-001.mp4' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.payload.videoFilePath, videoFilePath);
  });

  it('POST /upload rejects files that are not .mp4 videos', async () => {
    const res = await app.upload('/upload', { buffer: Buffer.from('hello'), filename: 'notes.txt', type: 'text/plain' });
    assert.ok(res.status >= 400 && res.status < 600, `status ${res.status}`);
    assert.ok(!existsSync(path.join(app.env.VIDEOS_DIR, 'notes.txt')), 'rejected file is not stored');
  });

  it('GET /videos lists uploaded videos', async () => {
    const res = await app.request('GET', '/videos');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.msg, 'Video files listed!');
    assert.ok(Array.isArray(res.body.payload.videos));
    assert.ok(res.body.payload.videos.some((v) => path.basename(v) === 'call-001.mp4'));
  });

  it('POST /process returns the LLM response as a JSON string', async () => {
    const res = await app.request('POST', '/process', { json: { videoFilePath } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.msg, 'Processing completed');
    assert.equal(typeof res.body.payload.response, 'string');
    assert.deepEqual(JSON.parse(res.body.payload.response), DEFAULT_LLM_RESULT);
  });

  it('POST /process with noPrompting returns the raw analysis and the prompt', async () => {
    const res = await app.request('POST', '/process', { json: { videoFilePath, noPrompting: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.msg, 'Processing completed, without prompting.');
    assert.equal(typeof res.body.payload.stdout, 'string');
    const analysis = JSON.parse(res.body.payload.stdout);
    assert.ok(Array.isArray(analysis.frames));
    assert.ok(Array.isArray(analysis.audioTranscription));
    assert.equal(typeof res.body.payload.prompt, 'string');
    assert.match(res.body.payload.prompt, /My name is Lauren/);
  });

  it('POST /process without videoFilePath is a 400', async () => {
    const res = await app.request('POST', '/process', { json: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('POST /process outside the videos directory is a 403', async () => {
    for (const videoPath of [path.join(app.dataDir, 'elsewhere', 'x.mp4'), '../../etc/passwd.mp4']) {
      const res = await app.request('POST', '/process', { json: { videoFilePath: videoPath } });
      assert.equal(res.status, 403, videoPath);
      assert.equal(res.body.success, false);
    }
  });

  it('POST /process for a missing video is a 404', async () => {
    const res = await app.request('POST', '/process', { json: { videoFilePath: path.join(app.env.VIDEOS_DIR, 'missing.mp4') } });
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });

  it('POST /process for a non-video file is a 400', async () => {
    await mkdir(app.env.VIDEOS_DIR, { recursive: true });
    const textFile = path.join(app.env.VIDEOS_DIR, 'readme.txt');
    await writeFile(textFile, 'not a video');
    const res = await app.request('POST', '/process', { json: { videoFilePath: textFile } });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('DELETE /delete validates its input', async () => {
    const missingName = await app.request('DELETE', '/delete', { json: {} });
    assert.equal(missingName.status, 400);
    const notFound = await app.request('DELETE', '/delete', { json: { videoFileName: 'nope.mp4' } });
    assert.equal(notFound.status, 404);
  });

  it('DELETE /delete removes the video', async () => {
    const res = await app.request('DELETE', '/delete', { json: { videoFileName: 'call-001.mp4' } });
    assert.equal(res.status, 200);
    assert.deepEqual({ success: res.body.success, msg: res.body.msg }, { success: true, msg: 'Video file deleted!' });
    assert.ok(!existsSync(path.resolve(app.dataDir, videoFilePath)));
    const list = await app.request('GET', '/videos');
    assert.ok(!list.body.payload.videos.some((v) => path.basename(v) === 'call-001.mp4'));
  });
});
