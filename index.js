/**
 * Host half of the custom skill manager.
 *
 * Four same-origin routes are served from DSH's shared web server:
 *   GET  /dsh-skill-manager/state    – installed skills, default model status
 *   GET  /dsh-skill-manager/session  – skills mounted on one session
 *   POST /dsh-skill-manager/import   – raw archive upload → staging preview
 *   POST /dsh-skill-manager/action   – every JSON action (generate/create/...)
 *
 * Skills live under `<DSH_HOME>/skills/<slug>` and are ordinary DSH skills:
 * they are discovered by the shipped filesystem provider, so a `/slug` token
 * in a user message expands to the skill prompt exactly like a built-in skill.
 */

import path from 'node:path';
import { ARCHIVE_LIMITS } from './lib/archive.js';
import { SkillCatalog } from './lib/catalog.js';
import { fail } from './lib/errors.js';
import { headerValue, readJsonBody, readRawBody, requireMethod, sameOrigin, send, sendError } from './lib/http.js';
import { describeModel, generateDraft, tryGenerateName, tryGenerateSummary } from './lib/llm.js';
import { describeSkillMounts } from './lib/mount-info.js';
import { cleanDisplayName, defaultDescription, deriveSlug, humanizeSlug, normalizeManualDisplayName } from './lib/naming.js';
import { resolveLayout, writeFileAtomic } from './lib/paths.js';
import { STAGING_TTL_MS, MAX_STAGING, StagingStore } from './lib/staging.js';
import { MountStore } from './lib/store.js';
import { parseSkillMarkdown } from './lib/manifest.js';
import { normalizeScriptList, withEnvironmentNote } from './lib/scripts.js';
import { SummaryStore, bodyDigest, normalizeSummaryRecord } from './lib/summaries.js';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const JSON_BODY_LIMIT = 1024 * 1024;

function sessionIdOf(value) {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId) fail('bad_request', '缺少会话 ID');
  if (!SESSION_ID_RE.test(sessionId)) fail('bad_request', '会话 ID 格式无效');
  return sessionId;
}

function invocationOf(payload, fallback) {
  const raw = typeof payload?.invocation === 'string' ? payload.invocation.trim().toLowerCase() : '';
  if (raw === 'auto' || raw === 'manual') return raw;
  if (raw) fail('bad_request', '注入方式只能是 auto 或 manual');
  if (typeof payload?.modelInvocable === 'boolean') return payload.modelInvocable ? 'auto' : 'manual';
  return fallback;
}

function slugListOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('bad_request', '技能列表必须是数组');
  return value.filter((slug) => typeof slug === 'string' && slug.trim()).map((slug) => slug.trim());
}

/**
 * Build the service object (routes + stores) without touching `apply`.
 * Tests construct this with a temporary layout and a fake context.
 */
