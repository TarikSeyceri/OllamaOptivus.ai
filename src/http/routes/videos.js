// v1 video management: upload (content-addressed), list, get, delete (cascades to derived data).
import { Router } from 'express';
import { deleteFramesForVideo } from '../../core/jobs/pipeline.js';
import { badRequest, conflict, forbidden, HttpError, validate } from '../errors.js';
import { listVideosQuery, sha256Id } from '../schemas.js';

export const publicVideo = (meta) => ({
  id: meta.id,
  fileName: meta.fileName,
  originalName: meta.originalName,
  size: meta.size,
  container: meta.container,
  source: meta.source,
  createdAt: meta.createdAt,
});

export function videosRouter({ config, services, upload, heavyLimiter }) {
  const router = Router();
  const { videoStore, jobQueue, analysisCache } = services;

  const managementAllowed = (req, res, next) => {
    if (config.storage.processingOnly) return next(forbidden('Video management is disabled on this server (PROCESSING_ONLY).'));
    return next();
  };

  router.post(
    '/v1/videos',
    managementAllowed,
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
      if (!req.file) throw badRequest('Upload the video as multipart/form-data in the "video" field.');
      const { video, deduplicated } = await videoStore.saveUpload({ tmpPath: req.file.path, originalName: req.file.originalname });
      res
        .status(deduplicated ? 200 : 201)
        .location(`/v1/videos/${video.id}`)
        .json({
          success: true,
          msg: deduplicated ? 'This video was already uploaded.' : 'Video uploaded.',
          payload: { video: publicVideo(video), deduplicated },
        });
    },
  );

  router.get('/v1/videos', managementAllowed, async (req, res) => {
    const { limit, offset } = validate(listVideosQuery, req.query);
    const all = await videoStore.list();
    res.json({
      success: true,
      msg: 'Videos listed.',
      payload: { total: all.length, videos: all.slice(offset, offset + limit).map(publicVideo) },
    });
  });

  router.get('/v1/videos/:id', managementAllowed, async (req, res) => {
    const id = validate(sha256Id, req.params.id);
    const video = await videoStore.getById(id);
    if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', 'Video not found.');
    res.json({ success: true, msg: 'Video found.', payload: { video: publicVideo(video) } });
  });

  router.delete('/v1/videos/:id', managementAllowed, async (req, res) => {
    const id = validate(sha256Id, req.params.id);
    if (jobQueue.activeVideoIds().has(id)) throw conflict('The video is used by a queued or running job; cancel it first.');
    const deleted = await videoStore.deleteById(id);
    if (deleted.length === 0) throw new HttpError(404, 'VIDEO_NOT_FOUND', 'Video not found.');
    await analysisCache.deleteForVideo(id);
    await deleteFramesForVideo(config.storage, id);
    res.json({ success: true, msg: 'Video and its derived data deleted.', payload: { deletedFiles: deleted.map((m) => m.fileName) } });
  });

  return router;
}
