#!/usr/bin/env node
// Compares Ollama models on a real analysis with exactly the production prompt.
//
//   node scripts/bench-models.mjs --analysis data/json/<key>.json --models qwen3.5:4b,gemma4:e4b
//        [--ollama http://127.0.0.1:11434] [--language en] [--explanation "..."] [--format format.json]
//        [--num-ctx 16384] [--out bench-results]
//
// Get an analysis from a finished job: GET /v1/jobs/{id}/analysis (save payload.analysis to a file),
// or take one from the data volume (data/json/*.json). Each model is loaded fresh, so load time is part
// of the measurement. Results (answers and metrics) are written to --out for side-by-side reading.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildPrompt } from '../src/core/llm/prompt.js';
import { DEFAULT_FORMAT } from '../src/core/llm/summarize.js';

const { values: args } = parseArgs({
  options: {
    analysis: { type: 'string' },
    models: { type: 'string' },
    ollama: { type: 'string', default: process.env.OLLAMA_AI_API_URL ?? 'http://127.0.0.1:11434' },
    language: { type: 'string', default: 'en' },
    explanation: { type: 'string' },
    format: { type: 'string' },
    'num-ctx': { type: 'string', default: '16384' },
    out: { type: 'string', default: 'bench-results' },
  },
});
if (!args.analysis || !args.models) {
  console.error('Usage: node scripts/bench-models.mjs --analysis <analysis.json> --models <m1,m2,...> [--ollama URL]');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(args.analysis, 'utf8'));
const analysis = raw.payload?.analysis ?? raw;
const format = args.format ? JSON.parse(readFileSync(args.format, 'utf8')) : DEFAULT_FORMAT;
const prompt = buildPrompt(analysis, { language: args.language, videoExplanation: args.explanation, format });
let canWrite = true;
try {
  mkdirSync(args.out, { recursive: true });
} catch {
  canWrite = false;
  console.warn(`Cannot write to ${args.out}; answers are printed instead.`);
}
console.log(`Prompt: ~${prompt.estimatedTokens} tokens, video ${prompt.duration.toFixed(0)} s, context ${args['num-ctx']}\n`);

async function post(route, body) {
  const res = await fetch(args.ollama + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const rows = [];
for (const model of args.models
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)) {
  process.stdout.write(`${model} ... `);
  try {
    await post('/api/generate', { model, prompt: '', keep_alive: 0 }).catch(() => {}); // start cold
    const started = Date.now();
    const r = await post('/api/chat', {
      model,
      stream: false,
      think: false,
      format,
      keep_alive: '1m',
      options: { temperature: 0, num_ctx: Number(args['num-ctx']), num_predict: 2048 },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });
    const wallS = (Date.now() - started) / 1000;
    const ps = (await (await fetch(`${args.ollama}/api/ps`)).json()).models?.find((m) => m.name === model || m.model === model);
    let parsed;
    try {
      parsed = JSON.parse(r.message.content);
    } catch {
      parsed = undefined;
    }
    const row = {
      model,
      wallS: Number(wallS.toFixed(1)),
      loadS: Number((r.load_duration / 1e9).toFixed(1)),
      promptTokS: Math.round(r.prompt_eval_count / (r.prompt_eval_duration / 1e9)),
      genTokS: Math.round(r.eval_count / (r.eval_duration / 1e9)),
      outputTokens: r.eval_count,
      vramGb: ps ? Number((ps.size_vram / 1e9).toFixed(2)) : undefined,
      onGpu: ps ? `${Math.round((ps.size_vram / ps.size) * 100)}%` : undefined,
      validJson: parsed !== undefined,
    };
    rows.push(row);
    const report = JSON.stringify({ metrics: row, answer: parsed ?? r.message.content }, null, 2);
    if (canWrite) writeFileSync(path.join(args.out, `${model.replace(/[^\w.-]+/g, '_')}.json`), report);
    console.log(`${row.wallS}s`);
    if (!canWrite) console.log(report);
  } catch (error) {
    rows.push({ model, error: error.message });
    console.log(`failed: ${error.message}`);
  }
}
console.log();
console.table(rows);
if (canWrite) console.log(`Answers written to ${path.resolve(args.out)} - compare them for accuracy, not only speed.`);
