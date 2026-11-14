#!/usr/bin/env node
// End-to-end smoke test against a running stack: readiness -> upload -> job -> result.
//
//   node scripts/smoke.mjs [--url http://127.0.0.1:3330] [--video test/fixtures/speech.mp4]
//                          [--language en] [--no-prompting] [--features objects,ocr,scenes]
//
// The API token comes from OPTIVUS_TOKEN or from HTTP_BEARER_TOKEN in ./.env.
// Exit code 0 = the job completed; anything else = failure (details are printed).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.OPTIVUS_URL ?? 'http://127.0.0.1:3330' },
    video: { type: 'string', default: 'test/fixtures/speech.mp4' },
    language: { type: 'string', default: 'en' },
    features: { type: 'string' },
    'no-prompting': { type: 'boolean', default: false },
    'ready-timeout': { type: 'string', default: '900' },
    'job-timeout': { type: 'string', default: '1800' },
  },
});

const token =
  process.env.OPTIVUS_TOKEN ?? (existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')).HTTP_BEARER_TOKEN?.split(',')[0] : undefined);
if (!token) {
  console.error('No API token: set OPTIVUS_TOKEN or run scripts/init first.');
  process.exit(2);
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (message) => console.log(`[${elapsed()}] ${message}`);

async function call(method, urlPath, { json, form } = {}) {
  const res = await fetch(args.url + urlPath, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  // 1) Readiness: the worker loads its models and Ollama may pull the model on first start.
  const readyDeadline = Date.now() + Number(args['ready-timeout']) * 1000;
  for (let last = ''; ;) {
    let status = 'unreachable';
    try {
      const res = await fetch(`${args.url}/health/ready`);
      const body = await res.json();
      if (res.ok) break;
      status = JSON.stringify(body.checks);
    } catch {
      /* not up yet */
    }
    if (status !== last) log(`waiting for readiness: ${status}`);
    last = status;
    if (Date.now() > readyDeadline) throw new Error('the stack did not become ready in time');
    await new Promise((r) => setTimeout(r, 3000));
  }
  log('stack is ready');

  // 2) Upload.
  const file = path.resolve(args.video);
  const form = new FormData();
  form.append('video', new Blob([readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
  const { payload: uploaded } = await call('POST', '/v1/videos', { form });
  log(`uploaded ${path.basename(file)} as ${uploaded.video.id.slice(0, 12)}... (${uploaded.deduplicated ? 'already known' : 'new'})`);

  // 3) Job.
  const request = {
    videoId: uploaded.video.id,
    language: args.language,
    videoExplanation: 'This is a short test video with a voice-over and on-screen text.',
    noPrompting: args['no-prompting'],
    ...(args.features ? { features: args.features.split(',') } : {}),
  };
  let { payload } = await call('POST', '/v1/jobs?wait=60', { json: request });
  let job = payload.job;
  log(`job ${job.id} ${job.status}`);
  const jobDeadline = Date.now() + Number(args['job-timeout']) * 1000;
  while (!['completed', 'failed', 'canceled'].includes(job.status)) {
    if (Date.now() > jobDeadline) throw new Error(`job ${job.id} did not finish in time`);
    ({ payload } = await call('GET', `/v1/jobs/${job.id}?wait=30`));
    job = payload.job;
    log(`job ${job.status} - ${job.stage} ${Math.round(job.progress * 100)}%`);
  }
  if (job.status !== 'completed') throw new Error(`job ${job.status}: ${JSON.stringify(job.error)}`);

  // 4) Report.
  console.log('\nSummary:', JSON.stringify(job.summary, null, 2));
  if (job.warnings) console.log('Warnings:', job.warnings);
  console.log(args['no-prompting'] ? `\nPrompt:\n${job.prompt}` : `\nResult:\n${JSON.stringify(job.result, null, 2)}`);
  log('smoke test passed');
} catch (error) {
  console.error(`\nSMOKE TEST FAILED after ${elapsed()}: ${error.message}`);
  process.exit(1);
}
