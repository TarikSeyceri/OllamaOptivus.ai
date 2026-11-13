// In-process job queue with persistence, bounded size, dedupe, attempts, timeouts and cancellation.
//
// One API replica owns the data directory (see data-dir-lock.js), so an in-memory queue backed by
// atomic JSON files is enough: after a crash or restart, queued and interrupted jobs are re-queued
// (up to JOB_MAX_ATTEMPTS, so a video that crashes the analyzer cannot loop forever).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError } from '../../http/errors.js';

export const TERMINAL = new Set(['completed', 'failed', 'canceled']);
const ACTIVE = new Set(['queued', 'running']);

export class JobQueue extends EventEmitter {
  /**
   * @param {{ store: import('./job-store.js').JobStore, runner: Function, logger: import('pino').Logger,
   *           concurrency: number, maxQueued: number, timeoutMs: number, maxAttempts: number }} deps
   */
  constructor({ store, runner, logger, concurrency = 1, maxQueued = 20, timeoutMs, maxAttempts = 2 }) {
    super();
    this.setMaxListeners(0);
    this.store = store;
    this.runner = runner;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.pending = [];
    this.running = new Map(); // id -> AbortController
    this.closed = false;
  }

  async init() {
    const recoverable = this.store
      .all()
      .filter((job) => ACTIVE.has(job.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of recoverable) {
      if (job.attempts >= this.maxAttempts) {
        await this.#finish(job, 'failed', {
          error: { code: 'INTERRUPTED', message: 'The job was interrupted too many times (server restarts or crashes).' },
        });
      } else {
        job.status = 'queued';
        job.stage = 'queued';
        await this.store.save(job);
        this.pending.push(job.id);
      }
    }
    if (recoverable.length) this.logger.info({ count: recoverable.length }, 'recovered unfinished jobs');
    this.#pump();
  }

  /**
   * Creates a job, or returns the active job with the same dedupe key.
   * @returns {Promise<{ job: object, deduplicated: boolean }>}
   */
  async submit(request, { dedupeKey, meta = {} } = {}) {
    if (this.closed) throw new HttpError(503, 'SHUTTING_DOWN', 'The server is shutting down.');
    if (dedupeKey) {
      const existing = this.store.all().find((j) => j.dedupeKey === dedupeKey && ACTIVE.has(j.status));
      if (existing) return { job: existing, deduplicated: true };
    }
    if (this.pending.length >= this.maxQueued) {
      throw new HttpError(503, 'QUEUE_FULL', 'Too many jobs are waiting; please try again later.');
    }
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      status: 'queued',
      stage: 'queued',
      progress: 0,
      attempts: 0,
      createdAt: now,
      dedupeKey,
      request,
      ...meta,
    };
    await this.store.save(job);
    this.pending.push(job.id);
    this.logger.info({ jobId: job.id }, 'job queued');
    this.#pump();
    return { job, deduplicated: false };
  }

  get(id) {
    return this.store.get(id);
  }

  list({ status, limit = 50 } = {}) {
    return this.store
      .all()
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  position(id) {
    const index = this.pending.indexOf(id);
    return index === -1 ? undefined : index + 1;
  }

  /** Video content ids referenced by queued or running jobs (protected from deletion/retention). */
  activeVideoIds() {
    return new Set(
      this.store
        .all()
        .filter((j) => ACTIVE.has(j.status) && j.video?.id)
        .map((j) => j.video.id),
    );
  }

  isActive(id) {
    return ACTIVE.has(this.store.get(id)?.status);
  }

  async cancel(id) {
    const job = this.store.get(id);
    if (!job || TERMINAL.has(job.status)) return job;
    const index = this.pending.indexOf(id);
    if (index !== -1) {
      this.pending.splice(index, 1);
      await this.#finish(job, 'canceled', {});
    } else {
      this.running.get(id)?.abort(new HttpError(499, 'CANCELED', 'The job was canceled.'));
    }
    return job;
  }

  /** Resolves with the job once it is finished, or with its current state after `timeoutMs`. */
  waitFor(id, timeoutMs) {
    const job = this.store.get(id);
    if (!job || TERMINAL.has(job.status) || timeoutMs <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const onSettled = (settled) => {
        if (settled.id !== id) return;
        cleanup();
        resolve(settled);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.store.get(id));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('settled', onSettled);
      };
      this.on('settled', onSettled);
    });
  }

  /** Stops taking work; waits up to `graceMs` for running jobs, then aborts them (they resume on restart). */
  async close(graceMs = 10_000) {
    this.closed = true;
    if (this.running.size === 0) return;
    const idle = new Promise((resolve) => {
      const check = () => {
        if (this.running.size === 0) resolve();
      };
      this.on('settled', check);
    });
    await Promise.race([idle, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    for (const controller of this.running.values()) controller.abort(new HttpError(503, 'SHUTTING_DOWN', 'The server is shutting down.'));
  }

  #pump() {
    while (!this.closed && this.running.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      const job = this.store.get(id);
      if (!job || job.status !== 'queued') continue;
      this.#start(job);
    }
  }

  #start(job) {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new HttpError(504, 'JOB_TIMEOUT', `The job did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes.`),
        ),
      this.timeoutMs,
    );
    timer.unref?.();

    const run = async () => {
      job.status = 'running';
      job.attempts += 1;
      job.startedAt = new Date().toISOString();
      job.error = undefined;
      await this.store.save(job);
      this.logger.info({ jobId: job.id, attempt: job.attempts }, 'job started');

      let lastSave = 0;
      const update = async (patch) => {
        Object.assign(job, patch);
        const now = Date.now();
        if (now - lastSave > 1000 || patch.stage) {
          lastSave = now;
          await this.store.save(job).catch((error) => this.logger.warn({ err: error }, 'could not persist job progress'));
        }
      };

      try {
        const result = await this.runner(job, { signal: controller.signal, update });
        if (controller.signal.aborted) throw controller.signal.reason;
        await this.store.saveResult(job.id, result.result);
        await this.#finish(job, 'completed', { summary: result.summary, warnings: result.warnings });
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        if (reason?.code === 'SHUTTING_DOWN') {
          // Leave it "running": init() re-queues it after the restart.
          this.logger.warn({ jobId: job.id }, 'job interrupted by shutdown');
        } else if (reason?.code === 'CANCELED') {
          await this.#finish(job, 'canceled', {});
        } else {
          const code = reason instanceof HttpError ? reason.code : 'JOB_FAILED';
          const message = reason instanceof HttpError ? reason.message : 'Processing failed.';
          if (!(reason instanceof HttpError) || reason.status >= 500) this.logger.error({ jobId: job.id, err: reason }, 'job failed');
          await this.#finish(job, 'failed', { error: { code, message } });
        }
      } finally {
        clearTimeout(timer);
        this.running.delete(job.id);
        this.emit('settled', job);
        this.#pump();
      }
    };
    run().catch((error) => this.logger.error({ err: error }, 'job runner crashed'));
  }

  async #finish(job, status, patch) {
    Object.assign(job, patch, { status, stage: status === 'completed' ? 'done' : job.stage, finishedAt: new Date().toISOString() });
    if (status === 'completed') job.progress = 1;
    if (job.startedAt) job.durationMs = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
    await this.store.save(job);
    this.logger.info({ jobId: job.id, status, durationMs: job.durationMs }, 'job finished');
    if (!this.running.has(job.id)) this.emit('settled', job);
  }
}
