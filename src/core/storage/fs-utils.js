// Small, dependency-free filesystem helpers shared by the stores.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes a file atomically (temp file + rename) so readers never see a half-written file.
 * On Windows a rename can briefly fail with EPERM/EBUSY while another process (antivirus,
 * indexer) holds the target open, so it is retried a few times.
 */
export async function writeFileAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await fs.promises.rm(tmp, { force: true });
        throw error;
      }
      await sleep(25 * 2 ** attempt);
    }
  }
}

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, JSON.stringify(value));

/** Reads and parses a JSON file; returns undefined when it is missing or unreadable. */
export async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Streams a file through SHA-256 (about 1 s per 500 MB on a modern CPU). */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Free bytes on the volume that holds `dir` (undefined if the platform cannot tell). */
export async function freeBytes(dir) {
  try {
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/**
 * Identifies the container format from the first bytes of a file (magic numbers), independent of
 * the file name and of the client-supplied MIME type.
 * @returns {Promise<'mp4'|'matroska'|'avi'|undefined>}
 */
export async function sniffVideoContainer(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    if (bytesRead >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') return 'mp4'; // MP4, MOV, M4V, 3GP
    if (bytesRead >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'matroska'; // MKV, WebM
    if (bytesRead >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 11) === 'AVI') return 'avi';
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Which file extensions are plausible for a sniffed container. */
export const CONTAINER_EXTENSIONS = {
  mp4: new Set(['mp4', 'mov', 'm4v', '3gp']),
  matroska: new Set(['mkv', 'webm']),
  avi: new Set(['avi']),
};
