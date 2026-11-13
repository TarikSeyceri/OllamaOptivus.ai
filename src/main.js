// Ollama Optivus AI - API service entry point.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { AnalysisCache } from './core/analysis/cache.js';
import { WorkerBackend } from './core/analysis/worker-backend.js';
import { JobQueue } from './core/jobs/job-queue.js';
import { JobStore } from './core/jobs/job-store.js';
import { createGpuCoordinator, createJobRunner } from './core/jobs/pipeline.js';
import { OllamaService } from './core/llm/ollama.js';
import { acquireDataDirLock } from './core/storage/data-dir-lock.js';
import { startRetention } from './core/storage/retention.js';
import { VideoStore } from './core/storage/video-store.js';
import { createLogger } from './logger.js';

loadDotEnv(path.resolve('.env')); // real environment variables always win over .env
const { config, errors, warnings } = loadConfig(process.env);
if (errors.length) {
  // Plain stderr: the logger may not be configured when the configuration itself is invalid.
  console.error(`Invalid configuration - refusing to start:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

const logger = createLogger(config.log);
warnings.forEach((warning) => logger.warn(warning));

async function main() {
  const { storage } = config;
  const releaseLock = await acquireDataDirLock(storage.dataDir);
  for (const dir of [storage.videosDir, storage.analysisDir, storage.promptsDir, storage.framesDir, storage.tmpDir]) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const videoStore = new VideoStore({ storage, logger });
  const analysisCache = new AnalysisCache({ dir: storage.analysisDir });
  const jobStore = new JobStore({ jobsDir: storage.jobsDir, resultsDir: storage.resultsDir });
  await Promise.all([videoStore.init(), analysisCache.init(), jobStore.init()]);

  const backend = new WorkerBackend({ analysis: config.analysis, logger });
  const ollama = new OllamaService({ ollama: config.ollama, logger });
  if (!config.ollama.disabled) ollama.init().catch((error) => logger.error({ err: error }, 'Ollama initialization stopped'));

  const gpu = createGpuCoordinator({ shared: config.ollama.lowVram || !config.jobs.pipelined });
  const runner = createJobRunner({ config, logger, videoStore, backend, analysisCache, ollama, gpu });
  const jobQueue = new JobQueue({
    store: jobStore,
    runner,
    logger,
    concurrency: config.jobs.pipelined ? 2 : 1,
    maxQueued: config.jobs.maxQueued,
    timeoutMs: config.jobs.timeoutMs,
    maxAttempts: config.jobs.maxAttempts,
  });
  await jobQueue.init();

  const services = { videoStore, analysisCache, jobStore, jobQueue, backend, ollama };
  const retention = startRetention({ config, logger, videoStore, jobStore, jobQueue, analysisCache });
  const app = createApp({ config, logger, services });

  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info(
      { port: config.http.port, env: config.env, workers: config.analysis.workerUrls.length, docs: config.docs.enabled },
      'Ollama Optivus Server running',
    );
  });
  server.requestTimeout = config.http.requestTimeoutMs; // large uploads on slow links
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000; // longer than typical load-balancer idle timeouts

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const hardExit = setTimeout(() => process.exit(1), 25_000);
    hardExit.unref();
    server.close();
    server.closeIdleConnections?.();
    retention.stop();
    await jobQueue.close(15_000); // running jobs resume after the restart
    await releaseLock();
    logger.flush?.();
    setTimeout(() => process.exit(0), 200).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
main().catch((error) => {
  console.error(`Fatal start-up error: ${error.message}`);
  logger.fatal({ err: error }, 'start-up failed');
  setTimeout(() => process.exit(1), 200);
});
