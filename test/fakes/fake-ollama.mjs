// A small in-process stand-in for the Ollama HTTP API, used by the black-box tests.
// It records every request so tests can assert on what the API sent (model, options, format, ...).
import http from 'node:http';

export const DEFAULT_LLM_RESULT = {
  summary: 'A customer calls support to ask about an invoice.',
  events: [{ timestamp: 2, description: 'The agent greets the customer.' }],
};

const normalize = (name = '') => (name.includes(':') ? name : `${name}:latest`);

export async function startFakeOllama({ models = ['test-model:latest'], result = DEFAULT_LLM_RESULT } = {}) {
  const state = {
    models: new Set(models.map(normalize)),
    loaded: new Map(),
    requests: [],
    result,
    /** Text appended after the JSON object, to emulate structured-output whitespace runaway. */
    trailing: '',
    /** Optional per-request hook: (path, body) => ({ status, body }) | undefined */
    intercept: undefined,
  };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, 'http://fake');
    state.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });

    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    const hooked = state.intercept?.(url.pathname, body);
    if (hooked) return send(hooked.status ?? 200, hooked.body);

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/version':
        return send(200, { version: '0.40.13' });
      case 'GET /api/tags':
        return send(200, {
          models: [...state.models].map((name) => ({
            name,
            model: name,
            size: 3_300_000_000,
            digest: 'sha256:0000',
            details: { family: 'fake', parameter_size: '4B', quantization_level: 'Q4_K_M' },
          })),
        });
      case 'GET /api/ps':
        return send(200, { models: [...state.loaded.values()] });
      case 'POST /api/show':
        return state.models.has(normalize(body?.model ?? body?.name))
          ? send(200, { capabilities: ['completion', 'vision'], model_info: {} })
          : send(404, { error: 'model not found' });
      case 'POST /api/pull': {
        state.models.add(normalize(body?.model ?? body?.name));
        if (body?.stream === false) return send(200, { status: 'success' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'downloading', total: 100, completed: 100 })}\n`);
        return res.end(`${JSON.stringify({ status: 'success' })}\n`);
      }
      case 'POST /api/generate':
      case 'POST /api/chat':
        return complete(url.pathname === '/api/chat', body, res, send);
      default:
        return send(404, { error: `unknown route ${req.method} ${url.pathname}` });
    }
  });

  function complete(isChat, body, res, send) {
    const model = normalize(body?.model);
    if (!state.models.has(model)) return send(404, { error: `model '${body?.model}' not found` });

    // An empty prompt with keep_alive 0 is Ollama's "unload this model" request.
    const emptyPrompt = isChat ? !(body?.messages?.length) : !body?.prompt;
    if (body?.keep_alive === 0 || body?.keep_alive === '0' || body?.keep_alive === '0s') {
      state.loaded.delete(model);
      if (emptyPrompt) return send(200, { model, done: true, done_reason: 'unload' });
    } else {
      state.loaded.set(model, {
        name: model,
        model,
        size: 5_000_000_000,
        size_vram: 5_000_000_000,
        context_length: body?.options?.num_ctx ?? 4096,
      });
    }

    const isCaption = isChat && body?.messages?.some((m) => Array.isArray(m.images) && m.images.length);
    const content = isCaption
      ? 'A person sits at a desk in an office.'
      : (typeof state.result === 'string' ? state.result : JSON.stringify(state.result)) + state.trailing;

    const meta = { model, created_at: new Date().toISOString(), prompt_eval_count: 100, eval_count: 50 };
    if (body?.stream === false) {
      return send(200, isChat
        ? { ...meta, message: { role: 'assistant', content }, done: true, done_reason: 'stop' }
        : { ...meta, response: content, done: true, done_reason: 'stop' });
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const pieces = content.match(/[\s\S]{1,16}/g) ?? [''];
    for (const piece of pieces) {
      res.write(`${JSON.stringify(isChat
        ? { ...meta, message: { role: 'assistant', content: piece }, done: false }
        : { ...meta, response: piece, done: false })}\n`);
    }
    return res.end(`${JSON.stringify(isChat
      ? { ...meta, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }
      : { ...meta, response: '', done: true, done_reason: 'stop' })}\n`);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requestsTo: (path) => state.requests.filter((r) => r.path === path),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
