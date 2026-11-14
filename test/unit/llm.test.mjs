// Unit tests for the timeline/prompt builder and the streaming JSON detector.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fromLegacy, toLegacy } from '../../src/core/analysis/format.js';
import { createJsonEndDetector, parseJsonLoose } from '../../src/core/llm/json-stream.js';
import { answerInstruction, labelsFor } from '../../src/core/llm/languages.js';
import { buildPrompt, chunkLines, effectiveLanguage, estimateTokens } from '../../src/core/llm/prompt.js';
import { clampTimestamps, summarize } from '../../src/core/llm/summarize.js';
import { buildTimeline, similarText, normalizeText } from '../../src/core/llm/timeline.js';
import { fixturesDir } from '../helpers/harness.mjs';

const frame = (t, extra = {}) => ({ t, objects: {}, texts: [], ...extra });
const analysis = (frames, transcript = [], extra = {}) => ({
  analysisVersion: 2,
  video: { duration: 0, hasAudio: transcript.length > 0 },
  language: 'en',
  transcript,
  frames,
  ...extra,
});

describe('json end detector', () => {
  it('finds the end of the top-level object across chunks, ignoring braces in strings', () => {
    const d = createJsonEndDetector();
    assert.equal(d.push('{"a":"x}{\\"'), -1);
    assert.equal(d.push('y","b":[1,{"c":2}]'), -1);
    assert.equal(d.push('}   \n\t\t  '), 1);
    assert.equal(d.done, true);
  });

  it('handles arrays and escaped backslashes', () => {
    const d = createJsonEndDetector();
    assert.equal(d.push('[{"p":"C:\\\\dir\\\\"}]tail'), 19); // index right after "]"
  });

  it('parses JSON with or without a markdown fence', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.equal(parseJsonLoose('{"a":'), undefined);
  });
});

describe('timeline', () => {
  it('treats OCR flicker as the same text', () => {
    assert.ok(similarText(normalizeText('OR, ISTANBUL, DUBAI.'), normalizeText('CR, ISTANBUL, DUBAI')));
    assert.ok(!similarText(normalizeText('INVOICE 4821'), normalizeText('RECEIPT 1093')));
    assert.ok(!similarText(normalizeText('INVOICE 4821'), normalizeText('INVOICE 4822')), 'numbers must match exactly');
    assert.ok(!similarText(normalizeText('slide 1'), normalizeText('slide 3')));
  });

  it('reports background text once and lists only new text per window', () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      frame(i * 2, { texts: i % 2 ? ['ISTANBUL DUBAI', `slide ${i}`] : ['IStANBUL DUBAI'] }),
    );
    const tl = buildTimeline(analysis(frames));
    assert.deepEqual(tl.background, ['IStANBUL DUBAI']);
    const all = tl.windows.flatMap((w) => w.texts);
    assert.ok(!all.some((t) => /istanbul/i.test(t)));
    assert.ok(all.includes('slide 1'));
  });

  it('keeps scene-specific text on the timeline (only cross-scene text is background)', () => {
    const frames = Array.from({ length: 14 }, (_, i) =>
      frame(i, { sceneCut: i === 0 || i === 7, texts: [i < 7 ? 'OPTIVUS DEMO' : 'INVOICE 4821'] }),
    );
    const tl = buildTimeline(analysis(frames));
    assert.deepEqual(tl.background, []);
    const shown = tl.windows.flatMap((w) => w.texts);
    assert.ok(shown.includes('OPTIVUS DEMO') && shown.includes('INVOICE 4821'));
  });

  it('drops one-frame object detections (false positives) and reports counts', () => {
    const frames = [
      frame(0, { objects: { person: 2 } }),
      frame(1, { objects: { person: 2, cake: 1 } }),
      frame(2, { objects: { person: 1 } }),
    ];
    const tl = buildTimeline(analysis(frames));
    assert.deepEqual(tl.objects, { person: 2 });
    assert.match(tl.windows[0].objects, /person ×2/);
  });

  it('splits long silent stretches at scene cuts and every 15 s', () => {
    const frames = Array.from({ length: 40 }, (_, i) => frame(i, { sceneCut: i === 10, texts: i === 10 || i === 30 ? [`text ${i}`] : [] }));
    const tl = buildTimeline(analysis(frames));
    const starts = tl.windows.map((w) => w.start);
    assert.ok(starts.includes(10), JSON.stringify(starts));
    assert.ok(tl.windows.find((w) => w.start === 10).sceneCuts.includes(10));
  });

  it('weaves captions and facial expressions into the prompt', () => {
    const frames = [
      frame(0, { caption: 'A person at a desk.', faces: [{ expression: 'neutral', score: 0.9 }] }),
      frame(1, { faces: [{ expression: 'happy', score: 0.8 }] }),
    ];
    const prompt = buildPrompt(analysis(frames, [{ start: 0, end: 2, text: 'Hello.' }]), { language: 'en' });
    assert.match(prompt.user, /Scene: "A person at a desk\."/);
    assert.match(prompt.user, /Faces: 1 \(neutral 50%, happy 50%\)/);
  });
});

