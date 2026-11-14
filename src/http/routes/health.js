// Unauthenticated health probes for Docker, orchestrators and load balancers. They reveal no
// versions, paths or model names.
import fs from 'node:fs';
import { Router } from 'express';

export function healthRouter({ config, services }) {
  const router = Router();

  router.get('/health/live', (req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health/ready', async (req, res) => {
    const checks = {};
    try {
      await fs.promises.access(config.storage.dataDir, fs.constants.W_OK);
      checks.storage = 'ok';
    } catch {
      checks.storage = 'error';
    }
    const backend = await services.backend.ready().catch(() => ({ ok: false }));
    checks.analysis = backend.ok ? 'ok' : 'unavailable';
    if (!config.ollama.disabled) checks.llm = services.ollama.ready ? 'ok' : 'unavailable';
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  return router;
}
