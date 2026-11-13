// Video storage: uploads, metadata, lookup and deletion.
//
// - v1 uploads are content-addressed: <sha256>.<ext>. Uploading the same bytes twice is a no-op.
// - Legacy (/upload) files keep their sanitized original name, as v1 clients expect. If that name is
//   taken by different content, the new file is stored as <name>-<sha8>.mp4 (v1 silently returned
//   the old file, which made clients analyze the wrong video).
// - Every file has a sidecar in meta/videos/<fileName>.json; the video id is its SHA-256.
// - Files placed into a root by other means are hashed lazily the first time they are used.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, unsupportedMedia } from '../../http/errors.js';
import { CONTAINER_EXTENSIONS, freeBytes, readJson, sha256File, sniffVideoContainer, writeJsonAtomic } from './fs-utils.js';
import { resolveInNamedRoot, resolveInsideRoots, sanitizeFileName } from './paths.js';

const HIDDEN = /^\./;

export class VideoStore {
  /** @param {{ storage: object, logger: import('pino').Logger }} deps */
  constructor({ storage, logger }) {
    this.storage = storage;
    this.logger = logger;
    this.videosDir = storage.videosDir;
    this.metaDir = path.join(storage.metaDir, 'videos');
    this.byFile = new Map(); // fileName -> meta
    this.fingerprints = new Map(); // realpath -> { size, mtimeMs, sha256 }
    this.locks = new Map();
  }

  async init() {
    for (const dir of [this.videosDir, this.metaDir, this.storage.tmpDir]) await fs.promises.mkdir(dir, { recursive: true });
    for (const entry of await fs.promises.readdir(this.metaDir)) {
      if (!entry.endsWith('.json')) continue;
      const meta = await readJson(path.join(this.metaDir, entry));
      if (meta?.fileName && fs.existsSync(path.join(this.videosDir, meta.fileName))) this.byFile.set(meta.fileName, meta);
      else await fs.promises.rm(path.join(this.metaDir, entry), { force: true }); // orphaned sidecar
    }
    // Leftovers of interrupted uploads.
    for (const entry of await fs.promises.readdir(this.storage.tmpDir)) {
      if (entry.endsWith('.part')) await fs.promises.rm(path.join(this.storage.tmpDir, entry), { force: true });
    }
  }

  /** Serializes work per key (e.g. a target file name) inside this process. */
  async withLock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  async assertFreeSpace() {
    const free = await freeBytes(this.storage.dataDir);
    if (free !== undefined && free < this.storage.minFreeBytes) {
      throw new HttpError(507, 'INSUFFICIENT_STORAGE', 'Not enough free disk space to accept new videos.');
    }
  }

  /**
   * Validates and stores an uploaded temp file.
   * @param {{ tmpPath: string, originalName: string, legacy?: boolean }} upload
   * @returns {Promise<{ video: object, deduplicated: boolean }>}
   */
  async saveUpload({ tmpPath, originalName, legacy = false }) {
    try {
      const container = await sniffVideoContainer(tmpPath);
      if (!container) throw unsupportedMedia('The uploaded file is not a supported video container (MP4/MOV, MKV/WebM or AVI).');

      const safeName = sanitizeFileName(originalName);
      const nameExt = safeName ? path.extname(safeName).slice(1) : '';
      if (legacy && (nameExt !== 'mp4' || container !== 'mp4')) throw unsupportedMedia('Only .mp4 video files are allowed');
      const ext = CONTAINER_EXTENSIONS[container].has(nameExt) ? nameExt : [...CONTAINER_EXTENSIONS[container]][0];
      if (!this.storage.allowedExtensions.includes(ext)) throw unsupportedMedia(`.${ext} files are not allowed on this server.`);

      const sha256 = await sha256File(tmpPath);
      const { size } = await fs.promises.stat(tmpPath);

      if (!legacy) {
        const fileName = `${sha256}.${ext}`;
        return await this.withLock(fileName, () => this.#place(tmpPath, fileName, { sha256, size, container, originalName, legacy }));
      }

      const stem = path.basename(safeName, '.mp4');
      const candidates = [safeName, `${stem}-${sha256.slice(0, 8)}.mp4`];
      for (const fileName of candidates) {
        const placed = await this.withLock(fileName, async () => {
          const existing = await this.#metaFor(fileName);
          if (existing && existing.id !== sha256) return undefined; // taken by other content
          return this.#place(tmpPath, fileName, { sha256, size, container, originalName, legacy });
        });
        if (placed) return placed;
      }
      throw new HttpError(409, 'NAME_CONFLICT', 'A different video with this name already exists.');
    } finally {
      await fs.promises.rm(tmpPath, { force: true });
    }
  }

  async #place(tmpPath, fileName, { sha256, size, container, originalName, legacy }) {
    const target = path.join(this.videosDir, fileName);
    const existing = await this.#metaFor(fileName);
    if (existing && fs.existsSync(target)) return { video: existing, deduplicated: true };
    await fs.promises.rename(tmpPath, target);
    const meta = {
      id: sha256,
      fileName,
      originalName: String(originalName ?? '').slice(0, 255),
      size,
      container,
      source: legacy ? 'legacy-upload' : 'upload',
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(this.metaDir, `${fileName}.json`), meta);
    this.byFile.set(fileName, meta);
    this.logger.info({ videoId: sha256, fileName, size }, 'video stored');
    return { video: meta, deduplicated: false };
  }