describe('prompt', () => {
  it('uses Turkish labels and answer instruction for tr, English fallback otherwise', () => {
    assert.equal(labelsFor('tr').speech, 'Konuşma');
    assert.equal(labelsFor('de').speech, 'Speech');
    assert.match(answerInstruction('de'), /German/);
    assert.equal(effectiveLanguage('auto', { detectedLanguage: 'tr' }), 'tr');
  });

  it('embeds a custom schema and the real duration in the system prompt', () => {
    const p = buildPrompt(analysis([frame(0), frame(90)]), {
      language: 'en',
      format: { type: 'object', properties: { x: { type: 'number' } } },
    });
    assert.match(p.system, /between 0 and 90\.0/);
    assert.match(p.system, /"properties":\{"x"/);
  });

  it('chunks long timelines under a token budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `[${i}] ${'word '.repeat(30)}`);
    const chunks = chunkLines(lines, 500);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.flat().length, 100);
  });

  it('clamps timestamps outside the video', () => {
    const value = { events: [{ timestamp: 1576234800 }, { timestamp: -3 }, { timestamp: 5 }], nested: { startTimestamp: 999 } };
    assert.equal(clampTimestamps(value, 60), 3);
    assert.deepEqual(
      value.events.map((e) => e.timestamp),
      [60, 0, 5],
    );
  });

  it('matches the golden prompt for the bank-call fixture', () => {
    const legacy = JSON.parse(readFileSync(path.join(fixturesDir, 'analysis-v1-bank-call.json'), 'utf8'));
    const prompt = buildPrompt(fromLegacy(legacy, { language: 'en' }), {
      language: 'en',
      videoExplanation: 'The following is an analysis of a video call between a bank agent and a customer.',
    });
    const golden = path.join(fixturesDir, 'golden', 'bank-call.prompt.txt');
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, prompt.text);
    assert.equal(prompt.text, readFileSync(golden, 'utf8'), 'prompt format changed: review, then run with UPDATE_GOLDEN=1');
    assert.ok(prompt.estimatedTokens < 4000, `prompt is compact (${prompt.estimatedTokens} tokens)`);
  });
});

