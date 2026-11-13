// Unit tests for configuration parsing and path helpers.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { isInside, sanitizeFileName } from '../../src/core/storage/paths.js';

const TOKEN = 'unit-test-token-0123456789abcdef0123456789';
const load = (env) => loadConfig({ HTTP_BEARER_TOKEN: TOKEN, WORKER_TOKEN: `${TOKEN}w`, ...env }, { cwd: '/srv/optivus' });

describe('config', () => {
  it('has secure, documented defaults', () => {
    const { config, errors } = load({});
    assert.deepEqual(errors, []);
    assert.equal(config.env, 'production', 'anything but "development" is production');
    assert.equal(config.docs.enabled, false);
    assert.equal(config.http.port, 3330);
    assert.equal(config.ollama.model, 'qwen3.5:4b');
    assert.equal(config.ollama.numCtx, 16384);
    assert.equal(config.ollama.think, false);
    assert.equal(config.ollama.lowVram, true);
    assert.equal(config.storage.maxUploadBytes, 500 * 1024 ** 2);
    assert.ok(Object.isFrozen(config.storage));
  });

  it('collects every invalid value with a readable message', () => {
    const { errors } = load({ HTTP_PORT: '99999', OLLAMA_AI_TEMPERATURE: 'hot', HTTP_RATE_LIMIT_ENABLED: 'maybe' });
    assert.equal(errors.length, 3, errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('HTTP_PORT')));
  });

  it('rejects weak tokens and AUTH_DISABLED outside development', () => {
    assert.ok(load({ HTTP_BEARER_TOKEN: 'mysecrettoken' }).errors.some((e) => /publicly known/.test(e)));
    assert.ok(load({ HTTP_BEARER_TOKEN: 'short' }).errors.some((e) => /too short/.test(e)));
    assert.ok(load({ AUTH_DISABLED: 'true' }).errors.some((e) => /only allowed/.test(e)));
    assert.deepEqual(load({ AUTH_DISABLED: 'true', NODE_ENV: 'development', HTTP_BEARER_TOKEN: '' }).errors, []);
  });

  it('reads secrets from *_FILE and supports several tokens', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'optivus-cfg-'));
    const file = path.join(dir, 'tokens');
    writeFileSync(file, `${TOKEN}x\n${TOKEN}y\n`);
    const { config, errors } = load({ HTTP_BEARER_TOKEN: '', HTTP_BEARER_TOKEN_FILE: file });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.auth.tokens, [`${TOKEN}x`, `${TOKEN}y`]);
  });

  it('parses named storage roots and maps the deprecated outside-dir flag', () => {
    const { config, errors, warnings } = load({
      PROCESSING_ROOTS: 'nas:/mnt/nas, usb:/media/usb',
      ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR: 'true',
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      config.storage.roots.map((r) => r.name),
      ['videos', 'nas', 'usb', 'filesystem'],
    );
    assert.ok(warnings.some((w) => /deprecated/.test(w)));
    assert.ok(load({ PROCESSING_ROOTS: 'C:\\media' }).errors.length > 0, 'drive letters are not root names');
  });

  it('parses sizes and model allowlists', () => {
    const { config } = load({
      VIDEO_FILE_MAX_UPLOAD_SIZE: '2gb',
      OLLAMA_AI_ALLOWED_MODELS: 'gemma4:e4b',
      OLLAMA_AI_VISION_MODEL: 'qwen3-vl:4b',
    });
    assert.equal(config.storage.maxUploadBytes, 2 * 1024 ** 3);
    assert.deepEqual(config.ollama.allowedModels, ['qwen3.5:4b', 'qwen3-vl:4b', 'gemma4:e4b']);
  });

  it('requires a strong worker token in production and reports obsolete variables', () => {
    assert.ok(load({ WORKER_TOKEN: '' }).errors.some((e) => /WORKER_TOKEN/.test(e)));
    assert.ok(load({ WORKER_TOKEN: 'short' }).errors.some((e) => /WORKER_TOKEN #1 is too short/.test(e)));
    assert.deepEqual(load({ WORKER_TOKEN: '', NODE_ENV: 'development' }).errors, []);
    const { warnings } = load({ PYTHON_BINARY_PATH: 'python3', AUDIOS_DIR: 'data/audios' });
    assert.ok(warnings.some((w) => /PYTHON_BINARY_PATH/.test(w)));
    assert.ok(warnings.some((w) => /AUDIOS_DIR/.test(w)));
  });
});

describe('paths', () => {
  it('sanitizes upload names', () => {
    assert.equal(sanitizeFileName('../../etc/passwd.mp4'), 'passwd.mp4');
    assert.equal(sanitizeFileName('C:\\Users\\x\\My Video (1).MP4'), 'My Video _1_.mp4');
    assert.equal(sanitizeFileName('çağrı kaydı.mp4'), 'çağrı kaydı.mp4');
    assert.equal(sanitizeFileName('con.mp4'), null);
    assert.equal(sanitizeFileName('...'), null);
    assert.ok(sanitizeFileName(`${'a'.repeat(300)}.mp4`).length <= 120);
  });

  it('checks containment without prefix confusion', () => {
    assert.ok(isInside(path.resolve('/data/videos'), path.resolve('/data/videos/a.mp4')));
    assert.ok(!isInside(path.resolve('/data/videos'), path.resolve('/data/videos2/a.mp4')));
    assert.ok(!isInside(path.resolve('/data/videos'), path.resolve('/data/videos/../jobs/a')));
  });
});
