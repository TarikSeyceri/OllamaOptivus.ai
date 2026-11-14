import { Router } from 'express';
import { normalizeModelName } from '../../core/llm/ollama.js';

export function modelsRouter({ config, services }) {
  const router = Router();

  router.get('/v1/models', async (req, res) => {
    let installed = [];
    try {
      installed = await services.ollama.installedModels();
    } catch {
      // Ollama unreachable: still list the configuration.
    }
    res.json({
      success: true,
      msg: 'Models listed.',
      payload: {
        default: config.ollama.model,
        vision: config.ollama.vision.enabled ? config.ollama.vision.model : null,
        allowed: config.ollama.allowedModels.map((name) => ({ name, installed: installed.includes(normalizeModelName(name)) })),
        llmReady: services.ollama.ready,
      },
    });
  });

  router.get('/v1/capabilities', async (req, res) => {
    const capabilities = await services.backend.capabilities();
    res.json({
      success: true,
      msg: 'Capabilities listed.',
      payload: { analysis: capabilities, captions: config.ollama.vision.enabled && capabilities.keyframes },
    });
  });

  return router;
}
