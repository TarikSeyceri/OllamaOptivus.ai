// Ensures that only one API instance works on a data directory at a time.
// The lock file is refreshed every 30 s; a lock that has not been refreshed for 90 s belongs to a
// crashed instance and is taken over. This works across containers that share a volume.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 90_000;
const REFRESH_MS = 30_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, but belongs to another user
  }
}

export async function acquireDataDirLock(dataDir) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, '.api.lock');
  const owner = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };

  try {
    const stat = await fs.promises.stat(file);
    const current = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const fresh = Date.now() - stat.mtimeMs < STALE_MS;
    const self = current.pid === owner.pid && current.hostname === owner.hostname;
    // On the same host we can tell whether the owner still runs; across hosts/containers sharing a
    // volume only the lock's freshness tells.
    const ownerAlive = current.hostname === owner.hostname ? isAlive(current.pid) : fresh;
    if (fresh && !self && ownerAlive) {
      throw new Error(
        `Another API instance (pid ${current.pid} on ${current.hostname}) is using ${dataDir}. Run a single API replica per data directory.`,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  await fs.promises.writeFile(file, JSON.stringify(owner));
  const timer = setInterval(() => {
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
  }, REFRESH_MS);
  timer.unref();

  return async function release() {
    clearInterval(timer);
    await fs.promises.rm(file, { force: true });
  };
}
