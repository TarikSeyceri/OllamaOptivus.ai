import crypto from 'node:crypto';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const isProbe = (req) => req.path === '/' || req.path.startsWith('/health');

/** Callers are identified by a hash of their bearer token, falling back to the (IPv6-aware) client IP. */
function keyGenerator(req) {
  const match = /^Bearer\s+(\S+)/i.exec(req.get('authorization') ?? '');
  if (match) return `key:${crypto.createHash('sha256').update(match[1]).digest('hex').slice(0, 16)}`;
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function limiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    skip: isProbe, // Docker / load-balancer health checks must not consume client budgets.
    handler: (req, res) => res.status(429).json({ success: false, msg: message, error: { code: 'RATE_LIMITED' }, requestId: req.id }),
  });
}

/** General limit for every authenticated route. */
export const generalLimiter = ({ windowMs, max }) =>
  limiter({ windowMs, limit: max, message: 'Too many requests sent, please try again later.' });

/** Stricter limit for expensive routes (uploads, job creation). */
export const heavyLimiter = ({ windowMs, heavyMax }) =>
  limiter({ windowMs, limit: heavyMax, message: 'Too many uploads or processing requests, please try again later.' });