describe('summarize', () => {
  const logger = { info() {}, warn() {} };
  const request = { language: 'en', model: 'test-model:latest', temperature: 0.2 };
  const smallContext = { numCtx: 4096, numPredict: 512 };
  // A 30-minute call: about 13,000 tokens of transcript, far more than a 4K context.
  const longCall = () =>
    analysis(
      [frame(0)],
      Array.from({ length: 300 }, (_, i) => ({
        start: i * 6,
        end: i * 6 + 5,
        text: `Segment ${i}: the customer explains the problem with order ${1000 + i} and the agent answers in detail.`,
      })),
      { video: { duration: 1800, hasAudio: true } },
    );
  const shortClip = () => analysis([frame(0)], [{ start: 0, end: 4, text: 'Hello.' }], { video: { duration: 10, hasAudio: true } });

  /** A scripted OllamaService: `reply(params, callNumber)` returns the model's answer for each chat call. */
  const scriptedOllama = (reply) => {
    const calls = [];
    return {
      calls,
      async chat(params) {
        calls.push(params);
        return { text: reply(params, calls.length), stats: {} };
      },
      async checkOffload() {},
    };
  };
  const isNotesCall = (params) => Boolean(params.format?.properties?.notes);

  it('summarizes videos longer than the context window in parts (map-reduce)', async () => {
    const ollama = scriptedOllama((params) =>
      isNotesCall(params)
        ? JSON.stringify({ notes: [{ timestamp: 12, note: 'The customer reports a broken order.' }] })
        : JSON.stringify({ summary: 'A long support call.', events: [{ timestamp: 99999, description: 'The call ends.' }] }),
    );
    const result = await summarize({ ollama, cfg: smallContext, analysis: longCall(), request, logger });

    assert.equal(result.chunked, true);
    const notesCalls = ollama.calls.filter(isNotesCall);
    assert.ok(notesCalls.length > 1, 'the timeline is split into several parts');
    for (const call of notesCalls) {
      const tokens = estimateTokens(call.messages.map((m) => m.content).join('\n'));
      assert.ok(tokens <= smallContext.numCtx - smallContext.numPredict, `a part fits the context (${tokens} tokens)`);
    }
    const final = ollama.calls.at(-1);
    assert.equal(isNotesCall(final), false, 'the last call answers with the requested schema');
    assert.match(final.messages[1].content, /\[12\.0\] The customer reports a broken order\./);
    assert.equal(result.json.events[0].timestamp, 1800, 'timestamps are clamped to the video');
    assert.ok(result.warnings.some((w) => w.includes('map-reduce')));
  });

  it('retries once, at temperature 0, when the answer is not valid JSON', async () => {
    const ollama = scriptedOllama((_params, n) => (n === 1 ? 'Sure! Here is the summary you asked for.' : '{"summary":"ok","events":[]}'));
    const result = await summarize({ ollama, cfg: { numCtx: 16384, numPredict: 1024 }, analysis: shortClip(), request, logger });
    assert.deepEqual(result.json, { summary: 'ok', events: [] });
    assert.equal(ollama.calls.length, 2);
    assert.equal(ollama.calls[1].options.temperature, 0);
  });

  it('fails with LLM_INVALID_JSON when the retry is not valid JSON either', async () => {
    const ollama = scriptedOllama(() => 'still not JSON');
    await assert.rejects(
      summarize({ ollama, cfg: { numCtx: 16384, numPredict: 1024 }, analysis: shortClip(), request, logger }),
      (error) => error.status === 502 && error.code === 'LLM_INVALID_JSON',
    );
  });

  it('gives up with VIDEO_TOO_LONG_FOR_CONTEXT when the notes do not get shorter', async () => {
    const wordy = Array.from({ length: 60 }, (_, i) => ({ timestamp: i, note: `${'a very detailed note '.repeat(10)}${i}` }));
    const ollama = scriptedOllama((params) => (isNotesCall(params) ? JSON.stringify({ notes: wordy }) : '{}'));
    await assert.rejects(
      summarize({ ollama, cfg: smallContext, analysis: longCall(), request, logger }),
      (error) => error.status === 413 && error.code === 'VIDEO_TOO_LONG_FOR_CONTEXT',
    );
    assert.ok(ollama.calls.every(isNotesCall), 'no final answer is attempted');
  });
});

describe('analysis format', () => {
  it('round-trips the legacy shape', () => {
    const v1 = {
      frames: [{ timestamp: 1, detections: ['person', 'person', 'cup'], texts: ['A'] }],
      audioTranscription: [{ start: 0, end: 2, text: 'hi' }],
    };
    const v2 = fromLegacy(v1, { language: 'en' });
    assert.deepEqual(v2.frames[0].objects, { person: 2, cup: 1 });
    assert.equal(v2.video.duration, 2);
    assert.deepEqual(toLegacy(v2), v1);
  });
});
