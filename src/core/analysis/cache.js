// Analysis cache: results are keyed by the video's content hash plus everything that changes the
// output (backend version, language, sampling rate, features). Re-prompting a video with another
// model, format or explanation therefore skips the expensive video analysis entirely.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../storage/fs-utils.js';

export class AnalysisCache {
  constructor({ dir }) {
    this.dir = dir;
  }

  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  key({ sha256, backendVersion, options }) {
    const material = JSON.stringify({
      backendVersion,
      language: options.language,
      sampleFps: options.sampleFps,
      features: [...options.features].sort(),
    });
    return `${sha256}.${crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
  }

  file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key) {
    const value = await readJson(this.file(key));
    return value?.analysisVersion ? value : undefined;
  }

  async put(key, analysis) {
    await writeJsonAtomic(this.file(key), analysis);
  }

  /** Removes every cached analysis of a video. */
  async deleteForVideo(sha256) {
    const entries = await fs.promises.readdir(this.dir).catch(() => []);
    await Promise.all(
      entries.filter((e) => e.startsWith(`${sha256}.`)).map((e) => fs.promises.rm(path.join(this.dir, e), { force: true })),
    );
  }
}
