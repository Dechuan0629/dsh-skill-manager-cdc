/**
 * Resolve *where* one Skill is mounted: which workspaces and which sessions.
 *
 * The mount store only knows session ids. Two read-only Host services turn those
 * into labels without resuming an Agent:
 *
 * - `workspaceRegistry.list()` gives each Workspace's title/path and its
 *   `sessionIds`, so a session id maps to its owning workspace.
 * - `sessionQuery.readTitleSnapshots()` folds the log-backed title of cold
 *   sessions; live sessions fall back to `sessionTitle.get()` when the query
 *   service is unavailable.
 *
 * Both lookups are best-effort: an older/newer Harness without one of the
 * services still yields a usable list with blank labels.
 */

const MAX_LOOKUP = 200;

/** Session ids are strings at runtime; accept only non-empty, de-duplicated ids. */
export function normalizeSessionIds(sessionIds) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(sessionIds) ? sessionIds : []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_LOOKUP) break;
  }
  return ids;
}

function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Index each Session id by the Workspace that owns it. */
function indexWorkspaces(ctx) {
  const bySession = new Map();
  const registry = service(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') return bySession;
  let list;
  try {
    list = registry.list();
  } catch {
    return bySession;
  }
  for (const workspace of Array.isArray(list) ? list : []) {
    if (!workspace || typeof workspace !== 'object') continue;
    const meta = {
      workspaceId: String(workspace.id ?? ''),
      workspaceTitle: String(workspace.title ?? ''),
      workspacePath: String(workspace.path ?? ''),
    };
    if (!meta.workspaceId && !meta.workspaceTitle) continue;
    for (const raw of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      const sessionId = String(raw ?? '');
      if (sessionId && !bySession.has(sessionId)) bySession.set(sessionId, meta);
    }
  }
  return bySession;
}

/** Fold titles for cold sessions; fall back to the live title service. */
async function readTitles(ctx, ids, signal) {
  const titles = new Map();
  const query = service(ctx, 'sessionQuery');
  if (query && typeof query.readTitleSnapshots === 'function') {
    try {
      const results = await query.readTitleSnapshots(ids, signal);
      for (const item of Array.isArray(results) ? results : []) {
        if (item?.status !== 'fulfilled') continue;
        const sessionId = String(item.sessionId ?? '');
        const title = item.value?.title?.title;
        if (sessionId && typeof title === 'string' && title.trim()) titles.set(sessionId, title.trim());
      }
      return titles;
    } catch {
      /* fall through to the live services */
    }
  }
  const sessions = service(ctx, 'sessions');
  const sessionTitle = service(ctx, 'sessionTitle');
  if (!sessions || typeof sessions.get !== 'function' || !sessionTitle || typeof sessionTitle.get !== 'function') return titles;
  for (const id of ids) {
    try {
      const session = sessions.get(id);
      if (!session) continue;
      const snapshot = sessionTitle.get(session);
      if (snapshot && typeof snapshot.title === 'string' && snapshot.title.trim()) titles.set(id, snapshot.title.trim());
    } catch {
      /* a single unreadable title must not fail the whole list */
    }
  }
  return titles;
}

/**
 * Describe every mounted session of one Skill.
 *
 * @param {object} ctx Cordis Host context.
 * @param {{ sessionIds?: readonly string[], signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{sessionId:string, title:string, workspaceId:string,
 *   workspaceTitle:string, workspacePath:string}>>}
 */
export async function describeSkillMounts(ctx, { sessionIds = [], signal } = {}) {
  const ids = normalizeSessionIds(sessionIds);
  const bySession = indexWorkspaces(ctx);
  const titles = await readTitles(ctx, ids, signal);
  return ids.map((sessionId) => {
    const workspace = bySession.get(sessionId);
    return {
      sessionId,
      title: titles.get(sessionId) ?? '',
      workspaceId: workspace?.workspaceId ?? '',
      workspaceTitle: workspace?.workspaceTitle ?? '',
      workspacePath: workspace?.workspacePath ?? '',
    };
  });
}
