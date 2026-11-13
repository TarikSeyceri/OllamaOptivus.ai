// The job runner: resolve video -> analyze (cached) -> describe keyframes (optional) -> summarize.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../../http/errors.js';
import { describeAnalysis, toLegacy } from '../analysis/format.js';
import { buildPrompt } from '../llm/prompt.js';
import { summarize } from '../llm/summarize.js';
import { describeKeyframes } from '../llm/vision.js';
import { writeFileAtomic } from '../storage/fs-utils.js';

/** Serializes GPU-heavy stages. With a shared low-VRAM GPU every stage shares one lock. */
export function createGpuCoordinator({ shared }) {
  const tails = new Map();
  return {
    async run(kind, fn) {
      const key = shared ? 'gpu' : kind;
      const previous = tails.get(key) ?? Promise.resolve();
      let release;
      const mine = new Promise((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(key, tail);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

/**
 * @returns {(job: object, ctx: { signal: AbortSignal, update: Function }) => Promise<{ result: object, summary?: object, warnings?: string[] }>}
 */
export function createJobRunner({ config, logger, videoStore, backend, analysisCache, ollama, gpu }) {
  const { storage, ollama: llmCfg } = config;

  return async function runJob(job, { signal, update }) {
    const request = job.request;
    const log = logger.child({ jobId: job.id });

    // 1) Video ------------------------------------------------------------------------------------
    const video = await videoStore.resolve(request.source);
    await update({ video: { id: video.sha256, root: video.root, path: video.relPath, size: video.size } });

    // 2) Analysis (content-addressed cache) -------------------------------------------------------
    const options = { language: request.language, sampleFps: request.sampleFps, features: request.features };
    const capabilities = await backend.capabilities();
    const key = analysisCache.key({ sha256: video.sha256, backendVersion: capabilities.version ?? backend.version, options });
    let analysis = await analysisCache.get(key);
    const timings = {};
    if (analysis) {
      log.info('analysis served from cache');
    } else {
      await update({ stage: 'analyzing', progress: 0 });
      const started = Date.now();
      analysis = await gpu.run('analysis', async () => {
        if (llmCfg.lowVram && !llmCfg.disabled) await ollama.unloadAll(); // free VRAM for the worker
        return backend.analyze({
          video,
          options,
          // Keyframes belong to the cached analysis (not to the job), so later jobs can caption them.
          keyframesDir: `frames/${key}`,
          signal,
          onProgress: (progress) => update({ progress: Math.min(0.99, progress) }),
        });
      });
      timings.analysisMs = Date.now() - started;
      await analysisCache.put(key, analysis);
    }

    const needsLlm = !llmCfg.disabled && (!request.noPrompting || request.features.includes('captions'));
    if (needsLlm && !(await ollama.waitUntilReady(60_000))) {
      throw new HttpError(503, 'LLM_UNAVAILABLE', 'The language model (Ollama) is not ready.');
    }

    // 3) Scene descriptions (optional) ------------------------------------------------------------
    const wantsCaptions = request.features.includes('captions') && llmCfg.vision.enabled && !llmCfg.disabled;
    const captionKey = `${key}.captions-${llmCfg.vision.model.replace(/[^\w.-]+/g, '_')}`;
    if (wantsCaptions && analysis.frames?.some((f) => f.keyframe)) {
      const cached = await analysisCache.get(captionKey);
      if (cached) {
        analysis = cached;
      } else {
        await update({ stage: 'describing', progress: 0 });
        const started = Date.now();
        analysis = await gpu.run('llm', () =>
          describeKeyframes({
            ollama,
            cfg: llmCfg,
            analysis: structuredClone(analysis),
            framesRoot: storage.dataDir,
            signal,
            onProgress: (progress) => update({ progress }),
            logger: log,
          }),
        );
        timings.captionsMs = Date.now() - started;
        await analysisCache.put(captionKey, analysis);
      }
    }

    // 4) Prompt -----------------------------------------------------------------------------------
    const prompt = buildPrompt(analysis, request);
    if (storage.storePrompts) {
      await writeFileAtomic(path.join(storage.promptsDir, `${job.id}.txt`), prompt.text).catch((error) => {
        log.warn({ err: error.message }, 'could not store prompt');
      });
    }
    const summary = { ...describeAnalysis(analysis), analysisKey: key, timings };

    if (request.noPrompting || llmCfg.disabled) {
      return {
        result: { noPrompting: true, prompt: prompt.text, analysisKey: key, legacyStdout: JSON.stringify(toLegacy(analysis)) },
        summary,
      };
    }

    // 5) Summary ----------------------------------------------------------------------------------
    await update({ stage: 'summarizing', progress: 0 });
    const started = Date.now();
    const out = await gpu.run('llm', () =>
      summarize({
        ollama,
        cfg: llmCfg,
        analysis,
        request,
        signal,
        onStage: (stage, progress) => update({ stage, progress }),
        logger: log,
      }),
    );
    summary.timings.llmMs = Date.now() - started;
    summary.llm = { model: request.model, ...out.stats, chunked: out.chunked };

    return {
      result: { result: out.json, response: out.text, model: request.model, prompt: prompt.text, analysisKey: key },
      summary,
      warnings: out.warnings,
    };
  };
}

/** Deletes the keyframes of every cached analysis of a video. */
export async function deleteFramesForVideo(storage, sha256) {
  const entries = await fs.promises.readdir(storage.framesDir).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${sha256}.`))
      .map((entry) => fs.promises.rm(path.join(storage.framesDir, entry), { recursive: true, force: true })),
  );
}
