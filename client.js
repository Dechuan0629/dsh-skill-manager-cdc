/**
 * Web client half of the custom skill manager.
 *
 * Five UI surfaces:
 *   sidebar.panellist              – "SKILLS 管理" icon → the manager panel
 *   main                           – the panel: list, AI/hand-written create, archive import
 *   sidebar.workspaces.session.menu.item – "自定义 Skills" in a session's menu
 *   shell.overlay                  – the session-mount dialog and the /mySkills picker
 *   conversation.input.overlay     – watches the composer draft for "/mySkills"
 *   inputTriggers "/" source       – custom skills in the composer's slash autocomplete
 *
 * The client never computes skill names or touches files: it talks to the host
 * routes under /dsh-skill-manager and renders whatever they return.
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    /* Shipped menu primitives: SessionSkillsMenuItem must be a real menu row or it
       misses the icon column and the label inset every other menu row uses. */
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-skill-manager] menu primitives unavailable, falling back to a plain row', error);
    }
    const MenuItemButton = primitives?.MenuItemButton;

    const API = '/dsh-skill-manager';
    const PANEL_ID = 'skill-manager';
    const STYLE_ID = 'dsh-skill-manager-styles';
    const EMPTY_DRAFT = { displayName: '', slug: '', description: '', whenToUse: '', body: '' };

    // ---------------------------------------------------------------- styles

    const CSS = `
.smx{--smx-radius:12px;}
.smx,.smx *{box-sizing:border-box;}
.smx-spacer{flex:1;}
.smx-muted{color:var(--dsw-alias-label-tertiary,#8a8a8a);}
.smx-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);}
.smx-header{display:flex;align-items:center;gap:8px;padding:14px 18px 8px;}
.smx-title{font-size:16px;font-weight:600;letter-spacing:.01em;}
.smx-sub{display:flex;align-items:center;gap:10px;padding:0 18px 10px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;flex-wrap:wrap;}
.smx-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));font-size:12px;color:var(--dsw-alias-label-secondary,#555);}
.smx-chip-bad{color:var(--dsw-alias-state-error-primary,#b42318);}
.smx-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;}
.smx-scroll{flex:1;min-height:0;overflow:auto;padding:4px 18px 18px;}
.smx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap;}
.smx-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
.smx-btn:disabled{opacity:.5;cursor:not-allowed;}
.smx-btn-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;}
.smx-btn-primary:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.07);}
.smx-btn-ghost{border-color:transparent;background:transparent;}
.smx-btn-danger{color:var(--dsw-alias-state-error-primary,#b42318);}
.smx-btn-sm{height:26px;padding:0 9px;font-size:12px;}
.smx-link{border:0;background:none;padding:0;color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;font:inherit;font-size:12px;}
.smx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;}
.smx-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--smx-radius);padding:12px 14px;display:flex;flex-direction:column;gap:7px;background:var(--dsw-alias-bg-base,#fff);}
.smx-card-head{display:flex;align-items:center;gap:8px;min-width:0;}
.smx-card-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.smx-code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.smx-card-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary,#555);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:34px;line-height:1.45;}
.smx-card-foot{display:flex;align-items:center;gap:6px;margin-top:auto;}
.smx-form{max-width:780px;display:flex;flex-direction:column;gap:12px;padding-top:4px;}
.smx-tabs{display:flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:9px;align-self:flex-start;margin-bottom:2px;}
.smx-tab{height:28px;padding:0 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:13px;cursor:pointer;}
.smx-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,#f2f3f5);color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;}
.smx-field{display:flex;flex-direction:column;gap:5px;}
.smx-label{font-size:12.5px;color:var(--dsw-alias-label-secondary,#555);font-weight:500;}
.smx-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.5;}
.smx-input,.smx-textarea{width:100%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:13px;padding:8px 10px;outline:none;}
.smx-input:focus,.smx-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.smx-textarea{resize:vertical;min-height:82px;line-height:1.55;}
.smx-textarea-code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;min-height:220px;}
.smx-actions{display:flex;align-items:center;gap:8px;padding-top:2px;}
.smx-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border-radius:9px;font-size:12.5px;line-height:1.5;border:1px solid transparent;}
.smx-banner-error{background:rgba(217,45,32,.07);border-color:rgba(217,45,32,.24);color:var(--dsw-alias-state-error-primary,#b42318);}
.smx-banner-warn{background:rgba(247,144,9,.08);border-color:rgba(247,144,9,.3);color:#8a5300;}
.smx-banner-info{background:var(--dsw-alias-bg-layer-1,#f5f6f8);color:var(--dsw-alias-label-secondary,#555);}
.smx-dropzone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:26px 16px;border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.2));border-radius:12px;cursor:pointer;color:var(--dsw-alias-label-secondary,#555);font-size:13px;text-align:center;}
.smx-dropzone:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));}
.smx-dropzone input{display:none;}
.smx-preview{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;}
.smx-kv{display:grid;grid-template-columns:86px 1fr;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#555);}
.smx-kv dt{color:var(--dsw-alias-label-tertiary,#8a8a8a);}
.smx-kv dd{margin:0;word-break:break-all;}
.smx-pre{margin:0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f6f7f9);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;}
.smx-scripts{display:flex;flex-direction:column;gap:3px;font-size:12px;}
.smx-script{display:flex;gap:10px;justify-content:space-between;color:var(--dsw-alias-label-secondary,#555);}
.smx-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:13px;text-align:center;line-height:1.6;}
.smx-toast{padding:6px 12px;border-radius:999px;background:rgba(17,24,39,.88);color:#fff;font-size:12px;align-self:center;margin:6px 0 10px;}
.smx-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);pointer-events:auto;}
.smx-dialog{width:min(560px,100%);max-height:min(78vh,760px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.24);overflow:hidden;}
.smx-dialog-head{display:flex;align-items:center;gap:8px;padding:14px 16px 8px;}
.smx-dialog-title{font-size:15px;font-weight:600;}
.smx-dialog-body{flex:1;min-height:0;overflow:auto;padding:2px 16px 12px;}
.smx-dialog-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));}
.smx-rows{display:flex;flex-direction:column;gap:6px;}
.smx-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:9px;cursor:pointer;background:transparent;}
.smx-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));}
.smx-row input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.smx-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;}
.smx-row-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}
.smx-row-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.45;}
.smx-badge{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#eef0f3);color:var(--dsw-alias-label-secondary,#555);font-weight:500;}
.smx-badge-ok{background:rgba(18,128,92,.1);color:var(--dsw-alias-state-success-primary,#12805c);}
.smx-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer;}
.smx-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));}
.smx-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;flex:none;}
.smx-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(0,0,0,.15);border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:smx-spin .8s linear infinite;display:inline-block;}
@keyframes smx-spin{to{transform:rotate(360deg);}}
.smx-sidebar-icon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;}
`;

    function installStyles() {
      try {
        if (typeof document === 'undefined') return;
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        if (style.textContent !== CSS) style.textContent = CSS;
      } catch (error) {
        console.warn('[dsh-skill-manager] could not install styles', error);
      }
    }

    // ---------------------------------------------------------------- helpers

    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return String(error ?? '');
    }

    function shortId(sessionId) {
      const text = String(sessionId ?? '');
      return text.length > 12 ? `${text.slice(0, 8)}…` : text;
    }

    async function readJson(response) {
      const text = await response.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    }

    async function apiGet(pathname) {
      const response = await fetch(`${API}${pathname}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await readJson(response);
      if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
      return data;
    }

    async function apiPost(pathname, payload) {
      const response = await fetch(`${API}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await readJson(response);
      if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
      return data;
    }

    async function apiUpload(file) {
      const buffer = await file.arrayBuffer();
      const response = await fetch(`${API}/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          accept: 'application/json',
          'x-skill-manager-filename': encodeURIComponent(file.name || 'skill.zip'),
        },
        credentials: 'same-origin',
        body: buffer,
      });
      const data = await readJson(response);
      if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || `上传失败（HTTP ${response.status}）`);
      return data;
    }

    function formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${bytes} B`;
    }

    // ---------------------------------------------------------------- store

    const store = {
      revision: 0,
      state: { status: 'idle', data: null, error: null },
      sessions: new Map(),
      dialog: null,
      sessionDialog: { status: 'idle', skills: [], mounted: [], selected: new Set(), error: null, dirty: false },
      mySkillsPicker: { status: 'idle', skills: [], mounted: [], selected: new Set(), error: null, dirty: false },
      composerActions: new Map(),
      composerActionsLive: new Map(),
      listeners: new Set(),
    };

    let statePromise = null;
    let layoutService = null;

    function notify() {
      store.revision += 1;
      for (const listener of [...store.listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[dsh-skill-manager] store listener failed', error);
        }
      }
    }

    function subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    }

    function useRevision() {
      return useSyncExternalStore(subscribe, () => store.revision, () => store.revision);
    }

    function ensureState() {
      if (store.state.status === 'ready') return Promise.resolve(store.state.data);
      if (statePromise) return statePromise;
      store.state = { ...store.state, status: 'loading', error: null };
      notify();
      statePromise = apiGet('/state')
        .then((data) => {
          store.state = { status: 'ready', data, error: null };
          notify();
          return data;
        })
        .catch((error) => {
          store.state = { status: 'error', data: store.state.data, error: messageOf(error) };
          notify();
          throw error;
        })
        .finally(() => {
          statePromise = null;
        });
      return statePromise;
    }

    function refreshState() {
      store.state = { ...store.state, status: 'idle', error: null };
      return ensureState();
    }

    function fetchSession(sessionId) {
      return apiGet(`/session?sessionId=${encodeURIComponent(sessionId)}`);
    }

    function closeDialog() {
      store.dialog = null;
      notify();
    }

    function openPanel() {
      try {
        if (layoutService && typeof layoutService.selectPanel === 'function') {
          layoutService.selectPanel(PANEL_ID);
          return true;
        }
      } catch (error) {
        console.warn('[dsh-skill-manager] could not open the panel', error);
      }
      return false;
    }

    function applyDraft(dialog, text) {
      const actions = dialog?.inputActions;
      try {
        if (actions && typeof actions.setDraft === 'function') actions.setDraft(text);
        if (actions && typeof actions.persistDraft === 'function') actions.persistDraft();
      } catch (error) {
        console.warn('[dsh-skill-manager] could not update the composer draft', error);
      }
    }

    async function openSessionDialog(sessionId, title) {
      store.dialog = { kind: 'session', sessionId, title: title || '' };
      store.sessionDialog = {
        status: 'loading',
        skills: store.state.data?.skills ?? [],
        mounted: [],
        selected: new Set(),
        error: null,
      };
      notify();
      try {
        const [stateData, sessionData] = await Promise.all([ensureState().catch(() => null), fetchSession(sessionId)]);
        if (store.dialog?.kind !== 'session' || store.dialog.sessionId !== sessionId) return;
        store.sessions.set(sessionId, { status: 'ready', data: sessionData });
        const skills = stateData?.skills ?? store.state.data?.skills ?? [];
        const mounted = Array.isArray(sessionData.mounted) ? sessionData.mounted : [];
        store.sessionDialog = { status: 'ready', skills, mounted, selected: new Set(mounted), error: null, dirty: false };
      } catch (error) {
        if (store.dialog?.kind !== 'session' || store.dialog.sessionId !== sessionId) return;
        store.sessionDialog = { status: 'error', skills: [], mounted: [], selected: new Set(), error: messageOf(error), dirty: false };
      }
      notify();
    }

    /**
     * Per-session handle that forwards draft writes to the currently mounted
     * composer. The command menu does not receive the session input actions, so
     * the command path acquires this handle instead of a snapshot object.
     */
    function composerActionsFor(sessionId) {
      if (!sessionId) return null;
      let cached = store.composerActions.get(sessionId);
      if (!cached) {
        const live = () => store.composerActionsLive.get(sessionId) || null;
        cached = {
          setDraft(text) {
            const actions = live();
            if (actions && typeof actions.setDraft === 'function') actions.setDraft(text);
          },
          persistDraft() {
            const actions = live();
            if (actions && typeof actions.persistDraft === 'function') actions.persistDraft();
          },
        };
        store.composerActions.set(sessionId, cached);
      }
      return cached;
    }

    async function openMySkillsDialog({ sessionId, baseDraft, inputActions, source = 'draft' }) {
      store.dialog = { kind: 'my-skills', sessionId, baseDraft: baseDraft || '', inputActions, source };
      store.mySkillsPicker = { status: 'loading', skills: [], mounted: [], selected: new Set(), error: null, dirty: false };
      notify();
      if (!sessionId) {
        store.mySkillsPicker = { status: 'error', skills: [], mounted: [], selected: new Set(), error: '无法识别当前会话' };
        notify();
        return;
      }
      try {
        const sessionData = await fetchSession(sessionId);
        if (store.dialog?.kind !== 'my-skills') return;
        store.sessions.set(sessionId, { status: 'ready', data: sessionData });
        const mounted = Array.isArray(sessionData.mounted) ? sessionData.mounted : [];
        const skills = Array.isArray(sessionData.skills) ? sessionData.skills : [];
        store.mySkillsPicker = { status: 'ready', skills, mounted, selected: new Set(mounted), error: null, dirty: false };
      } catch (error) {
        if (store.dialog?.kind !== 'my-skills') return;
        store.mySkillsPicker = { status: 'error', skills: [], mounted: [], selected: new Set(), error: messageOf(error) };
      }
      notify();
    }

    // ---------------------------------------------------------------- icons

    function SkillIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block', flex: 'none' } },
        h('path', {
          d: 'M12 2.8 14.2 9l6.2 2.2-6.2 2.2L12 19.6l-2.2-6.2L3.6 11.2 9.8 9 12 2.8Z',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 19, cy: 5, r: 1.5, fill: 'currentColor' }),
      );
    }

    // ---------------------------------------------------------------- panel

    function SkillManagerPanel() {
      useRevision();
      const [view, setView] = useState('list');
      const [mode, setMode] = useState('ai');
      const [aiPrompt, setAiPrompt] = useState('');
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      const [generating, setGenerating] = useState(false);
      const [creating, setCreating] = useState(false);
      const [formError, setFormError] = useState('');
      const [uploading, setUploading] = useState(false);
      const [preview, setPreview] = useState(null);
      const [importName, setImportName] = useState('');
      const [importError, setImportError] = useState('');
      const [importing, setImporting] = useState(false);
      const [detail, setDetail] = useState({ status: 'idle', skill: null, error: '' });
      const [toast, setToast] = useState('');
      const fileRef = useRef(null);

      useEffect(() => {
        void ensureState().catch(() => {});
      }, []);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(''), 3600);
        return () => clearTimeout(timer);
      }, [toast]);

      const data = store.state.data;
      const skills = Array.isArray(data?.skills) ? data.skills : [];

      const resetCreate = useCallback(() => {
        setMode('ai');
        setAiPrompt('');
        setDraft(EMPTY_DRAFT);
        setFormError('');
      }, []);

      function openCreate() {
        resetCreate();
        setView('create');
      }

      function patchDraft(patch) {
        setDraft((current) => ({ ...current, ...patch }));
      }

      async function runGenerate() {
        const prompt = aiPrompt.trim();
        if (!prompt) {
          setFormError('请先用一句话描述这个 Skill 要做什么');
          return;
        }
        setFormError('');
        setGenerating(true);
        try {
          const result = await apiPost('/action', { action: 'generate', prompt });
          const next = result.draft || {};
          setDraft({
            displayName: next.displayName || '',
            slug: next.slug || '',
            description: next.description || '',
            whenToUse: next.whenToUse || '',
            body: next.body || '',
          });
          setMode('manual');
          setToast('AI 草稿已生成，确认或修改后点击创建');
        } catch (error) {
          setFormError(messageOf(error));
        } finally {
          setGenerating(false);
        }
      }

      async function submitCreate() {
        if (!draft.body.trim()) {
          setFormError('请填写 SKILL.md 的提示词内容');
          return;
        }
        setFormError('');
        setCreating(true);
        try {
          const result = await apiPost('/action', {
            action: 'create',
            source: mode,
            displayName: draft.displayName.trim() || undefined,
            slug: draft.slug.trim() || undefined,
            description: draft.description.trim() || undefined,
            whenToUse: draft.whenToUse.trim() || undefined,
            body: draft.body,
            prompt: mode === 'ai' ? aiPrompt.trim() || undefined : undefined,
          });
          await refreshState().catch(() => {});
          setToast(`已创建「${result.skill?.displayName || draft.displayName || 'Skill'}」`);
          resetCreate();
          setView('list');
        } catch (error) {
          setFormError(messageOf(error));
        } finally {
          setCreating(false);
        }
      }

      async function uploadFile(file) {
        if (!file) return;
        const limit = Number(data?.limits?.archiveBytes || 0);
        if (limit && file.size > limit) {
          setImportError(`压缩包超过 ${formatBytes(limit)} 上限（当前 ${formatBytes(file.size)}）`);
          return;
        }
        setImportError('');
        setPreview(null);
        setUploading(true);
        try {
          const result = await apiUpload(file);
          setPreview(result.preview || null);
          setImportName('');
        } catch (error) {
          setImportError(messageOf(error));
        } finally {
          setUploading(false);
        }
      }

      async function confirmImport() {
        if (!preview) return;
        setImportError('');
        setImporting(true);
        try {
          const result = await apiPost('/action', {
            action: 'create-imported',
            stagingId: preview.stagingId,
            displayName: importName.trim() || undefined,
          });
          await refreshState().catch(() => {});
          setToast(`已导入「${result.skill?.displayName || 'Skill'}」`);
          setPreview(null);
          setImportName('');
          setView('list');
        } catch (error) {
          setImportError(messageOf(error));
        } finally {
          setImporting(false);
        }
      }

      async function discardImport() {
        if (!preview) {
          setView('list');
          return;
        }
        try {
          await apiPost('/action', { action: 'discard-import', stagingId: preview.stagingId });
        } catch {
          /* best effort */
        }
        setPreview(null);
        setImportName('');
        setView('list');
      }

      async function openDetail(skill) {
        setView('detail');
        setDetail({ status: 'loading', skill: null, error: '' });
        try {
          const result = await apiPost('/action', { action: 'content', slug: skill.slug });
          setDetail({ status: 'ready', skill: result.skill || null, error: '' });
        } catch (error) {
          setDetail({ status: 'error', skill: null, error: messageOf(error) });
        }
      }

      async function deleteSkill(skill) {
        const confirmed = window.confirm(`删除「${skill.displayName}」？\n所有已挂载该 Skill 的会话会同步移除，此操作不可撤销。`);
        if (!confirmed) return;
        try {
          const result = await apiPost('/action', { action: 'delete', slug: skill.slug });
          await refreshState().catch(() => {});
          setToast(result.unmountedSessions ? `已删除「${skill.displayName}」，并从 ${result.unmountedSessions} 个会话移除` : `已删除「${skill.displayName}」`);
          if (view === 'detail') setView('list');
        } catch (error) {
          setToast(`删除失败：${messageOf(error)}`);
        }
      }

      async function copyCommand(skill) {
        try {
          await navigator.clipboard.writeText(`/${skill.slug}`);
          setToast(`已复制 /${skill.slug}`);
        } catch {
          setToast(`/${skill.slug}`);
        }
      }

      function renderList() {
        const stateError = store.state.status === 'error' ? store.state.error : '';
        const invalid = Array.isArray(data?.invalid) ? data.invalid : [];
        const sections = [];

        if (stateError) {
          sections.push(
            h(
              'div',
              { key: 'error', className: 'smx-banner smx-banner-error' },
              h('span', null, `读取失败：${stateError}`),
              h('button', { type: 'button', className: 'smx-link', onClick: () => { void refreshState().catch(() => {}); } }, '重试'),
            ),
          );
        }
        if (invalid.length) {
          sections.push(
            h(
              'div',
              { key: 'invalid', className: 'smx-banner smx-banner-warn' },
              h('div', null, h('strong', null, `${invalid.length} 个目录不符合 DSH Skill 规范，已被忽略：`), h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } }, invalid.slice(0, 5).map((item) => h('li', { key: item.slug }, `${item.slug}：${item.message}`)))),
            ),
          );
        }

        if (!data && store.state.status === 'loading') {
          sections.push(h('div', { key: 'loading', className: 'smx-empty' }, h('span', { className: 'smx-spin' }), '正在读取 Skill 目录…'));
        } else if (!skills.length) {
          sections.push(
            h(
              'div',
              { key: 'empty', className: 'smx-empty' },
              h(SkillIcon, { size: 28 }),
              h('div', null, '还没有自定义 Skill'),
              h('div', { className: 'smx-hint' }, '用一句话让 AI 生成，或导入一个包含 skill.md 与 scripts/ 的压缩包。'),
              h('div', { className: 'smx-actions' },
                h('button', { type: 'button', className: 'smx-btn smx-btn-sm', onClick: openCreate }, '新建 Skill'),
                h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-primary', onClick: () => { setImportError(''); setView('import'); } }, '导入压缩包')),
            ),
          );
        } else {
          sections.push(
            h('div', { key: 'grid', className: 'smx-grid' },
              skills.map((skill) =>
                h(SkillCard, {
                  key: skill.slug,
                  skill,
                  onDetail: (value) => void openDetail(value),
                  onDelete: (value) => void deleteSkill(value),
                  onCopy: (value) => void copyCommand(value),
                }),
              ),
            ),
          );
        }

        return h('div', { className: 'smx-scroll' }, sections);
      }

      function renderCreate() {
        const modelAvailable = data?.model?.available === true;
        const modelReason = data?.model?.reason || '';
        const tabs = h('div', { className: 'smx-tabs', role: 'tablist' },
          h('button', { type: 'button', role: 'tab', className: 'smx-tab', 'aria-selected': mode === 'ai' ? 'true' : 'false', onClick: () => setMode('ai') }, '一句话创建（AI）'),
          h('button', { type: 'button', role: 'tab', className: 'smx-tab', 'aria-selected': mode === 'manual' ? 'true' : 'false', onClick: () => setMode('manual') }, '手写提示词'),
        );

        const aiBlock = mode === 'ai'
          ? h('div', { className: 'smx-field' },
              h('span', { className: 'smx-label' }, '用一句话描述这个 Skill 要做什么'),
              h('textarea', {
                className: 'smx-textarea',
                rows: 3,
                value: aiPrompt,
                placeholder: '例如：把 Markdown 表格转换成 Excel，并建议列宽',
                onChange: (event) => setAiPrompt(event.target.value),
              }),
              h('div', { className: 'smx-actions' },
                h('button', { type: 'button', className: 'smx-btn smx-btn-primary', disabled: generating || !modelAvailable, onClick: () => void runGenerate() }, generating ? '生成中…' : 'AI 生成草稿'),
                !modelAvailable ? h('span', { className: 'smx-hint' }, `默认模型不可用：${modelReason || '未配置'}`) : null),
            )
          : null;

        const fields = mode === 'manual'
          ? [
              h('div', { key: 'name', className: 'smx-field' },
                h('span', { className: 'smx-label' }, '名称（可选）'),
                h('input', { className: 'smx-input', value: draft.displayName, placeholder: '留空则由 AI 自动命名（3-6 个字）', onChange: (event) => patchDraft({ displayName: event.target.value }) })),
              h('div', { key: 'slug', className: 'smx-field' },
                h('span', { className: 'smx-label' }, '标识（可选）'),
                h('input', { className: 'smx-input', value: draft.slug, placeholder: '默认由名称生成，以小写 -skill 结尾', onChange: (event) => patchDraft({ slug: event.target.value }) })),
              h('div', { key: 'desc', className: 'smx-field' },
                h('span', { className: 'smx-label' }, '描述（可选）'),
                h('input', { className: 'smx-input', value: draft.description, placeholder: '一句话说明它解决什么问题', onChange: (event) => patchDraft({ description: event.target.value }) })),
              h('div', { key: 'when', className: 'smx-field' },
                h('span', { className: 'smx-label' }, '适用场景（可选）'),
                h('input', { className: 'smx-input', value: draft.whenToUse, placeholder: '例如：需要在 Excel 里整理表格时', onChange: (event) => patchDraft({ whenToUse: event.target.value }) })),
              h('div', { key: 'body', className: 'smx-field' },
                h('span', { className: 'smx-label' }, 'SKILL.md 提示词正文'),
                h('textarea', { className: 'smx-textarea smx-textarea-code', value: draft.body, placeholder: '写清步骤、约束与可调用的 scripts/ 脚本用法…', onChange: (event) => patchDraft({ body: event.target.value }) }),
                h('span', { className: 'smx-hint' }, '保存时会自动写入 name / description / displayName frontmatter；正文中也可以自带 frontmatter。')),
            ]
          : null;

        return h('div', { className: 'smx-scroll' },
          h('div', { className: 'smx-form' },
            tabs,
            aiBlock,
            fields,
            formError ? h('div', { className: 'smx-banner smx-banner-error' }, formError) : null,
            h('div', { className: 'smx-actions' },
              h('button', { type: 'button', className: 'smx-btn smx-btn-primary', disabled: creating || (mode === 'manual' && !draft.body.trim()), onClick: () => void submitCreate() }, creating ? '创建中…' : '创建 Skill'),
              h('button', { type: 'button', className: 'smx-btn', onClick: () => { resetCreate(); setView('list'); } }, '取消'))));
      }

      function renderImport() {
        const limits = data?.limits || {};
        const previewCard = preview
          ? h('div', { className: 'smx-preview', 'data-smx': 'import-preview' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h(SkillIcon, { size: 16 }),
                h('strong', { style: { fontSize: '14px' } }, preview.displayName || preview.name || '未命名 Skill'),
                preview.hasFrontmatter ? null : h('span', { className: 'smx-badge' }, '无 frontmatter')),
              h('dl', { className: 'smx-kv' },
                h('dt', null, '来源'),
                h('dd', null, preview.originalName || '压缩包'),
                h('dt', null, '目录名'),
                h('dd', null, preview.name || '（未声明）'),
                h('dt', null, '文件'),
                h('dd', null, `${preview.files || 0} 个，共 ${formatBytes(preview.bytes)}`),
                preview.description ? h('dt', null, '描述') : null,
                preview.description ? h('dd', null, preview.description) : null),
              Array.isArray(preview.scripts) && preview.scripts.length
                ? h('div', { className: 'smx-field' },
                    h('span', { className: 'smx-label' }, `scripts/ 内的脚本（${preview.scripts.length}）`),
                    h('div', { className: 'smx-scripts' }, preview.scripts.slice(0, 12).map((script) => h('div', { key: script.path, className: 'smx-script' }, h('span', null, script.path), h('span', null, formatBytes(script.size))))))
                : h('div', { className: 'smx-hint' }, '未包含 scripts/ 脚本，创建时会自动生成空目录。'),
              preview.bodyExcerpt ? h('div', { className: 'smx-field' }, h('span', { className: 'smx-label' }, 'SKILL.md 片段'), h('pre', { className: 'smx-pre' }, preview.bodyExcerpt)) : null,
              Array.isArray(preview.warnings) && preview.warnings.length
                ? h('div', { className: 'smx-banner smx-banner-warn' }, h('ul', { style: { margin: 0, paddingLeft: '18px' } }, preview.warnings.map((warning, index) => h('li', { key: index }, warning))))
                : null,
              h('div', { className: 'smx-field' },
                h('span', { className: 'smx-label' }, '名称（可选）'),
                h('input', { className: 'smx-input', value: importName, placeholder: '留空则由 AI 阅读 SKILL.md 后自动命名（3-6 个字）', onChange: (event) => setImportName(event.target.value) })),
              importError ? h('div', { className: 'smx-banner smx-banner-error' }, importError) : null,
              h('div', { className: 'smx-actions' },
                h('button', { type: 'button', className: 'smx-btn smx-btn-primary', disabled: importing, onClick: () => void confirmImport() }, importing ? '创建中…' : '创建 Skill'),
                h('button', { type: 'button', className: 'smx-btn', disabled: importing, onClick: () => void discardImport() }, '放弃')))
          : null;

        return h('div', { className: 'smx-scroll' },
          h('div', { className: 'smx-form' },
            h('div', { className: 'smx-banner smx-banner-info' },
              h('div', null,
                h('div', null, '支持 .zip / .rar / .7z / .tar / .tar.gz 等常见压缩包。'),
                h('div', null, '压缩包内需要包含 skill.md（或 SKILL.md）与 scripts/ 目录，也可以把它们放进 xxx-skill/ 文件夹；其它文件会被忽略，不会导入。'),
                limits.archiveBytes ? h('div', null, `单个压缩包上限 ${formatBytes(limits.archiveBytes)}，解压后上限 ${formatBytes(limits.extractedBytes)}。`) : null)),
            !preview && !uploading
              ? h('label', { className: 'smx-dropzone', onDragOver: (event) => event.preventDefault(), onDrop: (event) => { event.preventDefault(); const file = event.dataTransfer?.files?.[0]; if (file) void uploadFile(file); } },
                  h('input', { ref: fileRef, type: 'file', accept: '.zip,.rar,.7z,.tar,.tgz,.gz,.bz2,.xz', onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadFile(file); } }),
                  h(SkillIcon, { size: 24 }),
                  h('span', null, '点击选择压缩包，或拖拽到此处'),
                  h('span', { className: 'smx-hint' }, '导入后会先解析并预览，确认后才写入 ~/.dsh/skills'))
              : null,
            uploading ? h('div', { className: 'smx-empty' }, h('span', { className: 'smx-spin' }), '正在解析压缩包…') : null,
            !preview && !uploading && importError ? h('div', { className: 'smx-banner smx-banner-error' }, importError) : null,
            previewCard,
            !preview ? h('div', { className: 'smx-actions' }, h('button', { type: 'button', className: 'smx-btn', onClick: () => setView('list') }, '返回列表')) : null));
      }

      function renderDetail() {
        const skill = detail.skill;
        if (detail.status === 'loading') return h('div', { className: 'smx-scroll' }, h('div', { className: 'smx-empty' }, h('span', { className: 'smx-spin' }), '正在读取…'));
        if (detail.status === 'error' || !skill) {
          return h('div', { className: 'smx-scroll' },
            h('div', { className: 'smx-form' },
              h('div', { className: 'smx-banner smx-banner-error' }, detail.error || 'Skill 不存在'),
              h('div', { className: 'smx-actions' }, h('button', { type: 'button', className: 'smx-btn', onClick: () => setView('list') }, '返回列表'))));
        }
        return h('div', { className: 'smx-scroll' },
          h('div', { className: 'smx-form' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h(SkillIcon, { size: 18 }),
              h('strong', { style: { fontSize: '15px' } }, skill.displayName),
              h('span', { className: 'smx-code' }, `/${skill.slug}`),
              h('span', { className: 'smx-spacer' }),
              h('button', { type: 'button', className: 'smx-btn smx-btn-sm', onClick: () => void copyCommand(skill) }, '复制命令'),
              h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-danger', onClick: () => void deleteSkill(skill) }, '删除')),
            skill.description ? h('div', { className: 'smx-hint' }, skill.description) : null,
            skill.whenToUse ? h('div', { className: 'smx-hint' }, `适用场景：${skill.whenToUse}`) : null,
            h('dl', { className: 'smx-kv' },
              h('dt', null, '目录'),
              h('dd', null, skill.dir || ''),
              h('dt', null, '文件'),
              h('dd', null, skill.skillFile || 'SKILL.md')),
            h('div', { className: 'smx-field' },
              h('span', { className: 'smx-label' }, `scripts/ 内的脚本（${Array.isArray(skill.scripts) ? skill.scripts.length : 0}）`),
              Array.isArray(skill.scripts) && skill.scripts.length
                ? h('div', { className: 'smx-scripts' }, skill.scripts.map((script) => h('div', { key: script.path, className: 'smx-script' }, h('span', null, script.path), h('span', null, formatBytes(script.size)))))
                : h('div', { className: 'smx-hint' }, '这个 Skill 没有附带脚本。')),
            h('div', { className: 'smx-field' },
              h('span', { className: 'smx-label' }, 'SKILL.md'),
              h('pre', { className: 'smx-pre' }, skill.text || skill.body || '')),
            h('div', { className: 'smx-actions' },
              h('button', { type: 'button', className: 'smx-btn', onClick: () => setView('list') }, '返回列表'),
              h('button', { type: 'button', className: 'smx-btn smx-btn-ghost', onClick: () => { setView('list'); openPanel(); } }, '完成'))));
      }

      const isList = view === 'list';
      const headerTitle = view === 'list' ? 'SKILLS 管理' : view === 'create' ? '新建 Skill' : view === 'import' ? '导入 Skill' : 'Skill 详情';

      return h('div', { className: 'smx smx-panel', 'data-smx': 'panel' },
        h('div', { className: 'smx-header' },
          h(SkillIcon, { size: 18 }),
          h('div', { className: 'smx-title' }, headerTitle),
          h('span', { className: 'smx-spacer' }),
          isList
            ? [
                h('button', { key: 'refresh', type: 'button', className: 'smx-btn smx-btn-sm', onClick: () => { void refreshState().catch(() => {}); } }, '刷新'),
                h('button', { key: 'create', type: 'button', className: 'smx-btn smx-btn-sm', onClick: openCreate }, '新建'),
                h('button', { key: 'import', type: 'button', className: 'smx-btn smx-btn-sm smx-btn-primary', onClick: () => { setImportError(''); setView('import'); } }, '导入 Skill'),
              ]
            : h('button', { type: 'button', className: 'smx-btn smx-btn-sm', onClick: () => { if (view === 'import' && preview) { void discardImport(); } else { setView('list'); } } }, '返回')),
        isList ? renderSubRow() : null,
        view === 'list' ? renderList() : view === 'create' ? renderCreate() : view === 'import' ? renderImport() : renderDetail(),
        toast ? h('div', { className: 'smx-toast' }, toast) : null);
    }

    function renderSubRowFor(data) {
      const model = data?.model;
      const chip = model?.available
        ? h('span', { className: 'smx-chip', title: `provider: ${model.provider || ''}\nmodel: ${model.model || ''}\nsource: ${model.source || ''}` },
            h('span', { className: 'smx-dot', style: { color: 'var(--dsw-alias-state-success-primary,#12805c)' } }),
            `AI 命名：${model.model || '默认模型'}`)
        : h('span', { className: 'smx-chip smx-chip-bad', title: model?.reason || '未配置默认模型' }, 'AI 命名不可用');
      return h('div', { className: 'smx-sub' },
        chip,
        data?.skillsRoot ? h('span', { title: data.skillsRoot }, `技能目录 ${data.skillsRoot}`) : null,
        data?.stagingCount ? h('span', null, `暂存 ${data.stagingCount} 个导入任务`) : null);
    }

    // `renderSubRow` is declared as a plain function so the panel body stays readable.
    function renderSubRow() {
      return renderSubRowFor(store.state.data);
    }

    function SkillCard({ skill, onDetail, onDelete, onCopy }) {
      const mounted = Number(skill.mountedSessions || 0);
      const scripts = Array.isArray(skill.scripts) ? skill.scripts.length : 0;
      return h('div', { className: 'smx-card', 'data-smx': 'skill-card', 'data-slug': skill.slug },
        h('div', { className: 'smx-card-head' },
          h(SkillIcon, { size: 16 }),
          h('div', { className: 'smx-card-name', title: skill.displayName }, skill.displayName),
          mounted > 0 ? h('span', { className: 'smx-badge smx-badge-ok' }, `已挂载 ${mounted}`) : null),
        h('div', { className: 'smx-code', title: skill.slug }, `/${skill.slug}`),
        h('div', { className: 'smx-card-desc' }, skill.description || '（无描述）'),
        h('div', { className: 'smx-card-foot' },
          h('span', { className: 'smx-muted' }, `${scripts} 个脚本`),
          h('span', { className: 'smx-spacer' }),
          h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-ghost', onClick: () => onCopy(skill) }, '复制命令'),
          h('button', { type: 'button', className: 'smx-btn smx-btn-sm', onClick: () => onDetail(skill) }, '详情'),
          h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-danger', onClick: () => onDelete(skill) }, '删除')));
    }

    // ------------------------------------------------------- session menu item

    const SESSION_MENU_LABEL = '自定义 Skills';

    function SessionSkillsMenuItem(props) {
      const sessionId = props?.sessionId || props?.session?.id || '';
      const title = props?.displayTitle || props?.session?.title || '';
      const hook = props?.useMenuOpenState;
      const onSelect = () => {
        dismissMenu(hook);
        if (!sessionId) return;
        void openSessionDialog(sessionId, title);
      };
      if (typeof MenuItemButton === 'function') {
        return h(MenuItemButton, { icon: h(SkillIcon, { size: 16 }), onSelect }, SESSION_MENU_LABEL);
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'smx smx-menu-item',
        'data-smx': 'session-menu-item',
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        },
      }, h('span', { className: 'smx-menu-icon' }, h(SkillIcon, { size: 16 })), h('span', null, SESSION_MENU_LABEL));
    }

    function dismissMenu(hook) {
      try {
        const value = typeof hook === 'function' ? hook() : null;
        const setter = Array.isArray(value) ? value[1] : value && typeof value.setOpen === 'function' ? value.setOpen : null;
        if (typeof setter === 'function') setter(false);
      } catch (error) {
        console.warn('[dsh-skill-manager] could not close the session menu', error);
      }
    }

    // ------------------------------------------------------ session dialog

    function SessionSkillsDialog() {
      useRevision();
      const [saving, setSaving] = useState(false);
      const [actionError, setActionError] = useState('');
      const active = store.dialog?.kind === 'session';
      const dialog = active ? store.dialog : null;
      const data = store.sessionDialog;

      useEffect(() => {
        if (!active) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') closeDialog();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [active]);

      if (!active) return null;

      function toggle(slug) {
        const next = new Set(store.sessionDialog.selected);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        store.sessionDialog = { ...store.sessionDialog, selected: next, dirty: true };
        notify();
      }

      async function save() {
        setActionError('');
        const mounted = Array.isArray(data.mounted) ? data.mounted : [];
        const selected = [...(data.selected || new Set())];
        const add = selected.filter((slug) => !mounted.includes(slug));
        const remove = mounted.filter((slug) => !selected.includes(slug));
        if (!add.length && !remove.length) {
          closeDialog();
          return;
        }
        setSaving(true);
        try {
          const result = await apiPost('/action', { action: 'mounts', sessionId: dialog.sessionId, add, remove });
          store.sessions.set(dialog.sessionId, { status: 'ready', data: result });
          await refreshState().catch(() => {});
          closeDialog();
        } catch (error) {
          setActionError(messageOf(error));
        } finally {
          setSaving(false);
        }
      }

      const skills = Array.isArray(data.skills) ? data.skills : [];
      const ready = data.status === 'ready';

      return h('div', { className: 'smx smx-mask', 'data-smx': 'session-dialog', onClick: (event) => { if (event.target === event.currentTarget) closeDialog(); } },
        h('div', { className: 'smx-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '自定义 Skills' },
          h('div', { className: 'smx-dialog-head' },
            h(SkillIcon, { size: 18 }),
            h('div', { className: 'smx-dialog-title' }, '自定义 Skills'),
            h('span', { className: 'smx-spacer' }),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-ghost', 'aria-label': '关闭', onClick: closeDialog }, '✕')),
          h('div', { className: 'smx-dialog-body' },
            h('div', { className: 'smx-sub', style: { padding: '0 0 10px' } },
              dialog.title ? h('span', { title: dialog.title }, dialog.title) : null,
              h('span', null, `会话 ${shortId(dialog.sessionId)}`)),
            data.status === 'loading' ? h('div', { className: 'smx-empty' }, h('span', { className: 'smx-spin' }), '正在读取本会话已挂载的 Skill…') : null,
            data.status === 'error'
              ? h('div', { className: 'smx-banner smx-banner-error' },
                  h('span', null, data.error || '读取失败'),
                  h('button', { type: 'button', className: 'smx-link', onClick: () => void openSessionDialog(dialog.sessionId, dialog.title) }, '重试'))
              : null,
            ready && !skills.length ? h('div', { className: 'smx-empty' }, '还没有自定义 Skill。先到左侧「SKILLS 管理」新建或导入一个。') : null,
            ready && skills.length
              ? h('div', { className: 'smx-rows' },
                  skills.map((skill) => h('label', { key: skill.slug, className: 'smx-row' },
                    h('input', { type: 'checkbox', checked: data.selected.has(skill.slug), onChange: () => toggle(skill.slug) }),
                    h('div', { className: 'smx-row-main' },
                      h('div', { className: 'smx-row-title' },
                        skill.displayName,
                        h('span', { className: 'smx-code' }, `/${skill.slug}`),
                        data.mounted.includes(skill.slug) ? h('span', { className: 'smx-badge smx-badge-ok' }, '已挂载') : null),
                      h('div', { className: 'smx-row-desc' }, skill.description || '（无描述）')))))
              : null,
            ready && skills.length
              ? h('div', { className: 'smx-banner smx-banner-info', style: { marginTop: '10px' } },
                  '勾选即挂载。保存后可在本会话输入框输入 /slug 调用，或输入 /mySkills 勾选使用。')
              : null,
            actionError ? h('div', { className: 'smx-banner smx-banner-error', style: { marginTop: '10px' } }, actionError) : null),
          h('div', { className: 'smx-dialog-foot' },
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-ghost', onClick: () => { closeDialog(); openPanel(); } }, '打开 SKILLS 管理'),
            h('span', { className: 'smx-spacer' }),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm', disabled: saving, onClick: closeDialog }, '取消'),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-primary', disabled: saving || !ready || !data.dirty, onClick: () => void save() }, saving ? '保存中…' : '保存挂载'))));
    }

    // ------------------------------------------------------- /mySkills picker

    function MySkillsTrigger(props) {
      if (!props || typeof props.useInput !== 'function') return null;
      return h(MySkillsTriggerBody, props);
    }

    function MySkillsTriggerBody(props) {
      const draft = props.useInput((state) => (state && typeof state.draft === 'string' ? state.draft : '')) || '';
      const trimmed = String(draft).replace(/\s+$/, '');
      const matched = /(^|\s)\/mySkills$/i.test(trimmed);
      const sessionId = props.sessionId || (props.session && props.session.id) || '';

      /*
       * The `/mySkills` command row (registered through `commandUi`) runs from
       * the command menu, where the session scope's input actions are not handed
       * to the callback. Keep the composer's live actions per session so both
       * entries open the same picker with a working draft writer; the handle in
       * `composerActionsFor` forwards to whatever composer is mounted now.
       */
      if (sessionId && props.inputActions) store.composerActionsLive.set(sessionId, props.inputActions);
      useEffect(() => () => {
        const live = store.composerActionsLive.get(sessionId);
        if (live === props.inputActions) store.composerActionsLive.delete(sessionId);
      }, [sessionId]);

      useEffect(() => {
        const open = store.dialog?.kind === 'my-skills';
        if (!matched) {
          // Close only the picker the draft gesture opened: a command-triggered
          // picker lives on after the `/mySkills` token has been consumed.
          if (open && store.dialog.source !== 'command' && store.dialog.sessionId === sessionId) closeDialog();
          return;
        }
        if (open) return;
        const baseDraft = trimmed.replace(/(^|\s)\/mySkills$/i, '$1').replace(/\s+$/, '');
        void openMySkillsDialog({ sessionId, baseDraft, inputActions: props.inputActions });
      }, [matched, trimmed, sessionId]);

      return null;
    }

    function MySkillsDialog() {
      useRevision();
      const active = store.dialog?.kind === 'my-skills';
      const dialog = active ? store.dialog : null;
      const data = store.mySkillsPicker;

      useEffect(() => {
        if (!active) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') cancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      });

      if (!active) return null;

      function toggle(slug) {
        const next = new Set(store.mySkillsPicker.selected);
        if (next.has(slug)) next.delete(slug);
        else next.add(slug);
        store.mySkillsPicker = { ...store.mySkillsPicker, selected: next, dirty: true };
        notify();
      }

      function cancel() {
        applyDraft(store.dialog, store.dialog?.baseDraft || '');
        closeDialog();
      }

      function confirm() {
        const current = store.dialog;
        if (!current) return;
        const selected = store.mySkillsPicker.selected;
        const chosen = (store.mySkillsPicker.skills || [])
          .filter((skill) => selected.has(skill.slug))
          .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName), 'zh-Hans-CN'));
        const tokens = chosen.map((skill) => `/${skill.slug}`).join(' ');
        const base = String(current.baseDraft || '').replace(/\s+$/, '');
        const next = tokens ? (base ? `${base} ${tokens} ` : `${tokens} `) : base;
        applyDraft(current, next);
        closeDialog();
      }

      const skills = Array.isArray(data.skills) ? data.skills : [];
      const ready = data.status === 'ready';
      const count = data.selected instanceof Set ? data.selected.size : 0;

      return h('div', { className: 'smx smx-mask', 'data-smx': 'my-skills-dialog', onClick: (event) => { if (event.target === event.currentTarget) cancel(); } },
        h('div', { className: 'smx-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '本轮使用的自定义 Skills' },
          h('div', { className: 'smx-dialog-head' },
            h(SkillIcon, { size: 18 }),
            h('div', { className: 'smx-dialog-title' }, '本轮使用的自定义 Skills'),
            h('span', { className: 'smx-spacer' }),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-ghost', 'aria-label': '关闭', onClick: cancel }, '✕')),
          h('div', { className: 'smx-dialog-body' },
            h('div', { className: 'smx-sub', style: { padding: '0 0 10px' } }, '勾选的 Skill 会以 /slug 插入输入框，本轮生效；发送后由 DSH 展开为技能提示词。'),
            data.status === 'loading' ? h('div', { className: 'smx-empty' }, h('span', { className: 'smx-spin' }), '正在读取本会话已挂载的 Skill…') : null,
            data.status === 'error' ? h('div', { className: 'smx-banner smx-banner-error' }, data.error || '读取失败') : null,
            ready && !skills.length
              ? h('div', { className: 'smx-empty' },
                  '本会话还没有挂载自定义 Skill。',
                  h('button', { type: 'button', className: 'smx-link', onClick: () => { closeDialog(); openPanel(); } }, '打开 SKILLS 管理'))
              : null,
            ready && skills.length
              ? h('div', { className: 'smx-rows' },
                  skills.map((skill) => h('label', { key: skill.slug, className: 'smx-row' },
                    h('input', { type: 'checkbox', checked: data.selected.has(skill.slug), onChange: () => toggle(skill.slug) }),
                    h('div', { className: 'smx-row-main' },
                      h('div', { className: 'smx-row-title' }, skill.displayName, h('span', { className: 'smx-code' }, `/${skill.slug}`)),
                      h('div', { className: 'smx-row-desc' }, skill.description || '（无描述）')))))
              : null),
          h('div', { className: 'smx-dialog-foot' },
            h('span', { className: 'smx-muted' }, ready ? `已勾选 ${count} 个` : ''),
            h('span', { className: 'smx-spacer' }),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm', onClick: cancel }, '关闭'),
            h('button', { type: 'button', className: 'smx-btn smx-btn-sm smx-btn-primary', disabled: !ready, onClick: confirm }, '使用勾选的 Skill'))));
    }

    // ---------------------------------------------------------------- apply

    function SidebarSkillsIcon({ size = 16, active }) {
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: active ? 'var(--dsw-alias-brand-primary,#4d6bfe)' : 'inherit' },
      }, h(SkillIcon, { size }));
    }

    function apply(ctx) {
      try {
        layoutService = typeof ctx.get === 'function' ? ctx.get('layout') ?? null : null;
      } catch {
        layoutService = null;
      }
      installStyles();

      const disposers = [];
      /**
       * Register one slot entry. `slots.inject` is the shipped pattern: it waits
       * for the slot host to declare the slot and only then registers.
       */
      const register = (options, component) => {
        try {
          disposers.push(ctx.slots.inject(options.name, () => ctx.slots.register(options, component)));
          return;
        } catch (error) {
          /* Fall back to a direct registration when the slot is already declared. */
        }
        try {
          disposers.push(ctx.slots.register(options, component));
        } catch (error) {
          console.warn(`[dsh-skill-manager] could not register ${options.name}`, error);
        }
      };

      /**
       * Slash autocomplete source: every managed skill appears in the composer's
       * `/` menu under its own "自定义 SKILLS" heading, with the skill icon.
       * A pick only inserts `/<slug> ` — it never sends, and DSH's own `/slug`
       * gesture expands the skill into the turn.
       */
      const customSkillsSource = {
        trigger: '/',
        name: 'custom-skills',
        order: -1,
        showGroupTitle: false,
        async candidates(_session, request = {}) {
          const { query, signal } = request;
          let data;
          try {
            data = await ensureState();
          } catch {
            return [];
          }
          if (signal && signal.aborted) return [];
          const needle = String(query || '').trim().toLowerCase();
          const skills = Array.isArray(data?.skills) ? data.skills : [];
          return skills
            .filter((skill) => {
              if (!needle) return true;
              const haystack = `${skill.displayName || ''} ${skill.slug || ''} ${skill.description || ''}`.toLowerCase();
              return haystack.includes(needle);
            })
            .sort((left, right) => String(left.displayName || '').localeCompare(String(right.displayName || ''), 'zh-Hans-CN'))
            .slice(0, 20)
            .map((skill) => ({
              value: `/${skill.slug} `,
              name: `/${skill.slug}`,
              label: skill.displayName || skill.slug,
              description: skill.description || '',
              icon: SkillIcon,
              section: '自定义 SKILLS',
            }));
        },
        onPick({ candidate }) {
          const text = String(candidate?.value || '');
          return text ? { text } : undefined;
        },
      };

      const mount = () => {
        register({ name: 'sidebar.panellist', id: PANEL_ID, order: -20, label: () => 'SKILLS 管理' }, SidebarSkillsIcon);
        register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, SkillManagerPanel);
        register({ name: 'sidebar.workspaces.session.menu.item', id: 'skill-manager-session', order: 460 }, SessionSkillsMenuItem);
        register({ name: 'shell.overlay', id: 'skill-manager-session-dialog', order: 62 }, SessionSkillsDialog);
        register({ name: 'shell.overlay', id: 'skill-manager-my-skills-dialog', order: 63 }, MySkillsDialog);
        register({ name: 'conversation.input.overlay', id: 'skill-manager-my-skills-trigger', order: 4 }, MySkillsTrigger);
      };

      const mountTriggers = () => {
        const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined;
        if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return undefined;
        return inputTriggers.registerSource(customSkillsSource);
      };

      /**
       * Command surface: `/mySkills` is a real client command, so typing `/my`
       * completes to a "自定义 SKILLS" row (icon, localized title, alias) and
       * picking it opens the same per-turn picker the typed gesture opens.
       * Client contributions cannot claim a command chip, so the completion row
       * is the surface and the picker opens on selection.
       */
      const mountCommand = () => {
        if (typeof ctx.inject !== 'function') return;
        try {
          ctx.inject(['commandUi'], (scope) => {
            const commandUi = scope.commandUi;
            if (!commandUi || typeof commandUi.register !== 'function') return;
            const dispose = commandUi.register({
              name: 'mySkills',
              label: () => '自定义 SKILLS',
              description: () => '勾选本轮要使用的自定义 Skill，确认后以 /slug 插入输入框',
              icon: SkillIcon,
              available: () => true,
              ui: {
                kind: 'action',
                run: (session) => {
                  const sessionId = (session && (session.sessionId || session.id)) || '';
                  if (!sessionId) return;
                  const inputActions = composerActionsFor(sessionId);
                  if (!inputActions) {
                    console.warn('[dsh-skill-manager] /mySkills found no composer for session', sessionId);
                    return;
                  }
                  void openMySkillsDialog({ sessionId, baseDraft: '', inputActions, source: 'command' });
                },
              },
            });
            if (typeof dispose === 'function' && typeof scope.effect === 'function') {
              scope.effect(() => () => {
                try {
                  dispose();
                } catch {
                  /* ignore teardown failures */
                }
              }, 'dsh-skill-manager: /mySkills command');
            }
          });
        } catch (error) {
          console.warn('[dsh-skill-manager] could not register the /mySkills command', error);
        }
      };

      const cleanup = () => {
        for (const dispose of disposers.splice(0)) {
          try {
            if (typeof dispose === 'function') dispose();
            else if (dispose && typeof dispose.dispose === 'function') dispose.dispose();
          } catch {
            /* ignore teardown failures */
          }
        }
      };

      const mountAll = () => {
        mount();
        const disposeTriggers = mountTriggers();
        return () => {
          cleanup();
          try {
            if (typeof disposeTriggers === 'function') disposeTriggers();
          } catch {
            /* ignore teardown failures */
          }
        };
      };

      if (typeof ctx.effect === 'function') {
        ctx.effect(mountAll, 'dsh-skill-manager: UI slots and slash source');
      } else {
        mountAll();
      }
      mountCommand();
    }

    return { inject: ['slots', 'inputTriggers'], apply };
  },
});
