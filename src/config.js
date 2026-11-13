// Configuration: environment variables -> one validated, immutable config object.
// Every variable is documented in docs/configuration.md. Existing v1 names keep working; deprecated
// ones are mapped and reported as warnings at start-up.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { z } from 'zod';

const WEAK_TOKENS = new Set(['mysecrettoken', 'changeme', 'secret', 'token', 'password', 'test', 'admin']);
export const MIN_TOKEN_LENGTH = 32;

// ---------------------------------------------------------------------------------------------
// Typed parsers for string environment values
// ---------------------------------------------------------------------------------------------
const blank = (v) => v === undefined || String(v).trim() === '';

const bool = (fallback) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (blank(v)) return fallback;
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected true/false, got "${v}"` });
      return z.NEVER;
    });

const num = (fallback, { min = -Infinity, max = Infinity, int = false } = {}) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (blank(v)) return fallback;
      const n = Number(v.trim());
      if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min || n > max) {
        const range = [min > -Infinity ? `>= ${min}` : '', max < Infinity ? `<= ${max}` : ''].filter(Boolean).join(' and ');
        ctx.addIssue({ code: 'custom', message: `expected ${int ? 'an integer' : 'a number'}${range ? ` ${range}` : ''}, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const str = (fallback) =>
  z
    .string()
    .optional()
    .transform((v) => (blank(v) ? fallback : v.trim()));
const list = (fallback = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      blank(v)
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );
const oneOf = (values, fallback) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (blank(v)) return fallback;
      const s = v.trim().toLowerCase();
      if (values.includes(s)) return s;
      ctx.addIssue({ code: 'custom', message: `expected one of ${values.join(', ')}, got "${v}"` });
      return z.NEVER;
    });

// Sizes such as "500mb", "1GB" or plain bytes.
const bytes = (fallback) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (blank(v)) return fallback;
      const m = /^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g|tb|t)?$/i.exec(v.trim());
      if (!m) {
        ctx.addIssue({ code: 'custom', message: `expected a size like 500mb or 1gb, got "${v}"` });
        return z.NEVER;
      }
      const unit = (m[2] ?? 'b').toLowerCase()[0];
      const factor = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit];
      return Math.round(Number(m[1]) * factor);
    });

