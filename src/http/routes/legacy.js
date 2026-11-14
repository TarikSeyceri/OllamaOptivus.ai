// Legacy v1 endpoints (deprecated, kept so existing clients keep working).
// The request/response contract is unchanged; internally everything runs on the v2 job system,
// with v2's validation, storage and security.
import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { deleteFramesForVideo } from '../../core/jobs/pipeline.js';
import { buildJobRequest, dedupeKeyFor } from '../../core/jobs/requests.js';
import { sanitizeFileName } from '../../core/storage/paths.js';
import { HttpError } from '../errors.js';
import { legacyProcessBody } from '../schemas.js';

const fail = (res, status, msg, extra = {}) => res.status(status).json({ success: false, msg, ...extra });
const DEPRECATION = '@1798761600'; // RFC 9745: announced deprecation date (2027-01-01)

/** Maps job failures to the status codes v1 used. */
const LEGACY_STATUS = { VIDEO_NOT_FOUND: 404, PATH_NOT_ALLOWED: 403, INVALID_FILE_TYPE: 400, QUEUE_FULL: 503, SHUTTING_DOWN: 503 };

export function legacyRouter({ config, services, heavyLimiter }) {
  const router = Router();
  const { videoStore, jobQueue, analysisCache, backend } = services;
  const { storage } = config;
  const displayPath = (fileName) => path.join(storage.videosDirDisplay, fileName);

  router.use(['/upload', '/videos', '/delete', '/process'], (req, res, next) => {
    res.set('Deprecation', DEPRECATION);
    res.set('Link', '</docs>; rel="deprecation"');
    next();
  });

  const disabledWhenProcessingOnly = (action) => (req, res, next) => {
    if (!storage.processingOnly) return next();
    req.log?.warn(`Video file ${action} disabled in this environment`);
    return fail(res, 403, `Video file ${action} disabled in this environment!`);
  };

  // v1 accepted .mp4 only, judged by name and declared type before writing; content is sniffed after.
  const upload = multer({
    storage: multer.diskStorage({
      destination: storage.tmpDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: storage.maxUploadBytes, files: 1, fields: 10, parts: 12 },
    fileFilter: (req, file, cb) => {
      const name = sanitizeFileName(file.originalname);
      if (file.fieldname !== 'video' || !name || path.extname(name) !== '.mp4' || file.mimetype !== 'video/mp4') {
        return cb(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only .mp4 video files are allowed'));
      }
      return cb(null, true);
    },
  }).single('video');

  router.post(
    '/upload',
    disabledWhenProcessingOnly('upload'),
    heavyLimiter,
    async (req, res, next) => {
      try {
        await videoStore.assertFreeSpace();
        return next();
      } catch (error) {
        return next(error);
      }
    },
    upload,
    async (req, res) => {
      if (!req.file) return fail(res, 400, 'Video file not uploaded!');
      const { video } = await videoStore.saveUpload({ tmpPath: req.file.path, originalName: req.file.originalname, legacy: true });
      return res.json({ success: true, msg: 'Video file uploaded!', payload: { videoFilePath: displayPath(video.fileName) } });
    },
  );

  router.get('/videos', disabledWhenProcessingOnly('listing'), async (req, res) => {
    const videos = (await videoStore.list()).map((v) => displayPath(v.fileName));
    return res.json({ success: true, msg: 'Video files listed!', payload: { videos } });
  });

  router.delete('/delete', disabledWhenProcessingOnly('deletion'), async (req, res) => {
    const { videoFileName } = req.body ?? {};
    if (typeof videoFileName !== 'string' || !videoFileName.trim()) return fail(res, 400, 'videoFileName not provided!');
    const fileName = path.basename(videoFileName.replace(/\\/g, '/'));
    const meta = fileName.startsWith('.') ? undefined : await videoStore.getByFileName(fileName);
    if (!meta) return fail(res, 404, 'Video file not found!');
    if (jobQueue.activeVideoIds().has(meta.id)) return fail(res, 409, 'The video is being processed; try again later.');
    const deleted = await videoStore.deleteFile(fileName);
    if (deleted && !deleted.stillReferenced) {
      await analysisCache.deleteForVideo(meta.id);
      await deleteFramesForVideo(storage, meta.id);
    }
    return res.json({ success: true, msg: 'Video file deleted!' });
  });

  router.post('/process', heavyLimiter, async (req, res) => {
    const raw = req.body ?? {};
    if (raw.videoFilePath === undefined || raw.videoFilePath === null || raw.videoFilePath === '') {
      return fail(res, 400, 'Video file path not provided!');
    }
    const parsed = legacyProcessBody.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(res, 400, `${issue.path.join('.') || 'body'}: ${issue.message}`, { error: { code: 'VALIDATION_FAILED' } });
    }
    const body = parsed.data;

    let video;
    try {
      video = await videoStore.resolve({ path: body.videoFilePath });
    } catch (error) {
      if (error instanceof HttpError) return fail(res, error.status, error.message);
      throw error;
    }

    const capabilities = await backend.capabilities();
    const source = { path: body.videoFilePath };
    const { request, warnings } = buildJobRequest({ body, source, legacy: true, config, capabilities });
    if (warnings.length) res.set('Warning', `299 - "${warnings[0].replace(/"/g, "'")}"`);

    const { job } = await jobQueue.submit(request, {
      dedupeKey: dedupeKeyFor(request, video.sha256),
      meta: { video: { id: video.sha256, root: video.root, path: video.relPath, size: video.size }, warnings },
    });
    // Waiting is not tied to this connection: if the client or a proxy gives up, the job keeps
    // running and an identical retry re-attaches to it (dedupe key).
    const done = await jobQueue.waitFor(job.id, config.jobs.syncTimeoutMs);

    if (done.status === 'completed') {
      const result = await services.jobStore.readResult(done.id);
      if (result?.noPrompting) {
        return res.json({
          success: true,
          msg: 'Processing completed, without prompting.',
          payload: { stdout: result.legacyStdout, prompt: result.prompt, jobId: done.id },
        });
      }
      return res.json({
        success: true,
        msg: 'Processing completed',
        payload: { response: result.response, result: result.result, jobId: done.id, ...(warnings.length ? { warnings } : {}) },
      });
    }
    if (done.status === 'failed') {
      const status = LEGACY_STATUS[done.error?.code] ?? 500;
      return fail(res, status, status === 500 ? 'Processing failed' : done.error.message, {
        error: { code: done.error?.code },
        payload: { jobId: done.id },
      });
    }
    if (done.status === 'canceled') return fail(res, 409, 'Processing was canceled.', { payload: { jobId: done.id } });
    return fail(res, 504, 'Processing is still running; poll GET /v1/jobs/{jobId} for the result.', { payload: { jobId: done.id } });
  });

  return router;
}
