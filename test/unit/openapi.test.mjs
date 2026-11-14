// The committed OpenAPI document must match what the code generates (run `npm run openapi` after
// changing routes or schemas).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildOpenApi } from '../../src/http/openapi.js';

describe('OpenAPI document', () => {
  it('docs/openapi.json is up to date', () => {
    const committed = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenApi())), 'run `npm run openapi` and commit the result');
  });

  it('documents every v1 route with security', () => {
    const { paths, components } = buildOpenApi();
    for (const route of ['/v1/videos', '/v1/videos/{id}', '/v1/jobs', '/v1/jobs/{id}', '/v1/jobs/{id}/analysis', '/v1/models']) {
      assert.ok(paths[route], route);
    }
    assert.equal(components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.deepEqual(paths['/health/live'].get.security, [], 'health probes are public');
  });
});