export function createService(ctx, { layout = resolveLayout() } = {}) {
  const store = new MountStore(layout.stateFile);
  const summaries = new SummaryStore(layout);
  const staging = new StagingStore(layout);
  const catalog = new SkillCatalog(layout);
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-skill-manager] ${message}`);
    } catch {
      /* Logging must never break a request. */
    }
  };

  async function listSnapshot() {
    const { skills, invalid } = await catalog.list();
    return { skills, invalid, bySlug: new Map(skills.map((skill) => [skill.slug, skill])) };
  }

  /** Resolve display name and slug, asking the default model when the user left the name blank. */
  async function resolveIdentity({ requestedName, frontmatterName, displayNameHint, description, body, explicitSlug }) {
    let displayName = cleanDisplayName(requestedName);
    let degraded = false;
    let warning;
    if (!displayName) {
      const fallback = cleanDisplayName(displayNameHint) || (frontmatterName ? humanizeSlug(frontmatterName) : '自定义技能');
      const named = await tryGenerateName(ctx, { body, description, slug: frontmatterName, fallback });
      displayName = normalizeManualDisplayName(named.displayName || fallback);
      degraded = named.degraded === true;
      warning = named.warning;
    }
    const slug = deriveSlug({ explicitSlug, frontmatterName, displayName, body });
    return { displayName, slug, degraded, warning };
  }

  async function mountOne(sessionId, slug) {
    const { bySlug } = await listSnapshot();
    if (!bySlug.has(slug)) fail('not_found', `Skill 不存在：${slug}`);
    const current = await store.get(sessionId);
    if (current.includes(slug)) return current;
    return store.set(sessionId, [...current, slug]);
  }

  async function handleState(request, response) {
    if (!requireMethod(request, response, 'GET')) return;
    const { skills, invalid } = await catalog.list();
    const counts = await store.counts();
    const model = await describeModel(ctx);
    const stagingCount = await staging.count();
    send(response, 200, {
      ok: true,
      dshHome: layout.home,
      skillsRoot: layout.skills,
      model,
      limits: {
        archiveBytes: ARCHIVE_LIMITS.archiveBytes,
        extractedBytes: ARCHIVE_LIMITS.extractedBytes,
        files: ARCHIVE_LIMITS.files,
        fileBytes: ARCHIVE_LIMITS.fileBytes,
        stagingTtlMinutes: Math.round(STAGING_TTL_MS / 60000),
        maxStaging: MAX_STAGING,
      },
      stagingCount,
      skills: skills.map((skill) => ({ ...withSummary(skill), mountedSessions: counts[skill.slug] ?? 0 })),
      invalid,
    });
  }

  async function handleSession(request, response) {
    if (!requireMethod(request, response, 'GET')) return;
    const url = new URL(request.url ?? '/', 'http://localhost');
    const sessionId = sessionIdOf(url.searchParams.get('sessionId'));
    const mounted = await store.get(sessionId);
    const { bySlug } = await listSnapshot();
    const known = mounted.filter((slug) => bySlug.has(slug));
    if (known.length !== mounted.length) await store.set(sessionId, known);
    send(response, 200, {
      ok: true,
      sessionId,
      mounted: known,
      skills: known.map((slug) => ({ ...bySlug.get(slug), mounted: true })),
    });
  }

  async function handleImport(request, response) {
    if (!requireMethod(request, response, 'POST')) return;
    const header = headerValue(request, 'x-skill-manager-filename');
    let originalName = 'skill.zip';
    if (header) {
      try {
        originalName = decodeURIComponent(header) || originalName;
      } catch {
        originalName = header;
      }
    }
    const body = await readRawBody(request, ARCHIVE_LIMITS.archiveBytes + 1024);
    if (body.length === 0) fail('bad_archive', '压缩包为空');
    const reserved = await staging.begin();
    const archiveFile = path.join(reserved.dir, 'archive.bin');
    await writeFileAtomic(archiveFile, body, 0o600);
    try {
      const preview = await staging.prepare(reserved.id, archiveFile, { originalName });
      send(response, 200, { ok: true, preview });
    } catch (error) {
      await staging.discard(reserved.id).catch(() => {});
      throw error;
    }
  }

  /**
   * Persist the two card lines. `auto` is the default for AI creation and
   * import; a manual create that left both fields empty passes auto=false.
   */
  async function rememberSummary(slug, { summary = '', usage = '', bodyHash = '', model = '', auto = true } = {}) {
    const manual = normalizeSummaryRecord({ summary, usage });
    if (manual.summary || manual.usage) {
      return summaries.set(slug, { ...manual, bodyHash, model: model || 'manual' });
    }
    if (!auto) return null;
    const skill = await catalog.read(slug).catch(() => null);
    if (!skill) return null;
    const generated = await tryGenerateSummary(ctx, {
      name: skill.name,
      description: skill.description,
      body: skill.text,
    });
    if (generated.degraded) return { degraded: true, warning: generated.warning };
    const record = await summaries.set(slug, {
      summary: generated.summary,
      usage: generated.usage,
      bodyHash: skill.bodyHash,
      model: generated.model,
    });
    return { ...record, degraded: false };
  }

  /** Attach the stored card copy (if any) to one skill object. */
  function withSummary(skill) {
    if (!skill) return skill;
    const record = summaries.get(skill.slug);
    return {
      ...skill,
      summary: record?.summary ?? '',
      usage: record?.usage ?? '',
      summaryUpdatedAt: record?.updatedAt ?? '',
      summaryStale: Boolean(record?.bodyHash && record.bodyHash !== skill.bodyHash),
    };
  }

  async function actionGenerateSummary(payload) {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) fail('bad_request', '缺少 Skill 标识');
    const skill = await catalog.read(slug);
    const generated = await tryGenerateSummary(ctx, {
      name: skill.name,
      description: skill.description,
      body: skill.text,
    });
    if (generated.degraded) {
      return { slug, summary: '', usage: '', degraded: true, warning: generated.warning };
    }
    const record = await summaries.set(slug, {
      summary: generated.summary,
      usage: generated.usage,
      bodyHash: skill.bodyHash,
      model: generated.model,
    });
    return { slug, ...record, degraded: false };
  }

  async function actionGenerate(payload) {
    const withScripts = payload.withScripts === true;
    const draft = await generateDraft(ctx, { prompt: payload.prompt, withScripts });
    return { draft };
  }

  async function actionGenerateName(payload) {
    const stagingId = typeof payload.stagingId === 'string' ? payload.stagingId.trim() : '';
    let body = typeof payload.body === 'string' ? payload.body : '';
    let description = cleanDisplayName(payload.description ?? '');
    let frontmatterName = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (stagingId) {
      const staged = await staging.readStaged(stagingId);
      body = staged.parsed.body;
      description = description || staged.parsed.description;
      frontmatterName = frontmatterName || staged.meta.frontmatterName || '';
    } else if (!body.trim() && frontmatterName) {
      const existing = await catalog.read(frontmatterName).catch(() => undefined);
      if (existing) {
        body = existing.body;
        description = description || existing.description;
      }
    }
    const fallback = cleanDisplayName(payload.fallback ?? '') || (frontmatterName ? humanizeSlug(frontmatterName) : '自定义技能');
    const named = await tryGenerateName(ctx, { body, description, slug: frontmatterName, fallback });
    return {
      displayName: named.displayName || fallback,
      slug: named.slug || '',
      degraded: named.degraded === true,
      ...(named.warning ? { warning: named.warning } : {}),
      ...(stagingId ? { stagingId } : {}),
    };
  }

  async function actionCreate(payload) {
    const bodyInput = typeof payload.body === 'string' ? payload.body : '';
    if (!bodyInput.trim()) fail('invalid_skill', '请填写 Skill 提示词内容');
    const parsed = parseSkillMarkdown(bodyInput);
    const description = cleanDisplayName(payload.description ?? '') || parsed.description;
    const whenToUse = cleanDisplayName(payload.whenToUse ?? '') || parsed.whenToUse;
    const draftBody = parsed.body.trim() ? parsed.body : bodyInput;
    const prepared = normalizeScriptList(payload.scripts);
    const invocation = invocationOf(payload, 'manual');
    const identity = await resolveIdentity({
      requestedName: payload.displayName,
      frontmatterName: parsed.name,
      displayNameHint: parsed.hasFrontmatter ? parsed.displayName : '',
      description,
      body: parsed.body,
      explicitSlug: payload.slug,
    });
    const skill = await catalog.create({
      slug: identity.slug,
      displayName: identity.displayName,
      description: description || defaultDescription(identity.displayName),
      whenToUse,
      body: withEnvironmentNote(draftBody, prepared.scripts),
      modelInvocable: invocation === 'auto',
    });
    if (prepared.scripts.length > 0) {
      try {
        for (const script of prepared.scripts) {
          await catalog.writeScript(identity.slug, script.name, script.content);
        }
      } catch (error) {
        await catalog.delete(identity.slug).catch(() => {});
        throw error;
      }
    }
    const stored = prepared.scripts.length > 0 ? await catalog.read(identity.slug) : skill;
    const summaryNotes = await rememberSummary(identity.slug, {
      summary: payload.summary,
      usage: payload.usage,
      bodyHash: stored.bodyHash ?? bodyDigest(stored.text),
      auto: payload.autoSummary !== false,
    }).catch(() => null);
    let mounted;
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      mounted = await mountOne(sessionIdOf(payload.sessionId), stored.slug);
    }
    return {
      skill: stored,
      naming: { degraded: identity.degraded, ...(identity.warning ? { warning: identity.warning } : {}) },
      scripts: prepared.scripts.map((script) => ({ name: script.name, bytes: script.bytes })),
      warnings: [
        ...prepared.warnings,
        ...(summaryNotes?.warning ? [summaryNotes.warning] : []),
      ],
      ...(mounted ? { mounted } : {}),
    };
  }

  async function actionCreateImported(payload) {
    const stagingId = typeof payload.stagingId === 'string' ? payload.stagingId.trim() : '';
    if (!stagingId) fail('bad_request', '缺少导入任务标识');
    const staged = await staging.readStaged(stagingId);
    const description = cleanDisplayName(payload.description ?? '') || staged.parsed.description;
    const whenToUse = cleanDisplayName(payload.whenToUse ?? '') || staged.parsed.whenToUse;
    const invocation = invocationOf(payload, staged.parsed.modelInvocable === false ? 'manual' : 'auto');
    const identity = await resolveIdentity({
      requestedName: payload.displayName,
      frontmatterName: staged.parsed.name,
      displayNameHint: staged.meta.displayName,
      description,
      body: staged.parsed.body,
      explicitSlug: payload.slug,
    });
    const skill = await catalog.createFromStaging(
      { skillDir: staged.skillDir },
      {
        slug: identity.slug,
        displayName: identity.displayName,
        description: description || defaultDescription(identity.displayName),
        whenToUse,
        body: staged.parsed.body,
        modelInvocable: invocation === 'auto',
      },
    );
    await staging.discard(stagingId).catch(() => {});
    const summaryNotes = await rememberSummary(skill.slug, {
      summary: payload.summary,
      usage: payload.usage,
      bodyHash: bodyDigest(skill.text),
      auto: payload.autoSummary !== false,
    }).catch(() => null);
    let mounted;
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      mounted = await mountOne(sessionIdOf(payload.sessionId), skill.slug);
    }
    return {
      skill,
      naming: { degraded: identity.degraded, ...(identity.warning ? { warning: identity.warning } : {}) },
      warnings: [...(staged.meta.warnings ?? []), ...(summaryNotes?.warning ? [summaryNotes.warning] : [])],
      ...(mounted ? { mounted } : {}),
    };
  }

  async function actionSetInvocation(payload) {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) fail('bad_request', '缺少 Skill 标识');
    const invocation = invocationOf(payload, '');
    if (!invocation) fail('bad_request', '缺少注入方式');
    const result = await catalog.setInvocation(slug, invocation === 'auto', { log });
    const stored = result.summary ?? (await catalog.read(slug));
    return { skill: stored, changed: result.changed, repaired: result.repaired, ...(result.backup ? { backup: result.backup } : {}) };
  }

  async function actionDiscardImport(payload) {
    const stagingId = typeof payload.stagingId === 'string' ? payload.stagingId.trim() : '';
    if (!stagingId) fail('bad_request', '缺少导入任务标识');
    await staging.discard(stagingId);
    return { discarded: stagingId };
  }

  async function actionDelete(payload) {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) fail('bad_request', '缺少 Skill 标识');
    await catalog.delete(slug);
    await summaries.remove(slug).catch(() => {});
    const unmountedSessions = await store.removeSkill(slug);
    return { slug, unmountedSessions };
  }

  async function actionContent(payload) {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) fail('bad_request', '缺少 Skill 标识');
    const skill = await catalog.read(slug);
    return { skill: withSummary(skill) };
  }

  /**
   * Where is one Skill mounted? Returns every mounting session together with
   * its Workspace label and log-backed title (cold sessions included).
   */
  async function actionMountInfo(payload) {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) fail('bad_request', '缺少 Skill 标识');
    const { bySlug } = await listSnapshot();
    const skill = bySlug.get(slug);
    if (!skill) fail('not_found', `Skill 不存在：${slug}`);
    const mounts = await store.sessionsWithSkill(slug);
    const updatedAt = new Map(mounts.map((mount) => [mount.sessionId, mount.updatedAt]));
    const sessions = await describeSkillMounts(ctx, { sessionIds: mounts.map((mount) => mount.sessionId) });
    return {
      skill: { ...skill, mountedSessions: sessions.length },
      sessions: sessions.map((entry) => ({ ...entry, mountedAt: updatedAt.get(entry.sessionId) || '' })),
    };
  }

  async function actionMounts(payload) {
    const sessionId = sessionIdOf(payload.sessionId);
    const add = slugListOf(payload.add);
    const remove = slugListOf(payload.remove);
    const { bySlug } = await listSnapshot();
    for (const slug of add) if (!bySlug.has(slug)) fail('not_found', `Skill 不存在：${slug}`);
    const current = await store.get(sessionId);
    const next = [...new Set([...current, ...add])].filter((slug) => !remove.includes(slug));
    const mounted = await store.set(sessionId, next);
    return {
      sessionId,
      mounted,
      skills: mounted.map((slug) => ({ ...bySlug.get(slug), mounted: true })),
    };
  }

  const ACTIONS = new Map([
    ['generate', actionGenerate],
    ['generate-name', actionGenerateName],
    ['create', actionCreate],
    ['create-imported', actionCreateImported],
    ['discard-import', actionDiscardImport],
    ['delete', actionDelete],
    ['content', actionContent],
    ['mounts', actionMounts],
    ['mount-info', actionMountInfo],
    ['set-invocation', actionSetInvocation],
    ['generate-summary', actionGenerateSummary],
  ]);

  async function handleAction(request, response) {
    if (!requireMethod(request, response, 'POST')) return;
    const payload = await readJsonBody(request, JSON_BODY_LIMIT);
    const action = typeof payload?.action === 'string' ? payload.action : '';
    const handler = ACTIONS.get(action);
    if (!handler) fail('bad_request', `未知操作：${action || '(空)'}`);
    const result = await handler(payload ?? {});
    send(response, 200, { ok: true, action, ...result });
  }

  const wrap = (handler) => async (request, response) => {
    try {
      if (!sameOrigin(request)) {
        send(response, 403, { ok: false, error: { code: 'bad_request', message: '请求来源不受信任' } });
        return;
      }
      await handler(request, response);
    } catch (error) {
      log(`${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`);
      sendError(response, error);
    }
  };

  const routes = new Map([
    ['/dsh-skill-manager/state', wrap(handleState)],
    ['/dsh-skill-manager/session', wrap(handleSession)],
    ['/dsh-skill-manager/import', wrap(handleImport)],
    ['/dsh-skill-manager/action', wrap(handleAction)],
  ]);

  return { layout, store, staging, summaries, catalog, routes, resolveIdentity };
}

export const inject = ['webServer'];

export function apply(ctx) {
  const service = createService(ctx);
  ctx.effect(
    () => {
      void service.store.load().catch((error) => ctx.logger?.warn?.(`[dsh-skill-manager] state load failed: ${error?.message ?? error}`));
      void service.staging.prune().catch((error) => ctx.logger?.warn?.(`[dsh-skill-manager] staging prune failed: ${error?.message ?? error}`));
      void service.summaries.load().catch((error) => ctx.logger?.warn?.(`[dsh-skill-manager] summary load failed: ${error?.message ?? error}`));
    },
    'dsh-skill-manager: warm stores',
  );
  for (const [routePath, handler] of service.routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: routePath, handler }),
      `dsh-skill-manager: route ${routePath}`,
    );
  }
}
