/**
 * Shared test helpers: fake Node request/response pairs and archive fixtures.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

export async function tempDir(prefix = 'skill-manager-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Build a fake response that captures status/payload. */
export function fakeResponse() {
  const response = {
    status: 0,
    headers: {},
    payload: undefined,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(body) {
      this.writableEnded = true;
      try {
        this.payload = body === undefined ? undefined : JSON.parse(body);
      } catch {
        this.payload = body;
      }
    },
  };
  return response;
}

/** Build a fake request; `body` may be a Buffer, a string or an object. */
export function fakeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
  let chunks;
  if (body === undefined) chunks = [];
  else if (Buffer.isBuffer(body)) chunks = [body];
  else if (typeof body === 'string') chunks = [Buffer.from(body)];
  else chunks = [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks);
  return {
    method,
    url,
    headers: { host: '127.0.0.1:61115', origin: 'http://127.0.0.1:61115', ...headers },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  };
}

/** Call one service route and return `{status, payload}`. */
export async function callRoute(service, routePath, options = {}) {
  const basePath = routePath.split('?')[0];
  const handler = service.routes.get(basePath);
  if (!handler) throw new Error(`route not registered: ${basePath}`);
  const response = fakeResponse();
  await handler(fakeRequest({ url: routePath, ...options }), response);
  return { status: response.status, payload: response.payload };
}

/** Create a skill source tree plus a zip archive of it. */
export async function makeZipFixture(root, { wrapper = 'demo-skill', skillFile = 'SKILL.md', scripts = { 'run.sh': '#!/bin/sh\necho hi\n' }, extra = {} } = {}) {
  const source = path.join(root, 'source');
  const skillDir = wrapper ? path.join(source, wrapper) : source;
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, skillFile),
    '---\nname: demo-skill\ndescription: 用于测试的示例技能\ndisplayName: 示例技能\n---\n\n# 示例技能\n\n按步骤执行。\n',
  );
  if (scripts) {
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(path.join(skillDir, 'scripts', name), content);
    }
  }
  for (const [relative, content] of Object.entries(extra)) {
    const target = path.join(skillDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = path.join(root, 'demo.zip');
  execFileSync('/usr/bin/bsdtar', ['-a', '-c', '-f', archive, '-C', source, wrapper || '.'], { stdio: 'ignore' });
  return archive;
}

/** A fake context exposing the model services the Host half consumes. */
export function fakeContext({ selection = { provider: 'deepseek-account', model: 'deepseek-flash' }, reply = '{"displayName":"文档解析"}', replies = null } = {}) {
  const warnings = [];
  const answers = Array.isArray(replies) ? replies : [reply];
  let answerIndex = 0;
  const ctx = {
    warnings,
    get(name) {
      if (name === 'agentDefaultModel') {
        return selection === null ? undefined : { currentSelection: () => selection };
      }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
          listModels: async () => [{ provider: 'deepseek-account', id: 'deepseek-flash', name: 'Flash' }],
          stream: async function* () {
            const text = answers[Math.min(answerIndex, answers.length - 1)];
            answerIndex += 1;
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      return undefined;
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    effect(callback) {
      callback();
    },
  };
  return ctx;
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}
