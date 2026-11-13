// API documentation: /openapi.json and an interactive Swagger UI at /docs.
// Enabled by default only in development (API_DOCS_ENABLED overrides). The document is public when
// enabled; it contains no secrets.
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApi } from '../openapi.js';

export function docsRouter() {
  const router = Router();
  const document = buildOpenApi();
  router.get('/openapi.json', (req, res) => res.json(document));
  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(document, {
      customSiteTitle: 'Ollama Optivus AI API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  return router;
}