  /** Metadata for a file in the videos directory, indexing it on first sight. */
  async #metaFor(fileName) {
    const known = this.byFile.get(fileName);
    if (known) return known;
    const file = path.join(this.videosDir, fileName);
    if (HIDDEN.test(fileName) || !fs.existsSync(file)) return undefined;
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return undefined;
    const meta = {
      id: await this.fingerprint(file),
      fileName,
      originalName: fileName,
      size: stat.size,
      container: await sniffVideoContainer(file).catch(() => undefined),
      source: 'discovered',
      createdAt: stat.mtime.toISOString(),
    };
    await writeJsonAtomic(path.join(this.metaDir, `${fileName}.json`), meta);
    this.byFile.set(fileName, meta);
    return meta;
  }

  /** SHA-256 of any file, cached by (realpath, size, mtime). */
  async fingerprint(absPath) {
    const real = await fs.promises.realpath(absPath);
    const { size, mtimeMs } = await fs.promises.stat(real);
    const cached = this.fingerprints.get(real);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha256;
    const sha256 = await sha256File(real);
    this.fingerprints.set(real, { size, mtimeMs, sha256 });
    return sha256;
  }

  /** All files in the videos directory (indexed lazily), newest first. */
  async list() {
    const entries = await fs.promises.readdir(this.videosDir, { withFileTypes: true });
    const metas = [];
    for (const entry of entries) {
      if (!entry.isFile() || HIDDEN.test(entry.name)) continue;
      const meta = await this.#metaFor(entry.name).catch(() => undefined);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getById(id) {
    let matches = [...this.byFile.values()].filter((m) => m.id === id);
    if (matches.length === 0) matches = (await this.list()).filter((m) => m.id === id);
    // Prefer the content-addressed copy over legacy-named ones.
    return matches.find((m) => m.fileName.startsWith(id)) ?? matches[0];
  }

  async getByFileName(fileName) {
    return this.#metaFor(fileName);
  }

  pathOf(meta) {
    return path.join(this.videosDir, meta.fileName);
  }

  /**
   * Resolves what a job should analyze.
   * @param {{ videoId?: string, path?: string, root?: string }} source
   * @returns {Promise<{ absPath: string, sha256: string, size: number, root: string, relPath: string, video?: object }>}
   */
  async resolve(source) {
    if (source.videoId) {
      const video = await this.getById(source.videoId);
      if (!video) throw new HttpError(404, 'VIDEO_NOT_FOUND', 'Video not found.');
      const absPath = this.pathOf(video);
      return { absPath, sha256: video.id, size: video.size, root: 'videos', relPath: video.fileName, video };
    }

    const roots = this.storage.roots;
    const resolved = source.root ? await resolveInNamedRoot(source.root, source.path, roots) : await resolveInsideRoots(source.path, roots);
    if (resolved.error === 'unknown_root') throw new HttpError(400, 'UNKNOWN_ROOT', `Unknown storage root "${source.root}".`);
    if (resolved.error === 'forbidden') throw new HttpError(403, 'PATH_NOT_ALLOWED', 'Video file path not allowed!');
    if (resolved.error === 'not_found') throw new HttpError(404, 'VIDEO_NOT_FOUND', 'Video file not found!');

    const ext = path.extname(resolved.path).slice(1).toLowerCase();
    const container = await sniffVideoContainer(resolved.path).catch(() => undefined);
    if (!container || !CONTAINER_EXTENSIONS[container].has(ext)) throw new HttpError(400, 'INVALID_FILE_TYPE', 'Invalid file type!');

    const { size } = await fs.promises.stat(resolved.path);
    return {
      absPath: resolved.path,
      sha256: await this.fingerprint(resolved.path),
      size,
      root: resolved.root.name,
      relPath: resolved.relPath,
    };
  }

  /** Deletes one file. Returns the meta and whether other files still share its content. */
  async deleteFile(fileName) {
    return this.withLock(fileName, async () => {
      const meta = await this.#metaFor(fileName);
      if (!meta) return undefined;
      await fs.promises.rm(path.join(this.videosDir, fileName), { force: true });
      await fs.promises.rm(path.join(this.metaDir, `${fileName}.json`), { force: true });
      this.byFile.delete(fileName);
      const stillReferenced = [...this.byFile.values()].some((m) => m.id === meta.id);
      return { meta, stillReferenced };
    });
  }

  /** Deletes every file with the given content id. */
  async deleteById(id) {
    const files = (await this.list()).filter((m) => m.id === id);
    for (const meta of files) await this.deleteFile(meta.fileName);
    return files;
  }
}
