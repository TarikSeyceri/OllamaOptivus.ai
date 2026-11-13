#!/usr/bin/env node
// Writes the OpenAPI 3.1 document (generated from the request schemas) to docs/openapi.json.
import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../src/http/openapi.js';

writeFileSync(new URL('../docs/openapi.json', import.meta.url), `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log('docs/openapi.json written');
