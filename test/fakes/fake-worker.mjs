// A stand-in for the Python analysis worker that speaks the real protocol (see
// src/core/analysis/worker-backend.js): bearer auth, /readyz, /v1/capabilities and an NDJSON
// /v1/analyze stream. Analyses come from per-video fixtures, like the old fake processor.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fromLegacy } from '../../src/core/analysis/format.js';
import { WHISPER_LANGUAGES } from '../../src/core/llm/languages.js';

// Smallest valid JPEG (1x1 px); enough for the caption step, which only forwards the bytes.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64',
);

/**
 * @param {{ token: string, dataDir: string, fixturesDir: string, defaultFixture: string, delayMs?: number, failCode?: string }} options
 */
export async function startFakeWorker({ token, dataDir, fixturesDir, defaultFixture, delayMs = 0, failCode }) {
  const state = { runs: 0, busy: false, delayMs, failCode, cancelled: 0 };
  const authorized = (req) => req.headers.authorization === `Bearer ${token}`;

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz') return send(200, { status: 'ok' });
    if (req.url === '/readyz') return send(200, { status: 'ready', busy: state.busy });
    if (!authorized(req)) return send(401, { detail: 'Unauthorized' });

    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      return send(200, {
        analysisVersion: 2,
        workerVersion: 'fake',
        languages: ['auto', ...WHISPER_LANGUAGES],
        ocrLanguages: ['en', 'tr'],
        features: ['faces', 'objects', 'ocr', 'scenes'],
        keyframes: true,
        models: { speech: 'fake:whisper', objects: 'fake:yolo', ocr: 'fake:ocr', faces: 'fake:faces' },
        device: { kind: 'cpu', name: 'fake' },
      });
    }

    if (req.method === 'POST' && req.url === '/v1/analyze') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (state.busy) return send(429, { detail: 'busy' });
      state.busy = true;
      state.runs++;
      let closed = false;
      res.on('close', () => {
        if (!res.writableFinished) {
          closed = true;
          state.cancelled++;
        }
      });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (event) => !closed && res.write(`${JSON.stringify(event)}\n`);
      try {
        write({ type: 'progress', stage: 'starting', progress: 0 });
        const deadline = Date.now() + state.delayMs;
        while (Date.now() < deadline && !closed) {
          await new Promise((r) => setTimeout(r, 50));
          write({ type: 'heartbeat' });
        }
        if (closed) return undefined;
        if (state.failCode) {
          write({ type: 'error', code: state.failCode, message: `fake failure ${state.failCode}` });
          return res.end();
        }
        const name = path.basename(body.path, path.extname(body.path));
        let fixture;
        try {
          fixture = await readFile(path.join(fixturesDir, `${name}.json`), 'utf8');
        } catch {
          fixture = await readFile(defaultFixture, 'utf8');
        }
        const parsed = JSON.parse(fixture);
        const analysis = parsed.analysisVersion === 2 ? parsed : fromLegacy(parsed, { language: body.language });
        if (body.language === 'auto') analysis.detectedLanguage = 'en';
        if (body.keyframes_dir && analysis.frames.length) {
          // Keyframe at the first frame and at every scene cut (like the real worker).
          await mkdir(path.join(dataDir, body.keyframes_dir), { recursive: true });
          for (const frame of analysis.frames.filter((f, i) => i === 0 || f.sceneCut)) {
            const file = `${String(Math.round(frame.t * 1000)).padStart(9, '0')}.jpg`;
            await writeFile(path.join(dataDir, body.keyframes_dir, file), TINY_JPEG);
            frame.keyframe = `${body.keyframes_dir}/${file}`;
          }
        }
        analysis.device = 'fake';
        write({ type: 'progress', stage: 'frames', progress: 1 });
        write({ type: 'result', analysis });
        return res.end();
      } finally {
        state.busy = false;
      }
    }
    return send(404, { detail: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
