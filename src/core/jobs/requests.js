// Normalizes v1 and legacy input into one job request.
import crypto from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import { normalizeModelName } from '../llm/ollama.js';

/**
 * @param {{ body: object, source: object, legacy: boolean, config: object, capabilities: object }} params
 * @returns {{ request: object, warnings: string[] }}
 */
export function buildJobRequest({ body, source, legacy, config, capabilities }) {
  const warnings = [];

  // Language: legacy clients silently fell back to English; v1 gets a precise error.
  let language = String(body.language ?? 'en')
    .trim()
    .toLowerCase();
  if (!capabilities.languages.includes(language)) {
    if (!legacy) {
      throw new HttpError(
        400,
        'UNSUPPORTED_LANGUAGE',
        `Language "${language}" is not supported by the analysis backend. Supported: ${capabilities.languages.join(', ')}.`,
      );
    }
    language = 'en';
  }

  // Model allowlist: clients must not be able to load arbitrary (huge) models on the server.
  let model = body.model ?? config.ollama.model;
  const allowed = new Set(config.ollama.allowedModels.map(normalizeModelName));
  if (!allowed.has(normalizeModelName(model))) {
    if (!legacy) {
      throw new HttpError(
        400,
        'MODEL_NOT_ALLOWED',
        `Model "${model}" is not allowed on this server. Allowed: ${config.ollama.allowedModels.join(', ')}.`,
      );
    }
    warnings.push(`Model "${model}" is not allowed on this server; "${config.ollama.model}" was used instead.`);
    model = config.ollama.model;
  }

  // Features: requested ones must be available; defaults are silently reduced to what is available.
  const visionOn = config.ollama.vision.enabled && !config.ollama.disabled && capabilities.keyframes;
  const available = new Set([...capabilities.features, ...(visionOn ? ['captions'] : [])]);
  const requested = body.features ?? [...config.analysis.features, ...(visionOn ? ['captions'] : [])];
  const unavailable = requested.filter((f) => !available.has(f));
  if (unavailable.length && body.features && !legacy) {
    throw new HttpError(
      400,
      'FEATURE_UNAVAILABLE',
      `Not available on this server: ${unavailable.join(', ')}. Available: ${[...available].join(', ')}.`,
    );
  }
  const features = [...new Set(requested.filter((f) => available.has(f)))].sort();

  return {
    warnings,
    request: {
      source,
      language,
      videoExplanation: body.videoExplanation || undefined,
      model,
      temperature: body.temperature ?? config.ollama.temperature,
      seed: body.seed ?? config.ollama.seed,
      format: body.format,
      noPrompting: Boolean(body.noPrompting),
      features,
      sampleFps: body.sampleFps ?? config.analysis.sampleFps,
      legacy: legacy || undefined,
    },
  };
}

/** Identical requests for the same video content share one active job. */
export function dedupeKeyFor(request, videoSha256) {
  const { source: _source, legacy: _legacy, ...rest } = request;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ videoSha256, ...rest }))
    .digest('hex');
}

/** The public view of a job. It never contains transcripts; the prompt only for noPrompting jobs (it is their result). */
export function jobView(job, { position, result } = {}) {
  const { request } = job;
  const view = {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: Math.round((job.progress ?? 0) * 1000) / 1000,
    position,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    attempts: job.attempts,
    video: job.video,
    request: {
      language: request.language,
      model: request.model,
      temperature: request.temperature,
      seed: request.seed,
      noPrompting: request.noPrompting,
      features: request.features,
      sampleFps: request.sampleFps,
      customFormat: request.format !== undefined,
    },
    summary: job.summary,
    warnings: job.warnings?.length ? job.warnings : undefined,
    error: job.error,
  };
  if (result && job.status === 'completed') {
    if (result.noPrompting) view.prompt = result.prompt;
    else {
      view.result = result.result;
      view.response = result.response;
    }
  }
  return view;
}
