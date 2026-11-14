import multer from 'multer';
import { z } from 'zod';

/** An error with an HTTP status and a stable, machine-readable code. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);
export const forbidden = (message) => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message) => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message) => new HttpError(409, 'CONFLICT', message);
export const unsupportedMedia = (message) => new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
export const unavailable = (message, code = 'UNAVAILABLE') => new HttpError(503, code, message);

/** Validates `data` with a zod schema; throws a 400 with readable details on failure. */
export function validate(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  const first = details[0];
  throw new HttpError(400, 'VALIDATION_FAILED', first.path ? `${first.path}: ${first.message}` : first.message, details);
}

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, msg: 'Not found', error: { code: 'NOT_FOUND' }, requestId: req.id });
}

/** Always JSON, never a stack trace; maps parser and upload errors to proper 4xx codes. */
export function errorHandler(logger) {
  return (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL';
    let msg = 'Internal server error';
    let details;

    if (err instanceof HttpError) {
      ({ status, code, message: msg, details } = err);
    } else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = err.code;
      msg = err.code === 'LIMIT_FILE_SIZE' ? 'Video file is too large.' : `Invalid upload: ${err.message}`;
    } else if (err instanceof z.ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      msg = err.issues[0]?.message ?? 'Invalid request';
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'MALFORMED_JSON';
      msg = 'Malformed JSON body.';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      msg = 'Request body is too large.';
    } else if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      status = 415;
      code = 'UNSUPPORTED_ENCODING';
      msg = err.message;
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      status = err.status;
      code = 'BAD_REQUEST';
      msg = err.expose === false ? 'Bad request' : err.message;
    }

    const log = req.log ?? logger;
    if (status >= 500) log.error({ err }, 'request failed');
    else log.warn({ status, code }, msg);

    if (res.headersSent) return undefined;
    return res.status(status).json({ success: false, msg, error: { code, ...(details ? { details } : {}) }, requestId: req.id });
  };
}
