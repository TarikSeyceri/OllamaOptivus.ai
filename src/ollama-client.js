const { Ollama } = require("ollama");

/** Ollama treats "name" and "name:latest" as the same model. */
const normalizeModelName = (name = "") => (name.includes(":") ? name : `${name}:latest`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin wrapper around the Ollama client:
 *  - startup readiness with retry/backoff instead of crashing the process,
 *  - exact model-name matching and streamed pulls with progress logs,
 *  - streamed generation (avoids the 300 s response-header timeout of Node's fetch on long outputs),
 *  - an overall timeout per generation.
 */
class OllamaService {
    constructor({ host, model, keepAlive, numCtx, think, timeoutMs, logger = console }) {
        this.host = host;
        this.model = model;
        this.keepAlive = keepAlive;
        this.numCtx = numCtx;
        this.think = think;
        this.timeoutMs = timeoutMs;
        this.logger = logger;
        this.client = new Ollama({ host });
        this.ready = false;
        this.lastError = undefined;
        this.readyPromise = new Promise((resolve) => { this.markReady = resolve; });
    }

    /** Resolves true once Ollama is ready, or false after `timeoutMs`. */
    async waitUntilReady(timeoutMs) {
        if (this.ready) return true;
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
        try {
            return await Promise.race([this.readyPromise.then(() => true), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    async hasModel(model) {
        const { models } = await this.client.list();
        const wanted = normalizeModelName(model);
        return models.some((m) => normalizeModelName(m.model ?? m.name) === wanted);
    }

    async pull(model) {
        this.logger.info(`Pulling Ollama model ${model} (this can take a while on first start)...`);
        let lastLogged = -10;
        const stream = await this.client.pull({ model, stream: true });
        for await (const part of stream) {
            if (part.total && part.completed !== undefined) {
                const percent = Math.floor((part.completed / part.total) * 100);
                if (percent >= lastLogged + 10) {
                    lastLogged = percent;
                    this.logger.info(`Pulling ${model}: ${part.status} ${percent}%`);
                }
            }
        }
        this.logger.info(`Pulled Ollama model ${model}.`);
    }

    /** Waits (with exponential backoff, forever) until Ollama answers and the default model exists. */
    async init({ autoPull = true, maxDelayMs = 30_000 } = {}) {
        for (let attempt = 0; ; attempt++) {
            try {
                if (!(await this.hasModel(this.model))) {
                    if (!autoPull) throw new Error(`model ${this.model} is not available and auto-pull is disabled`);
                    await this.pull(this.model);
                    if (!(await this.hasModel(this.model))) throw new Error(`model ${this.model} still missing after pull`);
                }
                this.ready = true;
                this.lastError = undefined;
                this.markReady();
                this.logger.info(`Ollama is reachable at ${this.host} and model ${this.model} is available.`);
                return;
            } catch (error) {
                this.lastError = error;
                const delay = Math.min(maxDelayMs, 1000 * 2 ** Math.min(attempt, 5));
                this.logger.warn(`Ollama not ready at ${this.host} (${error.message}); retrying in ${Math.round(delay / 1000)}s.`);
                await sleep(delay);
            }
        }
    }

    /** Generates a (JSON) completion and returns the raw text. */
    async generate({ model = this.model, system, prompt, format, temperature }) {
        const request = {
            model,
            system,
            prompt,
            format,
            stream: true,
            keep_alive: this.keepAlive,
            options: { temperature, num_ctx: this.numCtx },
        };
        if (this.think !== undefined) request.think = this.think;

        let stream;
        try {
            stream = await this.client.generate(request);
        } catch (error) {
            // Models without a thinking mode reject the `think` flag on some Ollama versions; retry without it.
            if (request.think !== undefined && /think/i.test(error.message)) {
                delete request.think;
                stream = await this.client.generate(request);
            } else {
                throw error;
            }
        }

        const timer = setTimeout(() => stream.abort(), this.timeoutMs);
        let text = "";
        try {
            for await (const part of stream) {
                text += part.response ?? "";
            }
        } catch (error) {
            if (error.name === "AbortError") throw new Error(`Ollama generation timed out after ${this.timeoutMs} ms`);
            throw error;
        } finally {
            clearTimeout(timer);
        }
        // Structured outputs can end with long runs of whitespace; they are not part of the JSON.
        return text.trim();
    }
}

module.exports = { OllamaService, normalizeModelName };
