// Regression tests for the analysis -> prompt step (black-box, via /process with noPrompting).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers/harness.mjs';

const frame = (timestamp, texts = [], detections = []) => ({ timestamp, texts, detections });

describe('prompt construction', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.stop(); });

  async function promptFor(name, analysis, extra = {}) {
    await app.setAnalysisFor(name, analysis);
    const up = await app.upload('/upload', { filename: `${name}.mp4` });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const res = await app.request('POST', '/process', { json: { videoFilePath: up.body.payload.videoFilePath, noPrompting: true, ...extra } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.payload.prompt;
  }

  it('handles speech that starts after the first second (was a ReferenceError)', async () => {
    const prompt = await promptFor('late-speech', {
      frames: [frame(0, ['WELCOME SCREEN'], ['person']), frame(1, ['WELCOME SCREEN']), frame(3, [], ['cup'])],
      audioTranscription: [{ start: 2, end: 4, text: ' Hello there.' }],
    });
    assert.match(prompt, /WELCOME SCREEN/);
    assert.match(prompt, /Hello there/);
  });

  it('keeps visual information of videos without speech', async () => {
    const prompt = await promptFor('no-speech', {
      frames: [frame(0, ['SLIDE ONE']), frame(1, ['SLIDE TWO'], ['laptop'])],
      audioTranscription: [],
    });
    assert.match(prompt, /SLIDE ONE/);
    assert.match(prompt, /SLIDE TWO/);
    assert.match(prompt, /laptop/);
  });

  it('keeps frames that fall into gaps between speech segments', async () => {
    const prompt = await promptFor('speech-gap', {
      frames: [frame(1), frame(6, ['GAP TEXT']), frame(9)],
      audioTranscription: [{ start: 0, end: 5, text: ' First.' }, { start: 8, end: 10, text: ' Second.' }],
    });
    assert.match(prompt, /GAP TEXT/);
  });

  it('counts a frame on a segment boundary only once', async () => {
    const prompt = await promptFor('boundary', {
      frames: [frame(5, ['BOUNDARY TEXT'])],
      audioTranscription: [{ start: 0, end: 5, text: ' One.' }, { start: 5, end: 10, text: ' Two.' }],
    });
    assert.equal(prompt.match(/BOUNDARY TEXT/g)?.length, 1);
  });

  it('does not leak videoExplanation into later requests', async () => {
    const analysis = { frames: [frame(0, [], ['person'])], audioTranscription: [{ start: 0, end: 2, text: ' Hi.' }] };
    const first = await promptFor('explain-a', analysis, { videoExplanation: 'SECRET CONTEXT XYZ' });
    assert.match(first, /SECRET CONTEXT XYZ/);
    const second = await promptFor('explain-b', analysis);
    assert.doesNotMatch(second, /SECRET CONTEXT XYZ/);
  });

  it('keeps on-screen text in short videos', async () => {
    const prompt = await promptFor('short-ocr', {
      frames: [frame(0, ['INVOICE 4821']), frame(4, ['INVOICE 4821']), frame(8, ['INVOICE 4821'])],
      audioTranscription: [{ start: 0, end: 3, text: ' a' }, { start: 3, end: 6, text: ' b' }, { start: 6, end: 9, text: ' c' }],
    });
    assert.match(prompt, /INVOICE 4821/);
  });
});
