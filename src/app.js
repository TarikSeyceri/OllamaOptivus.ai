// Express application factory (no listening, no global state: easy to test).
import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { bearerAuth } from './http/middleware/auth.js';
import { generalLimiter, heavyLimiter } from './http/middleware/rate-limit.js';
import { docsRouter } from './http/routes/docs.js';
import { healthRouter } from './http/routes/health.js';
import { jobsRouter } from './http/routes/jobs.js';
import { legacyRouter } from './http/routes/legacy.js';
import { modelsRouter } from './http/routes/models.js';
import { videosRouter } from './http/routes/videos.js';
import { createUploader } from './http/uploads.js';

const REQUEST_ID = /^[\w.:-]{1,128}$/;
const isProbe = (url = '') => url === '/' || url.startsWith('/health');

export function createApp({ config, logger, services }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => isProbe(req.url) },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      // Swagger UI needs its own (self-hosted) scripts and inline styles; everything else is JSON.
      contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'], 'upgrade-insecure-requests': null } },
      crossOriginEmbedderPolicy: false,
    }),
  );
  if (config.http.corsOrigins.length) {
    app.use(
      cors({
        origin: config.http.corsOrigins.includes('*') ? true : config.http.corsOrigins,
        methods: ['GET', 'POST', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
        exposedHeaders: ['X-Request-Id', 'Location', 'RateLimit', 'RateLimit-Policy', 'Deprecation'],
        maxAge: 600,
      }),
    );
  }
  app.use(express.json({ limit: config.http.jsonLimit }));

  // Public routes: probes, hello world and (when enabled) the API docs.
  app.use(healthRouter({ config, services }));
  app.get('/', (req, res) => res.json({ success: true, msg: 'Ollama Optivus Server is running!' }));
  if (config.docs.enabled) app.use(docsRouter());

  // Everything below is rate-limited and requires a bearer token.
  const limits = config.http.rateLimit;
  const heavy = limits.enabled ? heavyLimiter(limits) : (req, res, next) => next();
  if (limits.enabled) app.use(generalLimiter(limits));
  if (!config.auth.disabled) app.use(bearerAuth(config.auth.tokens));

  const upload = createUploader({ storage: config.storage });
  app.use(videosRouter({ config, services, upload, heavyLimiter: heavy }));
  app.use(jobsRouter({ config, services, heavyLimiter: heavy }));
  app.use(modelsRouter({ config, services }));
  app.use(legacyRouter({ config, services, heavyLimiter: heavy }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
