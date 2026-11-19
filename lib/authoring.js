/**
 * Authoring guidance for the AI draft call.
 *
 * Matt Pocock's "writing-for-agents" methodology ships inside this package as
 * plain reference material (`lib/prompts/writing-for-agents/`). It is *not* a
 * DSH skill: nothing here is written to a skill scan root, registered with a
 * skill provider, or exposed in any session's skill catalog. The text is only
 * appended to the system prompt of the "one sentence → skill" generation.
 *
 * Missing or unreadable material degrades silently to an empty string so skill
 * creation keeps working exactly as before.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripFrontmatter } from './naming.js';

/** The tag the draft prompt wraps injected guidance in; tests assert on it. */
export const AUTHORING_MARKER = '<authoring-guidance>';

/** Disable injection without touching code, e.g. for benchmarking. */
const DISABLE_ENV = 'DSH_SKILL_MANAGER_AUTHORING';

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_DIR = fileURLToPath(new URL('./prompts/writing-for-agents/', import.meta.url));

/** One warning per process, not one per generation attempt. */
let warned = false;

/** Memoized loads keyed by directory + character budget. */
const cache = new Map();

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn(
    `[dsh-skill-manager] authoring guidance unavailable (${error instanceof Error ? error.message : String(error)}); continuing without it`,
  );
}

function readGuidanceFile(dir, name) {
  return readFile(path.join(dir, name), 'utf8').then(stripFrontmatter);
}

function truncate(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit);
}

/**
 * Load the methodology text used to steer skill generation.
 *
 * Reads `SKILL.md` then `SKILL-MECHANICS.md`, strips their frontmatter, joins
 * them with a heading, and truncates the whole thing to `maxChars`. Results are
 * memoized; any read failure returns an empty string and warns once.
 *
 * @param {{ dir?: string, maxChars?: number }} [options]
 * @returns {Promise<string>} guidance text, or '' when unavailable/disabled
 */
export async function loadAuthoringGuidance({ dir = DEFAULT_DIR, maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (String(process.env[DISABLE_ENV] ?? '').trim().toLowerCase() === 'off') return '';
  const key = `${dir}\u0000${maxChars}`;
  if (cache.has(key)) return cache.get(key);
  let guidance = '';
  try {
    const [skill, mechanics] = await Promise.all([
      readGuidanceFile(dir, 'SKILL.md'),
      readGuidanceFile(dir, 'SKILL-MECHANICS.md'),
    ]);
    const parts = [];
    if (skill.trim()) parts.push(skill.trim());
    if (mechanics.trim()) parts.push(`## SKILL-MECHANICS.md\n\n${mechanics.trim()}`);
    guidance = parts.join('\n\n');
    if (!guidance.trim()) {
      warnOnce(new Error('authoring guidance files are empty'));
      guidance = '';
    }
  } catch (error) {
    warnOnce(error);
    guidance = '';
  }
  guidance = truncate(guidance, maxChars);
  cache.set(key, guidance);
  return guidance;
}
