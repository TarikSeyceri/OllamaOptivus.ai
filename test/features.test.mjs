// The modernized dev-branch features, end to end through the API: scene cuts, scene descriptions
// (keyframe captions by the vision model) and facial expressions.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers/harness.mjs';

const analysis = {
  analysisVersion: 2,
  video: { duration: 20, hasAudio: true },
  language: 'en',
  transcript: [{ start: 0, end: 6, text: 'Welcome to the quarterly review.' }],
  frames: [
    { t: 0, objects: { person: 1 }, texts: ['Q3 REVIEW'], sceneCut: true, faces: [{ expression: 'happy', score: 0.9 }] },
    { t: 5, objects: { person: 1 }, texts: ['Q3 REVIEW'], faces: [{ expression: 'neutral', score: 0.8 }] },
    { t: 10, objects: { laptop: 1, person: 1 }, texts: ['REVENUE +12%'], sceneCut: true },
    { t: 15, objects: { laptop: 1 }, texts: ['REVENUE +12%'] },
  ],
  scenes: [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
  ],
};

describe('scene descriptions, scene cuts and facial expressions', () => {
  let app;
  let videoId;
  before(async () => {
    app = await startApp({ env: { OLLAMA_AI_VISION_ENABLED: 'true' } });
    await app.setAnalysisFor('review', analysis);
    videoId = (await app.upload('/v1/videos', { filename: 'review.mp4', unique: true })).body.payload.video.id;
  });
  after(async () => {
    await app?.stop();
  });

  const promptOf = async (body) => {
    const res = await app.request('POST', '/v1/jobs?wait=30', { json: { videoId, noPrompting: true, ...body } });
    assert.equal(res.body.payload.job.status, 'completed', JSON.stringify(res.body));
    return res.body.payload.job.prompt;
  };

  it('captions every scene keyframe with the vision model and puts it in the prompt', async () => {
    // The API keeps its own copy of the video under a content-addressed name; map it to the fixture.
    const fileName = (await app.request('GET', `/v1/videos/${videoId}`)).body.payload.video.fileName;
    await app.setAnalysisFor(fileName.replace(/\.mp4$/, ''), analysis);

    const prompt = await promptOf({ features: ['objects', 'ocr', 'scenes', 'faces', 'captions'] });
    const captionCalls = app.ollama.requestsTo('/api/chat').filter((r) => r.body.messages.some((m) => m.images?.length));
    assert.equal(captionCalls.length, 2, 'one caption per scene keyframe');
    assert.equal(captionCalls[0].body.options.num_ctx, 16384, 'same context size as the summary (no model reload)');
    assert.equal(captionCalls[0].body.think, false);
    assert.match(prompt, /Scene: "A person sits at a desk in an office\."/);
    assert.match(prompt, /Scene change: 10\.0 s/);
    assert.match(prompt, /Faces: 1 \(happy 50%, neutral 50%\)/);
  });

  it('reuses cached captions for the same video', async () => {
    const before = app.ollama.requestsTo('/api/chat').length;
    const prompt = await promptOf({ features: ['objects', 'ocr', 'scenes', 'faces', 'captions'], temperature: 0.5 });
    assert.equal(app.ollama.requestsTo('/api/chat').length, before, 'no new vision calls');
    assert.match(prompt, /Scene: "A person sits at a desk/);
  });

  it('leaves captions and faces out when they are not requested', async () => {
    const fileName = (await app.request('GET', `/v1/videos/${videoId}`)).body.payload.video.fileName;
    const withoutFaces = { ...analysis, frames: analysis.frames.map(({ faces: _faces, ...frame }) => frame) };
    await app.setAnalysisFor(fileName.replace(/\.mp4$/, ''), withoutFaces);
    const prompt = await promptOf({ features: ['objects', 'ocr', 'scenes'], sampleFps: 2 });
    assert.doesNotMatch(prompt, /Scene: "/);
    assert.doesNotMatch(prompt, /Faces:/);
  });
});

describe('feature availability', () => {
  it('rejects captions when no vision model is enabled', async () => {
    const app = await startApp();
    try {
      const videoId = (await app.upload('/v1/videos', { filename: 'x.mp4' })).body.payload.video.id;
      const res = await app.request('POST', '/v1/jobs', { json: { videoId, features: ['captions'] } });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'FEATURE_UNAVAILABLE');
      const caps = await app.request('GET', '/v1/capabilities');
      assert.equal(caps.body.payload.captions, false);
    } finally {
      await app.stop();
    }
  });
});
