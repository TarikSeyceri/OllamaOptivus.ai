// OpenAPI 3.1 document, generated from the same zod schemas that validate requests.
import { z } from 'zod';
import { createJobBody, envelope, errorEnvelope, jobView, legacyProcessBody, videoView } from './schemas.js';

const json = (schema) => {
  const out = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  delete out.$schema;
  return out;
};
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const content = (schema) => ({ 'application/json': { schema } });
const ok = (description, schema) => ({ description, content: content(schema) });
const errors = (...codes) =>
  Object.fromEntries(codes.map((code) => [code, { description: ERROR_TEXT[code], content: content(ref('Error')) }]));

const ERROR_TEXT = {
  400: 'Invalid request',
  401: 'Missing or wrong bearer token',
  403: 'Forbidden (path outside the allowed roots, or video management disabled)',
  404: 'Not found',
  409: 'Conflict (resource in use)',
  413: 'Upload too large',
  415: 'Unsupported file type',
  429: 'Rate limit exceeded',
  503: 'Queue full or service not ready',
  507: 'Not enough free disk space',
};

const idParam = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const waitParam = {
  name: 'wait',
  in: 'query',
  required: false,
  description: 'Long-poll: wait up to N seconds (max 60) for the job to finish.',
  schema: { type: 'number', minimum: 0, maximum: 60 },
};

