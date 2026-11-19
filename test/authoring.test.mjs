import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUTHORING_MARKER, loadAuthoringGuidance } from '../lib/authoring.js';
import { draftSystemPrompt } from '../lib/llm.js';

const PROMPTS_DIR = fileURLToPath(new URL('../lib/prompts/writing-for-agents/', import.meta.url));

test('loadAuthoringGuidance reads both files and strips frontmatter', async () => {
  const guidance = await loadAuthoringGuidance({ dir: PROMPTS_DIR });
  assert.ok(guidance.length > 1_000, `expected a large reference, got ${guidance.length}`);
  assert.match(guidance, /context pointer/);
  assert.match(guidance, /SKILL-MECHANICS/);
  // Frontmatter of both files must be gone.
  assert.ok(!guidance.startsWith('---'), 'frontmatter was not stripped');
  assert.ok(!guidance.includes('name: writing-for-agents'));
  assert.ok(!guidance.includes('description: Writing documents for agents'));
});

test('a missing directory degrades to an empty string', async () => {
  const guidance = await loadAuthoringGuidance({ dir: '/tmp/definitely-missing-authoring-dir' });
  assert.equal(guidance, '');
});

test('DSH_SKILL_MANAGER_AUTHORING=off disables the guidance', async () => {
  const key = 'DSH_SKILL_MANAGER_AUTHORING';
  const previous = process.env[key];
  process.env[key] = 'Off';
  try {
    const guidance = await loadAuthoringGuidance({ dir: PROMPTS_DIR });
    assert.equal(guidance, '');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('maxChars truncates the guidance', async () => {
  const guidance = await loadAuthoringGuidance({ dir: PROMPTS_DIR, maxChars: 120 });
  assert.equal(guidance.length, 120);
  const full = await loadAuthoringGuidance({ dir: PROMPTS_DIR });
  assert.ok(full.startsWith(guidance.slice(0, 80)));
});

test('draftSystemPrompt appends guidance inside the authoring marker', () => {
  const withGuidance = draftSystemPrompt({ guidance: 'MARKER-XYZ' });
  assert.ok(withGuidance.includes('MARKER-XYZ'));
  assert.ok(withGuidance.includes(AUTHORING_MARKER));
  assert.ok(withGuidance.includes('</authoring-guidance>'));
  assert.ok(withGuidance.length > draftSystemPrompt({}).length);
});

test('draftSystemPrompt omits the guidance block without guidance', () => {
  const plain = draftSystemPrompt({});
  assert.ok(!plain.includes(AUTHORING_MARKER));
  assert.ok(!plain.includes('</authoring-guidance>'));
});

test('draftSystemPrompt keeps the existing script branches', () => {
  const withScripts = draftSystemPrompt({ withScripts: true });
  assert.match(withScripts, /用户已要求附带 scripts 脚本/);
  assert.match(withScripts, /严格输出 JSON/);
  assert.match(withScripts, /200-400/);
  const withoutScripts = draftSystemPrompt({ withScripts: false });
  assert.match(withoutScripts, /不要生成脚本/);
  assert.ok(!withoutScripts.includes('用户已要求附带 scripts 脚本'));
});
