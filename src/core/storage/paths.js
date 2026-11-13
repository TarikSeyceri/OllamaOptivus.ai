import fs from 'node:fs';
import path from 'node:path';

/** True when `child` is `root` itself or inside it (both absolute). */
export function isInside(root, child) {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathOrResolve(p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Accepts both "data/videos/x.mp4" and Windows-style "data\\videos\\x.mp4" on every platform. */
export function normalizeClientPath(input) {
  return path.sep === '/' ? input.replace(/\\/g, '/') : input;
}

/**
 * Resolves a client-supplied path and checks that it stays inside one of the given root
 * directories. Checked twice: lexically first (so "outside" wins over "missing", like v1), then
 * after resolving symlinks with realpath (so a symlink inside a root cannot point outside of it).
 *
 * @param {string} input   path from the client (absolute, or relative to `cwd`)
 * @param {{ name: string, dir: string }[]} roots
 * @returns {Promise<{ path: string, root: { name: string, dir: string } } | { error: 'forbidden' | 'not_found' }>}
 */
export async function resolveInsideRoots(input, roots, { cwd = process.cwd() } = {}) {
  const absolute = path.resolve(cwd, normalizeClientPath(input));
  const candidates = await Promise.all(
    roots.map(async (root) => ({ root, lexical: path.resolve(root.dir), real: await realpathOrResolve(root.dir) })),
  );

  if (!candidates.some((c) => isInside(c.lexical, absolute) || isInside(c.real, absolute))) {
    return { error: 'forbidden' };
  }

  let real;
  try {
    real = await fs.promises.realpath(absolute);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { error: 'not_found' };
    throw error;
  }
  const owner = candidates.find((c) => isInside(c.real, real));
  if (!owner) return { error: 'forbidden' };

  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) return { error: 'not_found' };
  return { path: real, root: owner.root, relPath: path.relative(owner.real, real) };
}

/**
 * Resolves `{ root, path }` (a path relative to a named root) the same way.
 * @param {string} rootName
 * @param {string} relPath
 * @param {{ name: string, dir: string }[]} roots
 */
export async function resolveInNamedRoot(rootName, relPath, roots) {
  const root = roots.find((r) => r.name === rootName);
  if (!root) return { error: 'unknown_root' };
  const clean = normalizeClientPath(relPath);
  if (path.isAbsolute(clean)) return { error: 'forbidden' };
  return resolveInsideRoots(path.join(root.dir, clean), [root]);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Turns a client-supplied upload name into a safe file name: no directories, no control or shell
 * characters, bounded length, lower-case extension. Returns null when nothing usable is left.
 */
export function sanitizeFileName(original, { maxLength = 120 } = {}) {
  const base = String(original ?? '')
    .split(/[\\/]/)
    .pop()
    .normalize('NFC');
  const ext = path.extname(base).toLowerCase();
  let stem = path
    .basename(base, path.extname(base))
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_-]+|[.\s]+$/g, '');
  if (!stem || WINDOWS_RESERVED.test(stem)) return null;
  stem = stem.slice(0, Math.max(1, maxLength - ext.length));
  return stem + ext;
}
