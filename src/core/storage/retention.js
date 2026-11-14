// Data retention: everything older than FILE_RETENTION_DAYS is removed hourly - uploaded videos,
// cached analyses, keyframes, prompts, finished job records and their results. Videos used by a
// queued or running job are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { deleteFramesForVideo } from '../jobs/pipeline.js';
import { TERMINAL } from '../jobs/job-queue.js';

export function startRetention({ config, logger, videoStore, jobStore, jobQueue, analysisCache }) {
  const { storage } = config;
  const maxAgeMs = storage.retentionDays * 24 * 60 * 60 * 1000;

  async function removeOldEntries(dir, { recursive = false, skip = () => false } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < cutoff && (entry.isFile() || (recursive && entry.isDirectory()))) {
          await fs.promises.rm(file, { recursive, force: true });
          removed++;
        }
      } catch (error) {
        logger.warn({ file, err: error.message }, 'retention: could not remove');
      }
    }
    return removed;
  }

  async function sweep() {
    const cutoff = Date.now() - maxAgeMs;
    const active = jobQueue.activeVideoIds();
    let videos = 0;
    for (const meta of await videoStore.list()) {
      if (Date.parse(meta.createdAt) >= cutoff || active.has(meta.id)) continue;
      const deleted = await videoStore.deleteFile(meta.fileName);
      if (deleted && !deleted.stillReferenced) {
        await analysisCache.deleteForVideo(meta.id);
        await deleteFramesForVideo(storage, meta.id);
      }
      videos++;
    }

    let jobs = 0;
    for (const job of jobStore.all()) {
      if (TERMINAL.has(job.status) && Date.parse(job.finishedAt ?? job.updatedAt ?? job.createdAt) < cutoff) {
        await jobStore.delete(job.id);
        await fs.promises.rm(path.join(storage.promptsDir, `${job.id}.txt`), { force: true });
        jobs++;
      }
    }

    const activePrefix = (name) => [...active].some((id) => name.startsWith(`${id}.`));
    const files =
      (await removeOldEntries(storage.analysisDir, { skip: activePrefix })) +
      (await removeOldEntries(storage.framesDir, { recursive: true, skip: activePrefix })) +
      (await removeOldEntries(storage.promptsDir));
    if (videos || jobs || files) logger.info({ videos, jobs, files }, 'retention sweep removed expired data');
  }

  const run = () => sweep().catch((error) => logger.error({ err: error }, 'retention sweep failed'));
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 60 * 60 * 1000);
  first.unref();
  timer.unref();
  return {
    sweep,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