const ENV_SCHEMA = z.object({
  NODE_ENV: z
    .string()
    .optional()
    .transform((v) => (v?.trim().toLowerCase() === 'development' ? 'development' : 'production')),

  // HTTP
  HTTP_HOST: str('0.0.0.0'),
  HTTP_PORT: num(3330, { min: 1, max: 65535, int: true }),
  HTTP_TRUST_PROXY: str('false'),
  HTTP_CORS_ORIGINS: list([]),
  HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT: str('100kb'),
  HTTP_REQUEST_TIMEOUT_MS: num(30 * 60_000, { min: 10_000, int: true }),
  HTTP_RATE_LIMIT_ENABLED: bool(true),
  HTTP_RATE_LIMIT_WINDOW_MS: num(60_000, { min: 1000, int: true }),
  HTTP_RATE_LIMIT_MAX_REQUESTS: num(60, { min: 1, int: true }),
  HTTP_RATE_LIMIT_HEAVY_MAX_REQUESTS: num(10, { min: 1, int: true }),
  AUTH_DISABLED: bool(false),
  API_DOCS_ENABLED: z.string().optional(),

  // Logging
  LOG_LEVEL: oneOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], 'info'),
  LOG_FORMAT: oneOf(['json', 'pretty'], undefined),
  LOG_DIR: str(undefined),
  LOG_RETENTION_DAYS: num(30, { min: 1, int: true }),

  // Storage
  DATA_DIR: str('data'),
  VIDEOS_DIR: str(undefined),
  JSON_DATA_DIR: str(undefined),
  PROMPTS_DIR: str(undefined),
  AUDIOS_DIR: str(undefined),
  VIDEO_FILE_MAX_UPLOAD_SIZE: bytes(500 * 1024 ** 2),
  VIDEO_ALLOWED_EXTENSIONS: list(['mp4', 'mov', 'm4v', 'mkv', 'webm']),
  FILE_RETENTION_DAYS: num(2, { min: 0.01 }),
  STORAGE_MIN_FREE_BYTES: bytes(1024 ** 3),
  STORE_PROMPTS: bool(true),
  PROCESSING_ONLY: bool(false),
  PROCESSING_ROOTS: list([]),
  ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR: bool(false),

  // Jobs
  JOBS_MAX_QUEUED: num(20, { min: 1, int: true }),
  JOBS_PIPELINED: bool(false),
  JOB_TIMEOUT_MS: num(2 * 60 * 60_000, { min: 60_000, int: true }),
  JOB_MAX_ATTEMPTS: num(2, { min: 1, max: 10, int: true }),
  PROCESS_SYNC_TIMEOUT_MS: num(undefined, { min: 1000, int: true }),
  ENABLE_PROCESS_LOCK_MECHANISM: str(undefined),

  // Analysis backend
  ANALYSIS_BACKEND: oneOf(['worker', 'subprocess'], 'subprocess'),
  PYTHON_BINARY_PATH: str(process.platform === 'win32' ? 'python' : 'python3'),
  PROCESSING_TIMEOUT_MS: num(2 * 60 * 60_000, { min: 60_000, int: true }),
  WORKER_URLS: list(['http://127.0.0.1:8000']),
  WORKER_IDLE_TIMEOUT_MS: num(120_000, { min: 5000, int: true }),
  PROCESSING_FPS: num(1, { min: 0.05, max: 10 }),
  PROCESSING_FEATURES: list(['objects', 'ocr', 'scenes']),

  // LLM (Ollama)
  OLLAMA_AI_DISABLED: bool(false),
  OLLAMA_AI_API_URL: str('http://127.0.0.1:11434'),
  OLLAMA_AI_MODEL: str('qwen3.5:4b'),
  OLLAMA_AI_ALLOWED_MODELS: list([]),
  OLLAMA_AI_TEMPERATURE: num(0, { min: 0, max: 2 }),
  OLLAMA_AI_SEED: num(undefined, { int: true }),
  OLLAMA_AI_NUM_CTX: num(16384, { min: 2048, int: true }),
  OLLAMA_AI_NUM_PREDICT: num(2048, { min: 64, int: true }),
  OLLAMA_AI_KEEP_ALIVE: str('5m'),
  OLLAMA_AI_THINK: str('false'),
  OLLAMA_AI_TIMEOUT_MS: num(10 * 60_000, { min: 10_000, int: true }),
  OLLAMA_AI_AUTO_PULL: bool(true),
  GPU_SHARED_LOW_VRAM: bool(true),
  OLLAMA_AI_VISION_ENABLED: bool(false),
  OLLAMA_AI_VISION_MODEL: str(undefined),
  OLLAMA_AI_VISION_MAX_FRAMES: num(30, { min: 1, max: 500, int: true }),
  OLLAMA_AI_VISION_MIN_INTERVAL_SECONDS: num(10, { min: 0, max: 3600 }),

  // Deprecated (still read)
  PROCESSING_VERBOSE: str(undefined),
});

