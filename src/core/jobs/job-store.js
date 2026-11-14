// Persistent job records (data/jobs/<id>.json) and results (data/results/<id>.json).
// Files are written atomically; the in-memory index is rebuilt from disk at start-up.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/fs-utils.js';

const ID = /^[a-f0-9-]{36}$/;

export class JobStore {
  constructor({ jobsDir, resultsDir }) {
    this.jobsDir = jobsDir;
    this.resultsDir = resultsDir;
    this.jobs = new Map();
  }

  async init() {
    await fs.promises.mkdir(this.jobsDir, { recursive: true });
    await fs.promises.mkdir(this.resultsDir, { recursive: true });
    for (const entry of await fs.promises.readdir(this.jobsDir)) {
      if (!entry.endsWith('.json')) continue;
      const job = await readJson(path.join(this.jobsDir, entry));
      if (job?.id && ID.test(job.id)) this.jobs.set(job.id, job);
    }
  }

  get(id) {
    return ID.test(id ?? '') ? this.jobs.get(id) : undefined;
  }

  all() {
    return [...this.jobs.values()];
  }

  async save(job) {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.id, job);
    await writeJsonAtomic(path.join(this.jobsDir, `${job.id}.json`), job);
  }

  async saveResult(id, result) {
    await writeJsonAtomic(path.join(this.resultsDir, `${id}.json`), result);
  }

  async readResult(id) {
    return ID.test(id ?? '') ? readJson(path.join(this.resultsDir, `${id}.json`)) : undefined;
  }

  async delete(id) {
    if (!ID.test(id ?? '')) return;
    this.jobs.delete(id);
    await fs.promises.rm(path.join(this.jobsDir, `${id}.json`), { force: true });
    await fs.promises.rm(path.join(this.resultsDir, `${id}.json`), { force: true });
  }
}
