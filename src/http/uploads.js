// Multipart upload handling for POST /v1/videos. The file is streamed to a temp file under
// data/tmp; validation (magic bytes, hashing, naming) happens in VideoStore.saveUpload.
import crypto from 'node:crypto';
import multer from 'multer';
import { HttpError } from './errors.js';

export function createUploader({ storage }) {
  return multer({
    storage: multer.diskStorage({
      destination: storage.tmpDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: storage.maxUploadBytes, files: 1, fields: 10, parts: 12, fieldSize: 64 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.fieldname !== 'video') return cb(new HttpError(400, 'UNEXPECTED_FIELD', 'Upload the video in the "video" form field.'));
      return cb(null, true);
    },
  }).single('video');
}