// ---------------------------------------------------------------------------------------------
// Secrets: VAR or VAR_FILE (Docker/Kubernetes secrets). Lists are comma or newline separated.
// ---------------------------------------------------------------------------------------------
function readSecretList(env, name, errors) {
  const parts = [env[name] ?? ''];
  const file = env[`${name}_FILE`];
  if (!blank(file)) {
    try {
      parts.push(fs.readFileSync(file.trim(), 'utf8'));
    } catch (error) {
      errors.push(`${name}_FILE: cannot read "${file}": ${error.message}`);
    }
  }
  return parts
    .join(',')
    .split(/[,\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Problems that make a token unacceptable for production use. */
export function tokenProblems(tokens, label = 'API token') {
  return tokens.flatMap((token, i) => {
    if (WEAK_TOKENS.has(token.toLowerCase())) return [`${label} #${i + 1} is a publicly known default value and must be replaced.`];
    if (token.length < MIN_TOKEN_LENGTH)
      return [`${label} #${i + 1} is too short (${token.length} chars); use at least ${MIN_TOKEN_LENGTH}.`];
    return [];
  });
}

const ROOT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Builds the config from an environment object. Never throws for invalid values: problems are
 * returned in `errors` (fatal) and `warnings` (start-up log), so the caller decides what to do.
 * @returns {{ config: object, errors: string[], warnings: string[] }}
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];
  const parsed = ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.')}: ${issue.message}`);
    return { config: undefined, errors, warnings };
  }
  const e = parsed.data;
  const isDev = e.NODE_ENV === 'development';
  const abs = (p) => path.resolve(cwd, p);

  // --- storage --------------------------------------------------------------------------------
  const dataDir = abs(e.DATA_DIR);
  const videosDir = abs(e.VIDEOS_DIR ?? path.join(e.DATA_DIR, 'videos'));
  const roots = [{ name: 'videos', dir: videosDir }];
  for (const entry of e.PROCESSING_ROOTS) {
    const sep = entry.indexOf(':');
    const name = sep > 0 ? entry.slice(0, sep).trim().toLowerCase() : '';
    const dir = sep > 0 ? entry.slice(sep + 1).trim() : '';
    // "C:\media" has a drive letter, not a root name: names are at least 2 characters long.
    if (!ROOT_NAME.test(name) || name.length < 2 || !dir) {
      errors.push(`PROCESSING_ROOTS: expected "name:/absolute/dir" entries, got "${entry}"`);
    } else if (roots.some((r) => r.name === name)) {
      errors.push(`PROCESSING_ROOTS: duplicate root name "${name}"`);
    } else {
      roots.push({ name, dir: abs(dir) });
    }
  }
  if (e.ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR) {
    warnings.push(
      'ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR is deprecated and lets /process read any video file this process can access. Use PROCESSING_ROOTS=name:/dir instead.',
    );
    roots.push({ name: 'filesystem', dir: path.parse(dataDir).root, legacyAnyPath: true });
  }
  if (!blank(e.AUDIOS_DIR) && e.ANALYSIS_BACKEND === 'worker') {
    warnings.push('AUDIOS_DIR is no longer used: audio is decoded in memory by the worker.');
  }
  if (e.ENABLE_PROCESS_LOCK_MECHANISM !== undefined) {
    warnings.push('ENABLE_PROCESS_LOCK_MECHANISM is deprecated: jobs are queued; use JOBS_PIPELINED for overlap.');
  }
  if (e.PROCESSING_VERBOSE !== undefined) warnings.push('PROCESSING_VERBOSE is deprecated: use LOG_LEVEL=debug.');

  // --- auth -----------------------------------------------------------------------------------
  const tokens = readSecretList(env, 'HTTP_BEARER_TOKEN', errors);
  if (e.AUTH_DISABLED) {
    if (!isDev) errors.push('AUTH_DISABLED=true is only allowed with NODE_ENV=development.');
    else warnings.push('Authentication is DISABLED (AUTH_DISABLED=true, development only).');
  } else if (tokens.length === 0) {
    errors.push(
      'No API token configured. Set HTTP_BEARER_TOKEN (or HTTP_BEARER_TOKEN_FILE), e.g. to the output of `openssl rand -hex 32`.',
    );
  } else {
    errors.push(...tokenProblems(tokens));
  }

  const workerTokens = readSecretList(env, 'WORKER_TOKEN', errors);
  if (e.ANALYSIS_BACKEND === 'worker') {
    if (workerTokens.length === 0 && !isDev) errors.push('WORKER_TOKEN (or WORKER_TOKEN_FILE) is required with ANALYSIS_BACKEND=worker.');
    else errors.push(...tokenProblems(workerTokens, 'WORKER_TOKEN'));
  }
  const ollamaApiKey = readSecretList(env, 'OLLAMA_AI_API_KEY', errors)[0];

  // --- misc -----------------------------------------------------------------------------------
  let trustProxy = e.HTTP_TRUST_PROXY;
  if (trustProxy === 'false') trustProxy = false;
  else if (trustProxy === 'true') trustProxy = true;
  else if (/^\d+$/.test(trustProxy)) trustProxy = Number(trustProxy);

  let think = e.OLLAMA_AI_THINK.toLowerCase();
  if (think === 'true') think = true;
  else if (think === 'false') think = false;
  else if (!['low', 'medium', 'high'].includes(think)) {
    errors.push(`OLLAMA_AI_THINK: expected true, false, low, medium or high, got "${e.OLLAMA_AI_THINK}"`);
  }

  const visionModel = e.OLLAMA_AI_VISION_MODEL ?? e.OLLAMA_AI_MODEL;
  const allowedModels = [...new Set([e.OLLAMA_AI_MODEL, visionModel, ...e.OLLAMA_AI_ALLOWED_MODELS])];
  const features = e.PROCESSING_FEATURES.map((f) => f.toLowerCase());
  const unknownFeature = features.find((f) => !['objects', 'ocr', 'scenes', 'faces'].includes(f));
  if (unknownFeature) errors.push(`PROCESSING_FEATURES: unknown feature "${unknownFeature}" (use objects, ocr, scenes, faces)`);

  const config = {
    env: e.NODE_ENV,
    isDev,
    http: {
      host: e.HTTP_HOST,
      port: e.HTTP_PORT,
      trustProxy,
      corsOrigins: e.HTTP_CORS_ORIGINS,
      jsonLimit: e.HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT,
      requestTimeoutMs: e.HTTP_REQUEST_TIMEOUT_MS,
      rateLimit: {
        enabled: e.HTTP_RATE_LIMIT_ENABLED,
        windowMs: e.HTTP_RATE_LIMIT_WINDOW_MS,
        max: e.HTTP_RATE_LIMIT_MAX_REQUESTS,
        heavyMax: e.HTTP_RATE_LIMIT_HEAVY_MAX_REQUESTS,
      },
    },
    auth: { disabled: e.AUTH_DISABLED && isDev, tokens },
    docs: { enabled: blank(e.API_DOCS_ENABLED) ? isDev : ['true', '1', 'yes', 'on'].includes(e.API_DOCS_ENABLED.trim().toLowerCase()) },
    log: {
      level: e.LOG_LEVEL,
      pretty: (e.LOG_FORMAT ?? (isDev ? 'pretty' : 'json')) === 'pretty',
      dir: e.LOG_DIR ? abs(e.LOG_DIR) : undefined,
      retentionDays: e.LOG_RETENTION_DAYS,
    },
    storage: {
      dataDir,
      videosDir,
      // v1 responses echo VIDEOS_DIR as configured (often relative, e.g. data/videos/x.mp4).
      videosDirDisplay: e.VIDEOS_DIR ?? path.join(e.DATA_DIR, 'videos'),
      analysisDir: abs(e.JSON_DATA_DIR ?? path.join(e.DATA_DIR, 'json')),
      promptsDir: abs(e.PROMPTS_DIR ?? path.join(e.DATA_DIR, 'prompts')),
      audiosDir: abs(e.AUDIOS_DIR ?? path.join(e.DATA_DIR, 'audios')),
      metaDir: path.join(dataDir, 'meta'),
      jobsDir: path.join(dataDir, 'jobs'),
      resultsDir: path.join(dataDir, 'results'),
      framesDir: path.join(dataDir, 'frames'),
      tmpDir: path.join(dataDir, 'tmp'),
      maxUploadBytes: e.VIDEO_FILE_MAX_UPLOAD_SIZE,
      allowedExtensions: e.VIDEO_ALLOWED_EXTENSIONS.map((x) => x.replace(/^\./, '').toLowerCase()),
      retentionDays: e.FILE_RETENTION_DAYS,
      minFreeBytes: e.STORAGE_MIN_FREE_BYTES,
      storePrompts: e.STORE_PROMPTS,
      processingOnly: e.PROCESSING_ONLY,
      roots,
    },
    jobs: {
      maxQueued: e.JOBS_MAX_QUEUED,
      pipelined: e.JOBS_PIPELINED,
      timeoutMs: e.JOB_TIMEOUT_MS,
      maxAttempts: e.JOB_MAX_ATTEMPTS,
      syncTimeoutMs: e.PROCESS_SYNC_TIMEOUT_MS ?? e.JOB_TIMEOUT_MS,
    },
    analysis: {
      backend: e.ANALYSIS_BACKEND,
      python: e.PYTHON_BINARY_PATH,
      processingTimeoutMs: e.PROCESSING_TIMEOUT_MS,
      workerUrls: e.WORKER_URLS,
      workerToken: workerTokens[0],
      workerIdleTimeoutMs: e.WORKER_IDLE_TIMEOUT_MS,
      sampleFps: e.PROCESSING_FPS,
      features,
    },
    ollama: {
      disabled: e.OLLAMA_AI_DISABLED,
      url: e.OLLAMA_AI_API_URL,
      apiKey: ollamaApiKey,
      model: e.OLLAMA_AI_MODEL,
      allowedModels,
      temperature: e.OLLAMA_AI_TEMPERATURE,
      seed: e.OLLAMA_AI_SEED,
      numCtx: e.OLLAMA_AI_NUM_CTX,
      numPredict: e.OLLAMA_AI_NUM_PREDICT,
      keepAlive: e.OLLAMA_AI_KEEP_ALIVE,
      think,
      timeoutMs: e.OLLAMA_AI_TIMEOUT_MS,
      autoPull: e.OLLAMA_AI_AUTO_PULL,
      lowVram: e.GPU_SHARED_LOW_VRAM,
      vision: {
        enabled: e.OLLAMA_AI_VISION_ENABLED,
        model: visionModel,
        maxFrames: e.OLLAMA_AI_VISION_MAX_FRAMES,
        minIntervalSeconds: e.OLLAMA_AI_VISION_MIN_INTERVAL_SECONDS,
      },
    },
  };
  return { config: deepFreeze(config), errors, warnings };
}

/**
 * Reads KEY=VALUE pairs from a .env file into `env` without overriding variables that are already
 * set (the real environment always wins). Returns true when a file was loaded.
 */
export function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return false;
  const values = util.parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
