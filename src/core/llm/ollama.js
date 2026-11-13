// Ollama client wrapper used for keyframe captions and the final JSON summary.
import { Ollama } from 'ollama';
import { Agent, fetch as undiciFetch } from 'undici';
import { HttpError } from '../../http/errors.js';
import { createJsonEndDetector } from './json-stream.js';

/** Ollama treats "name" and "name:latest" as the same model. */
export const normalizeModelName = (name = '') => (name.includes(':') ? name : `${name}:latest`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OllamaService {
  /** @param {{ ollama: object, logger: import('pino').Logger }} deps */
  constructor({ ollama: cfg, logger }) {
    this.cfg = cfg;
    this.logger = logger;
    // Node's built-in fetch gives up after 300 s without response headers or between body chunks.
    // Model loads, long generations and multi-GB pulls need explicit, longer limits.
    const dispatcher = new Agent({
      connectTimeout: 10_000,
      headersTimeout: cfg.timeoutMs,
      bodyTimeout: cfg.timeoutMs,
      keepAliveTimeout: 30_000,
    });
    this.client = new Ollama({
      host: cfg.url,
      fetch: (input, init = {}) => undiciFetch(input, { ...init, dispatcher }),
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
    });
    this.ready = false;
    this.lastError = undefined;
    this.readyPromise = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  /** Models that must be present: the summary model and, if enabled, the vision model. */
  requiredModels() {
    const models = [this.cfg.model];
    if (this.cfg.vision.enabled) models.push(this.cfg.vision.model);
    return [...new Set(models.map(normalizeModelName))];
  }

  async installedModels() {
    const { models } = await this.client.list();
    return models.map((m) => normalizeModelName(m.model ?? m.name));
  }

  async pull(model) {
    this.logger.info({ model }, 'pulling Ollama model (first start can take a while)');
    let nextLog = 0;
    for await (const part of await this.client.pull({ model, stream: true })) {
      if (part.total && part.completed !== undefined) {
        const percent = Math.floor((part.completed / part.total) * 100);
        if (percent >= nextLog) {
          nextLog = percent + 10;
          this.logger.info({ model, status: part.status, percent }, 'pull progress');
        }
      }
    }
    this.logger.info({ model }, 'model pulled');
  }

  /** Retries (with backoff, until it succeeds) to reach Ollama and make sure the models exist. */
  async init({ maxDelayMs = 30_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const installed = new Set(await this.installedModels());
        for (const model of this.requiredModels()) {
          if (installed.has(model)) continue;
          if (!this.cfg.autoPull) throw new Error(`model ${model} is not installed and OLLAMA_AI_AUTO_PULL=false`);
          await this.pull(model);
        }
        this.ready = true;
        this.lastError = undefined;
        this.markReady();
        this.logger.info({ url: this.cfg.url, models: this.requiredModels() }, 'Ollama is ready');
        return;
      } catch (error) {
        this.lastError = error;
        const delay = Math.min(maxDelayMs, 1000 * 2 ** Math.min(attempt, 5));
        this.logger.warn({ url: this.cfg.url, err: error.message, retryInMs: delay }, 'Ollama not ready yet');
        await sleep(delay);
      }
    }
  }

  async waitUntilReady(timeoutMs) {
    if (this.ready) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.readyPromise.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async loadedModels() {
    return (await this.client.ps()).models ?? [];
  }

  /**
   * Frees the GPU before the video worker runs (8 GB cards cannot hold both). Unloading is
   * asynchronous inside Ollama, so /api/ps is polled until no model is resident.
   */
  async unloadAll({ timeoutMs = 20_000 } = {}) {
    let loaded = await this.loadedModels().catch(() => []);
    if (loaded.length === 0) return;
    for (const m of loaded) {
      await this.client.generate({ model: m.model ?? m.name, prompt: '', keep_alive: 0, stream: false }).catch((error) => {
        this.logger.warn({ model: m.name, err: error.message }, 'could not unload model');
      });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      loaded = await this.loadedModels().catch(() => []);
      if (loaded.length === 0) return;
      await sleep(250);
    }
    this.logger.warn({ models: loaded.map((m) => m.name) }, 'models still loaded after unload request');
  }

  /** Logs a warning when a loaded model does not fit in VRAM (silent 5-10x slowdown). */
  async checkOffload(model) {
    const entry = (await this.loadedModels().catch(() => [])).find(
      (m) => normalizeModelName(m.model ?? m.name) === normalizeModelName(model),
    );
    if (!entry || !entry.size) return undefined;
    const gpuFraction = entry.size_vram / entry.size;
    if (gpuFraction < 0.98) {
      this.logger.warn(
        { model, gpuPercent: Math.round(gpuFraction * 100) },
        'model is partially loaded in system RAM: expect much slower generation. Use a smaller model or context (OLLAMA_AI_NUM_CTX).',
      );
    }
    return gpuFraction;
  }

  /**
   * Streams one chat completion.
   * @param {{ model: string, messages: object[], format?: string|object, options?: object, think?: boolean|string,
   *           signal?: AbortSignal, expectJson?: boolean }} request
   * @returns {Promise<{ text: string, stats: object }>}
   */
  async chat({ model, messages, format, options, think = this.cfg.think, signal, expectJson = false }) {
    const request = { model, messages, stream: true, keep_alive: this.cfg.keepAlive, options };
    if (format !== undefined) request.format = format;
    if (think !== undefined) request.think = think;

    let iterator;
    let timedOut = false;
    const abort = () => (iterator ? iterator.abort() : this.client.abort());
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, this.cfg.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const started = Date.now();
    try {
      try {
        iterator = await this.client.chat(request);
      } catch (error) {
        // Models without a thinking mode can reject the `think` flag; retry without it.
        if (request.think === undefined || !/think/i.test(error.message)) throw error;
        delete request.think;
        iterator = await this.client.chat(request);
      }
      if (signal?.aborted) iterator.abort();

      const detector = expectJson ? createJsonEndDetector() : undefined;
      let text = '';
      let stats = {};
      for await (const part of iterator) {
        const piece = part.message?.content ?? '';
        if (detector) {
          const end = detector.push(piece);
          if (end !== -1) {
            text += piece.slice(0, end);
            iterator.abort(); // the JSON is complete: stop generating trailing whitespace
            stats.stoppedEarly = true;
            break;
          }
        }
        text += piece;
        if (part.done) {
          stats = {
            promptTokens: part.prompt_eval_count,
            outputTokens: part.eval_count,
            loadMs: part.load_duration ? Math.round(part.load_duration / 1e6) : undefined,
          };
        }
      }
      stats.wallMs = Date.now() - started;
      return { text: text.trim(), stats };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (timedOut)
        throw new HttpError(504, 'LLM_TIMEOUT', `The language model did not answer within ${Math.round(this.cfg.timeoutMs / 1000)} s.`);
      throw mapOllamaError(error, model);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function mapOllamaError(error, model) {
  const message = String(error?.message ?? error);
  if (/not found/i.test(message) && /model/i.test(message)) {
    return new HttpError(400, 'MODEL_NOT_FOUND', `Model "${model}" is not installed in Ollama.`);
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|UND_ERR_CONNECT/i.test(message + String(error?.cause?.code ?? ''))) {
    return new HttpError(503, 'LLM_UNAVAILABLE', 'Ollama is not reachable.');
  }
  return new HttpError(502, 'LLM_ERROR', `The language model failed: ${message.slice(0, 300)}`);
}
