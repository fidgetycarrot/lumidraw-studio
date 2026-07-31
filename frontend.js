// LumiDraw Studio — frontend
// Injects a launcher button + studio panel styled with Lumiverse theme
// variables. All traffic goes through the backend module.

console.log('[LumiDraw] frontend module imported')

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
        try { const r = dom.queryAll(sel); if (r && r.length) return r } catch { /* fall through */ }
      }
      return Array.from(document.querySelectorAll(sel))
    },
    cleanup() {
      if (ctx.dom && typeof ctx.dom.cleanup === 'function') {
        try { dom.cleanup() } catch { /* ignore */ }
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
  let busy = false
  const pending = new Map() // requestId → {resolve, reject}

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
      width: 42px; height: 42px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border);
      color: var(--lumiverse-text); cursor: pointer; font-size: 19px;
      box-shadow: 0 2px 10px rgba(0,0,0,.28); user-select: none;
    }
    .ld-launcher:hover { background: var(--lumiverse-fill-subtle); }
    .ld-panel {
      position: fixed; right: 16px; bottom: 140px; z-index: 9001;
      width: 340px; max-width: calc(100vw - 32px);
      max-height: min(72vh, 640px); display: none; flex-direction: column;
      background: var(--lumiverse-fill-subtle);
      border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius);
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
      color: var(--lumiverse-text); font-size: 13px;
    }
    .ld-panel.ld-open { display: flex; }
    .ld-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--lumiverse-border);
    }
    .ld-head-title { font-weight: 600; flex: 1; }
    .ld-tabbtn {
      background: none; border: none; color: var(--lumiverse-text-muted);
      cursor: pointer; padding: 4px 6px; border-radius: var(--lumiverse-radius);
      font-size: 12px;
    }
    .ld-tabbtn.ld-active { color: var(--lumiverse-text); background: var(--lumiverse-fill); }
    .ld-body { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .ld-row { display: flex; gap: 8px; align-items: center; }
    .ld-row > * { flex: 1; min-width: 0; }
    .ld-label { font-size: 11px; color: var(--lumiverse-text-muted); margin-bottom: 3px; display: block; }
    .ld-panel input, .ld-panel select, .ld-panel textarea {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); color: var(--lumiverse-text);
      font-size: 13px;
    }
    .ld-panel textarea { resize: vertical; min-height: 54px; }
    .ld-btn {
      padding: 7px 10px; border-radius: var(--lumiverse-radius);
      border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill);
      color: var(--lumiverse-text); cursor: pointer; font-size: 13px;
    }
    .ld-btn:hover:not(:disabled) { background: var(--lumiverse-fill-subtle); }
    .ld-btn:disabled { opacity: .5; cursor: default; }
    .ld-btn.ld-primary { font-weight: 600; }
    .ld-status { font-size: 12px; color: var(--lumiverse-text-muted); white-space: pre-wrap; word-break: break-word; }
    .ld-status.ld-err { color: #e5737f; }
    .ld-status.ld-good { color: #7fbf8e; }
    .ld-chip {
      display: inline-block; padding: 2px 6px; margin: 0 4px 4px 0;
      background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border);
      border-radius: 999px; font-size: 11px; color: var(--lumiverse-text-muted);
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      vertical-align: bottom;
    }
    .ld-history { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .ld-history .ld-thumb { position: relative; }
    .ld-history img {
      width: 100%; aspect-ratio: 1; object-fit: cover;
      border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border);
      cursor: pointer; display: block;
    }
    .ld-thumb .ld-append {
      position: absolute; right: 3px; bottom: 3px;
      padding: 2px 5px; font-size: 11px; line-height: 1;
      background: var(--lumiverse-fill); border: 1px solid var(--lumiverse-border);
      border-radius: var(--lumiverse-radius); color: var(--lumiverse-text);
      cursor: pointer; opacity: .85;
    }
    .ld-thumb .ld-append:hover { opacity: 1; }
    .ld-preset-item {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius);
      background: var(--lumiverse-fill);
    }
    .ld-preset-item.ld-active { outline: 1px solid var(--lumiverse-text-muted); }
    .ld-preset-name { flex: 1; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ld-preset-model { font-size: 10px; color: var(--lumiverse-text-muted); display: block; overflow: hidden; text-overflow: ellipsis; }
    .ld-x { background: none; border: none; color: var(--lumiverse-text-muted); cursor: pointer; font-size: 14px; padding: 2px 4px; }
    .ld-x:hover { color: #e5737f; }
    .ld-spin { animation: ld-rot 1s linear infinite; display: inline-block; }
    @keyframes ld-rot { to { transform: rotate(360deg); } }
  `)

  // ------------------------------------------------------------------ markup
  dom.inject('body', `
    <button class="ld-launcher" title="LumiDraw Studio">🎨</button>
    <div class="ld-panel">
      <div class="ld-head">
        <span class="ld-head-title">LumiDraw Studio</span>
        <button class="ld-tabbtn ld-active" data-tab="generate">Generate</button>
        <button class="ld-tabbtn" data-tab="presets">Presets</button>
        <button class="ld-tabbtn" data-tab="settings">Settings</button>
      </div>
      <div class="ld-body" data-view="generate">
        <div>
          <span class="ld-label">Preset</span>
          <div class="ld-row">
            <select class="ld-preset-select"><option value="">— none (synced state) —</option></select>
            <button class="ld-btn" style="flex:0 0 auto" data-act="sync" title="Capture the recipe currently shown in Draw Things">Sync ⟳</button>
          </div>
          <div class="ld-config-chips" style="margin-top:6px"></div>
        </div>
        <div>
          <span class="ld-label">Prompt</span>
          <textarea class="ld-prompt" placeholder="portrait of..."></textarea>
        </div>
        <div>
          <span class="ld-label">Negative prompt</span>
          <textarea class="ld-negative" style="min-height:36px"></textarea>
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
        <button class="ld-btn ld-primary" data-act="generate">Generate</button>
        <button class="ld-btn" data-act="append-last" style="display:none">Add to chat 💬</button>
        <div class="ld-status ld-gen-status"></div>
        <div>
          <span class="ld-label">Recent</span>
          <div class="ld-history"></div>
        </div>
      </div>
      <div class="ld-body" data-view="presets" style="display:none">
        <div class="ld-status">Sync the current Draw Things recipe, then save it under a name. Selecting a preset pins its full config — model included — for every generation, no matter what the app is set to.</div>
        <div class="ld-row">
          <input class="ld-preset-name-input" placeholder="Preset name (e.g. Fanny — story portraits)" />
          <button class="ld-btn" style="flex:0 0 auto" data-act="save-preset">Save</button>
        </div>
        <div class="ld-status ld-preset-status"></div>
        <div class="ld-preset-list" style="display:flex;flex-direction:column;gap:6px"></div>
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
        <div class="ld-status">Tip: Draw Things shows the recipe of whatever image is selected — so select any image you love, hit Sync, and you've captured its exact settings.</div>
      </div>
    </div>
  `)

  const $ = (sel) => dom.query(sel)
  const launcher = $('.ld-launcher')
  const panel = $('.ld-panel')

  // ------------------------------------------------------------------ helpers
  function setStatus(sel, msg, kind) {
    const el = $(sel)
    if (!el) return
    el.textContent = msg || ''
    el.classList.remove('ld-err', 'ld-good')
    if (kind) el.classList.add(kind === 'err' ? 'ld-err' : 'ld-good')
  }

  function renderChips() {
    const el = $('.ld-config-chips')
    if (!el) return
    if (!syncedConfig) {
      el.innerHTML = '<span class="ld-status">No config loaded — press Sync or pick a preset.</span>'
      return
    }
    const c = syncedConfig
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
      item.appendChild(del)
      list.appendChild(item)
    }
  }

  async function appendToChat(img, entry) {
    setStatus('.ld-gen-status', 'Adding to chat…')
    try {
      await call('append_to_chat', {
        imageUrl: img.url,
        alt: (entry && entry.prompt) ? entry.prompt.slice(0, 120) : 'Generated image',
      })
      setStatus('.ld-gen-status', 'Added to the active chat.', 'good')
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
        const btn = document.createElement('button')
        btn.className = 'ld-append'
        btn.textContent = '💬+'
        btn.title = 'Append this image to the active chat'
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); appendToChat(img, entry) })
        wrap.appendChild(im)
        wrap.appendChild(btn)
        el.appendChild(wrap)
      }
    }
  }

  function selectPreset(name) {
    const p = presets.find((x) => x.name === name)
    activePreset = p ? p.name : null
    if (p) {
      syncedConfig = { ...p.config }
      if (p.promptPrefix && !$('.ld-prompt').value) $('.ld-prompt').value = p.promptPrefix
      if (p.negativePrompt && !$('.ld-negative').value) $('.ld-negative').value = p.negativePrompt
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
    renderChips(); renderPresetSelect()
    setStatus(statusSel, `Captured ${res.captured.model || '(no model)'}`, 'good')
  }

  async function doGenerate() {
    if (busy) return
    if (!syncedConfig) {
      setStatus('.ld-gen-status', 'No config — press Sync or pick a preset first.', 'err')
      return
    }
    busy = true
    const btn = $('[data-act="generate"]')
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ld-spin">◌</span> Generating…' }
    setStatus('.ld-gen-status', 'Sent to Draw Things — hold tight…')
    try {
      const preset = activePresetObj()
      const seedRaw = $('.ld-seed').value
      const res = await call('generate', {
        prompt: $('.ld-prompt').value,
        negativePrompt: $('.ld-negative').value,
        seed: seedRaw === '' ? undefined : Number(seedRaw),
        config: syncedConfig,
        extra: preset ? preset.extra : null,
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
      if (btn) { btn.disabled = false; btn.textContent = 'Generate' }
    }
  }

  // ------------------------------------------------------------------ wiring
  launcher.addEventListener('click', () => panel.classList.toggle('ld-open'))

  for (const tab of dom.queryAll('.ld-tabbtn')) {
    tab.addEventListener('click', () => {
      for (const t of dom.queryAll('.ld-tabbtn')) t.classList.toggle('ld-active', t === tab)
      for (const v of dom.queryAll('.ld-body')) {
        v.style.display = v.getAttribute('data-view') === tab.getAttribute('data-tab') ? 'flex' : 'none'
      }
    })
  }

  $('.ld-preset-select').addEventListener('change', (e) => {
    if (e.target.value) selectPreset(e.target.value)
    else { activePreset = null; renderPresetList(); renderPresetSelect() }
  })

  $('[data-act="sync"]').addEventListener('click', () =>
    doSync('.ld-gen-status').catch((e) => setStatus('.ld-gen-status', e.message, 'err')))

  $('[data-act="generate"]').addEventListener('click', doGenerate)

  $('[data-act="append-last"]').addEventListener('click', () => {
    const last = history[0]
    if (last && last.images && last.images[0]) appendToChat(last.images[0], last)
  })

  $('[data-act="reuse-seed"]').addEventListener('click', () => {
    const last = history[0]
    if (last && last.seed !== undefined && last.seed !== 'random') {
      $('.ld-seed').value = last.seed
    } else {
      setStatus('.ld-gen-status', 'Last generation used a random seed Draw Things picked — no seed to reuse.', 'err')
    }
  })

  $('[data-act="save-preset"]').addEventListener('click', async () => {
    try {
      if (!syncedConfig) throw new Error('Nothing to save — sync from Draw Things first (Generate tab).')
      const name = $('.ld-preset-name-input').value
      const res = await call('save_preset', {
        name,
        config: syncedConfig,
        promptPrefix: $('.ld-prompt').value,
        negativePrompt: $('.ld-negative').value,
      })
      presets = res.presets
      activePreset = name.trim()
      renderPresetList(); renderPresetSelect()
      setStatus('.ld-preset-status', `Saved "${name.trim()}".`, 'good')
    } catch (e) {
      setStatus('.ld-preset-status', e.message, 'err')
    }
  })

  $('[data-act="save-settings"]').addEventListener('click', async () => {
    try {
      const res = await call('save_settings', {
        host: $('.ld-host').value,
        port: $('.ld-port').value,
      })
      settings = res.settings
      setStatus('.ld-settings-status', `Saved — pointing at ${settings.host}:${settings.port}.`, 'good')
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

  // ------------------------------------------------------------------ boot
  ;(async () => {
    try {
      const res = await call('init', {}, 12000)
      settings = res.settings; presets = res.presets; history = res.history
      $('.ld-host').value = settings.host
      $('.ld-port').value = settings.port
      renderPresetSelect(); renderPresetList(); renderHistory(); renderChips()
    } catch (e) {
      setStatus('.ld-gen-status', `Backend not ready: ${e.message}`, 'err')
    }
  })()

  return () => {
    unsub()
    removeStyle()
    dom.cleanup()
  }
}
