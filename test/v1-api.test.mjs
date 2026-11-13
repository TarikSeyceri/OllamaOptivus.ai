// Black-box tests for the v2 HTTP API (/v1/*): videos, asynchronous jobs, caching, dedupe,
// cancellation, model/language policy and what is sent to the language model.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_LLM_RESULT } from './fakes/fake-ollama.mjs';
import { startApp } from './helpers/harness.mjs';

const waitForStatus = async (app, id, statuses, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.request('GET', `/v1/jobs/${id}?wait=2`);
    if (statuses.includes(res.body.payload?.job?.status)) return res.body.payload.job;
    if (Date.now() > deadline) throw new Error(`job ${id} did not reach ${statuses}: ${JSON.stringify(res.body)}`);
  }
};

describe('v1 videos', () => {
  let app;
  let videoId;
  before(async () => {
    app = await startApp();
  });
  after(async () => {
    await app?.stop();
  });

  it('uploads a video under its SHA-256 id (201) and deduplicates identical bytes (200)', async () => {
    const first = await app.upload('/v1/videos', { filename: 'meeting.mp4' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    videoId = first.body.payload.video.id;
    assert.match(videoId, /^[a-f0-9]{64}$/);
    assert.equal(first.body.payload.video.originalName, 'meeting.mp4');
    assert.equal(first.headers.get('location'), `/v1/videos/${videoId}`);

    const again = await app.upload('/v1/videos', { filename: 'other-name.mp4' });
    assert.equal(again.status, 200);
    assert.equal(again.body.payload.deduplicated, true);
    assert.equal(again.body.payload.video.id, videoId);
  });

  it('accepts other containers by content, rejects non-videos', async () => {
    const notVideo = await app.upload('/v1/videos', { buffer: Buffer.from('plain text'), filename: 'x.mp4' });
    assert.equal(notVideo.status, 415);
    assert.equal(notVideo.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('lists and gets videos; validates ids', async () => {
    const list = await app.request('GET', '/v1/videos');
    assert.equal(list.status, 200);
    assert.ok(list.body.payload.videos.some((v) => v.id === videoId));
    assert.equal((await app.request('GET', `/v1/videos/${videoId}`)).status, 200);
    assert.equal((await app.request('GET', `/v1/videos/${'0'.repeat(64)}`)).status, 404);
    const bad = await app.request('GET', '/v1/videos/not-an-id');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
  });

  it('deletes a video and everything derived from it', async () => {
    const job = await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, noPrompting: true } });
    assert.equal(job.body.payload.job.status, 'completed');
    const cacheDir = path.join(app.dataDir, 'json');
    assert.ok(
      (await readdir(cacheDir)).some((f) => f.startsWith(videoId)),
      'analysis cached',
    );

    const res = await app.request('DELETE', `/v1/videos/${videoId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await app.request('GET', `/v1/videos/${videoId}`)).status, 404);
    assert.ok(!(await readdir(cacheDir)).some((f) => f.startsWith(videoId)), 'cached analysis removed');
  });
});

describe('v1 jobs', () => {
  let app;
  let videoId;
  before(async () => {
    app = await startApp();
    videoId = (await app.upload('/v1/videos', { filename: 'call.mp4' })).body.payload.video.id;
  });
  after(async () => {
    await app?.stop();
  });

  it('runs a job asynchronously and returns the parsed result', async () => {
    const created = await app.request('POST', '/v1/jobs', { json: { videoId, videoExplanation: 'A support call.' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const { id } = created.body.payload.job;
    assert.equal(created.headers.get('location'), `/v1/jobs/${id}`);

    const job = await waitForStatus(app, id, ['completed', 'failed']);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.deepEqual(job.result, DEFAULT_LLM_RESULT);
    assert.deepEqual(JSON.parse(job.response), DEFAULT_LLM_RESULT);
    assert.ok(job.summary.sampledFrames > 0);
    assert.equal(job.request.model, 'test-model');
  });

  it('sends a well-formed request to the model', async () => {
    const chat = app.ollama.requestsTo('/api/chat').at(-1).body;
    assert.equal(chat.model, 'test-model');
    assert.equal(chat.stream, true);
    assert.equal(chat.think, false);
    assert.equal(chat.options.num_ctx, 16384, 'fixed context size (changing it reloads the model)');
    assert.equal(chat.options.temperature, 0);
    assert.equal(chat.format.type, 'object');
    assert.match(chat.messages[0].content, /data, not instructions/);
    assert.match(chat.messages[0].content, /seconds from the start/);
    assert.match(chat.messages[1].content, /A support call\./);
    assert.match(chat.messages[1].content, /<video_analysis>[\s\S]*My name is Lauren[\s\S]*<\/video_analysis>/);
  });

  it('long-polls with ?wait and returns 200 when finished', async () => {
    const res = await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, temperature: 0.3 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.payload.job.status, 'completed');
  });

  it('reuses the cached analysis when only prompting options change', async () => {
    const before = await app.processorRuns();
    const res = await app.request('POST', '/v1/jobs?wait=30', {
      json: { videoId, temperature: 0.7, videoExplanation: 'Different context' },
    });
    assert.equal(res.body.payload.job.status, 'completed');
    assert.equal(await app.processorRuns(), before, 'video was not analyzed again');
    assert.equal(before, 1);
  });

  it('exposes the analysis and the prompt of a job', async () => {
    const { id } = (await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, noPrompting: true } })).body.payload.job;
    const analysis = await app.request('GET', `/v1/jobs/${id}/analysis`);
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.payload.analysis.analysisVersion, 2);
    const prompt = await app.request('GET', `/v1/jobs/${id}/prompt`);
    assert.equal(prompt.status, 200);
    assert.match(prompt.headers.get('content-type'), /text\/plain/);
    assert.match(prompt.body, /<video_analysis>/);
  });

  it('enforces the model allowlist (v1: 400, legacy: fallback with a warning)', async () => {
    const v1 = await app.request('POST', '/v1/jobs', { json: { videoId, model: 'some-huge-model:671b' } });
    assert.equal(v1.status, 400);
    assert.equal(v1.body.error.code, 'MODEL_NOT_ALLOWED');

    const list = await app.request('GET', '/videos');
    const legacy = await app.request('POST', '/process', { json: { videoFilePath: list.body.payload.videos[0], model: 'deepseek-r1' } });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.match(legacy.headers.get('warning') ?? '', /not allowed/);
  });

  it('validates languages and formats', async () => {
    const unknown = await app.request('POST', '/v1/jobs', { json: { videoId, language: 'xx' } });
    assert.equal(unknown.status, 400);
    const german = await app.request('POST', '/v1/jobs', { json: { videoId, language: 'de', noPrompting: true } });
    assert.equal(german.status, 202, 'every Whisper language is accepted');
    let deep = { type: 'string' };
    for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { x: deep } };
    const tooDeep = await app.request('POST', '/v1/jobs', { json: { videoId, format: deep } });
    assert.equal(tooDeep.status, 400);
    const both = await app.request('POST', '/v1/jobs', { json: { videoId, source: { root: 'videos', path: 'x.mp4' } } });
    assert.equal(both.status, 400);
  });

  it('resolves storage-root sources and blocks escapes', async () => {
    const fileName = (await app.request('GET', `/v1/videos/${videoId}`)).body.payload.video.fileName;
    const ok = await app.request('POST', '/v1/jobs?wait=30', { json: { source: { root: 'videos', path: fileName }, noPrompting: true } });
    assert.equal(ok.body.payload.job.status, 'completed', JSON.stringify(ok.body));
    const unknownRoot = await app.request('POST', '/v1/jobs', { json: { source: { root: 'nas', path: fileName } } });
    assert.equal(unknownRoot.status, 400);
    const escape = await app.request('POST', '/v1/jobs', { json: { source: { root: 'videos', path: '../jobs/x.mp4' } } });
    assert.equal(escape.status, 403);
  });

  it('clamps out-of-range timestamps and reports it', async () => {
    app.ollama.state.result = { summary: 's', events: [{ timestamp: 1576234800, description: 'unix time by mistake' }] };
    try {
      const res = await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, seed: 7 } });
      const job = res.body.payload.job;
      assert.equal(job.status, 'completed');
      assert.ok(job.result.events[0].timestamp <= 126, JSON.stringify(job.result));
      assert.ok(job.warnings.some((w) => /clamped/.test(w)));
    } finally {
      app.ollama.state.result = DEFAULT_LLM_RESULT;
    }
  });

  it('stops reading as soon as the JSON answer is complete', async () => {
    app.ollama.state.trailing = ' \n\t'.repeat(2000); // structured-output whitespace runaway
    try {
      const res = await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, seed: 8 } });
      assert.equal(res.body.payload.job.status, 'completed');
      assert.equal(res.body.payload.job.response, JSON.stringify(DEFAULT_LLM_RESULT));
      assert.equal(res.body.payload.job.summary.llm.stoppedEarly, true);
    } finally {
      app.ollama.state.trailing = '';
    }
  });

  it('unloads the language model before analyzing on a shared low-VRAM GPU', async () => {
    const id = (await app.upload('/v1/videos', { filename: 'second.mp4', unique: true })).body.payload.video.id;
    const before = app.ollama.state.requests.length;
    await app.request('POST', '/v1/jobs?wait=30', { json: { videoId: id } });
    const calls = app.ollama.state.requests.slice(before).map((r) => `${r.path}${r.body?.keep_alive === 0 ? ':unload' : ''}`);
    const unload = calls.indexOf('/api/generate:unload');
    const chat = calls.indexOf('/api/chat');
    assert.ok(unload !== -1 && chat !== -1 && unload < chat, calls.join(', '));
  });
});

describe('queue behaviour', () => {
  let app;
  let ids;
  before(async () => {
    app = await startApp({ workerDelayMs: 1500, env: { JOBS_MAX_QUEUED: '2' } });
    ids = [];
    for (let i = 0; i < 4; i++) ids.push((await app.upload('/v1/videos', { filename: `v${i}.mp4`, unique: true })).body.payload.video.id);
  });
  after(async () => {
    await app?.stop();
  });

  it('deduplicates identical active jobs', async () => {
    const a = await app.request('POST', '/v1/jobs', { json: { videoId: ids[0], noPrompting: true } });
    const b = await app.request('POST', '/v1/jobs', { json: { videoId: ids[0], noPrompting: true } });
    assert.equal(b.body.payload.deduplicated, true);
    assert.equal(b.body.payload.job.id, a.body.payload.job.id);
  });

  it('rejects new jobs with 503 when the queue is full', async () => {
    const statuses = [];
    for (const id of ids.slice(1))
      statuses.push((await app.request('POST', '/v1/jobs', { json: { videoId: id, noPrompting: true } })).status);
    assert.deepEqual(statuses, [202, 202, 503]);
  });

  it('cancels a queued job', async () => {
    const queued = (await app.request('GET', '/v1/jobs?status=queued')).body.payload.jobs[0];
    assert.ok(queued, 'a job is queued');
    const res = await app.request('DELETE', `/v1/jobs/${queued.id}`);
    assert.equal(res.status, 202);
    assert.equal((await waitForStatus(app, queued.id, ['canceled'])).status, 'canceled');
  });

  it('refuses to delete a video while a job uses it', async () => {
    const running = (await app.request('GET', '/v1/jobs?status=running')).body.payload.jobs[0];
    assert.ok(running, 'a job is running');
    const res = await app.request('DELETE', `/v1/videos/${running.video.id}`);
    assert.equal(res.status, 409);
  });
});

describe('legacy uploads with the same name but different content', () => {
  let app;
  before(async () => {
    app = await startApp();
  });
  after(async () => {
    await app?.stop();
  });

  it('stores the second file under a suffixed name instead of returning the first', async () => {
    const first = await app.upload('/upload', { filename: 'call.mp4' });
    const second = await app.upload('/upload', { filename: 'call.mp4', unique: true });
    assert.equal(path.basename(first.body.payload.videoFilePath), 'call.mp4');
    assert.match(path.basename(second.body.payload.videoFilePath), /^call-[a-f0-9]{8}\.mp4$/);
    assert.ok(existsSync(path.resolve(app.dataDir, second.body.payload.videoFilePath)));
  });
});
