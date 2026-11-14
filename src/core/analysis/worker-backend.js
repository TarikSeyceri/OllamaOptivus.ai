// Analysis backend that delegates to the Python worker service(s) (worker/, FastAPI).
//
// Protocol: POST {worker}/v1/analyze with a bearer token. The response is NDJSON:
//   {"type":"progress","stage":"transcribe|frames|...","progress":0.42}
//   {"type":"heartbeat"}                                   (at least every 15 s)
//   {"type":"result","analysis":{...analysis v2...}}
//   {"type":"error","code":"NO_VIDEO_STREAM","message":"..."}
// Closing the request cancels the analysis in the worker. A busy worker answers 429.
import crypto from 'node:crypto';
import { Agent, fetch } from 'undici';
import { HttpError } from '../../http/errors.js';
import { ANALYSIS_VERSION } from './format.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Worker error codes -> HTTP status for the API's clients. */
const ERROR_STATUS = {
  NOT_FOUND: 404,
  PATH_NOT_ALLOWED: 403,
  INVALID_VIDEO: 400,
  NO_VIDEO_STREAM: 400,
  VIDEO_TOO_LONG: 413,
  UNSUPPORTED_LANGUAGE: 400,
  FEATURE_UNAVAILABLE: 400,
  OUT_OF_GPU_MEMORY: 507,
};

export class WorkerBackend {
  constructor({ analysis, logger }) {
    this.urls = analysis.workerUrls.map((u) => u.replace(/\/+$/, ''));
    this.token = analysis.workerToken;
    this.idleTimeoutMs = analysis.workerIdleTimeoutMs;
    this.logger = logger;
    this.version = 'worker';
    this.inUse = new Set();
    this.capabilitiesCache = undefined;
    this.dispatcher = new Agent({
      connectTimeout: 10_000,
      headersTimeout: 60_000,
      bodyTimeout: this.idleTimeoutMs, // the worker sends heartbeats; silence means it hung
      keepAliveTimeout: 30_000,
    });
  }

  headers(extra = {}) {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async #get(url, timeoutMs = 5000) {
    const res = await fetch(url, { headers: this.headers(), dispatcher: this.dispatcher, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Languages, features and model versions of the worker (cached for a minute). */
  async capabilities() {
    if (this.capabilitiesCache && Date.now() - this.capabilitiesCache.at < 60_000) return this.capabilitiesCache.value;
    let lastError;
    for (const url of this.urls) {
      try {
        const caps = await this.#get(`${url}/v1/capabilities`);
        const fingerprint = crypto
          .createHash('sha256')
          .update(JSON.stringify(caps.models ?? {}))
          .digest('hex')
          .slice(0, 12);
        const value = { ...caps, version: `worker-a${caps.analysisVersion ?? ANALYSIS_VERSION}-${fingerprint}` };
        this.version = value.version;
        this.capabilitiesCache = { at: Date.now(), value };
        return value;
      } catch (error) {
        lastError = error;
      }
    }
    if (this.capabilitiesCache) return this.capabilitiesCache.value; // stale but useful while a worker restarts
    throw new HttpError(
      503,
      'WORKER_UNAVAILABLE',
      `The analysis worker is not reachable (${lastError?.message ?? 'no workers configured'}).`,
    );
  }

  /** Like capabilities(), but waits (with backoff) while the worker starts or loads its models. */
  async waitForCapabilities({ signal, timeoutMs = 10 * 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.capabilities();
      } catch (error) {
        if (Date.now() > deadline) throw error;
        if (attempt === 0) this.logger.info('waiting for the analysis worker to become ready');
        await sleep(Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4)), signal);
      }
    }
  }

  async ready() {
    for (const url of this.urls) {
      try {
        const body = await this.#get(`${url}/readyz`, 3000);
        if (body?.status === 'ready') return { ok: true };
      } catch {
        // try the next worker
      }
    }
    return { ok: false };
  }

  /** Picks a worker that this API is not currently using (round-robin), waiting if all are busy. */
  async #acquire(signal) {
    for (;;) {
      const free = this.urls.find((u) => !this.inUse.has(u));
      if (free) {
        this.inUse.add(free);
        return free;
      }
      await sleep(500, signal);
    }
  }

  /**
   * @param {{ video: { root: string, relPath: string, sha256: string }, options: { language: string, sampleFps: number, features: string[] },
   *           keyframesDir?: string, signal?: AbortSignal, onProgress?: (p: number) => void }} params
   */
  async analyze({ video, options, keyframesDir, signal, onProgress = () => {} }) {
    const body = JSON.stringify({
      root: video.root,
      path: video.relPath,
      sha256: video.sha256,
      language: options.language,
      sample_fps: options.sampleFps,
      features: options.features,
      keyframes_dir: options.features.includes('captions') ? keyframesDir : undefined,
    });

    const deadline = Date.now() + 10 * 60_000; // how long to keep retrying a busy / warming-up worker
    for (let attempt = 0; ; attempt++) {
      const url = await this.#acquire(signal);
      let res;
      try {
        res = await fetch(`${url}/v1/analyze`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json', accept: 'application/x-ndjson' }),
          body,
          signal,
          dispatcher: this.dispatcher,
        });
        if ((res.status === 429 || res.status === 503) && Date.now() < deadline) {
          await res.body?.cancel();
          this.inUse.delete(url);
          await sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)), signal);
          continue;
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new HttpError(
            res.status === 401 || res.status === 403 ? 500 : 502,
            'WORKER_ERROR',
            `The analysis worker rejected the request (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
          );
        }
        return await this.#readStream(res, onProgress);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof HttpError) throw error;
        if (
          Date.now() < deadline &&
          attempt < 3 &&
          /ECONNREFUSED|ECONNRESET|fetch failed|UND_ERR_CONNECT/i.test(`${error.message} ${error.cause?.code ?? ''}`)
        ) {
          this.logger.warn({ url, err: error.message }, 'worker unreachable; retrying');
          await sleep(2000 * (attempt + 1), signal);
          continue;
        }
        throw new HttpError(502, 'WORKER_ERROR', `The analysis worker failed: ${error.message}`);
      } finally {
        this.inUse.delete(url);
      }
    }
  }

  async #readStream(res, onProgress) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new HttpError(502, 'WORKER_PROTOCOL', 'The analysis worker sent an invalid message.');
        }
        if (event.type === 'progress' && Number.isFinite(event.progress)) onProgress(event.progress);
        else if (event.type === 'result') {
          if (event.analysis?.analysisVersion !== ANALYSIS_VERSION) {
            throw new HttpError(502, 'WORKER_PROTOCOL', `Unsupported analysis version ${event.analysis?.analysisVersion}.`);
          }
          return event.analysis;
        } else if (event.type === 'error') {
          throw new HttpError(ERROR_STATUS[event.code] ?? 500, event.code ?? 'ANALYSIS_FAILED', event.message ?? 'Video analysis failed.');
        }
      }
    }
    throw new HttpError(502, 'WORKER_PROTOCOL', 'The analysis worker closed the stream without a result.');
  }
}
