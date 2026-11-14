import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * Bearer-token authentication. Several tokens may be active at once (key rotation). Tokens are
 * compared as SHA-256 digests with crypto.timingSafeEqual, and every configured token is checked,
 * so the response time leaks neither which token matched nor how many characters were right.
 *
 * @param {string[]} tokens
 * @param {{ isPublic?: (req) => boolean }} [options]
 */
export function bearerAuth(tokens, { isPublic = () => false } = {}) {
  const digests = tokens.map(sha256);
  return (req, res, next) => {
    if (isPublic(req)) return next();
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '');
    if (match) {
      const candidate = sha256(match[1]);
      let valid = false;
      for (const digest of digests) valid = crypto.timingSafeEqual(candidate, digest) || valid;
      if (valid) return next();
    }
    res.set('WWW-Authenticate', 'Bearer realm="optivus"');
    return res.status(401).json({ success: false, msg: 'Unauthorized', error: { code: 'UNAUTHORIZED' }, requestId: req.id });
  };
}
