// LumiDraw Studio — frontend
// Injects a launcher button + studio panel styled with Lumiverse theme
// variables. All traffic goes through the backend module.

const EXTENSION_VERSION = '0.14.3'

console.log(`[LumiDraw] frontend module imported v${EXTENSION_VERSION}`)

function makeId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID() } catch { /* insecure context */ }
  }
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function setup(ctx) {
  console.log('[LumiDraw] setup called. ctx keys:', ctx ? Object.keys(ctx) : ctx)
  if (ctx && ctx.dom) console.log('[LumiDraw] ctx.dom keys:', Object.keys(ctx.dom))
  try {
    const cleanup = realSetup(ctx)
    console.log('[LumiDraw] setup finished — launcher should be visible bottom-right')
    return cleanup
  } catch (err) {
    console.error('[LumiDraw] setup crashed:', err)
    return () => {}
  }
}

export default setup

function realSetup(ctx) {
  // --- resilient DOM layer: prefer host helpers, fall back to document ---
  const injected = []
  const dom = {
    addStyle(css) {
      if (ctx.dom && typeof ctx.dom.addStyle === 'function') return ctx.dom.addStyle(css)
      const el = document.createElement('style')
      el.setAttribute('data-lumidraw', '1')
      el.textContent = css
      document.head.appendChild(el)
      injected.push(el)
      return () => el.remove()
    },
    inject(target, html) {
      if (ctx.dom && typeof ctx.dom.inject === 'function') {
        try { return ctx.dom.inject(target, html) } catch (e) {
          console.warn('[LumiDraw] ctx.dom.inject failed, using document fallback:', e.message)
        }
      }
      const root = document.createElement('div')
      root.setAttribute('data-lumidraw', '1')
      root.innerHTML = html
      document.body.appendChild(root)
      injected.push(root)
    },
    query(sel) {
      if (ctx.dom && typeof ctx.dom.query === 'function') {
        try { const r = ctx.dom.query(sel); if (r) return r } catch { /* fall through */ }
      }
      return document.querySelector(sel)
    },
    queryAll(sel) {
      if (ctx.dom && typeof ctx.dom.queryAll === 'function') {
        try { const r = ctx.dom.queryAll(sel); if (r && r.length) return Array.from(r) } catch { /* fall through */ }
      }
      return Array.from(document.querySelectorAll(sel))
    },
    cleanup() {
      if (ctx.dom && typeof ctx.dom.cleanup === 'function') {
        try { ctx.dom.cleanup() } catch { /* ignore */ }
      }
      for (const el of injected) el.remove()
    },
  }

  // ------------------------------------------------------------------ state
  let settings = { host: '127.0.0.1', port: 7862 }
  let presets = []
  let history = []
  let activePreset = null   // name of selected preset
  let syncedConfig = null   // last synced/loaded config powering the form
  let draftConfig = null    // temporary workspace config for manual generation
  let draftDirty = false
  let draftSourceLabel = ''
  let catalog = { models: [], samplers: [], loras: [], source: 'memory' }
  let busy = false
  let defaults = { protocol: '', parserInstruction: '' }
  const pending = new Map() // requestId → {resolve, reject}
  let rescanInputAction = null
  let rescanInputActionUnsub = null

  function call(type, data = {}, timeoutMs = 630000) {
    return new Promise((resolve, reject) => {
      const requestId = makeId()
      pending.set(requestId, { resolve, reject })
      ctx.sendToBackend({ type, requestId, ...data })
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId)
          reject(new Error(`Backend did not respond to "${type}" (timed out after ${timeoutMs/1000}s). If this is at startup, the backend module may not be running — check the Lumiverse server log for "[lumidraw] backend loaded".`))
        }
      }, timeoutMs)
    })
  }

  const unsub = ctx.onBackendMessage((payload) => {
    if (!payload || !payload.requestId || !pending.has(payload.requestId)) return
    const { resolve, reject } = pending.get(payload.requestId)
    pending.delete(payload.requestId)
    if (payload.ok) resolve(payload)
    else reject(new Error(payload.error || 'Unknown backend error'))
  })

  // ------------------------------------------------------------------ styles
  const removeStyle = dom.addStyle(`
    .ld-launcher {
      position: fixed; right: 16px; bottom: 88px; z-index: 9000;
      width: 58px; height: 58px; border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      color: var(--lumiverse-text, #eceef4); cursor: grab; touch-action: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.28); user-select: none;
    }
    .ld-launcher:hover { background: var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-panel {
      position: fixed; right: 16px; bottom: 140px; z-index: 9001;
      width: 384px; max-width: calc(100vw - 24px);
      max-height: min(78vh, 720px); display: none; flex-direction: column;
      background: rgba(23, 24, 30, 0.97);
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius, 8px);
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
      color: var(--lumiverse-text, #eceef4); font-size: 14px;
    }
    .ld-panel.ld-open { display: flex; }
    .ld-panel.ld-fullscreen {
      inset: 0 !important; width: 100vw !important; max-width: none !important;
      height: 100dvh !important; max-height: none !important;
      border-radius: 0; border-left: none; border-right: none;
    }
    .ld-panel.ld-fullscreen .ld-body {
      width: min(100%, 1100px); margin: 0 auto; box-sizing: border-box;
      padding-left: max(14px, env(safe-area-inset-left));
      padding-right: max(14px, env(safe-area-inset-right));
      padding-bottom: max(18px, env(safe-area-inset-bottom));
    }
    .ld-panel.ld-fullscreen .ld-history {
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    }
    body.ld-fullscreen-lock { overflow: hidden !important; }
    .ld-story-picker {
      position: fixed; inset: 0; z-index: 9200; display: none;
      align-items: center; justify-content: center; padding: 14px;
      background: var(--lumiverse-modal-backdrop, rgba(0,0,0,.62));
    }
    .ld-story-picker.ld-open { display: flex; }
    .ld-story-dialog {
      width: min(680px, 100%); max-height: min(84vh, 820px);
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(23, 24, 30, 0.99);
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius-lg, 12px);
      box-shadow: 0 18px 60px rgba(0,0,0,.55);
      color: var(--lumiverse-text, #eceef4);
    }
    .ld-story-head {
      display: flex; align-items: center; gap: 10px; padding: 12px 14px;
      border-bottom: 1px solid var(--lumiverse-border, #3d4050);
    }
    .ld-story-title { flex: 1; font-weight: 650; }
    .ld-story-tools { padding: 10px 12px; border-bottom: 1px solid var(--lumiverse-border, #3d4050); }
    .ld-story-search {
      width: 100%; box-sizing: border-box; padding: 9px 11px; font-size: 14px;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius, 8px); color: var(--lumiverse-text, #eceef4);
    }
    .ld-story-help { margin-top: 7px; font-size: 11px; color: var(--lumiverse-text-muted, #a2a5b4); }
    .ld-story-list { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .ld-story-item {
      width: 100%; padding: 10px 11px; text-align: left; cursor: pointer;
      background: var(--lumiverse-fill, #262833); color: var(--lumiverse-text, #eceef4);
      border: 1px solid var(--lumiverse-border, #3d4050); border-radius: var(--lumiverse-radius, 8px);
    }
    .ld-story-item:hover { background: var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-story-item-top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .ld-story-number { font-size: 12px; font-weight: 650; }
    .ld-story-badge {
      padding: 2px 6px; border-radius: 999px; font-size: 10px;
      color: var(--lumiverse-text-muted, #a2a5b4); border: 1px solid var(--lumiverse-border, #3d4050);
    }
    .ld-story-preview {
      font-size: 12px; line-height: 1.4; color: var(--lumiverse-text-muted, #a2a5b4);
      display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
    }
    .ld-story-empty { padding: 24px 12px; text-align: center; color: var(--lumiverse-text-muted, #a2a5b4); }
    @media (max-width: 520px) {
      .ld-story-picker { align-items: flex-end; padding: 0; }
      .ld-story-dialog { width: 100%; max-height: 90vh; border-radius: 14px 14px 0 0; }
    }
    .ld-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--lumiverse-border, #3d4050);
    }
    .ld-head-title { font-weight: 600; flex: 1; }
    .ld-tabbtn {
      background: none; border: none; color: var(--lumiverse-text-muted, #a2a5b4);
      cursor: pointer; padding: 4px 6px; border-radius: var(--lumiverse-radius, 8px);
      font-size: 12px;
    }
    .ld-tabbtn.ld-active { color: var(--lumiverse-text, #eceef4); background: var(--lumiverse-fill, #262833); }
    .ld-body { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .ld-row { display: flex; gap: 8px; align-items: center; }
    .ld-row > * { flex: 1; min-width: 0; }
    .ld-label { font-size: 11px; color: var(--lumiverse-text-muted, #a2a5b4); margin-bottom: 3px; display: block; }
    .ld-panel input, .ld-panel select, .ld-panel textarea {
      width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px !important;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius, 8px); color: var(--lumiverse-text, #eceef4);
      font-size: 13px;
    }
    .ld-panel textarea { resize: vertical; min-height: 54px; }
    .ld-btn {
      padding: 7px 10px; border-radius: var(--lumiverse-radius, 8px);
      border: 1px solid var(--lumiverse-border, #3d4050); background: var(--lumiverse-fill, #262833);
      color: var(--lumiverse-text, #eceef4); cursor: pointer; font-size: 13px;
    }
    .ld-btn:hover:not(:disabled) { background: var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-btn:disabled { opacity: .5; cursor: default; }
    .ld-btn.ld-primary { font-weight: 600; }
    .ld-status { font-size: 12px; color: var(--lumiverse-text-muted, #a2a5b4); white-space: pre-wrap; word-break: break-word; }
    .ld-status.ld-err { color: #e5737f; }
    .ld-status.ld-good { color: #7fbf8e; }
    .ld-chip {
      display: inline-block; padding: 2px 6px; margin: 0 4px 4px 0;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: 999px; font-size: 11px; color: var(--lumiverse-text-muted, #a2a5b4);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      vertical-align: bottom;
    }
    .ld-history { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .ld-history .ld-thumb { display: flex; flex-direction: column; gap: 4px; }
    .ld-history img {
      width: 100%; aspect-ratio: 1; object-fit: cover;
      border-radius: var(--lumiverse-radius, 8px); border: 1px solid var(--lumiverse-border, #3d4050);
      cursor: pointer; display: block;
    }
    .ld-thumb .ld-append {
      width: 100%; padding: 5px 4px; font-size: 12px; line-height: 1.1;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius, 8px); color: var(--lumiverse-text, #eceef4);
      cursor: pointer;
    }
    .ld-thumb .ld-append:hover { background: var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-thumb-row { display: flex; gap: 4px; }
    .ld-thumb-row .ld-append { flex: 1; padding: 4px 2px; font-size: 11px; }
    .ld-remove:hover { color: #e5737f; }
    .ld-preset-item {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      border: 1px solid var(--lumiverse-border, #3d4050); border-radius: var(--lumiverse-radius, 8px);
      background: var(--lumiverse-fill, #262833);
    }
    .ld-preset-item.ld-active { outline: 1px solid var(--lumiverse-text-muted, #a2a5b4); }
    .ld-preset-name { flex: 1; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ld-preset-model { font-size: 10px; color: var(--lumiverse-text-muted, #a2a5b4); display: block; overflow: hidden; text-overflow: ellipsis; }
    .ld-x { background: none; border: none; color: var(--lumiverse-text-muted, #a2a5b4); cursor: pointer; font-size: 14px; padding: 2px 4px; }
    .ld-min { font-size: 20px; line-height: 1; padding: 2px 8px; }
    .ld-fullscreen-toggle { font-size: 18px; line-height: 1; padding: 3px 7px; }
    .ld-textarea-wrap { position: relative; }
    .ld-textarea-wrap textarea { padding-right: 42px !important; }
    .ld-textarea-expand {
      position: absolute; top: 5px; right: 5px; z-index: 2;
      min-width: 30px; height: 28px; padding: 0 6px;
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: 7px; background: rgba(23,24,30,.88);
      color: var(--lumiverse-text-muted, #a2a5b4); cursor: pointer;
      font-size: 15px; line-height: 1;
    }
    .ld-textarea-expand:hover { color: var(--lumiverse-text, #eceef4); }
    .ld-text-editor {
      position: fixed; inset: 0; z-index: 9400; display: none;
      align-items: center; justify-content: center; padding: 14px;
      background: var(--lumiverse-modal-backdrop, rgba(0,0,0,.68));
    }
    .ld-text-editor.ld-open { display: flex; }
    .ld-text-editor-dialog {
      width: min(960px, 100%); height: min(88dvh, 920px);
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(23,24,30,.995);
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius-lg, 12px);
      box-shadow: 0 18px 60px rgba(0,0,0,.58);
    }
    .ld-text-editor-head, .ld-text-editor-actions {
      display: flex; align-items: center; gap: 8px; padding: 11px 13px;
      border-bottom: 1px solid var(--lumiverse-border, #3d4050);
    }
    .ld-text-editor-actions { border-top: 1px solid var(--lumiverse-border, #3d4050); border-bottom: none; justify-content: flex-end; }
    .ld-text-editor-title { flex: 1; font-weight: 650; }
    .ld-text-editor-area {
      flex: 1; min-height: 0 !important; resize: none !important;
      margin: 12px; width: calc(100% - 24px) !important; box-sizing: border-box;
      padding: 14px; font-size: 16px !important; line-height: 1.45;
      background: var(--lumiverse-fill, #262833);
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: var(--lumiverse-radius, 8px);
      color: var(--lumiverse-text, #eceef4);
    }
    .ld-x:hover { color: #e5737f; }
    .ld-spin { animation: ld-rot 1s linear infinite; display: inline-block; }
    .ld-subsection { border: 1px solid var(--lumiverse-border, #3d4050); border-radius: var(--lumiverse-radius, 8px); padding: 10px; }
    .ld-subtitle { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .ld-help { font-size: 11px; color: var(--lumiverse-text-muted, #a2a5b4); }
    .ld-compact { font-size: 12px; padding: 4px 8px; }
    .ld-section-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
    @media (max-width: 620px) {
      .ld-head { flex-wrap: wrap; padding-top: max(8px, env(safe-area-inset-top)); }
      .ld-head-title { flex: 1 1 calc(100% - 84px); }
      .ld-tabbtn { flex: 1 1 30%; order: 3; text-align: center; padding: 7px 4px; }
      .ld-fullscreen-toggle, .ld-min { order: 2; }
      .ld-panel.ld-fullscreen .ld-body { width: 100%; }
      .ld-text-editor { padding: 0; }
      .ld-text-editor-dialog { width: 100%; height: 100dvh; border-radius: 0; border-left: none; border-right: none; }
      .ld-text-editor-area { margin: 10px; width: calc(100% - 20px) !important; }
    }
    @keyframes ld-rot { to { transform: rotate(360deg); } }
  `)

  // ------------------------------------------------------------------ markup
  dom.inject('body', `
    <button class="ld-launcher" title="LumiDraw Studio v0.14.3" aria-label="LumiDraw Studio v0.14.3">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"></rect>
        <circle cx="9" cy="9" r="1.8"></circle>
        <path d="M21 15.5l-4.2-4.2a1.6 1.6 0 0 0-2.3 0L6 20"></path>
      </svg>
    </button>
    <div class="ld-panel">
      <div class="ld-head">
        <span class="ld-head-title">LumiDraw Studio <small style="font-weight:400;opacity:.65">v0.14.3</small></span>
        <button class="ld-tabbtn ld-active" data-tab="generate">Generate</button>
        <button class="ld-tabbtn" data-tab="presets">Presets</button>
        <button class="ld-tabbtn" data-tab="settings">Settings</button>
        <button class="ld-x ld-fullscreen-toggle" title="Open fullscreen" aria-label="Open fullscreen" aria-pressed="false">⛶</button>
        <button class="ld-x ld-min" title="Minimize back to the icon">&#8211;</button>
      </div>
      <div class="ld-body" data-view="generate">
        <div>
          <span class="ld-label">Chat preset</span>
          <div class="ld-row">
            <select class="ld-preset-select"><option value="">— none (synced state) —</option></select>
            <button class="ld-btn" style="flex:0 0 auto" data-act="sync" title="Capture the recipe currently shown in Draw Things">Sync ⟳</button>
          </div>
          <div class="ld-help" style="margin-top:6px">The chat preset stays committed for parser and inline story images. The workspace below is only for experimentation until you save it.</div>
        </div>
        <div class="ld-subsection">
          <div class="ld-subtitle">Workspace / draft settings</div>
          <div class="ld-config-chips" style="margin-top:2px"></div>
          <div class="ld-status ld-draft-status" style="margin-top:6px"></div>
          <div style="margin-top:8px">
            <span class="ld-label">Model</span>
            <select class="ld-draft-model"><option value="">— choose model —</option></select>
          </div>
          <div class="ld-row" style="margin-top:6px">
            <div><span class="ld-label">Sampler</span><input class="ld-draft-sampler" list="ld-samplers" /></div>
            <div style="flex:0 0 70px"><span class="ld-label">Steps</span><input class="ld-draft-steps" type="number" min="1" max="150" /></div>
            <div style="flex:0 0 70px"><span class="ld-label">CFG</span><input class="ld-draft-cfg" type="number" step="0.5" min="0" /></div>
          </div>
          <div class="ld-row" style="margin-top:6px">
            <div><span class="ld-label">Width</span><input class="ld-draft-w" type="number" step="64" min="256" /></div>
            <div><span class="ld-label">Height</span><input class="ld-draft-h" type="number" step="64" min="256" /></div>
          </div>
          <span class="ld-label" style="margin-top:8px">LoRAs</span>
          <div class="ld-draft-loras" style="display:flex;flex-direction:column;gap:4px"></div>
          <button class="ld-btn ld-compact" data-act="draft-addlora" style="margin-top:4px">＋ LoRA</button>
          <div class="ld-help" style="margin-top:6px">The lists contain models and LoRAs LumiDraw has already learned. Exact names can still be typed manually.</div>
          <div style="margin-top:8px">
            <span class="ld-label">Negative prompt</span>
            <textarea class="ld-negative" style="min-height:36px"></textarea>
          </div>
          <div class="ld-section-actions">
            <button class="ld-btn" data-act="draft-reset">Reset workspace</button>
            <button class="ld-btn" data-act="draft-save-new">Save as new preset</button>
            <button class="ld-btn" data-act="draft-save-active">Update active preset</button>
          </div>
        </div>
        <div>
          <span class="ld-label">Prompt</span>
          <textarea class="ld-prompt" placeholder="portrait of..."></textarea>
        </div>
        <div class="ld-row">
          <div>
            <span class="ld-label">Seed (blank = random)</span>
            <input class="ld-seed" type="number" min="0" placeholder="random" />
          </div>
          <div style="flex:0 0 auto; align-self: flex-end;">
            <button class="ld-btn" data-act="reuse-seed" title="Copy the seed from the last generation">↩ last</button>
          </div>
        </div>
        <button class="ld-btn ld-primary" data-act="generate">Generate with workspace</button>
        <button class="ld-btn" data-act="scan" title="Process the latest story message using the committed chat preset">Scan story now 📖</button>
        <button class="ld-btn ld-primary" data-act="scan-old" title="Choose any assistant message in the current chat and run Parser mode on it using the committed chat preset">Rescan old message 📚</button>
        <button class="ld-btn" data-act="append-last" style="display:none">Add to chat 💬</button>
        <div class="ld-status ld-gen-status"></div>
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span class="ld-label" style="margin-bottom:0">Recent</span>
            <button class="ld-x ld-clearall" title="Delete ALL recent images from the library and this list">Clear all</button>
          </div>
          <div class="ld-history"></div>
        </div>
      </div>
      <div class="ld-body" data-view="presets" style="display:none">
        <div class="ld-status">A preset is a complete pinned recipe: model, sampler, LoRAs, sizes, and identity tags. Edit any of it here; the Generate tab just runs whichever preset is selected.</div>
        <button class="ld-btn" data-act="new-preset">＋ New preset from synced state</button>
        <div class="ld-status ld-preset-status"></div>
        <div class="ld-preset-list" style="display:flex;flex-direction:column;gap:6px"></div>
        <div class="ld-editor" style="display:none;border:1px solid var(--lumiverse-border, #3d4050);border-radius:var(--lumiverse-radius, 8px);padding:10px;margin-top:4px">
          <span class="ld-label">Name</span>
          <input class="ld-ed-name" />
          <span class="ld-label" style="margin-top:6px">Model</span>
          <select class="ld-ed-model"></select>
          <div class="ld-row" style="margin-top:6px">
            <div><span class="ld-label">Sampler</span><input class="ld-ed-sampler" list="ld-samplers" /><datalist id="ld-samplers"></datalist></div>
            <div style="flex:0 0 70px"><span class="ld-label">Steps</span><input class="ld-ed-steps" type="number" min="1" max="150" /></div>
            <div style="flex:0 0 70px"><span class="ld-label">CFG</span><input class="ld-ed-cfg" type="number" step="0.5" min="0" /></div>
          </div>
          <div class="ld-row" style="margin-top:6px">
            <div><span class="ld-label">Width</span><input class="ld-ed-w" type="number" step="64" min="256" /></div>
            <div><span class="ld-label">Height</span><input class="ld-ed-h" type="number" step="64" min="256" /></div>
          </div>
          <span class="ld-label" style="margin-top:8px">LoRAs</span>
          <div class="ld-ed-loras" style="display:flex;flex-direction:column;gap:4px"></div>
          <button class="ld-btn" data-act="ed-addlora" style="margin-top:4px;font-size:12px;padding:4px 8px">＋ LoRA</button>
          <div class="ld-status" style="margin-top:2px">Add as many as you like. Suggestions list LoRAs the extension has seen — sync any Draw Things recipe using a LoRA once (or type its exact filename once) and it's remembered here forever.</div>
          <datalist id="ld-loras"></datalist>
          <span class="ld-label" style="margin-top:8px">Quality tags (always first)</span>
          <input class="ld-ed-quality" />
          <span class="ld-label" style="margin-top:6px">Character tags</span>
          <textarea class="ld-ed-chartags" style="min-height:40px"></textarea>
          <span class="ld-label" style="margin-top:6px">Persona tags (only when the User is in frame)</span>
          <textarea class="ld-ed-personatags" style="min-height:40px"></textarea>
          <span class="ld-label" style="margin-top:6px">Banned tags (stripped from model scene output)</span>
          <input class="ld-ed-banned" />
          <span class="ld-label" style="margin-top:6px">Prompt prefix</span>
          <textarea class="ld-ed-prefix" style="min-height:40px"></textarea>
          <span class="ld-label" style="margin-top:6px">Negative prompt</span>
          <textarea class="ld-ed-negative" style="min-height:40px"></textarea>
          <div class="ld-row" style="margin-top:10px">
            <button class="ld-btn ld-primary" data-act="ed-save">Save preset</button>
            <button class="ld-btn" data-act="ed-cancel">Cancel</button>
          </div>
          <div class="ld-status ld-ed-status" style="margin-top:6px"></div>
        </div>
      </div>
      <div class="ld-body" data-view="settings" style="display:none">
        <div>
          <span class="ld-label">Draw Things host</span>
          <input class="ld-host" />
        </div>
        <div>
          <span class="ld-label">Port (Draw Things → Settings → API Server, HTTP)</span>
          <input class="ld-port" type="number" />
        </div>
        <div class="ld-row">
          <button class="ld-btn" data-act="save-settings">Save</button>
          <button class="ld-btn" data-act="test">Test connection</button>
        </div>
        <div class="ld-status ld-settings-status"></div>
        <div style="border-top:1px solid var(--lumiverse-border, #3d4050); padding-top:10px">
          <span class="ld-label">Story illustrations</span>
          <select class="ld-mode">
            <option value="off">Off — manual only</option>
            <option value="inline">Inline — story model writes &lt;dt-image&gt; tags</option>
            <option value="parser">Parser — separate model derives the prompt afterward</option>
          </select>
          <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px">
            <input type="checkbox" class="ld-autoscan" style="width:auto" /> Auto-scan after each story message (if supported — otherwise use Scan story now)
          </label>
          <div class="ld-row" style="margin-top:6px">
            <div>
              <span class="ld-label">Min images per reply (0 = model decides)</span>
              <input class="ld-minimg" type="number" min="0" max="4" step="1" />
            </div>
            <div>
              <span class="ld-label">Max images</span>
              <input class="ld-maximg" type="number" min="1" max="4" step="1" />
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px">
            <input type="checkbox" class="ld-chartags" style="width:auto" /> Auto-include the active character's image tags in story prompts
          </label>
        </div>
        <div>
          <span class="ld-label">Parser connection (pick a cheap model — persists)</span>
          <select class="ld-parser-conn"><option value="">— default connection —</option></select>
        </div>
        <div>
          <span class="ld-label">Parser model (optional, persists)</span>
          <input class="ld-parser-model" placeholder="e.g. your Kimi deployment" />
        </div>
        <div>
          <span class="ld-label">Parser instruction — sent to the parser model with the story passage (Parser mode). Edit freely; paste your own converter prompt here.</span>
          <textarea class="ld-parser-instr" style="min-height:80px"></textarea>
          <button class="ld-btn" data-act="reset-parser" style="margin-top:4px">Reset to default</button>
        </div>
        <div>
          <span class="ld-label">Inline instruction — added to your story model's prompt (Inline mode) to teach it the &lt;dt-image&gt; tag. This is how it knows what to do. Edit freely.</span>
          <textarea class="ld-protocol" style="min-height:80px"></textarea>
          <button class="ld-btn" data-act="reset-protocol" style="margin-top:4px">Reset to default</button>
        </div>
        <div>
          <button class="ld-btn" data-act="diagnose">Run diagnostics 🔍</button>
          <textarea class="ld-diag" readonly style="min-height:120px;display:none;margin-top:6px;font-family:monospace;font-size:11px"></textarea>
        </div>
        <div class="ld-status">Story generations use the preset selected in the Generate tab (its prompt prefix becomes the character identity). Settings persist on the server across restarts.</div>
        <div class="ld-status">Tip: Draw Things shows the recipe of whatever image is selected — so select any image you love, hit Sync, and you've captured its exact settings.</div>
      </div>
    </div>
    <div class="ld-story-picker" aria-hidden="true">
      <div class="ld-story-dialog" role="dialog" aria-modal="true" aria-label="Choose a story message">
        <div class="ld-story-head">
          <span class="ld-story-title">Choose a story message</span>
          <button class="ld-x ld-story-close" title="Close">✕</button>
        </div>
        <div class="ld-story-tools">
          <input class="ld-story-search" type="search" placeholder="Search message text…" />
          <div class="ld-story-help">Newest first. Selecting a message runs Parser mode again and adds the new image without deleting existing images.</div>
        </div>
        <div class="ld-story-list"><div class="ld-story-empty">Loading messages…</div></div>
      </div>
    </div>
    <div class="ld-text-editor" aria-hidden="true">
      <div class="ld-text-editor-dialog" role="dialog" aria-modal="true" aria-label="Expanded text editor">
        <div class="ld-text-editor-head">
          <span class="ld-text-editor-title">Edit text</span>
          <button class="ld-x ld-text-editor-close" title="Cancel and close">✕</button>
        </div>
        <textarea class="ld-text-editor-area" spellcheck="true"></textarea>
        <div class="ld-text-editor-actions">
          <span class="ld-help" style="margin-right:auto">Escape cancels · ⌘/Ctrl+Enter applies</span>
          <button class="ld-btn ld-text-editor-cancel">Cancel</button>
          <button class="ld-btn ld-primary ld-text-editor-apply">Apply</button>
        </div>
      </div>
    </div>
  `)

  const $ = (sel) => dom.query(sel)
  const launcher = $('.ld-launcher')
  const panel = $('.ld-panel')
  const fullscreenToggle = $('.ld-fullscreen-toggle')
  const textEditor = $('.ld-text-editor')
  const textEditorArea = $('.ld-text-editor-area')
  const textEditorTitle = $('.ld-text-editor-title')
  const FULLSCREEN_KEY = 'lumidraw_panel_fullscreen_v1'
  let expandedTextarea = null

  // ------------------------------------------------------------------ helpers
  function setStatus(sel, msg, kind) {
    const el = $(sel)
    if (!el) return
    el.textContent = msg || ''
    el.classList.remove('ld-err', 'ld-good')
    if (kind) el.classList.add(kind === 'err' ? 'ld-err' : 'ld-good')
  }

  const DRAFT_KEY = 'lumidraw_generate_draft_v1'

  function cloneJson(value) {
    return value ? JSON.parse(JSON.stringify(value)) : value
  }

  function activeSourceForDraft() {
    const preset = activePresetObj()
    if (preset) {
      return {
        config: preset.config || {},
        negativePrompt: preset.negativePrompt || '',
        label: `chat preset “${preset.name}”`,
      }
    }
    if (syncedConfig) {
      return {
        config: syncedConfig,
        negativePrompt: $('.ld-negative') ? $('.ld-negative').value : '',
        label: 'synced Draw Things state',
      }
    }
    return null
  }

  function saveDraftLocal() {
    try {
      if (!draftConfig) return
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        config: draftConfig,
        negativePrompt: $('.ld-negative') ? $('.ld-negative').value : '',
      }))
    } catch { /* best effort */ }
  }

  function loadDraftLocal() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') }
    catch { return null }
  }

  function ensureDraftModelOption(value) {
    const select = $('.ld-draft-model')
    if (!select || !value) return
    if (![...select.options].some((option) => option.value === value)) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.insertBefore(option, select.firstChild)
    }
  }

  function draftLoraRow(file, weight) {
    const row = document.createElement('div')
    row.className = 'ld-row'
    const fileInput = document.createElement('input')
    fileInput.setAttribute('list', 'ld-loras')
    fileInput.placeholder = 'lora_file.ckpt'
    fileInput.value = file || ''
    fileInput.className = 'ld-lora-file'
    const weightInput = document.createElement('input')
    weightInput.type = 'number'
    weightInput.step = '0.05'
    weightInput.style.flex = '0 0 70px'
    weightInput.value = weight !== undefined ? weight : 1
    weightInput.className = 'ld-lora-weight'
    const remove = document.createElement('button')
    remove.className = 'ld-x'
    remove.textContent = '✕'
    remove.style.flex = '0 0 auto'
    remove.addEventListener('click', () => { row.remove(); onDraftControlChange() })
    fileInput.addEventListener('input', onDraftControlChange)
    weightInput.addEventListener('input', onDraftControlChange)
    row.appendChild(fileInput)
    row.appendChild(weightInput)
    row.appendChild(remove)
    return row
  }

  function readDraftConfigFromControls() {
    const config = cloneJson(draftConfig) || {}
    const model = $('.ld-draft-model').value || ''
    const sampler = $('.ld-draft-sampler').value.trim()
    const steps = $('.ld-draft-steps').value
    const cfg = $('.ld-draft-cfg').value
    const width = $('.ld-draft-w').value
    const height = $('.ld-draft-h').value
    if (model) config.model = model
    else delete config.model
    if (sampler) config.sampler = sampler
    else delete config.sampler
    if (steps !== '') config.steps = parseInt(steps, 10)
    else delete config.steps
    if (cfg !== '') config.guidance_scale = parseFloat(cfg)
    else delete config.guidance_scale
    if (width !== '') config.width = parseInt(width, 10)
    else delete config.width
    if (height !== '') config.height = parseInt(height, 10)
    else delete config.height
    config.loras = [...dom.queryAll('.ld-draft-loras .ld-row')].map((row) => ({
      file: row.querySelector('.ld-lora-file').value.trim(),
      weight: parseFloat(row.querySelector('.ld-lora-weight').value) || 1,
    })).filter((lora) => lora.file)
    return config
  }

  function renderDraftControls() {
    const config = draftConfig || {}
    ensureDraftModelOption(config.model || '')
    $('.ld-draft-model').value = config.model || ''
    $('.ld-draft-sampler').value = config.sampler || ''
    $('.ld-draft-steps').value = config.steps !== undefined ? config.steps : ''
    $('.ld-draft-cfg').value = config.guidance_scale !== undefined ? config.guidance_scale : ''
    $('.ld-draft-w').value = config.width || ''
    $('.ld-draft-h').value = config.height || ''
    const loraBox = $('.ld-draft-loras')
    loraBox.innerHTML = ''
    for (const lora of config.loras || []) {
      loraBox.appendChild(draftLoraRow(lora.file || lora.name || '', lora.weight))
    }
    if (!(config.loras || []).length) loraBox.appendChild(draftLoraRow('', 1))
  }

  function hydrateDraftFromSource(source, { force = false } = {}) {
    if (!source || !source.config) return false
    if (draftDirty && !force && draftConfig) return false
    draftConfig = cloneJson(source.config || {}) || {}
    draftSourceLabel = source.label || ''
    draftDirty = false
    renderDraftControls()
    $('.ld-negative').value = source.negativePrompt || ''
    renderChips()
    saveDraftLocal()
    setStatus('.ld-draft-status', draftSourceLabel
      ? `Workspace loaded from ${draftSourceLabel}.`
      : 'Workspace loaded.', 'good')
    return true
  }

  function onDraftControlChange() {
    draftConfig = readDraftConfigFromControls()
    draftDirty = true
    renderChips()
    saveDraftLocal()
    const source = draftSourceLabel ? ` Based on ${draftSourceLabel}.` : ''
    setStatus('.ld-draft-status', 'Workspace modified. Manual Generate uses these temporary settings.' + source)
  }

  function currentDraftBundle() {
    const preset = activePresetObj() || {}
    return {
      config: readDraftConfigFromControls(),
      extra: preset.extra || null,
      promptPrefix: preset.promptPrefix || '',
      negativePrompt: $('.ld-negative').value || '',
      qualityTags: preset.qualityTags || '',
      characterTags: preset.characterTags || '',
      personaTags: preset.personaTags || '',
      bannedTags: preset.bannedTags || '',
    }
  }

  let storyMessages = []

  function closeStoryPicker() {
    const picker = $('.ld-story-picker')
    if (!picker) return
    picker.classList.remove('ld-open')
    picker.setAttribute('aria-hidden', 'true')
  }

  function renderStoryPicker() {
    const list = $('.ld-story-list')
    const search = $('.ld-story-search')
    if (!list) return
    const query = String(search && search.value || '').trim().toLowerCase()
    const filtered = storyMessages.filter((item) => {
      if (!query) return true
      return String(item.preview || '').toLowerCase().includes(query) || String(item.turn || '').includes(query)
    })

    list.innerHTML = ''
    if (!filtered.length) {
      const empty = document.createElement('div')
      empty.className = 'ld-story-empty'
      empty.textContent = storyMessages.length ? 'No messages match that search.' : 'No assistant story messages were found in this chat.'
      list.appendChild(empty)
      return
    }

    for (const item of filtered) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ld-story-item'
      button.title = 'Run Parser mode on this message'

      const top = document.createElement('div')
      top.className = 'ld-story-item-top'
      const number = document.createElement('span')
      number.className = 'ld-story-number'
      number.textContent = `Story message ${item.turn}`
      top.appendChild(number)

      if (item.isLatest) {
        const badge = document.createElement('span')
        badge.className = 'ld-story-badge'
        badge.textContent = 'Latest'
        top.appendChild(badge)
      }
      if (item.hasImage) {
        const badge = document.createElement('span')
        badge.className = 'ld-story-badge'
        badge.textContent = 'Has image'
        top.appendChild(badge)
      } else if (item.processed) {
        const badge = document.createElement('span')
        badge.className = 'ld-story-badge'
        badge.textContent = 'Scanned'
        top.appendChild(badge)
      }

      const preview = document.createElement('div')
      preview.className = 'ld-story-preview'
      preview.textContent = item.preview || '(No visible prose)'
      button.appendChild(top)
      button.appendChild(preview)
      button.addEventListener('click', () => runStoryScan(item.id, `story message ${item.turn}`))
      list.appendChild(button)
    }
  }

  async function openStoryPicker() {
    const mode = $('.ld-mode') ? $('.ld-mode').value : settings.mode
    if (mode !== 'parser') {
      setStatus('.ld-gen-status', 'Choose Parser mode in Settings before rescanning an old message.', 'err')
      return
    }
    const picker = $('.ld-story-picker')
    const list = $('.ld-story-list')
    const search = $('.ld-story-search')
    if (!picker || !list) return
    storyMessages = []
    if (search) search.value = ''
    list.innerHTML = '<div class="ld-story-empty">Loading messages…</div>'
    picker.classList.add('ld-open')
    picker.setAttribute('aria-hidden', 'false')
    try {
      const res = await call('list_story_messages', { limit: 500 }, 30000)
      storyMessages = Array.isArray(res.messages) ? res.messages : []
      renderStoryPicker()
      if (search) search.focus()
    } catch (e) {
      list.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'ld-story-empty'
      empty.textContent = e.message
      list.appendChild(empty)
    }
  }

  async function runStoryScan(messageId, label = 'latest story message') {
    closeStoryPicker()
    setStatus('.ld-gen-status', `Scanning ${label}…`)
    try {
      const payload = { force: true }
      if (messageId !== undefined && messageId !== null && messageId !== '') payload.messageId = messageId
      const res = await call('scan_story', payload)
      history = (await call('init', {}, 15000)).history
      renderHistory()
      setStatus('.ld-gen-status', res.note || `Done (${res.mode}).`, res.processed ? 'good' : undefined)
    } catch (e) { setStatus('.ld-gen-status', e.message, 'err') }
  }

  function setFullscreen(enabled, persist = true) {
    const on = !!enabled
    panel.classList.toggle('ld-fullscreen', on)
    document.body.classList.toggle('ld-fullscreen-lock', on && panel.classList.contains('ld-open'))
    fullscreenToggle.textContent = on ? '↙' : '⛶'
    fullscreenToggle.title = on ? 'Return to floating panel' : 'Open fullscreen'
    fullscreenToggle.setAttribute('aria-label', fullscreenToggle.title)
    fullscreenToggle.setAttribute('aria-pressed', String(on))
    if (persist) {
      try { localStorage.setItem(FULLSCREEN_KEY, on ? '1' : '0') } catch { /* ignore */ }
    }
    if (!on && panel.classList.contains('ld-open')) placePanel()
  }

  function textareaTitle(textarea) {
    const titles = [
      ['ld-prompt', 'Generation prompt'],
      ['ld-negative', 'Workspace negative prompt'],
      ['ld-ed-chartags', 'Character tags'],
      ['ld-ed-personatags', 'Persona tags'],
      ['ld-ed-prefix', 'Prompt prefix'],
      ['ld-ed-negative', 'Preset negative prompt'],
      ['ld-parser-instr', 'Parser instruction'],
      ['ld-protocol', 'Inline instruction'],
    ]
    for (const [className, title] of titles) if (textarea.classList.contains(className)) return title
    const parentLabel = textarea.parentElement && textarea.parentElement.querySelector('.ld-label')
    return parentLabel ? parentLabel.textContent.trim() : 'Expanded text editor'
  }

  function openTextEditor(textarea) {
    if (!textarea) return
    expandedTextarea = textarea
    textEditorTitle.textContent = textareaTitle(textarea)
    textEditorArea.value = textarea.value || ''
    textEditor.classList.add('ld-open')
    textEditor.setAttribute('aria-hidden', 'false')
    document.body.classList.add('ld-fullscreen-lock')
    setTimeout(() => {
      textEditorArea.focus()
      textEditorArea.setSelectionRange(textEditorArea.value.length, textEditorArea.value.length)
    }, 0)
  }

  function closeTextEditor(apply) {
    if (apply && expandedTextarea) {
      expandedTextarea.value = textEditorArea.value
      expandedTextarea.dispatchEvent(new Event('input', { bubbles: true }))
      expandedTextarea.dispatchEvent(new Event('change', { bubbles: true }))
    }
    expandedTextarea = null
    textEditor.classList.remove('ld-open')
    textEditor.setAttribute('aria-hidden', 'true')
    document.body.classList.toggle('ld-fullscreen-lock', panel.classList.contains('ld-fullscreen') && panel.classList.contains('ld-open'))
  }

  function decorateTextareas() {
    for (const textarea of dom.queryAll('.ld-panel textarea')) {
      if (textarea.readOnly || textarea.dataset.ldExpandable === '1') continue
      textarea.dataset.ldExpandable = '1'
      const wrapper = document.createElement('div')
      wrapper.className = 'ld-textarea-wrap'
      textarea.parentNode.insertBefore(wrapper, textarea)
      wrapper.appendChild(textarea)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ld-textarea-expand'
      button.textContent = '⛶'
      button.title = `Expand ${textareaTitle(textarea)}`
      button.setAttribute('aria-label', button.title)
      button.addEventListener('click', () => openTextEditor(textarea))
      wrapper.appendChild(button)
    }
  }

  function renderChips() {
    const el = $('.ld-config-chips')
    if (!el) return
    if (!draftConfig) {
      el.innerHTML = '<span class="ld-status">No workspace loaded yet — choose a preset or press Sync.</span>'
      return
    }
    const c = draftConfig
    const bits = []
    if (c.model) bits.push(`model: ${c.model}`)
    if (c.sampler) bits.push(`sampler: ${c.sampler}`)
    if (c.steps !== undefined) bits.push(`${c.steps} steps`)
    if (c.guidance_scale !== undefined) bits.push(`cfg ${c.guidance_scale}`)
    if (c.width && c.height) bits.push(`${c.width}×${c.height}`)
    if (Array.isArray(c.loras) && c.loras.length) bits.push(`${c.loras.length} LoRA(s)`)
    el.innerHTML = bits.map((b) => {
      const span = document.createElement('span')
      span.className = 'ld-chip'
      span.textContent = b
      span.title = b
      return span.outerHTML
    }).join('')
  }

  function renderPresetSelect() {
    const sel = $('.ld-preset-select')
    if (!sel) return
    const current = activePreset || ''
    sel.innerHTML = '<option value="">— none (synced state) —</option>' +
      presets.map((p) => {
        const o = document.createElement('option')
        o.value = p.name
        o.textContent = p.name
        return o.outerHTML
      }).join('')
    sel.value = current
  }

  function renderPresetList() {
    const list = $('.ld-preset-list')
    if (!list) return
    list.innerHTML = ''
    if (!presets.length) {
      list.innerHTML = '<div class="ld-status">No presets yet.</div>'
      return
    }
    for (const p of presets) {
      const item = document.createElement('div')
      item.className = 'ld-preset-item' + (p.name === activePreset ? ' ld-active' : '')
      const name = document.createElement('span')
      name.className = 'ld-preset-name'
      name.textContent = p.name
      const model = document.createElement('span')
      model.className = 'ld-preset-model'
      model.textContent = (p.config && p.config.model) || ''
      name.appendChild(model)
      name.addEventListener('click', () => selectPreset(p.name))
      const ed = document.createElement('button')
      ed.className = 'ld-append'
      ed.textContent = 'Edit'
      ed.style.flex = '0 0 auto'
      ed.style.width = 'auto'
      ed.style.padding = '3px 8px'
      ed.addEventListener('click', (ev) => { ev.stopPropagation(); openEditor(p.name) })
      const del = document.createElement('button')
      del.className = 'ld-x'
      del.textContent = '✕'
      del.title = `Delete "${p.name}"`
      del.addEventListener('click', async () => {
        try {
          const res = await call('delete_preset', { name: p.name })
          presets = res.presets
          if (activePreset === p.name) { activePreset = null }
          renderPresetList(); renderPresetSelect()
        } catch (e) { setStatus('.ld-preset-status', e.message, 'err') }
      })
      item.appendChild(name)
      item.appendChild(ed)
      item.appendChild(del)
      list.appendChild(item)
    }
  }

  async function appendToChat(img, entry) {
    setStatus('.ld-gen-status', 'Adding to chat…')
    try {
      const res = await call('append_to_chat', {
        imageUrl: img.url,
        alt: (entry && entry.prompt) ? entry.prompt.slice(0, 120) : 'Generated image',
      })
      setStatus('.ld-gen-status', res.mode === 'inserted'
        ? 'Placed at the top of the latest story message.'
        : 'Could not edit the latest message — posted as a new message instead.', 'good')
    } catch (e) {
      setStatus('.ld-gen-status', e.message, 'err')
    }
  }

  function renderHistory() {
    const el = $('.ld-history')
    if (!el) return
    el.innerHTML = ''
    for (const entry of history) {
      for (const img of entry.images || []) {
        const wrap = document.createElement('div')
        wrap.className = 'ld-thumb'
        const im = document.createElement('img')
        im.src = img.url
        im.title = `${entry.model}\nseed ${entry.seed}\n${entry.prompt || ''}`.trim()
        im.addEventListener('click', () => window.open(img.url, '_blank'))
        const row = document.createElement('div')
        row.className = 'ld-thumb-row'
        const btn = document.createElement('button')
        btn.className = 'ld-append'
        btn.textContent = 'Insert'
        btn.title = 'Place this image into the latest story message'
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); appendToChat(img, entry) })
        const rm = document.createElement('button')
        rm.className = 'ld-append ld-remove'
        rm.textContent = 'Remove'
        rm.title = 'Take this image out of the chat (keeps the image)'
        rm.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          const orig = rm.textContent
          rm.textContent = '…'
          try {
            await call('remove_from_chat', { imageUrl: img.url })
            rm.textContent = 'Not in chat ✓'
            setTimeout(() => { rm.textContent = orig }, 2500)
          } catch (e) {
            rm.textContent = orig
            setStatus('.ld-gen-status', e.message, 'err')
          }
        })
        const del = document.createElement('button')
        del.className = 'ld-append ld-remove'
        del.textContent = 'Delete'
        del.title = 'Delete this image everywhere: chat, image library, and this list'
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          wrap.style.opacity = '0.35'
          wrap.style.pointerEvents = 'none'
          del.textContent = 'Deleting…'
          try {
            const res = await call('delete_image', { imageUrl: img.url, imageId: img.id })
            history = res.history
            renderHistory()
          } catch (e) {
            wrap.style.opacity = ''
            wrap.style.pointerEvents = ''
            del.textContent = 'Delete'
            setStatus('.ld-gen-status', e.message, 'err')
          }
        })
        row.appendChild(btn)
        row.appendChild(rm)
        row.appendChild(del)
        wrap.appendChild(im)
        wrap.appendChild(row)
        el.appendChild(wrap)
      }
    }
  }

  function selectPreset(name) {
    const preset = presets.find((item) => item.name === name)
    activePreset = preset ? preset.name : null
    call('set_active_preset', { name: activePreset || '' }).catch(() => {})
    if (preset) {
      syncedConfig = { ...preset.config }
      if (!draftConfig || !draftDirty) {
        hydrateDraftFromSource({
          config: preset.config || {},
          negativePrompt: preset.negativePrompt || '',
          label: `chat preset “${preset.name}”`,
        }, { force: true })
      } else {
        setStatus('.ld-draft-status', `Chat preset changed to “${preset.name}”. Your temporary workspace was kept; use Reset workspace to load the preset.`)
      }
    }
    renderChips(); renderPresetSelect(); renderPresetList()
  }

  function activePresetObj() {
    return presets.find((x) => x.name === activePreset) || null
  }

  // ------------------------------------------------------------------ actions
  async function doSync(statusSel) {
    setStatus(statusSel, 'Syncing from Draw Things…')
    const res = await call('sync_state')
    syncedConfig = res.captured
    activePreset = null
    renderPresetSelect()
    if (!draftConfig || !draftDirty) {
      hydrateDraftFromSource({
        config: syncedConfig,
        negativePrompt: $('.ld-negative').value || '',
        label: 'synced Draw Things state',
      }, { force: true })
    } else {
      setStatus('.ld-draft-status', 'Draw Things state captured. Your temporary workspace was kept; use Reset workspace to load the new sync.')
      renderChips()
    }
    setStatus(statusSel, `Captured ${res.captured.model || '(no model)'}`, 'good')
  }

  async function doGenerate() {
    if (busy) return
    draftConfig = readDraftConfigFromControls()
    if (!draftConfig || !draftConfig.model) {
      setStatus('.ld-gen-status', 'No model set in the workspace — choose a preset, press Sync, or pick a model.', 'err')
      return
    }
    busy = true
    const btn = $('[data-act="generate"]')
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ld-spin">◌</span> Generating…' }
    setStatus('.ld-gen-status', 'Sent to Draw Things — hold tight…')
    try {
      const bundle = currentDraftBundle()
      const seedRaw = $('.ld-seed').value
      const res = await call('generate', {
        prompt: $('.ld-prompt').value,
        qualityTags: bundle.qualityTags,
        characterTags: bundle.characterTags,
        negativePrompt: bundle.negativePrompt,
        seed: seedRaw === '' ? undefined : Number(seedRaw),
        config: bundle.config,
        extra: bundle.extra,
      })
      history = res.history
      renderHistory()
      const secs = (res.entry.durationMs / 1000).toFixed(1)
      setStatus('.ld-gen-status', `Done in ${secs}s · ${res.entry.model} · seed ${res.entry.seed}. Saved to your image library.`, 'good')
      const ab = $('[data-act="append-last"]')
      if (ab) ab.style.display = ''
    } catch (e) {
      setStatus('.ld-gen-status', e.message, 'err')
    } finally {
      busy = false
      if (btn) { btn.disabled = false; btn.textContent = 'Generate with workspace' }
    }
  }

  // ------------------------------------------------------------------ wiring
  // Draggable launcher: drag to move (position persists), tap to toggle.
  const POS_KEY = 'lumidraw_launcher_pos'
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function applyPos(x, y) {
    x = clamp(x, 4, window.innerWidth - launcher.offsetWidth - 4)
    y = clamp(y, 4, window.innerHeight - launcher.offsetHeight - 4)
    launcher.style.left = x + 'px'
    launcher.style.top = y + 'px'
    launcher.style.right = 'auto'
    launcher.style.bottom = 'auto'
    return { x, y }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (saved && Number.isFinite(saved.x)) applyPos(saved.x, saved.y)
  } catch { /* default CSS position */ }

  function placePanel() {
    if (panel.classList.contains('ld-fullscreen')) return
    const r = launcher.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const spaceAbove = r.top - 16
    const spaceBelow = vh - r.bottom - 16
    // Open on whichever side has more room, and never let the panel exceed it.
    const openAbove = spaceAbove >= spaceBelow
    const maxH = Math.min(720, Math.max(240, (openAbove ? spaceAbove : spaceBelow) - 4))
    panel.style.maxHeight = maxH + 'px'
    const pw = panel.offsetWidth || 384
    const ph = Math.min(panel.offsetHeight || 500, maxH)
    const left = clamp(r.right - pw, 8, vw - pw - 8)
    const top = openAbove
      ? clamp(r.top - ph - 10, 8, vh - ph - 8)
      : clamp(r.bottom + 10, 8, vh - ph - 8)
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  }

  let drag = null
  launcher.addEventListener('pointerdown', (e) => {
    const r = launcher.getBoundingClientRect()
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false }
    if (launcher.setPointerCapture) { try { launcher.setPointerCapture(e.pointerId) } catch { /* ok */ } }
  })
  launcher.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.sx
    const dy = e.clientY - drag.sy
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true
    if (drag.moved) {
      const p = applyPos(drag.ox + dx, drag.oy + dy)
      drag.last = p
      if (panel.classList.contains('ld-open')) placePanel()
    }
  })
  launcher.addEventListener('pointerup', () => {
    if (!drag) return
    if (drag.moved) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(drag.last)) } catch { /* ok */ }
    } else {
      panel.classList.toggle('ld-open')
      if (panel.classList.contains('ld-open')) {
        placePanel()
        document.body.classList.toggle('ld-fullscreen-lock', panel.classList.contains('ld-fullscreen'))
        if (!initialized) tryInit()
      } else {
        document.body.classList.remove('ld-fullscreen-lock')
      }
    }
    drag = null
  })

  for (const tab of dom.queryAll('.ld-tabbtn')) {
    tab.addEventListener('click', () => {
      for (const t of dom.queryAll('.ld-tabbtn')) t.classList.toggle('ld-active', t === tab)
      for (const v of dom.queryAll('.ld-body')) {
        v.style.display = v.getAttribute('data-view') === tab.getAttribute('data-tab') ? 'flex' : 'none'
      }
    })
  }

  fullscreenToggle.addEventListener('click', () => setFullscreen(!panel.classList.contains('ld-fullscreen')))
  $('.ld-min').addEventListener('click', () => {
    panel.classList.remove('ld-open')
    document.body.classList.remove('ld-fullscreen-lock')
  })
  $('.ld-text-editor-close').addEventListener('click', () => closeTextEditor(false))
  $('.ld-text-editor-cancel').addEventListener('click', () => closeTextEditor(false))
  $('.ld-text-editor-apply').addEventListener('click', () => closeTextEditor(true))
  textEditor.addEventListener('click', (event) => {
    if (event.target === textEditor) closeTextEditor(false)
  })
  textEditorArea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      closeTextEditor(true)
    }
  })
  decorateTextareas()
  try { setFullscreen(localStorage.getItem(FULLSCREEN_KEY) === '1', false) } catch { setFullscreen(false, false) }

  $('.ld-preset-select').addEventListener('change', (e) => {
    if (e.target.value) selectPreset(e.target.value)
    else {
      activePreset = null
      call('set_active_preset', { name: '' }).catch(() => {})
      renderPresetList(); renderPresetSelect()
    }
  })

  // ---------------- preset editor ----------------
  let editorOriginalName = null
  let editorExtra = null

  async function loadCatalog() {
    try {
      const res = await call('list_models', {}, 20000)
      catalog = {
        models: res.models || [],
        samplers: res.samplers || [],
        loras: res.loras || [],
        source: res.source || 'memory',
      }
      const sel = $('.ld-ed-model')
      sel.innerHTML = catalog.models.map((model) => `<option value="${model.file}">${model.file}</option>`).join('')
      const draftSelect = $('.ld-draft-model')
      if (draftSelect) {
        draftSelect.innerHTML = '<option value="">— choose model —</option>' +
          catalog.models.map((model) => `<option value="${model.file}">${model.file}</option>`).join('')
      }
      $('#ld-samplers').innerHTML = catalog.samplers.map((sampler) => `<option value="${sampler}"></option>`).join('')
      $('#ld-loras').innerHTML = catalog.loras.map((lora) => `<option value="${lora}"></option>`).join('')
      if (draftConfig) renderDraftControls()
    } catch (e) { console.log('[LumiDraw] catalog load failed:', e.message) }
  }

  function loraRow(file, weight) {
    const row = document.createElement('div')
    row.className = 'ld-row'
    const fi = document.createElement('input')
    fi.setAttribute('list', 'ld-loras')
    fi.placeholder = 'lora_file.ckpt'
    fi.value = file || ''
    fi.className = 'ld-lora-file'
    const wi = document.createElement('input')
    wi.type = 'number'; wi.step = '0.05'; wi.style.flex = '0 0 70px'
    wi.value = weight !== undefined ? weight : 1
    wi.className = 'ld-lora-weight'
    const x = document.createElement('button')
    x.className = 'ld-x'; x.textContent = '✕'; x.style.flex = '0 0 auto'
    x.addEventListener('click', () => row.remove())
    row.appendChild(fi); row.appendChild(wi); row.appendChild(x)
    return row
  }

  async function openEditor(nameOrNull, seedPreset = null) {
    await loadCatalog()
    const box = $('.ld-editor')
    box.style.display = 'block'
    const p = nameOrNull ? presets.find((x) => x.name === nameOrNull) : null
    const seed = seedPreset || null
    editorOriginalName = p ? p.name : null
    editorExtra = p ? (p.extra || null) : (seed ? (seed.extra || null) : null)
    const c = p ? (p.config || {}) : (seed ? (seed.config || {}) : (syncedConfig || {}))
    $('.ld-ed-name').value = p ? p.name : ''
    const msel = $('.ld-ed-model')
    if (c.model && ![...msel.options].some((o) => o.value === c.model)) {
      const o = document.createElement('option'); o.value = c.model; o.textContent = c.model
      msel.insertBefore(o, msel.firstChild)
    }
    msel.value = c.model || (msel.options[0] ? msel.options[0].value : '')
    $('.ld-ed-sampler').value = c.sampler || ''
    $('.ld-ed-steps').value = c.steps !== undefined ? c.steps : ''
    $('.ld-ed-cfg').value = c.guidance_scale !== undefined ? c.guidance_scale : ''
    $('.ld-ed-w').value = c.width || ''
    $('.ld-ed-h').value = c.height || ''
    const lbox = $('.ld-ed-loras')
    lbox.innerHTML = ''
    for (const l of c.loras || []) lbox.appendChild(loraRow(l.file || l.name || '', l.weight))
    $('.ld-ed-quality').value = p ? (p.qualityTags || '') : (seed ? (seed.qualityTags || '') : '')
    $('.ld-ed-chartags').value = p ? (p.characterTags || '') : (seed ? (seed.characterTags || '') : '')
    $('.ld-ed-personatags').value = p ? (p.personaTags || '') : (seed ? (seed.personaTags || '') : '')
    $('.ld-ed-banned').value = p ? (p.bannedTags || '') : (seed ? (seed.bannedTags || '') : '')
    $('.ld-ed-prefix').value = p ? (p.promptPrefix || '') : (seed ? (seed.promptPrefix || '') : '')
    $('.ld-ed-negative').value = p ? (p.negativePrompt || '') : (seed ? (seed.negativePrompt || '') : '')
    setStatus('.ld-ed-status', p ? '' : (seed ? 'Starting from the current workspace.' : (syncedConfig ? 'Starting from the last synced recipe.' : 'No synced recipe yet — Sync on the Generate tab first for model/sampler defaults.')))
    if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  $('[data-act="new-preset"]').addEventListener('click', () => openEditor(null))
  $('[data-act="ed-cancel"]').addEventListener('click', () => { $('.ld-editor').style.display = 'none' })
  $('[data-act="ed-addlora"]').addEventListener('click', () => $('.ld-ed-loras').appendChild(loraRow('', 1)))

  $('[data-act="draft-addlora"]').addEventListener('click', () => {
    $('.ld-draft-loras').appendChild(draftLoraRow('', 1))
    onDraftControlChange()
  })

  $('[data-act="draft-reset"]').addEventListener('click', () => {
    const source = activeSourceForDraft()
    if (!source) {
      setStatus('.ld-draft-status', 'Nothing to reset from yet — choose a preset or press Sync first.', 'err')
      return
    }
    hydrateDraftFromSource(source, { force: true })
  })

  $('[data-act="draft-save-new"]').addEventListener('click', () => {
    const bundle = currentDraftBundle()
    if (!bundle.config || !bundle.config.model) {
      setStatus('.ld-draft-status', 'Choose a model in the workspace first.', 'err')
      return
    }
    openEditor(null, bundle)
  })

  $('[data-act="draft-save-active"]').addEventListener('click', async () => {
    try {
      if (!activePreset) throw new Error('No active preset selected. Choose one or use Save as new preset.')
      const bundle = currentDraftBundle()
      const result = await call('save_preset', {
        name: activePreset,
        config: bundle.config,
        extra: bundle.extra,
        promptPrefix: bundle.promptPrefix,
        negativePrompt: bundle.negativePrompt,
        qualityTags: bundle.qualityTags,
        characterTags: bundle.characterTags,
        personaTags: bundle.personaTags,
        bannedTags: bundle.bannedTags,
      })
      presets = result.presets
      syncedConfig = cloneJson(bundle.config)
      draftDirty = false
      renderPresetList(); renderPresetSelect(); renderChips()
      setStatus('.ld-draft-status', `Updated active preset “${activePreset}” from the workspace.`, 'good')
    } catch (error) {
      setStatus('.ld-draft-status', error.message, 'err')
    }
  })

  for (const selector of ['.ld-draft-model', '.ld-draft-sampler', '.ld-draft-steps', '.ld-draft-cfg', '.ld-draft-w', '.ld-draft-h', '.ld-negative']) {
    const control = $(selector)
    if (control) control.addEventListener('input', onDraftControlChange)
  }

  $('[data-act="ed-save"]').addEventListener('click', async () => {
    try {
      const name = $('.ld-ed-name').value.trim()
      if (!name) throw new Error('Preset needs a name.')
      const base = editorOriginalName ? (presets.find((x) => x.name === editorOriginalName) || {}) : {}
      const config = { ...(base.config || syncedConfig || {}) }
      config.model = $('.ld-ed-model').value
      if (!config.model) throw new Error('Pick a model.')
      const setIf = (sel, key, float) => {
        const v = $(sel).value
        if (v !== '') config[key] = float ? parseFloat(v) : (isNaN(Number(v)) ? v : parseInt(v, 10))
        }
      const sv = $('.ld-ed-sampler').value.trim(); if (sv) config.sampler = sv
      setIf('.ld-ed-steps', 'steps'); setIf('.ld-ed-cfg', 'guidance_scale', true)
      setIf('.ld-ed-w', 'width'); setIf('.ld-ed-h', 'height')
      config.loras = [...$('.ld-editor').querySelectorAll('.ld-ed-loras .ld-row')].map((row) => ({
        file: row.querySelector('.ld-lora-file').value.trim(),
        weight: parseFloat(row.querySelector('.ld-lora-weight').value) || 1,
      })).filter((l) => l.file)
      const res = await call('save_preset', {
        name,
        config,
        extra: editorExtra,
        promptPrefix: $('.ld-ed-prefix').value,
        negativePrompt: $('.ld-ed-negative').value,
        qualityTags: $('.ld-ed-quality').value,
        characterTags: $('.ld-ed-chartags').value,
        personaTags: $('.ld-ed-personatags').value,
        bannedTags: $('.ld-ed-banned').value,
      })
      presets = res.presets
      if (editorOriginalName && editorOriginalName !== name) {
        const res2 = await call('delete_preset', { name: editorOriginalName })
        presets = res2.presets
      }
      if (!editorOriginalName || activePreset === editorOriginalName || activePreset === name) {
        selectPreset(name)
      }
      renderPresetList(); renderPresetSelect(); renderChips()
      setStatus('.ld-ed-status', `Saved "${name}".`, 'good')
      editorOriginalName = name
    } catch (e) { setStatus('.ld-ed-status', e.message, 'err') }
  })

  $('[data-act="sync"]').addEventListener('click', () =>
    doSync('.ld-gen-status').catch((e) => setStatus('.ld-gen-status', e.message, 'err')))

  $('[data-act="generate"]').addEventListener('click', doGenerate)

  $('[data-act="scan"]').addEventListener('click', () => runStoryScan(null, 'the latest story message'))
  $('[data-act="scan-old"]').addEventListener('click', openStoryPicker)

  // Also expose the picker through Lumiverse's native chat-input Extras menu.
  // This gives the feature a second, host-managed entry point and makes it
  // obvious when the updated frontend bundle is actually loaded.
  if (ctx.ui && typeof ctx.ui.registerInputBarAction === 'function') {
    try {
      rescanInputAction = ctx.ui.registerInputBarAction({
        id: 'rescan-old-story-message',
        label: 'Rescan old message',
        enabled: true,
        iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>',
      })
      rescanInputActionUnsub = rescanInputAction.onClick(openStoryPicker)
    } catch (e) {
      console.log('[LumiDraw] input-bar rescan action unavailable:', e.message)
    }
  }
  $('.ld-story-close').addEventListener('click', closeStoryPicker)
  $('.ld-story-search').addEventListener('input', renderStoryPicker)
  $('.ld-story-picker').addEventListener('click', (event) => {
    if (event.target === $('.ld-story-picker')) closeStoryPicker()
  })
  const onStoryPickerKeyDown = (event) => {
    if (event.key !== 'Escape') return
    if (textEditor.classList.contains('ld-open')) {
      closeTextEditor(false)
      return
    }
    if ($('.ld-story-picker').classList.contains('ld-open')) {
      closeStoryPicker()
      return
    }
    if (panel.classList.contains('ld-fullscreen')) setFullscreen(false)
  }
  window.addEventListener('keydown', onStoryPickerKeyDown)

  $('[data-act="diagnose"]').addEventListener('click', async () => {
    setStatus('.ld-settings-status', 'Probing the host…')
    try {
      const res = await call('diagnose', {}, 30000)
      const ta = $('.ld-diag')
      ta.style.display = ''
      ta.value = res.report
      setStatus('.ld-settings-status', 'Done — copy the box below and send it to Claude.', 'good')
    } catch (e) { setStatus('.ld-settings-status', e.message, 'err') }
  })

  $('[data-act="reset-parser"]').addEventListener('click', () => {
    $('.ld-parser-instr').value = defaults.parserInstruction || ''
  })
  $('[data-act="reset-protocol"]').addEventListener('click', () => {
    $('.ld-protocol').value = defaults.protocol || ''
  })

  $('[data-act="append-last"]').addEventListener('click', () => {
    const last = history[0]
    if (last && last.images && last.images[0]) appendToChat(last.images[0], last)
  })

  let clearArmed = false
  $('.ld-clearall').addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true
      $('.ld-clearall').textContent = 'Really delete all?'
      setTimeout(() => { clearArmed = false; $('.ld-clearall').textContent = 'Clear all' }, 4000)
      return
    }
    clearArmed = false
    $('.ld-clearall').textContent = 'Clear all'
    setStatus('.ld-gen-status', 'Deleting all recent images…')
    try {
      const res = await call('clear_history', { deleteImages: true }, 60000)
      history = res.history
      renderHistory()
      setStatus('.ld-gen-status', 'All recent images deleted.', 'good')
    } catch (e) { setStatus('.ld-gen-status', e.message, 'err') }
  })

  $('[data-act="reuse-seed"]').addEventListener('click', () => {
    const last = history[0]
    if (last && last.seed !== undefined && last.seed !== 'random') {
      $('.ld-seed').value = last.seed
    } else {
      setStatus('.ld-gen-status', 'Last generation used a random seed Draw Things picked — no seed to reuse.', 'err')
    }
  })

  async function pushSettings(statusMsg) {
    const res = await call('save_settings', {
      host: $('.ld-host').value,
      port: $('.ld-port').value,
      mode: $('.ld-mode').value,
      autoScan: $('.ld-autoscan').checked,
      parserConnection: $('.ld-parser-conn').value,
      parserModel: $('.ld-parser-model').value,
      parserInstruction: $('.ld-parser-instr').value,
      protocol: $('.ld-protocol').value,
      maxImages: $('.ld-maximg').value,
      minImages: $('.ld-minimg').value,
      autoCharTags: $('.ld-chartags').checked,
    })
    settings = res.settings
    updateScanLabel()
    if (statusMsg) setStatus('.ld-settings-status', statusMsg, 'good')
    return res
  }

  function updateScanLabel() {
    const btn = $('[data-act="scan"]')
    const oldBtn = $('[data-act="scan-old"]')
    const mode = $('.ld-mode') ? $('.ld-mode').value : 'off'
    if (btn) {
      btn.textContent = mode === 'off'
        ? 'Scan story now 📖 (mode: Off — set in Settings)'
        : `Scan story now 📖 (${mode})`
    }
    if (oldBtn) {
      oldBtn.disabled = mode !== 'parser'
      oldBtn.title = mode === 'parser'
        ? 'Choose any assistant message in the current chat and run Parser mode on it'
        : 'Old-message rescanning is available when Story illustrations is set to Parser'
    }
  }

  // All settings text fields auto-save as you type (debounced).
  let settingsSaveTimer = null
  for (const sel of ['.ld-parser-instr', '.ld-protocol', '.ld-parser-model', '.ld-host', '.ld-port']) {
    const el = $(sel)
    if (el) el.addEventListener('input', () => {
      clearTimeout(settingsSaveTimer)
      settingsSaveTimer = setTimeout(() => {
        pushSettings('Settings saved.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
      }, 900)
    })
  }

  // Story controls save themselves immediately — no Save press needed.
  for (const sel of ['.ld-mode', '.ld-autoscan', '.ld-maximg', '.ld-minimg', '.ld-chartags', '.ld-parser-conn']) {
    const el = $(sel)
    if (el) el.addEventListener('change', () => {
      pushSettings('Story settings saved.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
    })
  }

  $('[data-act="save-settings"]').addEventListener('click', async () => {
    try {
      await pushSettings(`Saved — pointing at ${$('.ld-host').value}:${$('.ld-port').value}.`)
    } catch (e) {
      setStatus('.ld-settings-status', e.message, 'err')
    }
  })

  $('[data-act="test"]').addEventListener('click', async () => {
    setStatus('.ld-settings-status', 'Testing…')
    try {
      const res = await call('test_connection')
      setStatus('.ld-settings-status', `Connected. Current model: ${res.model}`, 'good')
    } catch (e) {
      setStatus('.ld-settings-status', e.message, 'err')
    }
  })

  // Streaming tag interception: pre-generate the moment a <dt-image> tag
  // completes mid-reply, so the image is ready when the message finishes.
  ;(() => {
    const m = ctx.messages
    if (!m || typeof m.registerTagInterceptor !== 'function') {
      console.log('[LumiDraw] messages.registerTagInterceptor unavailable — inline images generate after the reply completes (compat mode)')
      return
    }
    const onTag = (payload) => {
      try {
        let body = ''
        let aspect = ''
        if (typeof payload === 'string') {
          const mm = /<dt-image([^>]*)>([\s\S]*?)<\/dt-image>/.exec(payload)
          if (mm) { body = mm[2]; aspect = (/aspect\s*=\s*"([^"]+)"/.exec(mm[1] || '') || [])[1] || '' }
          else body = payload
        } else if (payload && typeof payload === 'object') {
          body = payload.body || payload.content || payload.inner || payload.text || ''
          const attrs = payload.attributes || payload.attrs || {}
          aspect = attrs.aspect || ''
          if (!body && payload.raw) {
            const mm = /<dt-image([^>]*)>([\s\S]*?)<\/dt-image>/.exec(payload.raw)
            if (mm) { body = mm[2]; aspect = aspect || (/aspect\s*=\s*"([^"]+)"/.exec(mm[1] || '') || [])[1] || '' }
          }
        }
        body = String(body || '').trim()
        if (!body) { console.log('[LumiDraw] streaming tag payload unrecognized:', typeof payload, payload && Object.keys(payload)); return }
        console.log('[LumiDraw] streaming tag complete — pregenerating')
        ctx.sendToBackend({ type: 'pregenerate', requestId: makeId(), body, aspect })
      } catch (e) { console.log('[LumiDraw] tag interceptor error:', e.message) }
    }
    const shapes = [
      () => m.registerTagInterceptor('dt-image', onTag),
      () => m.registerTagInterceptor({ tag: 'dt-image', handler: onTag }),
      () => m.registerTagInterceptor({ tagName: 'dt-image', onComplete: onTag }),
    ]
    for (const s of shapes) {
      try { s(); console.log('[LumiDraw] streaming tag interceptor registered'); return } catch { /* next shape */ }
    }
    console.log('[LumiDraw] registerTagInterceptor exists but no call shape accepted — compat mode')
  })()

  // ------------------------------------------------------------------ boot
  let initialized = false
  async function tryInit() {
    if (initialized) return true
    try {
      const res = await call('init', {}, 8000)
      settings = res.settings; presets = res.presets; history = res.history
      defaults = res.defaults || defaults
      $('.ld-host').value = settings.host
      $('.ld-port').value = settings.port
      $('.ld-mode').value = settings.mode || 'off'
      $('.ld-autoscan').checked = settings.autoScan !== false
      $('.ld-maximg').value = settings.maxImages || 2
      $('.ld-minimg').value = settings.minImages || 0
      $('.ld-chartags').checked = settings.autoCharTags !== false
      try {
        const cres = await call('list_connections', {}, 10000)
        const sel = $('.ld-parser-conn')
        sel.innerHTML = '<option value="">— default connection —</option>' +
          (cres.connections || []).map((c) => {
            const o = document.createElement('option')
            o.value = c.id
            o.textContent = c.name + (c.model ? ' — ' + c.model : '')
            return o.outerHTML
          }).join('')
      } catch (e) { console.log('[LumiDraw] connections list failed:', e.message) }
      $('.ld-parser-conn').value = settings.parserConnection || ''
      $('.ld-parser-model').value = settings.parserModel || ''
      $('.ld-parser-instr').value = settings.parserInstruction || defaults.parserInstruction || ''
      $('.ld-protocol').value = settings.protocol || defaults.protocol || ''
      await loadCatalog()
      if (settings.activePreset) { activePreset = settings.activePreset }
      if (activePreset) {
        const p = presets.find((x) => x.name === activePreset)
        if (p) { syncedConfig = { ...p.config } }
        else activePreset = null
      }
      const savedDraft = loadDraftLocal()
      if (savedDraft && savedDraft.config && savedDraft.config.model) {
        draftConfig = savedDraft.config
        renderDraftControls()
        $('.ld-negative').value = savedDraft.negativePrompt || ''
        renderChips()
        setStatus('.ld-draft-status', 'Restored your last workspace draft.')
      } else if (activePreset) {
        const p = presets.find((x) => x.name === activePreset)
        if (p) {
          hydrateDraftFromSource({
            config: p.config || {},
            negativePrompt: p.negativePrompt || '',
            label: `chat preset “${p.name}”`,
          }, { force: true })
        }
      }
      renderPresetSelect(); renderPresetList(); renderHistory(); renderChips()
      updateScanLabel()
      initialized = true
      console.log(`[LumiDraw] backend connected — UI v${EXTENSION_VERSION}`)
      return true
    } catch (e) {
      console.log('[LumiDraw] backend not ready yet:', e.message)
      return false
    }
  }
  ;(async () => {
    // Silent boot: the backend restarts alongside the extension on every
    // update, so early failures are expected — retry quietly, never show
    // an error the user didn't cause.
    for (let i = 0; i < 6 && !initialized; i++) {
      if (await tryInit()) return
      await new Promise((r) => setTimeout(r, 4000))
    }
  })()

  return () => {
    if (typeof rescanInputActionUnsub === 'function') rescanInputActionUnsub()
    if (rescanInputAction && typeof rescanInputAction.destroy === 'function') rescanInputAction.destroy()
    window.removeEventListener('keydown', onStoryPickerKeyDown)
    document.body.classList.remove('ld-fullscreen-lock')
    unsub()
    removeStyle()
    dom.cleanup()
  }
}
