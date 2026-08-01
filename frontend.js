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
  let defaults = { protocol: '', parserInstruction: '' }
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
    .ld-x:hover { color: #e5737f; }
    .ld-spin { animation: ld-rot 1s linear infinite; display: inline-block; }
    @keyframes ld-rot { to { transform: rotate(360deg); } }
  `)

  // ------------------------------------------------------------------ markup
  dom.inject('body', `
    <button class="ld-launcher" title="LumiDraw Studio" aria-label="LumiDraw Studio">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"></rect>
        <circle cx="9" cy="9" r="1.8"></circle>
        <path d="M21 15.5l-4.2-4.2a1.6 1.6 0 0 0-2.3 0L6 20"></path>
      </svg>
    </button>
    <div class="ld-panel">
      <div class="ld-head">
        <span class="ld-head-title">LumiDraw Studio</span>
        <button class="ld-tabbtn ld-active" data-tab="generate">Generate</button>
        <button class="ld-tabbtn" data-tab="presets">Presets</button>
        <button class="ld-tabbtn" data-tab="settings">Settings</button>
        <button class="ld-x ld-min" title="Minimize back to the icon">&#8211;</button>
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
          <span class="ld-label">Quality tags (always prepended; saved with the preset)</span>
          <input class="ld-quality" placeholder="e.g. masterpiece, best quality, absurdres" />
        </div>
        <div>
          <span class="ld-label">Character tags (identity; saved with the preset — {{char}}/{{persona}} macros allowed)</span>
          <textarea class="ld-chartags-input" style="min-height:44px" placeholder="e.g. 1girl, long red hair, green eyes, freckles, slender"></textarea>
        </div>
        <div>
          <span class="ld-label">Persona tags (the User's look — used only when the model says you're in frame)</span>
          <textarea class="ld-personatags-input" style="min-height:44px" placeholder="e.g. 1boy, very tall, muscular, short brown hair"></textarea>
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
        <button class="ld-btn" data-act="scan" title="Process the latest story message: illustrate its <dt-image> tags, or run the parser on its prose">Scan story now 📖</button>
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
    const p = presets.find((x) => x.name === name)
    activePreset = p ? p.name : null
    call('set_active_preset', { name: activePreset || '' }).catch(() => {})
    if (p) {
      syncedConfig = { ...p.config }
      if (p.promptPrefix && !$('.ld-prompt').value) $('.ld-prompt').value = p.promptPrefix
      if (p.negativePrompt && !$('.ld-negative').value) $('.ld-negative').value = p.negativePrompt
      $('.ld-quality').value = p.qualityTags || ''
      $('.ld-chartags-input').value = p.characterTags || ''
      $('.ld-personatags-input').value = p.personaTags || ''
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
        qualityTags: $('.ld-quality').value,
        characterTags: $('.ld-chartags-input').value,
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
    launcher.setPointerCapture(e.pointerId)
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
        if (!initialized) tryInit()
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

  $('.ld-min').addEventListener('click', () => panel.classList.remove('ld-open'))

  $('.ld-preset-select').addEventListener('change', (e) => {
    if (e.target.value) selectPreset(e.target.value)
    else {
      activePreset = null
      call('set_active_preset', { name: '' }).catch(() => {})
      renderPresetList(); renderPresetSelect()
    }
  })

  $('[data-act="sync"]').addEventListener('click', () =>
    doSync('.ld-gen-status').catch((e) => setStatus('.ld-gen-status', e.message, 'err')))

  $('[data-act="generate"]').addEventListener('click', doGenerate)

  $('[data-act="scan"]').addEventListener('click', async () => {
    setStatus('.ld-gen-status', 'Scanning the latest story message…')
    try {
      const res = await call('scan_story', { force: true })
      history = (await call('init', {}, 15000)).history
      renderHistory()
      setStatus('.ld-gen-status', res.note || `Done (${res.mode}).`, res.processed ? 'good' : undefined)
    } catch (e) { setStatus('.ld-gen-status', e.message, 'err') }
  })

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

  $('[data-act="save-preset"]').addEventListener('click', async () => {
    try {
      if (!syncedConfig) throw new Error('Nothing to save — sync from Draw Things first (Generate tab).')
      const name = $('.ld-preset-name-input').value
      const res = await call('save_preset', {
        name,
        config: syncedConfig,
        promptPrefix: $('.ld-prompt').value,
        negativePrompt: $('.ld-negative').value,
        qualityTags: $('.ld-quality').value,
        characterTags: $('.ld-chartags-input').value,
        personaTags: $('.ld-personatags-input').value,
      })
      presets = res.presets
      activePreset = name.trim()
      renderPresetList(); renderPresetSelect()
      setStatus('.ld-preset-status', `Saved "${name.trim()}".`, 'good')
    } catch (e) {
      setStatus('.ld-preset-status', e.message, 'err')
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
    if (!btn) return
    const mode = $('.ld-mode') ? $('.ld-mode').value : 'off'
    btn.textContent = mode === 'off'
      ? 'Scan story now 📖 (mode: Off — set in Settings)'
      : `Scan story now 📖 (${mode})`
  }

  // Quality/Character tags auto-save into the selected preset as you type.
  let tagSaveTimer = null
  function scheduleTagSave() {
    if (!activePreset) return
    clearTimeout(tagSaveTimer)
    tagSaveTimer = setTimeout(async () => {
      const p = presets.find((x) => x.name === activePreset)
      if (!p) return
      try {
        const res = await call('save_preset', {
          name: p.name,
          config: p.config,
          extra: p.extra || null,
          promptPrefix: p.promptPrefix || '',
          negativePrompt: p.negativePrompt || '',
          qualityTags: $('.ld-quality').value,
          characterTags: $('.ld-chartags-input').value,
          personaTags: $('.ld-personatags-input').value,
        })
        presets = res.presets
        setStatus('.ld-gen-status', 'Preset updated ✓', 'good')
      } catch (e) { setStatus('.ld-gen-status', 'Preset save failed: ' + e.message, 'err') }
    }, 800)
  }
  for (const sel of ['.ld-quality', '.ld-chartags-input', '.ld-personatags-input']) {
    const el = $(sel)
    if (el) el.addEventListener('input', scheduleTagSave)
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
      if (settings.activePreset) { activePreset = settings.activePreset }
      if (activePreset) {
        const p = presets.find((x) => x.name === activePreset)
        if (p) { syncedConfig = { ...p.config }; $('.ld-quality').value = p.qualityTags || ''; $('.ld-chartags-input').value = p.characterTags || ''; $('.ld-personatags-input').value = p.personaTags || '' }
        else activePreset = null
      }
      renderPresetSelect(); renderPresetList(); renderHistory(); renderChips()
      updateScanLabel()
      initialized = true
      console.log('[LumiDraw] backend connected')
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
    unsub()
    removeStyle()
    dom.cleanup()
  }
}
