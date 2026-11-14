// v1 jobs: asynchronous processing with polling/long-polling, cancellation and result retrieval.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { buildJobRequest, dedupeKeyFor, jobView } from '../../core/jobs/requests.js';
import { HttpError, validate } from '../errors.js';
import { createJobBody, jobId, listJobsQuery, waitQuery } from '../schemas.js';

const notFoundJob = () => new HttpError(404, 'JOB_NOT_FOUND', 'Job not found.');

export function jobsRouter({ config, services, heavyLimiter }) {
  const router = Router();
  const { jobQueue, jobStore, videoStore, analysisCache, backend } = services;

  async function viewOf(job) {
    const result = job.status === 'completed' ? await jobStore.readResult(job.id) : undefined;
    return jobView(job, { position: jobQueue.position(job.id), result });
  }

  router.post('/v1/jobs', heavyLimiter, async (req, res) => {
    const body = validate(createJobBody, req.body);
    const { wait } = validate(waitQuery, req.query);
    const source = body.videoId ? { videoId: body.videoId } : { root: body.source.root, path: body.source.path };
    const capabilities = await backend.capabilities();
    const { request, warnings } = buildJobRequest({ body, source, legacy: false, config, capabilities });

    // Resolve now so that missing/forbidden videos fail synchronously with 4xx.
    const video = await videoStore.resolve(source);
    const { job, deduplicated } = await jobQueue.submit(request, {
      dedupeKey: dedupeKeyFor(request, video.sha256),
      meta: { video: { id: video.sha256, root: video.root, path: video.relPath, size: video.size }, warnings },
    });
    const current = wait ? await jobQueue.waitFor(job.id, wait * 1000) : job;
    const view = await viewOf(current);
    res
      .status(view.status === 'completed' ? 200 : 202)
      .location(`/v1/jobs/${job.id}`)
      .json({
        success: true,
        msg: deduplicated ? 'An identical job is already active.' : 'Job accepted.',
        payload: { job: view, deduplicated },
      });
  });

  router.get('/v1/jobs', (req, res, next) => {
    const { status, limit } = validate(listJobsQuery, req.query);
    Promise.all(jobQueue.list({ status, limit }).map((job) => jobView(job, { position: jobQueue.position(job.id) })))
      .then((jobs) => res.json({ success: true, msg: 'Jobs listed.', payload: { jobs } }))
      .catch(next);
  });

  router.get('/v1/jobs/:id', async (req, res) => {
    const id = validate(jobId, req.params.id);
    const { wait } = validate(waitQuery, req.query);
    const job = wait ? await jobQueue.waitFor(id, wait * 1000) : jobQueue.get(id);
    if (!job) throw notFoundJob();
    res.json({ success: true, msg: `Job is ${job.status}.`, payload: { job: await viewOf(job) } });
  });

  router.get('/v1/jobs/:id/analysis', async (req, res) => {
    const job = jobQueue.get(validate(jobId, req.params.id));
    if (!job) throw notFoundJob();
    const analysis = job.summary?.analysisKey ? await analysisCache.get(job.summary.analysisKey) : undefined;
    if (!analysis) throw new HttpError(404, 'ANALYSIS_NOT_FOUND', 'No analysis is available for this job (not finished, or expired).');
    res.json({ success: true, msg: 'Analysis found.', payload: { analysis } });
  });

  router.get('/v1/jobs/:id/prompt', async (req, res) => {
    const job = jobQueue.get(validate(jobId, req.params.id));
    if (!job) throw notFoundJob();
    try {
      const prompt = await fs.promises.readFile(path.join(config.storage.promptsDir, `${job.id}.txt`), 'utf8');
      res.type('text/plain; charset=utf-8').send(prompt);
    } catch {
      throw new HttpError(404, 'PROMPT_NOT_FOUND', 'No prompt is stored for this job (not built yet, STORE_PROMPTS=false, or expired).');
    }
  });

  router.delete('/v1/jobs/:id', async (req, res) => {
    const id = validate(jobId, req.params.id);
    const job = jobQueue.get(id);
    if (!job) throw notFoundJob();
    if (jobQueue.isActive(id)) {
      await jobQueue.cancel(id);
      return res.status(202).json({ success: true, msg: 'Cancellation requested.', payload: { job: await viewOf(jobQueue.get(id)) } });
    }
    await jobStore.delete(id);
    await fs.promises.rm(path.join(config.storage.promptsDir, `${id}.txt`), { force: true });
    return res.json({ success: true, msg: 'Job deleted.' });
  });

  return router;
}
