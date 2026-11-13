// Black-box test harness: runs the real API server (`node src/main.js`) as a child process with a
// throw-away data directory, a fake Ollama and a fake analysis backend, then talks to it over HTTP.
// The server's working directory is the temp dir, so a developer's local .env never leaks into tests.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../fakes/fake-ollama.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesDir = path.join(repoRoot, 'test', 'fixtures');
export const TEST_TOKEN = 'test-token-6f1c2a9b8e7d4c3b2a19f8e7d6c5b4a3';
// Resolve the real interpreter once, with the full environment. Launcher shims (e.g. the Windows
// Python install manager) misbehave when started with a reduced environment.
const PYTHON = (() => {
  const candidate = process.env.OPTIVUS_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : candidate;
})();

async function freePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

const passthroughEnv = () =>
  Object.fromEntries(
    [
      'PATH',
      'Path',
      'PATHEXT',
      'SYSTEMROOT',
      'SystemRoot',
      'SYSTEMDRIVE',
      'WINDIR',
      'COMSPEC',
      'TEMP',
      'TMP',
      'TMPDIR',
      'HOME',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'PROGRAMDATA',
      'LANG',
    ]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]]),
  );

/**
 * Starts the API with fakes. Returns helpers to call it and inspect side effects.
 * @param {{ env?: Record<string,string>, ollama?: Parameters<typeof startFakeOllama>[0], waitForReady?: boolean }} [opts]
 */
export async function startApp({ env = {}, ollama: ollamaOptions, waitForReady = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'optivus-test-'));
  const fakeAnalysisDir = path.join(dataDir, 'fake-analysis');
  await mkdir(fakeAnalysisDir, { recursive: true });
  const ollama = await startFakeOllama(ollamaOptions);
  const port = await freePort();

  const childEnv = {
    ...passthroughEnv(),
    NODE_ENV: 'production',
    HTTP_PORT: String(port),
    HTTP_BEARER_TOKEN: TEST_TOKEN,
    HTTP_RATE_LIMIT_MAX_REQUESTS: '100000',
    HTTP_RATE_LIMIT_HEAVY_MAX_REQUESTS: '100000',
    DATA_DIR: dataDir,
    VIDEOS_DIR: path.join(dataDir, 'videos'),
    AUDIOS_DIR: path.join(dataDir, 'audios'),
    JSON_DATA_DIR: path.join(dataDir, 'json'),
    PROMPTS_DIR: path.join(dataDir, 'prompts'),
    LOG_DIR: path.join(dataDir, 'logs'),
    LOG_LEVEL: 'warn',
    PROCESSING_ONLY: 'false',
    ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR: 'false',
    ENABLE_PROCESS_LOCK_MECHANISM: 'true',
    PYTHON_BINARY_PATH: PYTHON,
    PYTHONPATH: path.join(repoRoot, 'test', 'fakes', 'python'),
    OPTIVUS_FAKE_ANALYSIS_DIR: fakeAnalysisDir,
    OPTIVUS_FAKE_ANALYSIS_DEFAULT: path.join(fixturesDir, 'analysis-v1-sales-call.json'),
    OPTIVUS_FAKE_PROCESSOR_LOG: path.join(dataDir, 'fake-processor.log'),
    OLLAMA_AI_API_URL: ollama.url,
    OLLAMA_AI_MODEL: 'test-model',
    OLLAMA_AI_DISABLED: 'false',
    ...env,
  };

  const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'main.js')], {
    cwd: dataDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  const exited = once(child, 'exit');

  const baseUrl = `http://127.0.0.1:${port}`;
  const app = {
    baseUrl,
    dataDir,
    env: childEnv,
    ollama,
    child,
    logs: () => output,

    /** fetch wrapper: authenticated by default, JSON in/out helpers. */
    async request(method, urlPath, { token = TEST_TOKEN, json, body, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
      if (token) init.headers.authorization = `Bearer ${token}`;
      if (json !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      } else if (body !== undefined) {
        init.body = body;
      }
      const res = await fetch(baseUrl + urlPath, init);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, headers: res.headers, body: data };
    },

    /**
     * Multipart upload of a fixture (or any buffer) under the given file name. `unique: true` appends
     * random bytes so the upload is distinct content (videos and analyses are content-addressed).
     */
    async upload(
      urlPath,
      { file = 'speech.mp4', buffer, filename = 'call-001.mp4', type = 'video/mp4', field = 'video', token, unique = false } = {},
    ) {
      let data = buffer ?? (await readFile(path.join(fixturesDir, file)));
      if (unique) data = Buffer.concat([data, Buffer.from(crypto.randomUUID())]);
      const form = new FormData();
      form.append(field, new Blob([data], { type }), filename);
      return app.request('POST', urlPath, { body: form, token });
    },

    /** Makes the fake analysis backend return `analysis` for videos whose base name is `videoBaseName`. */
    async setAnalysisFor(videoBaseName, analysis) {
      await writeFile(path.join(fakeAnalysisDir, `${videoBaseName}.json`), JSON.stringify(analysis));
    },

    async processorRuns() {
      try {
        return (await readFile(childEnv.OPTIVUS_FAKE_PROCESSOR_LOG, 'utf8')).split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    },

    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      await ollama.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };

  if (waitForReady) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) {
        await app.stop();
        throw new Error(`API exited early with code ${child.exitCode}:\n${output}`);
      }
      try {
        const res = await fetch(`${baseUrl}/`);
        if (res.ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) {
        await app.stop();
        throw new Error(`API did not become ready in time:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return app;
}

/** Waits for a child process started with waitForReady:false to exit; resolves with its exit code. */
export async function waitForExit(app, timeoutMs = 15_000) {
  if (app.child.exitCode !== null) return app.child.exitCode;
  const [code] = await Promise.race([
    once(app.child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit')), timeoutMs)),
  ]);
  return code;
}
