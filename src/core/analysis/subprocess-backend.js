// Analysis backend that runs the legacy one-shot script (src/processor.py) per video.
// Kept for local setups without the worker service; the worker backend is the default in v2.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from '../../http/errors.js';
import { fromLegacy } from './format.js';

const execFileAsync = promisify(execFile);
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/**
 * Analysis backend contract (implemented by SubprocessBackend and WorkerBackend):
 *   version: string                                  part of the analysis cache key
 *   capabilities(): Promise<{ languages, features, ... }>
 *   ready(): Promise<{ ok: boolean, detail?: string }>
 *   analyze({ video, options, signal, onProgress }): Promise<analysis v2>
 */
export class SubprocessBackend {
  constructor({ analysis, storage, logger }) {
    this.version = 'subprocess-1';
    this.python = analysis.python;
    this.timeoutMs = analysis.processingTimeoutMs;
    this.storage = storage;
    this.logger = logger;
    this.script = path.join(import.meta.dirname, '..', '..', 'processor.py');
  }

  async capabilities() {
    return { version: this.version, languages: ['en', 'tr'], features: ['objects', 'ocr'], keyframes: false };
  }

  async ready() {
    return { ok: true };
  }

  async analyze({ video, options, signal }) {
    // The child gets the environment minus anything that looks like a credential.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.test(key)));
    Object.assign(env, {
      AUDIOS_DIR: this.storage.audiosDir,
      JSON_DATA_DIR: this.storage.analysisDir,
      PROCESSING_FPS: String(options.sampleFps),
      PYTHONIOENCODING: 'utf-8',
    });
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.python, [this.script, video.absPath, options.language], {
        env,
        signal,
        maxBuffer: 512 * 1024 * 1024,
        timeout: this.timeoutMs,
        windowsHide: true,
      }));
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error.killed ? `timed out after ${this.timeoutMs} ms` : String(error.stderr || error.message).slice(-2000);
      this.logger.error({ detail }, 'analysis subprocess failed');
      throw new HttpError(500, 'ANALYSIS_FAILED', 'Video analysis failed.');
    }
    try {
      return { ...fromLegacy(JSON.parse(stdout), { language: options.language }), device: 'subprocess' };
    } catch {
      throw new HttpError(500, 'ANALYSIS_FAILED', 'Video analysis returned invalid output.');
    }
  }
}
