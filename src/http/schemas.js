// Request/response schemas. They validate input and also generate the OpenAPI document.
import { z } from 'zod';
import { WHISPER_LANGUAGES } from '../core/llm/languages.js';

export const FEATURES = ['objects', 'ocr', 'scenes', 'faces', 'captions'];
const LANGUAGES = new Set(['auto', ...WHISPER_LANGUAGES]);

export const sha256Id = z.string().regex(/^[a-f0-9]{64}$/, 'must be a 64-character lowercase hex SHA-256 id');
export const jobId = z.string().uuid();
export const modelName = z.string().regex(/^[\w.:/-]{1,200}$/, 'is not a valid model name');

export const language = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => LANGUAGES.has(v), { message: 'is not a supported language code (ISO 639-1, e.g. "en", "tr", or "auto")' })
  .describe('Speech/on-screen text language (ISO 639-1) or "auto" to detect it.');

/** Limits for client-supplied JSON schemas: large or deeply nested schemas can stall Ollama's grammar engine. */
function schemaComplexity(value, depth = 0, counter = { nodes: 0 }) {
  counter.nodes++;
  if (depth > 10 || counter.nodes > 500) return false;
  if (Array.isArray(value)) return value.every((v) => schemaComplexity(v, depth + 1, counter));
  if (value && typeof value === 'object') return Object.values(value).every((v) => schemaComplexity(v, depth + 1, counter));
  return true;
}

export const format = z
  .union([z.literal('json'), z.record(z.string(), z.unknown())])
  .refine((v) => v === 'json' || JSON.stringify(v).length <= 16_384, { message: 'schema is too large (max 16 KB)' })
  .refine((v) => v === 'json' || schemaComplexity(v), { message: 'schema is too deeply nested or has too many nodes' })
  .describe(
    '"json" for free-form JSON, or a JSON schema the answer must follow (Ollama structured outputs). Defaults to { summary, events }.',
  );

export const feature = z.enum(FEATURES);

const commonJobFields = {
  language: language.optional(),
  videoExplanation: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe('Context for the model, e.g. "A recorded support call between an agent and a customer".'),
  model: modelName.optional().describe('Ollama model for the summary (must be in OLLAMA_AI_ALLOWED_MODELS).'),
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().optional().describe('Fixed seed for reproducible answers.'),
  format: format.optional(),
  noPrompting: z.boolean().optional().describe('Only analyze the video and build the prompt; skip the language model.'),
};

export const createJobBody = z
  .object({
    videoId: sha256Id.optional().describe('Id of an uploaded video (POST /v1/videos).'),
    source: z
      .object({
        root: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{1,31}$/)
          .describe('Name of a storage root from PROCESSING_ROOTS, e.g. "videos" or "nas".'),
        path: z.string().min(1).max(1024).describe('Path of the video relative to that root.'),
      })
      .strict()
      .optional(),
    ...commonJobFields,
    features: z
      .array(feature)
      .max(FEATURES.length)
      .optional()
      .describe('Analysis features. Defaults to PROCESSING_FEATURES (plus "captions" when vision is enabled).'),
    sampleFps: z.number().min(0.05).max(5).optional().describe('Frames analyzed per second of video.'),
  })
  .strict()
  .refine((b) => Boolean(b.videoId) !== Boolean(b.source), { message: 'Provide exactly one of "videoId" or "source".' });

export const waitQuery = z
  .object({
    wait: z.coerce.number().min(0).max(60).optional().describe('Long-poll: wait up to this many seconds for the job to finish.'),
  })
  .passthrough();

export const listJobsQuery = z
  .object({
    status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .passthrough();

export const listVideosQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .passthrough();

/** Legacy /process body: v1 accepted unknown fields and fell back to defaults, so this stays lenient. */
export const legacyProcessBody = z
  .object({
    videoFilePath: z.string().min(1).max(2048),
    language: z.string().max(16).optional(),
    videoExplanation: z.string().trim().max(4000).optional(),
    model: z.string().max(200).optional(),
    temperature: z.number().min(0).max(2).optional(),
    format: format.optional(),
    noPrompting: z.boolean().optional(),
  })
  .passthrough();

// --- response documentation (OpenAPI only) -----------------------------------------------------
export const videoView = z.object({
  id: sha256Id,
  fileName: z.string(),
  originalName: z.string(),
  size: z.number().int(),
  container: z.string().optional(),
  source: z.enum(['upload', 'legacy-upload', 'discovered']),
  createdAt: z.string(),
});

export const jobView = z.object({
  id: jobId,
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  stage: z.string().describe('queued, analyzing, describing, summarizing or done'),
  progress: z.number().min(0).max(1),
  position: z.number().int().optional().describe('Place in the queue while queued.'),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  attempts: z.number().int(),
  video: z.object({ id: sha256Id, root: z.string(), path: z.string(), size: z.number() }).partial().optional(),
  request: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.unknown()).optional().describe('Analysis statistics and per-stage timings.'),
  warnings: z.array(z.string()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  result: z.unknown().optional().describe('The parsed JSON answer of the model (completed jobs).'),
  response: z.string().optional().describe('The same answer as a JSON string.'),
});

export const envelope = (payload) => z.object({ success: z.literal(true), msg: z.string(), payload });
export const errorEnvelope = z.object({
  success: z.literal(false),
  msg: z.string(),
  error: z.object({ code: z.string(), details: z.array(z.object({ path: z.string(), message: z.string() })).optional() }),
  requestId: z.string().optional(),
});
