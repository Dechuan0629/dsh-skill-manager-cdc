import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeSkillMounts, normalizeSessionIds } from '../lib/mount-info.js';

function contextWith(services = {}) {
  return { get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined) };
}

const WORKSPACES = [
  { id: 'ws-1', title: 'dsh-dev', path: '/Users/me/dsh-dev', sessionIds: ['session-a', 'session-b'] },
  { id: 'ws-2', title: 'docs', path: '/Users/me/docs', sessionIds: ['session-c'] },
];

test('normalizeSessionIds keeps order, drops blanks and duplicates', () => {
  assert.deepEqual(normalizeSessionIds(['s2', 's1', 's2', '', '  ', 42, null]), ['s2', 's1']);
  assert.deepEqual(normalizeSessionIds('not-an-array'), []);
});

test('describeSkillMounts joins workspace labels and log-backed titles', async () => {
  const ctx = contextWith({
    workspaceRegistry: { list: () => WORKSPACES },
    sessionQuery: {
      readTitleSnapshots: async (ids) =>
        ids.map((sessionId) =>
          sessionId === 'session-b'
            ? { sessionId, status: 'rejected', reason: new Error('unreadable') }
            : { sessionId, status: 'fulfilled', value: { title: { title: sessionId === 'session-unknown' ? '' : `标题 ${sessionId}` } } },
        ),
    },
  });
  const sessions = await describeSkillMounts(ctx, {
    sessionIds: ['session-a', 'session-b', 'session-unknown', 'session-a'],
  });
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ['session-a', 'session-b', 'session-unknown']);
  assert.equal(sessions[0].workspaceTitle, 'dsh-dev');
  assert.equal(sessions[0].workspacePath, '/Users/me/dsh-dev');
  assert.equal(sessions[0].title, '标题 session-a');
  assert.equal(sessions[1].workspaceTitle, 'dsh-dev');
  assert.equal(sessions[1].title, '');
  assert.equal(sessions[2].workspaceId, '');
  assert.equal(sessions[2].workspaceTitle, '');
  assert.equal(sessions[2].title, '');
});

test('missing registry and query services yield blank labels instead of failing', async () => {
  const sessions = await describeSkillMounts(contextWith(), { sessionIds: ['session-a'] });
  assert.deepEqual(sessions, [
    { sessionId: 'session-a', title: '', workspaceId: '', workspaceTitle: '', workspacePath: '' },
  ]);
});

test('a throwing workspace registry does not fail the lookup', async () => {
  const ctx = contextWith({
    workspaceRegistry: {
      list() {
        throw new Error('registry unavailable');
      },
    },
  });
  const sessions = await describeSkillMounts(ctx, { sessionIds: ['session-a'] });
  assert.equal(sessions[0].workspaceTitle, '');
});

test('live sessions fall back to sessionTitle when sessionQuery is absent', async () => {
  const live = { id: 'session-a' };
  const ctx = contextWith({
    sessions: { get: (id) => (id === 'session-a' ? live : undefined) },
    sessionTitle: { get: (session) => ({ title: session === live ? '实时标题' : '' }) },
  });
  const sessions = await describeSkillMounts(ctx, { sessionIds: ['session-a', 'session-b'] });
  assert.equal(sessions[0].title, '实时标题');
  assert.equal(sessions[1].title, '');
});