export function buildOpenApi() {
  const jobPayload = envelope(z.object({ job: jobView, deduplicated: z.boolean().optional() }));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ollama Optivus AI API',
      version: '2.0.0',
      description: [
        'Video analysis with speech-to-text, OCR, object detection and scene understanding, summarized by a local Ollama model into JSON.',
        '',
        '**Typical flow:** `POST /v1/videos` (upload) -> `POST /v1/jobs` (start) -> `GET /v1/jobs/{id}?wait=30` (poll) -> read `payload.job.result`.',
        '',
        'All endpoints except `/`, `/health/*` and these docs require `Authorization: Bearer <token>`.',
        'The legacy endpoints `/upload`, `/videos`, `/delete` and `/process` are deprecated but fully supported.',
      ].join('\n'),
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Videos', description: 'Upload and manage videos' },
      { name: 'Jobs', description: 'Asynchronous video processing' },
      { name: 'System', description: 'Health, models and capabilities' },
      { name: 'Legacy (v1)', description: 'Deprecated v1 endpoints, kept for compatibility' },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'One of the tokens in HTTP_BEARER_TOKEN.' } },
      schemas: {
        Video: json(videoView),
        Job: json(jobView),
        CreateJob: json(createJobBody),
        LegacyProcess: json(legacyProcessBody),
        Error: json(errorEnvelope),
      },
    },
    paths: {
      '/v1/videos': {
        post: {
          tags: ['Videos'],
          summary: 'Upload a video',
          description: 'Stores the video under its SHA-256 id. Uploading identical bytes again returns the existing video (200).',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { type: 'object', required: ['video'], properties: { video: { type: 'string', format: 'binary' } } },
              },
            },
          },
          responses: {
            201: ok('Uploaded', json(envelope(z.object({ video: videoView, deduplicated: z.boolean() })))),
            200: ok('Already uploaded', json(envelope(z.object({ video: videoView, deduplicated: z.boolean() })))),
            ...errors(400, 401, 403, 413, 415, 429, 507),
          },
        },
        get: {
          tags: ['Videos'],
          summary: 'List videos',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            200: ok('Videos', json(envelope(z.object({ total: z.number(), videos: z.array(videoView) })))),
            ...errors(401, 403),
          },
        },
      },
      '/v1/videos/{id}': {
        get: {
          tags: ['Videos'],
          summary: 'Get a video',
          parameters: [idParam('id', 'SHA-256 video id')],
          responses: { 200: ok('Video', json(envelope(z.object({ video: videoView })))), ...errors(401, 403, 404) },
        },
        delete: {
          tags: ['Videos'],
          summary: 'Delete a video and everything derived from it',
          parameters: [idParam('id', 'SHA-256 video id')],
          responses: { 200: ok('Deleted', json(envelope(z.object({ deletedFiles: z.array(z.string()) })))), ...errors(401, 403, 404, 409) },
        },
      },
      '/v1/jobs': {
        post: {
          tags: ['Jobs'],
          summary: 'Start processing a video',
          description:
            'Returns 202 with the queued job. With `?wait=N` the call waits up to N seconds and returns 200 with the result if the job finished. An identical active job is reused.',
          parameters: [waitParam],
          requestBody: { required: true, content: content(ref('CreateJob')) },
          responses: {
            202: ok('Accepted', json(jobPayload)),
            200: ok('Finished within the wait time', json(jobPayload)),
            ...errors(400, 401, 403, 404, 429, 503),
          },
        },
        get: {
          tags: ['Jobs'],
          summary: 'List jobs',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'canceled'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { 200: ok('Jobs', json(envelope(z.object({ jobs: z.array(jobView) })))), ...errors(401) },
        },
      },
      '/v1/jobs/{id}': {
        get: {
          tags: ['Jobs'],
          summary: 'Get a job (and its result)',
          parameters: [idParam('id', 'Job id'), waitParam],
          responses: { 200: ok('Job', json(envelope(z.object({ job: jobView })))), ...errors(401, 404) },
        },
        delete: {
          tags: ['Jobs'],
          summary: 'Cancel an active job, or delete a finished one',
          parameters: [idParam('id', 'Job id')],
          responses: {
            202: ok('Cancellation requested', json(jobPayload)),
            200: ok('Deleted', json(envelope(z.object({}).optional()))),
            ...errors(401, 404),
          },
        },
      },
      '/v1/jobs/{id}/analysis': {
        get: {
          tags: ['Jobs'],
          summary: "Raw analysis of the job's video (transcript, frames, scenes)",
          parameters: [idParam('id', 'Job id')],
          responses: { 200: ok('Analysis', { type: 'object' }), ...errors(401, 404) },
        },
      },
      '/v1/jobs/{id}/prompt': {
        get: {
          tags: ['Jobs'],
          summary: 'The prompt that was sent to the model',
          parameters: [idParam('id', 'Job id')],
          responses: { 200: { description: 'Prompt', content: { 'text/plain': { schema: { type: 'string' } } } }, ...errors(401, 404) },
        },
      },
      '/v1/models': {
        get: {
          tags: ['System'],
          summary: 'Allowed and installed models',
          responses: { 200: ok('Models', { type: 'object' }), ...errors(401) },
        },
      },
      '/v1/capabilities': {
        get: {
          tags: ['System'],
          summary: 'Languages and features the analysis backend supports',
          responses: { 200: ok('Capabilities', { type: 'object' }), ...errors(401) },
        },
      },
      '/health/live': {
        get: { tags: ['System'], summary: 'Liveness probe', security: [], responses: { 200: ok('Alive', { type: 'object' }) } },
      },
      '/health/ready': {
        get: {
          tags: ['System'],
          summary: 'Readiness probe (storage, analysis backend, LLM)',
          security: [],
          responses: { 200: ok('Ready', { type: 'object' }), 503: ok('Not ready', { type: 'object' }) },
        },
      },
      '/': { get: { tags: ['Legacy (v1)'], summary: 'Hello world', security: [], responses: { 200: ok('Running', { type: 'object' }) } } },
      '/upload': {
        post: {
          tags: ['Legacy (v1)'],
          deprecated: true,
          summary: 'Upload an .mp4 (v1)',
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema: { type: 'object', properties: { video: { type: 'string', format: 'binary' } } } } },
          },
          responses: { 200: ok('Uploaded; payload.videoFilePath', { type: 'object' }), ...errors(400, 401, 403, 413, 415) },
        },
      },
      '/videos': {
        get: {
          tags: ['Legacy (v1)'],
          deprecated: true,
          summary: 'List video paths (v1)',
          responses: { 200: ok('payload.videos', { type: 'object' }), ...errors(401, 403) },
        },
      },
      '/delete': {
        delete: {
          tags: ['Legacy (v1)'],
          deprecated: true,
          summary: 'Delete a video by file name (v1)',
          requestBody: { content: content({ type: 'object', properties: { videoFileName: { type: 'string' } } }) },
          responses: { 200: ok('Deleted', { type: 'object' }), ...errors(400, 401, 403, 404, 409) },
        },
      },
      '/process': {
        post: {
          tags: ['Legacy (v1)'],
          deprecated: true,
          summary: 'Process a video and wait for the result (v1)',
          description:
            'Blocks until the job finishes. Prefer POST /v1/jobs. payload.response is the answer as a JSON string; payload.result is the same answer parsed.',
          requestBody: { required: true, content: content(ref('LegacyProcess')) },
          responses: { 200: ok('Completed', { type: 'object' }), ...errors(400, 401, 403, 404, 503) },
        },
      },
    },
  };
}
