// LumiDraw Studio — frontend
// Injects a launcher button + studio panel styled with Lumiverse theme
// variables. All traffic goes through the backend module.

const EXTENSION_VERSION = '1.3.25'

console.log(`[LumiDraw] frontend module imported v${EXTENSION_VERSION}`)

function makeId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID() } catch { /* insecure context */ }
  }
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Lumiverse serves its own cached image tiers from the same canonical image
// URL. Keep the original URL in LumiDraw's state and alter only display URLs.
function lumidrawImageVariantUrl(value, tier, enabled = true) {
  const raw = String(value || '').trim()
  if (!enabled || (tier !== 'sm' && tier !== 'lg') || !raw) return raw
  const match = raw.match(/^((?:https?:\/\/[^/?#]+)?\/api\/v1\/images\/[^/?#]+)(\?[^#]*)?(#.*)?$/i)
  if (!match) return raw
  const query = String(match[2] || '').replace(/^\?/, '')
  const kept = query.split('&').filter(Boolean).filter((part) => {
    try { return decodeURIComponent(part.split('=')[0] || '').toLowerCase() !== 'size' } catch { return true }
  })
  kept.push(`size=${tier}`)
  return `${match[1]}?${kept.join('&')}${match[3] || ''}`
}

function makeBootstrapLauncher() {
  const id = 'lumidraw-bootstrap-launcher'
  const stale = document.getElementById(id)
  if (stale) { try { stale.remove() } catch { /* ignore */ } }
  const button = document.createElement('button')
  button.id = id
  button.type = 'button'
  button.title = `LumiDraw Studio v${EXTENSION_VERSION} — starting…`
  button.setAttribute('aria-label', `LumiDraw Studio v${EXTENSION_VERSION}`)
  button.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="1.8"></circle><path d="M21 15.5l-4.2-4.2a1.6 1.6 0 0 0-2.3 0L6 20"></path></svg>'
  // This is intentionally raw DOM + inline CSS. It exists BEFORE any Spindle DOM
  // API call, so a permission/API/startup failure can never make LumiDraw wholly
  // inaccessible again. Once normal setup succeeds it is removed.
  button.style.cssText = [
    'position:fixed','right:16px','bottom:88px','z-index:2147483000',
    'width:58px','height:58px','border-radius:16px','display:flex',
    'align-items:center','justify-content:center','background:#262833',
    'border:1px solid #515564','color:#eceef4','cursor:pointer',
    'box-shadow:0 2px 12px rgba(0,0,0,.38)','padding:0'
  ].join(';')
  let startupError = ''
  const click = () => {
    const panel = document.querySelector('.ld-panel')
    if (panel) {
      panel.classList.toggle('ld-open')
      panel.style.display = panel.classList.contains('ld-open') ? 'flex' : ''
      return
    }
    const detail = startupError || 'The frontend setup function started, but the full LumiDraw panel has not mounted yet.'
    window.alert(`LumiDraw v${EXTENSION_VERSION} startup diagnostic:

${detail}`)
  }
  button.addEventListener('click', click)
  const host = document.body || document.documentElement
  if (!host) throw new Error('document root is unavailable during LumiDraw setup')
  host.appendChild(button)
  return {
    button,
    fail(error) {
      startupError = error && error.stack ? String(error.stack) : String(error && error.message ? error.message : error || 'Unknown startup error')
      button.style.background = '#6d2832'
      button.title = `LumiDraw v${EXTENSION_VERSION} startup failed — click for details`
      button.setAttribute('aria-label', `LumiDraw v${EXTENSION_VERSION} startup failed — click for details`)
    },
    remove() {
      button.removeEventListener('click', click)
      try { button.remove() } catch { /* ignore */ }
    },
  }
}

export function setup(ctx) {
  // First executable UI action. If this button never appears, Lumiverse did not
  // import/call this frontend at all; that distinguishes loader failures from
  // runtime failures without needing DevTools.
  const bootstrap = makeBootstrapLauncher()
  console.log('[LumiDraw] setup called. ctx keys:', ctx ? Object.keys(ctx) : ctx)
  if (ctx && ctx.dom) console.log('[LumiDraw] ctx.dom keys:', Object.keys(ctx.dom))
  try {
    const cleanup = realSetup(ctx)
    console.log('[LumiDraw] setup finished — launcher should be visible bottom-right')
    bootstrap.remove()
    return () => {
      try { if (typeof cleanup === 'function') cleanup() } finally { bootstrap.remove() }
    }
  } catch (err) {
    console.error('[LumiDraw] setup crashed:', err)
    bootstrap.fail(err)
    return () => bootstrap.remove()
  }
}

export default setup

function realSetup(ctx) {
  // Lumiverse can occasionally re-run an extension setup while the previous
  // DOM is still mounted. Two pixel-identical panels stacked together cause
  // unstable hover/click hit-testing, especially in Safari. Keep one live UI.
  const INSTANCE_KEY = '__lumidrawStudioLiveInstance'
  const priorInstance = window[INSTANCE_KEY]
  if (priorInstance) {
    const priorPanelLive = !!(priorInstance.panel && priorInstance.panel.isConnected)
    const priorLauncherLive = !!(priorInstance.launcher && priorInstance.launcher.isConnected)

    // Newer LumiDraw instances keep their own teardown handle. When Lumiverse
    // hot-reloads a different version, use it instead of stacking two copies of
    // the app on top of each other. 1.3.7 and earlier did not expose this handle.
    if ((priorPanelLive || priorLauncherLive) && typeof priorInstance.cleanup === 'function' &&
        priorInstance.version && priorInstance.version !== EXTENSION_VERSION) {
      console.warn(`[LumiDraw] replacing live v${priorInstance.version} with v${EXTENSION_VERSION}`)
      try { priorInstance.cleanup() } catch (error) {
        console.warn('[LumiDraw] prior-instance cleanup failed:', error && error.message ? error.message : error)
      }
      if (window[INSTANCE_KEY] === priorInstance) delete window[INSTANCE_KEY]
    } else if (priorPanelLive && priorLauncherLive) {
      console.warn('[LumiDraw] duplicate setup ignored; existing UI is still mounted')
      return () => {}
    } else if (priorPanelLive && !priorLauncherLive) {
      // Lumiverse can replace an extension injection during a hot reload while
      // leaving another injected node connected. 1.3.7's guard checked only the
      // panel, so a missing launcher made the entire app inaccessible. Recover an
      // entry point for that still-live panel instead of stranding it. A full page
      // refresh will then load the new version normally.
      console.warn('[LumiDraw] live panel found without its launcher; restoring launcher')
      const recovery = document.createElement('button')
      recovery.className = 'ld-launcher ld-launcher-recovery'
      recovery.title = 'LumiDraw Studio'
      recovery.setAttribute('aria-label', 'LumiDraw Studio')
      recovery.setAttribute('type', 'button')
      recovery.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="1.8"></circle><path d="M21 15.5l-4.2-4.2a1.6 1.6 0 0 0-2.3 0L6 20"></path></svg>'
      // Inline essentials make the rescue button usable even if the old style
      // injection was the node Lumiverse happened to discard.
      recovery.style.cssText = 'position:fixed;right:16px;bottom:88px;z-index:9000;width:58px;height:58px;border-radius:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;'
      const reopen = () => {
        priorInstance.panel.classList.toggle('ld-open')
        if (priorInstance.panel.classList.contains('ld-open')) {
          priorInstance.panel.style.display = 'flex'
        } else {
          priorInstance.panel.style.display = ''
        }
      }
      recovery.addEventListener('click', reopen)
      document.body.appendChild(recovery)
      priorInstance.launcher = recovery
      priorInstance.recoveredLauncher = true
      return () => {
        recovery.removeEventListener('click', reopen)
        try { recovery.remove() } catch { /* ignore */ }
      }
    } else if (!priorPanelLive && priorLauncherLive) {
      // The inverse half-instance is useless; remove the orphan and let this
      // setup create a complete fresh UI.
      try { priorInstance.launcher.remove() } catch { /* ignore */ }
      if (window[INSTANCE_KEY] === priorInstance) delete window[INSTANCE_KEY]
    } else if (!priorPanelLive && !priorLauncherLive && window[INSTANCE_KEY] === priorInstance) {
      delete window[INSTANCE_KEY]
    }
  }
  // --- resilient DOM layer: prefer host helpers, fall back to document ---
  const injected = []
  const dom = {
    addStyle(css) {
      if (ctx.dom && typeof ctx.dom.addStyle === 'function') {
        try { return ctx.dom.addStyle(css) } catch (e) {
          // Current Lumiverse gates DOM helpers behind app_manipulation. A stale
          // permission grant must not abort LumiDraw before it can explain itself.
          console.warn('[LumiDraw] ctx.dom.addStyle failed, using document fallback:', e && e.message ? e.message : e)
        }
      }
      const el = document.createElement('style')
      el.setAttribute('data-lumidraw', '1')
      el.textContent = css
      document.head.appendChild(el)
      injected.push(el)
      return () => el.remove()
    },
    inject(target, html, position = 'beforeend') {
      if (ctx.dom && typeof ctx.dom.inject === 'function') {
        try { return ctx.dom.inject(target, html, position) } catch (e) {
          console.warn('[LumiDraw] ctx.dom.inject failed, using document fallback:', e.message)
        }
      }
      const root = document.createElement('div')
      root.setAttribute('data-lumidraw', '1')
      root.innerHTML = html
      const parent = typeof target === 'string' ? document.querySelector(target) : target
      if (parent && typeof parent.insertAdjacentElement === 'function') {
        try { parent.insertAdjacentElement(position, root) } catch { parent.appendChild(root) }
      } else if (parent && typeof parent.appendChild === 'function') parent.appendChild(root)
      else document.body.appendChild(root)
      injected.push(root)
      return root
    },
    uninject(node) {
      if (!node) return
      if (ctx.dom && typeof ctx.dom.uninject === 'function') {
        try { ctx.dom.uninject(node); return } catch { /* fallback below */ }
      }
      try { node.remove() } catch { /* ignore */ }
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
  let personas = []
  let characters = []
  let places = []
  // url -> how many times its passage has been re-parsed this session
  const reparseAttempts = new Map()
  let libEditorKind = 'persona' // which library the shared editor is writing to
  let editorCastIds = []        // additional cast member ids in the open preset editor
  let history = []
  let storyDebug = null
  let autoStatus = null
  let liveScanStatus = null
  let liveScanStatusAt = 0
  let clickedChatImageUrl = ''
  let clickedChatPlacementId = ''
  let imagePlacements = []
  let imagePlacementChatId = ''
  let imagePlacementRefreshSeq = 0
  const imagePlacementMounts = new Map()
  const imagePlacementRenderKeys = new Map()
  const imagePlacementMountMessages = new Map()
  const imageLifecycleUnsubs = []
  const pendingImageMessageIds = new Set()
  const imageAttachRetryTimers = new Map()
  let lastSeenChatId = ''
  let scanElapsedTimer = null
  let activePreset = null   // name of selected preset
  let personaEditorId = null
  let syncedConfig = null   // last synced/loaded config powering the form
  let draftConfig = null    // temporary workspace config for manual generation
  let draftDirty = false
  let draftSourceLabel = ''
  let catalog = { models: [], samplers: [], loras: [], source: 'memory', bridge: null, currentRecipe: null }
  let busy = false
  let defaults = { protocol: '', parserInstruction: '', legacyParserInstruction: '', animaParserInstruction: '' }
  const pending = new Map() // requestId → {resolve, reject}
  let rescanInputAction = null
  let rescanInputActionUnsub = null

  function previewUrl(original, tier) {
    return lumidrawImageVariantUrl(original, tier, settings.optimizedPreviews !== false)
  }

  function setPreviewImageSource(img, original, tier) {
    if (!img) return
    const canonical = String(original || '')
    img.dataset.lumidrawOriginalUrl = canonical
    if (!img.dataset.lumidrawPreviewFallbackBound) {
      img.dataset.lumidrawPreviewFallbackBound = '1'
      img.addEventListener('error', () => {
        const fallback = String(img.dataset.lumidrawOriginalUrl || '')
        if (fallback && img.getAttribute('src') !== fallback) img.src = fallback
      })
    }
    img.src = previewUrl(canonical, tier)
  }

  function refreshNativePreviewSources() {
    for (const mount of imagePlacementMounts.values()) {
      if (!mount || !mount.querySelectorAll) continue
      for (const img of mount.querySelectorAll('img[data-lumidraw-original-url]')) {
        setPreviewImageSource(img, img.dataset.lumidrawOriginalUrl, 'lg')
      }
    }
  }

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
    if (!payload) return
    if (payload.type === 'image_placement_upserted') {
      const placement = payload.placement
      if (placement && placement.placementId) {
        const index = imagePlacements.findIndex((item) => item && item.placementId === placement.placementId)
        if (index >= 0) imagePlacements[index] = placement
        else imagePlacements.push(placement)
        const activeChat = activeChatIdFromCtx()
        const placementChat = String(placement.chatId || '')
        if (!activeChat || !placementChat || activeChat === placementChat) {
          imagePlacementChatId = placementChat || imagePlacementChatId || activeChat
          scheduleImageAttach(String(placement.messageId || ''))
        }
      }
      return
    }
    if (payload.type === 'image_placement_removed') {
      const removed = Array.isArray(payload.placements) ? payload.placements : []
      const ids = new Set(removed.map((item) => String(item && item.placementId || '')).filter(Boolean))
      const affected = new Set(removed.map((item) => String(item && item.messageId || '')).filter(Boolean))
      if (ids.size) imagePlacements = imagePlacements.filter((item) => !ids.has(String(item && item.placementId || '')))
      for (const messageId of affected) renderImagesIntoMessage(messageId)
      return
    }
    if (payload.type === 'history_updated') {
      history = Array.isArray(payload.history) ? payload.history : history
      const newest = payload.entry && payload.entry.images && payload.entry.images[0]
      if (payload.source === 'studio' && newest && newest.url) selectedOutputUrl = newest.url
      renderHistory()
      return
    }
    if (payload.type === 'bulk_regen_progress') {
      const gist = String(payload.statement || '').slice(0, 44)
      setStatus('.ld-lightbox-regen-status',
        `Rebuilding image ${payload.index} of ${payload.total}${gist ? ` — ${gist}…` : '…'}`)
      return
    }
    if (payload.type === 'auto_status') {
      autoStatus = payload.status || autoStatus
      renderStoryStatus()
      const state = payload.status && typeof payload.status === 'object' ? payload.status : {}
      if (['generated', 'done'].includes(String(state.status || ''))) {
        const chatId = String(state.chatId || activeChatIdFromCtx() || '')
        if (chatId) refreshImagePlacements(chatId).catch((error) => console.log('[LumiDraw] image refresh after completed scan failed:', error.message))
      }
      return
    }
    if (payload.type === 'scan_status') {
      liveScanStatus = payload.scan || null
      liveScanStatusAt = Date.now()
      renderLiveScanStatus()
      if (liveScanStatus && liveScanStatus.stage === 'done') {
        const chatId = activeChatIdFromCtx()
        if (chatId) refreshImagePlacements(chatId).catch((error) => console.log('[LumiDraw] image refresh after manual scan failed:', error.message))
      }
      return
    }
    if (!payload.requestId || !pending.has(payload.requestId)) return
    const { resolve, reject } = pending.get(payload.requestId)
    pending.delete(payload.requestId)
    if (payload.ok) resolve(payload)
    else reject(new Error(payload.error || 'Unknown backend error'))
  })

  // ------------------------------------------------------------------ styles
  const removeStyle = dom.addStyle(`
    .ld-launcher {
      position: fixed; right: 16px; bottom: 88px; z-index: 2147482000;
      width: 58px; height: 58px; border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      background: var(--lumiverse-fill, #262833); border: 1px solid var(--lumiverse-border, #3d4050);
      color: var(--lumiverse-text, #eceef4); cursor: grab; touch-action: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.28); user-select: none;
    }
    .ld-launcher:hover { background: var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-panel {
      position: fixed; right: 16px; bottom: 140px; z-index: 2147482001;
      width: min(1180px, calc(100vw - 24px)); max-width: calc(100vw - 24px);
      height: min(82vh, 820px); max-height: calc(100dvh - 24px);
      display: none; flex-direction: column; overflow: hidden;
      background: #17181e;
      border: 1px solid var(--lumiverse-border, #3d4050);
      border-radius: 12px;
      box-shadow: 0 14px 48px rgba(0,0,0,.48);
      color: var(--lumiverse-text, #eceef4); font-size: 14px;
    }
    .ld-panel.ld-open { display: flex; }
    /* Safari compatibility: keep the fixed workspace in one ordinary paint tree.
       Nested containment/isolation/transforms can make hit-testing oscillate. */
    .ld-panel, .ld-panel *, .ld-panel *::before, .ld-panel *::after {
      -webkit-backdrop-filter:none !important; backdrop-filter:none !important;
      filter:none; mix-blend-mode:normal; perspective:none;
    }
    .ld-panel { pointer-events:auto; transform:none; will-change:auto; }
    .ld-pane { contain:none !important; isolation:auto !important; transform:none; will-change:auto; }
    .ld-panel.ld-fullscreen {
      inset: 0 !important; width: 100vw !important; max-width: none !important;
      height: 100dvh !important; max-height: none !important;
      border-radius: 0; border: none;
    }
    body.ld-fullscreen-lock { overflow: hidden !important; }

    .ld-head {
      flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
      min-height: 50px; padding: max(8px, env(safe-area-inset-top)) 12px 8px;
      border-bottom: 1px solid var(--lumiverse-border, #3d4050);
      background: rgb(18,19,24);
    }
    .ld-head-title { font-weight: 700; margin-right: 6px; white-space: nowrap; }
    .ld-main-nav { display:flex; align-items:center; gap:4px; flex:1; min-width:0; }
    .ld-main-tab {
      flex:0 0 auto; white-space:nowrap;
      background: none; border: none; color: var(--lumiverse-text-muted, #a2a5b4);
      cursor: pointer; padding: 7px 10px; border-radius: 8px; font-size: 12px;
    }
    .ld-main-tab:hover { color: var(--lumiverse-text, #eceef4); }
    .ld-main-tab.ld-active { color: var(--lumiverse-text, #eceef4); background: var(--lumiverse-fill, #262833); }
    .ld-settings-rail { display:flex; flex:0 0 auto; gap:4px; flex-wrap:wrap; min-height:34px; margin:0 0 10px; }
    .ld-settings-tab { flex:0 0 auto; padding:5px 11px; border-radius:7px; cursor:pointer;
      border:1px solid var(--lumiverse-border, #333744); background:transparent;
      color: var(--lumiverse-text-muted, #a2a5b4); font:inherit; font-size:12px; }
    .ld-settings-tab:hover { color: var(--lumiverse-text, #eceef4); }
    .ld-settings-tab.ld-active { color: var(--lumiverse-text, #eceef4); background: var(--lumiverse-fill, #262833); }
    .ld-x { background: none; border: none; color: var(--lumiverse-text-muted, #a2a5b4); cursor: pointer; font-size: 14px; padding: 2px 4px; }
    .ld-x:hover { color: #e5737f; }
    .ld-min { font-size: 20px; line-height: 1; padding: 2px 8px; }
    .ld-fullscreen-toggle { font-size: 18px; line-height: 1; padding: 3px 7px; }

    .ld-statebar {
      flex: 0 0 auto; display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:8px;
      padding: 8px 12px; border-bottom:1px solid var(--lumiverse-border, #3d4050);
      background: #1f2028;
    }
    .ld-state-pill {
      display:flex; align-items:center; gap:7px; min-width:0; padding:7px 9px;
      border:1px solid var(--lumiverse-border, #3d4050); border-radius:9px;
      background:var(--lumiverse-fill, #262833); font-size:11px;
    }
    .ld-state-key { color:var(--lumiverse-text-muted, #a2a5b4); flex:0 0 auto; }
    .ld-state-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
    .ld-dot { width:7px; height:7px; border-radius:50%; background:#777; flex:0 0 auto; }
    .ld-dot.ld-online { background:#7fbf8e; box-shadow:0 0 0 3px rgba(127,191,142,.12); }
    .ld-dot.ld-offline { background:#e5737f; box-shadow:0 0 0 3px rgba(229,115,127,.10); }

    .ld-global-status {
      flex:0 0 auto; min-height:18px; padding:6px 12px;
      border-bottom:1px solid var(--lumiverse-border, #3d4050);
      background:#121318;
    }
    .ld-global-status { display:none; }
    .ld-view { flex:1 1 auto; min-height:0; overflow:hidden; display:none; }
    .ld-view.ld-active { display:flex; min-width:0; }

    .ld-mobile-tabs { display:none; flex:0 0 auto; gap:4px; overflow-x:auto; padding:7px 8px; border-bottom:1px solid var(--lumiverse-border, #3d4050); }
    .ld-mobile-tab {
      flex:0 0 auto; border:1px solid transparent; border-radius:8px; padding:7px 10px;
      background:none; color:var(--lumiverse-text-muted, #a2a5b4); font-size:12px; cursor:pointer;
    }
    .ld-mobile-tab.ld-active { background:var(--lumiverse-fill, #262833); border-color:var(--lumiverse-border, #3d4050); color:var(--lumiverse-text, #eceef4); }

    .ld-studio-shell { min-height:0; flex:1; display:flex; flex-direction:column; }
    /* Desktop deliberately uses plain nested flex rows instead of CSS Grid.
       Safari 27 beta can oscillate hit-testing when independently scrolling
       grid children and replaced images share a fixed-position ancestor. */
    .ld-studio-workspace {
      flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; padding:8px;
      background:#0f1015;
    }
    .ld-studio-top { flex:1 1 auto; min-height:0; display:flex; gap:8px; }
    .ld-studio-bottom { flex:0 0 min(30%, 230px); min-height:176px; display:flex; gap:8px; }
    .ld-studio-top > .ld-tune-pane { flex:.82 1 225px; }
    .ld-studio-top > .ld-create-pane { flex:1.65 1 360px; }
    .ld-studio-top > .ld-history-pane { flex:.95 1 245px; }
    .ld-studio-bottom > .ld-library-pane { flex:1.7 1 520px; }
    .ld-studio-bottom > .ld-stack-pane { flex:.8 1 280px; }
    .ld-pane {
      min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden;
      border:1px solid var(--lumiverse-border, #3d4050); border-radius:10px;
      background:#1b1c23; contain:none; isolation:auto;
    }
    .ld-pane-head {
      flex:0 0 auto; display:flex; align-items:center; gap:8px; min-height:38px; padding:8px 10px;
      border-bottom:1px solid var(--lumiverse-border, #3d4050); font-weight:650; font-size:12px;
      background:#252731;
    }
    .ld-pane-title { flex:1; }
    .ld-pane-body { flex:1; min-height:0; overflow-y:scroll; scrollbar-gutter:stable; padding:10px; }
    .ld-pane-body.ld-stack-body { display:flex; flex-direction:column; gap:7px; }
    .ld-tune-pane { grid-area:tune; }
    .ld-create-pane { grid-area:create; }
    .ld-history-pane { grid-area:history; }
    .ld-library-pane { grid-area:library; }
    .ld-stack-pane { grid-area:stack; }

    .ld-card { border:1px solid var(--lumiverse-border, #3d4050); border-radius:9px; padding:9px; background:var(--lumiverse-fill, #262833); }
    .ld-card + .ld-card { margin-top:8px; }
    .ld-subtitle { font-size:12px; font-weight:650; margin-bottom:7px; }
    .ld-help { font-size:11px; line-height:1.4; color:var(--lumiverse-text-muted, #a2a5b4); }
    .ld-label { font-size:11px; color:var(--lumiverse-text-muted, #a2a5b4); margin-bottom:3px; display:block; }
    .ld-row { display:flex; gap:8px; align-items:center; }
    .ld-row > * { flex:1; min-width:0; }
    .ld-panel input, .ld-panel select, .ld-panel textarea {
      width:100%; box-sizing:border-box; padding:8px 10px; font-size:14px !important;
      background:var(--lumiverse-fill, #262833); border:1px solid var(--lumiverse-border, #3d4050);
      border-radius:8px; color:var(--lumiverse-text, #eceef4);
    }
    .ld-panel textarea { resize:vertical; min-height:54px; }
    .ld-btn {
      padding:7px 10px; border-radius:8px; border:1px solid var(--lumiverse-border, #3d4050);
      background:var(--lumiverse-fill, #262833); color:var(--lumiverse-text, #eceef4); cursor:pointer; font-size:13px;
    }
    .ld-btn:hover:not(:disabled) { background:var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-btn:active:not(:disabled), .ld-btn.ld-pressed:not(:disabled) { background:#111218; box-shadow:inset 0 2px 5px rgba(0,0,0,.55); transform:translateY(1px); }
    .ld-btn:disabled { opacity:.5; cursor:default; }
    .ld-btn.ld-primary { font-weight:700; background:#3f4458; }
    .ld-btn.ld-wide { width:100%; }
    .ld-compact { font-size:12px; padding:4px 8px; }
    .ld-wardrobe-row > div:first-child { flex-wrap:wrap; }
    .ld-wardrobe-row .ld-wardrobe-input { min-width:160px; }
    .ld-wardrobe-row [data-act="wardrobe-save-one"],
    .ld-wardrobe-row [data-act="wardrobe-clear-one"] { flex:0 0 auto; }
    .ld-section-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
    .ld-status { font-size:12px; color:var(--lumiverse-text-muted, #a2a5b4); white-space:pre-wrap; word-break:break-word; }
    .ld-status.ld-err { color:#e5737f; }
    .ld-status.ld-good { color:#7fbf8e; }
    .ld-chip {
      display:inline-block; padding:2px 6px; margin:0 4px 4px 0;
      background:var(--lumiverse-fill, #262833); border:1px solid var(--lumiverse-border, #3d4050);
      border-radius:999px; font-size:11px; color:var(--lumiverse-text-muted, #a2a5b4);
      max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom;
    }

    .ld-create-body { display:flex; flex-direction:column; gap:10px; }
    .ld-output-stage {
      flex:1 1 42%; min-height:180px; display:flex; align-items:center; justify-content:center;
      overflow:hidden; border:1px dashed var(--lumiverse-border, #3d4050); border-radius:10px;
      background:#0c0d11; position:relative;
    }
    .ld-image-hit {
      appearance:none; -webkit-appearance:none; border:0; margin:0; padding:0; min-width:0;
      background:transparent; color:inherit; display:block; cursor:pointer; overflow:hidden;
    }
    .ld-output-stage .ld-image-hit { width:100%; height:100%; }
    .ld-output-stage img { width:100%; height:100%; object-fit:contain; display:block; pointer-events:none; -webkit-user-drag:none; user-select:none; }
    .ld-output-empty { text-align:center; padding:24px; color:var(--lumiverse-text-muted, #a2a5b4); font-size:12px; }
    .ld-output-meta {
      position:absolute; left:8px; right:8px; bottom:8px; padding:6px 8px; border-radius:8px;
      background:#0a0b0f; pointer-events:none; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    .ld-prompt-zone { display:flex; flex-direction:column; gap:8px; }
    .ld-generate-bar { flex:0 0 auto; display:flex; gap:7px; padding-top:2px; background:#1b1c23; }
    .ld-generate-bar [data-act="generate"] { flex:1; min-height:42px; }

    .ld-history { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:9px; }
    .ld-history .ld-thumb { display:flex; flex-direction:column; gap:4px; min-width:0; }
    .ld-history .ld-image-hit { width:100%; border-radius:8px; }
    .ld-history img { width:100%; aspect-ratio:1; object-fit:cover; border-radius:8px; border:1px solid var(--lumiverse-border, #3d4050); display:block; pointer-events:none; -webkit-user-drag:none; user-select:none; }
    .ld-thumb .ld-append { width:100%; padding:5px 4px; font-size:11px; line-height:1.1; background:var(--lumiverse-fill, #262833); border:1px solid var(--lumiverse-border, #3d4050); border-radius:7px; color:var(--lumiverse-text, #eceef4); cursor:pointer; }
    .ld-thumb-row { display:flex; gap:4px; }
    .ld-thumb-row .ld-append { flex:1; padding:4px 2px; font-size:10px; }
    .ld-remove:hover { color:#e5737f; }

    .ld-lora-tools { display:flex; gap:7px; align-items:center; margin-bottom:8px; }
    .ld-lora-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px,1fr)); gap:7px; }
    .ld-lora-card {
      display:flex; align-items:center; gap:8px; min-width:0; padding:8px;
      border:1px solid var(--lumiverse-border, #3d4050); border-radius:9px; background:var(--lumiverse-fill, #262833);
    }
    .ld-lora-card-main { flex:1; min-width:0; }
    .ld-lora-card-name { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ld-lora-card-path { font-size:10px; color:var(--lumiverse-text-muted, #a2a5b4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ld-lora-empty { padding:18px; text-align:center; color:var(--lumiverse-text-muted, #a2a5b4); font-size:12px; }

    .ld-preset-item { display:flex; align-items:center; gap:6px; padding:8px 9px; border:1px solid var(--lumiverse-border, #3d4050); border-radius:8px; background:var(--lumiverse-fill, #262833); }
    .ld-preset-item.ld-active { outline:1px solid var(--lumiverse-text-muted, #a2a5b4); }
    .ld-preset-name { flex:1; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ld-preset-model { font-size:10px; color:var(--lumiverse-text-muted, #a2a5b4); display:block; overflow:hidden; text-overflow:ellipsis; }

    .ld-form-view { flex:1 1 auto; min-width:0; min-height:0; width:min(920px, 100%); margin:0 auto; padding:12px; box-sizing:border-box; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; gap:10px; }
    /* These forms are scroll containers. Letting their children use flex's
       default shrink behavior can compress a subsection rail to a colored
       8px line on short portrait screens. Content keeps its natural height
       and scrolls beneath the rail instead. */
    .ld-form-view > * { flex-shrink:0; }
    .ld-form-view > .ld-reset-rail, .ld-form-view > .ld-settings-rail {
      position:sticky; top:0; z-index:12; background:#121318;
    }
    .ld-story-hero { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:end; }
    .ld-profile-block { margin-top:9px; border:1px solid var(--lumiverse-border, #3d4050); border-radius:9px; background:var(--lumiverse-fill-subtle, #1a1b22); overflow:hidden; }
    .ld-profile-block > summary { cursor:pointer; padding:9px 11px; font-size:12px; font-weight:650; user-select:none; }
    .ld-profile-fields { padding:0 11px 11px; display:flex; flex-direction:column; gap:7px; }
    .ld-profile-grid { display:grid; grid-template-columns:1fr 110px; gap:7px; }
    .ld-story-debug textarea { min-height:92px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; }
    .ld-binding-note { margin-top:7px; padding:8px 9px; border-radius:8px; background:var(--lumiverse-fill-subtle, #1a1b22); font-size:11px; line-height:1.45; color:var(--lumiverse-text-muted, #a2a5b4); }
    .ld-mode-segment { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
    .ld-mode-note { margin-top:5px; }
    .ld-subsection { border:1px solid var(--lumiverse-border, #3d4050); border-radius:9px; padding:10px; }

    .ld-textarea-wrap { position:relative; }
    .ld-textarea-wrap textarea { padding-right:42px !important; }
    .ld-textarea-expand { position:absolute; top:5px; right:5px; z-index:2; min-width:30px; height:28px; padding:0 6px; border:1px solid var(--lumiverse-border, #3d4050); border-radius:7px; background:#17181e; color:var(--lumiverse-text-muted, #a2a5b4); cursor:pointer; touch-action:manipulation; font-size:15px; line-height:1; }
    .ld-textarea-expand:hover { color:var(--lumiverse-text, #eceef4); }

    /* Keep one cursor shape inside the desktop workspace. The controls remain
       fully clickable; this prevents WebKit from visibly alternating cursors
       while it recalculates a fixed extension surface. */
    @media (hover:hover) and (pointer:fine) {
      .ld-panel, .ld-panel * { cursor:default !important; }
    }

    .ld-lightbox {
      position:fixed; inset:0; z-index:2147482800; display:none; align-items:center; justify-content:center;
      padding:18px; background:rgba(0,0,0,.86); color:var(--lumiverse-text, #eceef4);
    }
    .ld-lightbox.ld-open { display:flex; }
    .ld-lightbox-dialog {
      width:min(1180px,100%); height:min(92dvh,960px); min-height:0; display:flex; flex-direction:column;
      overflow:hidden; border:1px solid var(--lumiverse-border, #3d4050); border-radius:12px;
      background:#111217; box-shadow:0 22px 80px rgba(0,0,0,.65);
    }
    .ld-lightbox-head, .ld-lightbox-foot {
      flex:0 0 auto; display:flex; align-items:center; gap:9px; padding:10px 12px;
      background:#1b1c23;
    }
    .ld-lightbox-head { border-bottom:1px solid var(--lumiverse-border, #3d4050); }
    .ld-lightbox-foot { border-top:1px solid var(--lumiverse-border, #3d4050); }
    .ld-lightbox-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
    .ld-lightbox-stage { flex:1; min-height:0; position:relative; display:flex; align-items:center; padding:10px; background:#08090c; overflow:hidden; }
    .ld-lightbox-image-wrap { flex:1; min-width:0; min-height:0; width:100%; height:100%; display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; touch-action:none; overscroll-behavior:contain; }
    .ld-lightbox-image { max-width:100%; max-height:100%; object-fit:contain; display:block; -webkit-user-drag:none; user-select:none; transform-origin:center center; will-change:transform; }
    .ld-lightbox-nav { position:absolute; top:50%; z-index:4; width:42px; height:62px; border-radius:9px; font-size:30px; line-height:1; transform:translateY(-50%); }
    .ld-lightbox-prev { left:10px; }
    .ld-lightbox-next { right:10px; }
    .ld-lightbox-zoom-tools { position:absolute; z-index:5; left:50%; bottom:12px; transform:translateX(-50%); display:flex; align-items:center; gap:5px; padding:5px; border:1px solid var(--lumiverse-border, #3d4050); border-radius:10px; background:#1b1c23; box-shadow:0 5px 20px rgba(0,0,0,.45); }
    .ld-lightbox-zoom-tools .ld-btn { min-width:36px; height:34px; padding:0 9px; }
    .ld-lightbox-zoom-level { min-width:60px !important; font-variant-numeric:tabular-nums; }
    .ld-lightbox-meta { flex:1; min-width:0; font-size:11px; line-height:1.35; color:var(--lumiverse-text-muted, #a2a5b4); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ld-lightbox-actions { display:flex; gap:7px; flex:0 0 auto; }
    .ld-lightbox-regen { flex:0 0 auto; max-height:46%; overflow-y:auto; padding:10px 12px; border-top:1px solid var(--lumiverse-border, #3d4050); background:#15161c; }
    .ld-lightbox-regen textarea { width:100%; box-sizing:border-box; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; line-height:1.4; }
    .ld-dt-field { display:flex; flex-direction:column; gap:3px; margin-top:7px; }
    .ld-dt-field:first-child { margin-top:0; }
    .ld-dt-settings .ld-profile-block { margin-top:7px; }

    .ld-story-picker { position:fixed; inset:0; z-index:2147482600; display:none; align-items:center; justify-content:center; padding:14px; background:var(--lumiverse-modal-backdrop, rgba(0,0,0,.62)); }
    .ld-story-picker.ld-open { display:flex; }
    .ld-story-dialog { width:min(680px,100%); max-height:min(84vh,820px); display:flex; flex-direction:column; overflow:hidden; background:#17181e; border:1px solid var(--lumiverse-border, #3d4050); border-radius:12px; box-shadow:0 18px 60px rgba(0,0,0,.55); color:var(--lumiverse-text, #eceef4); }
    .ld-story-head { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--lumiverse-border, #3d4050); }
    .ld-story-title { flex:1; font-weight:650; }
    .ld-story-tools { padding:10px 12px; border-bottom:1px solid var(--lumiverse-border, #3d4050); }
    .ld-story-search { width:100%; box-sizing:border-box; padding:9px 11px; font-size:14px; background:var(--lumiverse-fill, #262833); border:1px solid var(--lumiverse-border, #3d4050); border-radius:8px; color:var(--lumiverse-text, #eceef4); }
    .ld-story-help { margin-top:7px; font-size:11px; color:var(--lumiverse-text-muted, #a2a5b4); }
    .ld-story-list { overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; }
    .ld-story-item { width:100%; padding:10px 11px; text-align:left; cursor:pointer; background:var(--lumiverse-fill, #262833); color:var(--lumiverse-text, #eceef4); border:1px solid var(--lumiverse-border, #3d4050); border-radius:8px; }
    .ld-story-item:hover { background:var(--lumiverse-fill-subtle, #1a1b22); }
    .ld-story-item-top { display:flex; align-items:center; gap:6px; margin-bottom:5px; }
    .ld-story-number { font-size:12px; font-weight:650; }
    .ld-story-badge { padding:2px 6px; border-radius:999px; font-size:10px; color:var(--lumiverse-text-muted, #a2a5b4); border:1px solid var(--lumiverse-border, #3d4050); }
    .ld-story-preview { font-size:12px; line-height:1.4; color:var(--lumiverse-text-muted, #a2a5b4); display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }
    .ld-story-empty { padding:24px 12px; text-align:center; color:var(--lumiverse-text-muted, #a2a5b4); }

    .ld-text-editor { position:fixed; inset:0; z-index:2147482900; display:none; align-items:center; justify-content:center; padding:14px; background:var(--lumiverse-modal-backdrop, rgba(0,0,0,.68)); }
    .ld-text-editor.ld-open { display:flex; }
    .ld-text-editor-dialog { width:min(960px,100%); height:min(88dvh,920px); display:flex; flex-direction:column; overflow:hidden; background:#17181e; border:1px solid var(--lumiverse-border, #3d4050); border-radius:12px; box-shadow:0 18px 60px rgba(0,0,0,.58); }
    .ld-text-editor-head, .ld-text-editor-actions { display:flex; align-items:center; gap:8px; padding:11px 13px; border-bottom:1px solid var(--lumiverse-border, #3d4050); }
    .ld-text-editor-actions { border-top:1px solid var(--lumiverse-border, #3d4050); border-bottom:none; justify-content:flex-end; }
    .ld-text-editor-title { flex:1; font-weight:650; }
    .ld-text-editor-area { flex:1; min-height:0 !important; resize:none !important; margin:12px; width:calc(100% - 24px) !important; box-sizing:border-box; padding:14px; font-size:16px !important; line-height:1.45; background:var(--lumiverse-fill, #262833); border:1px solid var(--lumiverse-border, #3d4050); border-radius:8px; color:var(--lumiverse-text, #eceef4); }
    .ld-spin { animation:ld-rot 1s linear infinite; display:inline-block; }

    @media (max-width: 840px) {
      .ld-panel { width:calc(100vw - 12px); max-width:none; height:min(92dvh, 900px); max-height:calc(100dvh - 12px); }
      .ld-head { flex-wrap:wrap; }
      .ld-head-title { flex:1 1 calc(100% - 84px); }
      .ld-main-nav { order:3; flex:0 0 100%; width:100%; min-height:32px; overflow-x:auto; overflow-y:hidden; overscroll-behavior-x:contain; scrollbar-width:none; scroll-snap-type:x proximity; }
      .ld-main-nav::-webkit-scrollbar, .ld-mobile-tabs::-webkit-scrollbar, .ld-settings-rail::-webkit-scrollbar { display:none; }
      .ld-main-tab { flex:1 0 auto; text-align:center; scroll-snap-align:start; touch-action:manipulation; }
      .ld-statebar { grid-template-columns:1fr; gap:5px; padding:6px 8px; }
      .ld-state-pill { padding:5px 8px; }
      .ld-mobile-tabs { display:flex; }
      .ld-studio-workspace { display:block; padding:7px; overflow:hidden; }
      .ld-studio-top, .ld-studio-bottom { display:contents; }
      .ld-studio-workspace [data-mobile-panel] { display:none !important; height:100%; }
      .ld-studio-workspace [data-mobile-panel].ld-mobile-active { display:flex !important; }
      .ld-pane { border-radius:9px; }
      .ld-pane-body { padding:9px; }
      .ld-output-stage { min-height:220px; }
      .ld-history { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .ld-lora-grid { grid-template-columns:1fr; }
      .ld-form-view { padding:8px; }
      .ld-form-view > .ld-reset-rail, .ld-form-view > .ld-settings-rail { top:0; }
      .ld-settings-rail { flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; overscroll-behavior-x:contain; scrollbar-width:none; }
      .ld-story-hero { grid-template-columns:1fr; }
      .ld-profile-grid { grid-template-columns:1fr; }
      /* iOS zooms focused controls smaller than 16px, shifting the fixed panel
         on every focus/caret correction. Keep typing at a no-zoom size. */
      .ld-panel input, .ld-panel select, .ld-panel textarea { font-size:16px !important; }
      .ld-story-picker input, .ld-lightbox input, .ld-lightbox select, .ld-lightbox textarea { font-size:16px !important; }
      .ld-textarea-wrap textarea { padding-right:52px !important; }
      .ld-textarea-expand { top:6px; right:6px; min-width:40px; height:38px; font-size:18px; }
      /* visualViewport-backed dimensions keep the editor inside the portion
         of the screen that remains visible above the software keyboard. */
      .ld-text-editor { inset:auto 0 auto 0; top:var(--ld-editor-viewport-top, 0px); width:100vw; height:var(--ld-editor-viewport-height, 100dvh); min-height:0; align-items:stretch; justify-content:stretch; overflow:hidden; box-sizing:border-box; padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
      .ld-text-editor-dialog { width:100%; height:100%; max-height:none; min-height:0; border-radius:0; border:none; }
      .ld-text-editor-head, .ld-text-editor-actions { padding-left:max(13px, env(safe-area-inset-left)); padding-right:max(13px, env(safe-area-inset-right)); }
      .ld-text-editor-actions { padding-bottom:max(11px, env(safe-area-inset-bottom)); }
      .ld-text-editor-area { flex:1 1 auto; height:auto !important; min-height:0 !important; margin:10px; width:calc(100% - 20px) !important; overflow:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
      .ld-lightbox { align-items:stretch; justify-content:stretch; box-sizing:border-box; overflow:hidden; padding:env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
      .ld-lightbox-dialog { width:100%; height:100%; max-height:100%; min-height:0; border:0; border-radius:0; }
      .ld-lightbox-stage { padding:4px; }
      .ld-lightbox-nav { width:36px; height:54px; padding:0; }
      .ld-lightbox-prev { left:5px; }
      .ld-lightbox-next { right:5px; }
      .ld-lightbox-zoom-tools { bottom:8px; }
      .ld-lightbox-foot { align-items:flex-start; flex-direction:column; max-height:34%; overflow-y:auto; }
      .ld-lightbox-actions { width:100%; }
      .ld-lightbox-actions .ld-btn { flex:1; }
    }
    @media (max-width: 520px) {
      .ld-panel { inset:6px !important; width:auto !important; height:auto !important; max-height:none !important; border-radius:12px; }
      .ld-panel.ld-fullscreen { inset:0 !important; }
      .ld-head { padding-left:max(8px,env(safe-area-inset-left)); padding-right:max(8px,env(safe-area-inset-right)); }
      .ld-main-tab { padding:7px 8px; }
      .ld-statebar { display:flex; overflow-x:auto; }
      .ld-state-pill { flex:0 0 auto; max-width:82vw; }
      .ld-row.ld-mobile-stack { flex-direction:column; align-items:stretch; }
      .ld-wardrobe-row .ld-wardrobe-input { flex:1 1 100% !important; }
      .ld-story-picker { align-items:flex-end; padding:0; }
      .ld-story-dialog { width:100%; max-height:90vh; border-radius:14px 14px 0 0; }
      .ld-text-editor-area { margin:8px; width:calc(100% - 16px) !important; }
    }
    @keyframes ld-rot { to { transform:rotate(360deg); } }
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
        <span class="ld-head-title">LumiDraw <small class="ld-version" style="font-weight:400;opacity:.65"></small></span>
        <nav class="ld-main-nav" aria-label="LumiDraw sections">
          <button class="ld-main-tab ld-active" data-tab="studio">Studio</button>
          <button class="ld-main-tab" data-tab="story">Story</button>
          <button class="ld-main-tab" data-tab="presets">Cast &amp; presets</button>
          <button class="ld-main-tab" data-tab="settings">Settings</button>
        </nav>
        <button class="ld-x ld-fullscreen-toggle" title="Open fullscreen" aria-label="Open fullscreen" aria-pressed="false">⛶</button>
        <button class="ld-x ld-min" title="Minimize back to the icon">&#8211;</button>
      </div>

      <div class="ld-statebar">
        <div class="ld-state-pill"><span class="ld-state-key">Preset</span><span class="ld-state-value ld-header-preset">None</span></div>
        <div class="ld-state-pill"><span class="ld-state-key">Workspace</span><span class="ld-state-value ld-header-workspace">Not loaded</span></div>
        <div class="ld-state-pill"><span class="ld-dot ld-header-bridge-dot"></span><span class="ld-state-key">Bridge</span><span class="ld-state-value ld-header-bridge">Checking…</span></div>
      </div>
      <div class="ld-global-status"><div class="ld-status ld-gen-status"></div></div>

      <section class="ld-view ld-active" data-view="studio">
        <div class="ld-studio-shell">
          <div class="ld-mobile-tabs" aria-label="Studio panels">
            <button class="ld-mobile-tab ld-active" data-mobile-tab="create">Create</button>
            <button class="ld-mobile-tab" data-mobile-tab="tune">Tune</button>
            <button class="ld-mobile-tab" data-mobile-tab="library">LoRAs</button>
            <button class="ld-mobile-tab" data-mobile-tab="stack">Stack</button>
            <button class="ld-mobile-tab" data-mobile-tab="history">History</button>
          </div>
          <div class="ld-studio-workspace">
            <div class="ld-studio-top">
            <section class="ld-pane ld-tune-pane" data-mobile-panel="tune">
              <div class="ld-pane-head"><span class="ld-pane-title">Tune</span><button class="ld-btn ld-compact" data-act="sync" title="Capture the recipe currently shown in Draw Things">Sync ⟳</button></div>
              <div class="ld-pane-body">
                <div class="ld-card">
                  <span class="ld-label">Committed chat preset</span>
                  <select class="ld-preset-select"><option value="">— none (synced state) —</option></select>
                  <div class="ld-help" style="margin-top:6px">Story images use this preset. Studio is fully separate and sends only the temporary workspace and text you enter below.</div>
                </div>
                <div class="ld-card">
                  <div class="ld-subtitle">Core generation</div>
                  <span class="ld-label">Model</span>
                  <input class="ld-draft-model" list="ld-model-catalog" placeholder="— choose or type a model —" /><datalist id="ld-model-catalog"></datalist>
                  <div class="ld-row" style="margin-top:7px">
                    <div><span class="ld-label">Sampler</span><select class="ld-draft-sampler"><option value="">— choose sampler —</option></select></div>
                  </div>
                  <div class="ld-row" style="margin-top:7px">
                    <div><span class="ld-label">Steps</span><input class="ld-draft-steps" type="number" min="1" max="150" /></div>
                    <div><span class="ld-label">CFG</span><input class="ld-draft-cfg" type="number" step="0.5" min="0" /></div>
                  </div>
                  <div class="ld-row" style="margin-top:7px">
                    <div><span class="ld-label">Width</span><input class="ld-draft-w" type="number" step="64" min="256" /></div>
                    <div><span class="ld-label">Height</span><input class="ld-draft-h" type="number" step="64" min="256" /></div>
                  </div>
                </div>
                <div class="ld-card">
                  <div class="ld-subtitle">Draw Things settings</div>
                  <div class="ld-help">Everything Draw Things reported on the last Sync, editable here. Generate uses these directly — no round-trip through Draw Things. Save them to a preset with the buttons below.</div>
                  <div class="ld-dt-settings" style="margin-top:8px"></div>
                </div>
                <div class="ld-card">
                  <div class="ld-subtitle">Workspace</div>
                  <div class="ld-config-chips"></div>
                  <div class="ld-status ld-draft-status" style="margin-top:5px"></div>
                  <div class="ld-section-actions">
                    <button class="ld-btn ld-compact" data-act="draft-reset">Reset to preset</button>
                    <button class="ld-btn ld-compact" data-act="draft-save-new">Save new</button>
                    <button class="ld-btn ld-compact" data-act="draft-save-active">Update preset</button>
                  </div>
                </div>
                <div class="ld-card">
                  <div class="ld-row" style="align-items:center">
                    <div class="ld-status ld-catalog-status">Checking LumiDraw Bridge…</div>
                    <button class="ld-btn ld-compact" style="flex:0 0 auto" data-act="refresh-catalog">Rescan ⟳</button>
                  </div>
                </div>
              </div>
            </section>

            <section class="ld-pane ld-create-pane ld-mobile-active" data-mobile-panel="create">
              <div class="ld-pane-head"><span class="ld-pane-title">Create</span><span class="ld-help">Standalone workspace generation</span></div>
              <div class="ld-pane-body ld-create-body">
                <div class="ld-output-stage ld-current-output"><div class="ld-output-empty">Your newest image will appear here.</div></div>
                <div class="ld-prompt-zone">
                  <div><span class="ld-label">Prompt</span><textarea class="ld-prompt" placeholder="portrait of..."></textarea></div>
                  <div><span class="ld-label">Negative prompt</span><textarea class="ld-negative" style="min-height:42px"></textarea></div>
                  <div class="ld-row">
                    <div><span class="ld-label">Seed (blank = random)</span><input class="ld-seed" type="number" min="0" placeholder="random" /></div>
                    <div style="flex:0 0 auto;align-self:flex-end"><button class="ld-btn" data-act="reuse-seed" title="Copy the seed from the last generation">↩ Last seed</button></div>
                  </div>
                </div>
                <div class="ld-generate-bar">
                  <button class="ld-btn ld-primary" data-act="generate">Generate with workspace</button>
                  <button class="ld-btn" data-act="append-last" style="display:none">Add to chat 💬</button>
                </div>
              </div>
            </section>

            <section class="ld-pane ld-history-pane" data-mobile-panel="history">
              <div class="ld-pane-head"><span class="ld-pane-title">History</span><div style="display:flex;align-items:center;gap:6px"><button class="ld-btn ld-compact" data-act="refresh-history" title="Reload recent images">Refresh ⟳</button><button class="ld-x ld-clearall" title="Delete ALL recent images from the library and this list">Clear all</button></div></div>
              <div class="ld-pane-body"><div class="ld-history"></div></div>
            </section>
            </div>

            <div class="ld-studio-bottom">
            <section class="ld-pane ld-library-pane" data-mobile-panel="library">
              <div class="ld-pane-head"><span class="ld-pane-title">LoRA Library</span><span class="ld-help ld-lora-count"></span></div>
              <div class="ld-pane-body">
                <div class="ld-lora-tools">
                  <input class="ld-lora-search" type="search" placeholder="Search installed LoRAs…" />
                  <button class="ld-btn ld-compact" data-act="refresh-catalog">Rescan ⟳</button>
                </div>
                <div class="ld-lora-grid"></div>
              </div>
            </section>

            <section class="ld-pane ld-stack-pane" data-mobile-panel="stack">
              <div class="ld-pane-head"><span class="ld-pane-title">Active Stack</span><button class="ld-btn ld-compact" data-act="draft-addlora">＋ LoRA</button></div>
              <div class="ld-pane-body ld-stack-body">
                <div class="ld-draft-loras" style="display:flex;flex-direction:column;gap:6px"></div>
                <div class="ld-help">LoRAs here are temporary Studio settings until you update or save a preset.</div>
              </div>
            </section>
            </div>
          </div>
        </div>
      </section>

      <section class="ld-view" data-view="story">
        <div class="ld-form-view">
          <div class="ld-card ld-story-hero">
            <div>
              <div class="ld-subtitle">Story illustration control</div>
              <div class="ld-help">Committed preset: <strong class="ld-story-preset-name">None</strong>. Studio is isolated: no story preset tags, profiles, quality tags, or hidden extras are sent unless you type them here yourself.</div>
            </div>
            <div class="ld-row" style="min-width:250px">
              <button class="ld-btn" data-act="scan">Scan latest 📖</button>
              <button class="ld-btn ld-primary" data-act="scan-old">Choose old message 📚</button>
              <button class="ld-btn ld-cancel-scan" data-act="cancel-scan" style="display:none">Cancel parser</button>
            </div>
          </div>
          <div class="ld-card">
            <div class="ld-subtitle">Illustration mode</div>
            <select class="ld-mode">
              <option value="off">Off — no story illustrations</option>
              <option value="inline">Inline — story model requests images</option>
              <option value="parser-manual">Parser — manual scans only</option>
              <option value="parser-auto">Parser — automatic after replies</option>
              <option value="direct-manual">Direct — manual scans only</option>
              <option value="direct-auto">Direct — automatic after replies</option>
            </select>
            <div class="ld-mode-note ld-help">Choose the prompt pipeline and its trigger together. Manual keeps the Scan buttons available without running after every reply; automatic runs the same pipeline after each saved story reply.</div>
            <input type="checkbox" class="ld-autoscan" hidden aria-hidden="true" tabindex="-1" />
            <label style="display:flex;align-items:center;gap:7px;margin-top:7px;font-size:12px"><input type="checkbox" class="ld-chartags" style="width:auto" /> Use active character image tags when the preset profile is blank</label>
            <label style="display:flex;align-items:center;gap:7px;margin-top:7px;font-size:12px"><input type="checkbox" class="ld-strip-directives" style="width:auto" /> Hide generated images and image-request directives from the story model</label>
            <div class="ld-help">Some presets teach the model to request pictures by writing markdown such as <code>![tags](/api/v1/images/gen)</code>. Those never render, and each one left in the history teaches the model to write another. This removes them from what the model sees for each generation — your stored messages are never modified. Real images, including LumiDraw's own, are always left alone.</div>
            <label style="display:flex;align-items:center;gap:7px;margin-top:11px;font-size:12px"><input type="checkbox" class="ld-size-images" style="width:auto" /> Set the display width of images in chat</label>
            <div class="ld-size-images-row" style="display:none;align-items:center;gap:8px;margin-top:6px"><input type="range" class="ld-image-width" min="200" max="1200" step="10" style="flex:1" /><input type="number" class="ld-image-width-num" min="200" max="1200" step="10" style="width:76px" /><span style="font-size:12px;opacity:0.7">px</span></div>
            <div class="ld-help">Applies immediately, to every image in the conversation. This is presentation only — nothing is regenerated and no message is modified. Leave it off if you already size images with your own custom CSS, or the two will fight.</div>
            <label style="display:flex;align-items:center;gap:7px;margin-top:11px;font-size:12px"><input type="checkbox" class="ld-optimized-previews" style="width:auto" /> Use optimized image previews</label>
            <label style="display:flex;align-items:center;gap:7px;margin-top:7px;font-size:12px"><input type="checkbox" class="ld-delete-chat-images" style="width:auto" /> Delete unshared LumiDraw images when their chat is deleted</label>
            <div class="ld-parser-binding-controls" style="margin-top:9px">
              <span class="ld-label">Parser engine</span>
              <select class="ld-parser-engine">
                <option value="legacy">Legacy instruction-only — version 0.13 behavior</option>
                <option value="anima">Anima hybrid experimental — structured anchors + legacy-style tags</option>
              </select>
              <div class="ld-binding-note ld-parser-engine-note">Legacy sends the story passage to the selected parser using only the instruction below, then sends its returned tag prompt directly to Draw Things.</div>
              <div class="ld-anima-context-controls" style="margin-top:9px;display:none">
                <div class="ld-row ld-mobile-stack">
                  <div>
                    <span class="ld-label">Reference context</span>
                    <select class="ld-parser-context">
                      <option value="0">Current message only</option>
                      <option value="1">1 previous story message</option>
                      <option value="2">2 previous story messages</option>
                      <option value="3">3 previous story messages</option>
                      <option value="4">4 previous story messages</option>
                    </select>
                  </div>
                  <div style="display:flex;align-items:end;padding-bottom:5px">
                    <label style="display:flex;align-items:center;gap:7px;font-size:12px"><input type="checkbox" class="ld-use-loom-ledger" style="width:auto" /> Use latest &lt;loomledger&gt; as continuity reference</label>
                  </div>
                </div>
                <div class="ld-help">Prior messages and the latest Loom ledger may resolve clothing, accessories, props, location, and pronouns. Only the current message may supply the illustrated moment or anchor. This counts <strong>story</strong> messages: your own turns are included as well but do not use up the count, since a reply like &ldquo;I take her hand&rdquo; carries little scene.</div>
              </div>
              <div class="ld-help ld-story-last-status">Auto illustrations idle.</div>
              <div style="margin-top:11px;padding-top:9px;border-top:1px solid var(--ld-border, rgba(255,255,255,.08))">
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="ld-label" style="margin:0">Cast — this chat</span>
                  <select class="ld-cast-pick" style="flex:1"></select>
                  <button class="ld-btn ld-compact" data-act="cast-duplicate" title="Copy this cast and use the copy here, so the original story keeps its own">Copy</button>
                </div>
                <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
                  <span class="ld-label" style="margin:0;flex:0 0 auto">Playing as</span>
                  <select class="ld-chat-persona" style="flex:1"></select>
                </div>
                <div class="ld-help" style="margin-top:3px">Who <em>you</em> are in this chat. Lumiverse does not record a persona per chat, so LumiDraw cannot read it — pick once and it is remembered for this chat only. This beats the cast's persona, so a new story is not stuck with whoever the last one was played as.</div>
                <label style="display:flex;align-items:center;gap:6px;margin-top:5px;font-size:12px">
                  <input type="checkbox" class="ld-cast-fantasy" />
                  <span>Fantasy setting — don't treat elves as a mistake</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:12px">
                  <input type="checkbox" class="ld-chat-leads" />
                  <span>Take the character and persona from the chat</span>
                </label>
                <div class="ld-help">On, this chat's own character card and persona are used for the two lead roles, so a new chat with a different persona just works. The cast still supplies the supporting characters and everyone's outfits. Off, the cast's own two leads are used — which pins them to every chat that shares the cast.</div>
                <div class="ld-help ld-cast-summary" style="margin-top:4px"></div>
                <div class="ld-help">A cast is <strong>who</strong> is in this story. Your preset is <strong>what the picture looks like</strong> — model, LoRAs, steps, quality. Changing presets no longer changes who is in the scene, and a character the story introduces here stays here.</div>
                <div class="ld-status ld-cast-status" style="font-size:11px"></div>
              </div>
              <div style="margin-top:11px;padding-top:9px;border-top:1px solid var(--ld-border, rgba(255,255,255,.08))">
                <div style="display:flex;align-items:center;gap:8px">
                  <span class="ld-label" style="margin:0">Wardrobe of record — this chat</span>
                  <button class="ld-btn ld-compact" data-act="wardrobe-refresh" title="Reload the saved wardrobe state">↻</button>
                  <button class="ld-btn ld-compact" data-act="wardrobe-sync" title="Ask the parser to extract explicit clothing changes from the latest story passage; no image is generated">Sync latest passage</button>
                </div>
                <div class="ld-wardrobe-rows" style="margin-top:6px"></div>
                <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
                  <select class="ld-wardrobe-add" style="flex:1"></select>
                  <button class="ld-btn ld-compact" data-act="wardrobe-add" title="Put this saved character into the cast this chat actually uses">Add to cast</button>
                </div>
                <div class="ld-help" style="margin-top:3px">Somebody in the story who is not on the character card — from a lorebook, say — goes here. This writes to whatever this chat reads from, which the preset editor's cast list does not.</div>
                <div class="ld-help">What images use when the passage does not describe clothing. Save and clear act on one character only. Sync latest passage runs the parser without generating an image and changes only clothing explicitly established there; silence leaves everyone untouched.</div>
                <div class="ld-status ld-wardrobe-status" style="font-size:11px"></div>
              </div>
            </div>
            <div style="margin-top:11px;padding:8px 9px;border-radius:6px;background:var(--ld-soft, rgba(255,255,255,.04))">
              <label style="display:flex;align-items:center;gap:6px">
                <input type="checkbox" class="ld-direct-mode" />
                <span><strong>Direct mode</strong> — let the parser write the prompt</span>
              </label>
              <div class="ld-help" style="margin-top:4px">The parser gets your character sheets, wardrobe, and place. With one or two people it writes the finished Danbooru prompt. With three or four it returns a spatial plan that LumiDraw formats into left/center/right subject clauses for Anima. The older compiler stays off: no garment substitutes or inferred orientation. Off = the existing pipeline, unchanged.</div>
            </div>
            <div class="ld-row" style="margin-top:9px">
              <div><span class="ld-label">Minimum images (0 = model decides)</span><input class="ld-minimg" type="number" min="0" max="4" step="1" /></div>
              <div><span class="ld-label">Maximum images</span><input class="ld-maximg" type="number" min="1" max="4" step="1" /></div>
            </div>
            <div style="margin-top:9px">
              <span class="ld-label">Maximum characters per image (Direct mode)</span>
              <select class="ld-maxsubjects">
                <option value="2">2 — proven default</option>
                <option value="3">3 — spatial group mode</option>
                <option value="4">4 — experimental spatial group</option>
              </select>
              <div class="ld-help" style="margin-top:3px">Two remains the unchanged reliable fallback. Three and four use repeated spatial labels, one owner per detail, and no BREAK separators. They preserve more participants but remain experimental.</div>
            </div>
          </div>
          <div class="ld-card">
            <span class="ld-label ld-parser-instruction-label">Legacy parser instruction</span>
            <textarea class="ld-parser-instr" style="min-height:110px"></textarea>
            <button class="ld-btn ld-compact" data-act="reset-parser" style="margin-top:6px">Reset to default</button>
          </div>
          <div class="ld-card">
            <span class="ld-label">Inline scene-selection guidance</span>
            <textarea class="ld-protocol" style="min-height:110px"></textarea>
            <button class="ld-btn ld-compact" data-act="reset-protocol" style="margin-top:6px">Reset to default</button>
          </div>
          <div class="ld-card ld-story-debug">
            <div class="ld-subtitle ld-parser-debug-title">What the last scan produced</div>
            <div class="ld-help">Legacy mode shows the parser's direct tag prompt. Anima hybrid mode shows the bound JSON scene plus a mostly tag-based prompt with a few controlled natural-language anchors. Inline mode remains separate.</div>
            <span class="ld-label" style="margin-top:8px">Final Draw Things prompt</span>
            <textarea class="ld-story-final-prompt" readonly placeholder="No parser prompt has been generated yet."></textarea>
            <details class="ld-profile-block">
              <summary>Parsed scene / parser reply</summary>
              <div class="ld-profile-fields"><textarea class="ld-story-parsed" readonly></textarea></div>
            </details>
          </div>
        </div>
      </section>

      <section class="ld-view" data-view="presets">
        <div class="ld-form-view">
          <div class="ld-card">
            <div class="ld-subtitle">Reusable character library</div>
            <div class="ld-help">Save a character once, then link it into any Story preset — as the main character or as an additional cast member. Changes to a linked character apply everywhere it is used.</div>
            <button class="ld-btn" data-act="new-character" style="margin-top:8px">＋ New reusable character</button>
            <div class="ld-status ld-charlib-status" style="margin-top:6px"></div>
            <div class="ld-charlib-list" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
          <div class="ld-card">
            <div class="ld-subtitle">Reusable persona library</div>
            <div class="ld-help">Save a persona once, then link it into any Story preset. Changes to a linked persona apply everywhere it is used.</div>
            <button class="ld-btn" data-act="new-persona" style="margin-top:8px">＋ New reusable persona</button>
            <div class="ld-status ld-persona-status" style="margin-top:6px"></div>
            <div class="ld-persona-list" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
          <div class="ld-card">
            <div class="ld-subtitle">Places — what a location looks like</div>
            <div class="ld-help">Give a recurring location its own tags once. When the story mentions it by name or by one of its cues, those tags become the setting — instead of the model re-inventing the room every image. One per line:<br /><code>name = setting tags | aliases: cues | no: negative tags</code></div>
            <textarea class="ld-places" style="min-height:96px;margin-top:7px" placeholder="Jason's truck = truck interior, worn bench seat, dashboard, windshield | aliases: the truck, the cab, the pickup | no: car seat, bucket seat
the diner = diner, booth seating, formica table, neon sign | aliases: the diner, Ruby's"></textarea>
            <div class="ld-section-actions"><button class="ld-btn" data-act="save-places">Save places</button></div>
            <div class="ld-status ld-places-status" style="margin-top:6px"></div>
          </div>
          <div class="ld-persona-editor ld-card" style="display:none">
            <div class="ld-subtitle ld-lib-ed-title">Persona library editor</div>
            <span class="ld-label">Library name</span><input class="ld-persona-ed-name" placeholder="Eric" />
            <div class="ld-profile-grid" style="margin-top:7px">
              <div><span class="ld-label">Anchor / name</span><input class="ld-persona-ed-anchor" placeholder="Eric" /></div>
              <div><span class="ld-label">Count tag</span><input class="ld-persona-ed-count" placeholder="1boy" /></div>
            </div>
              <div style="margin-top:7px"><span class="ld-label">Name in prompts (optional)</span><input class="ld-persona-ed-promptname" placeholder="Price" /><div class="ld-hint">Only needed when the name means something to the image model — "Fanny" is booru slang, "Rose" draws roses. A surname does not help; use a name without the word at all.</div></div>
            <div><span class="ld-label">Stable subject phrase</span><input class="ld-persona-ed-subject" placeholder="adult man" /></div>
            <div><span class="ld-label">Always include (Direct mode)</span><input class="ld-persona-ed-identity" placeholder="futanari" /><div class="ld-hint">Non-negotiable identity tags. Direct mode restores these if the parser drops them. Stable futanari in Permanent appearance is also locked automatically.</div></div>
            <div><span class="ld-label">Permanent appearance tags</span><textarea class="ld-persona-ed-tags" style="min-height:58px"></textarea></div>
            <div><span class="ld-label">Default outfit tags</span><textarea class="ld-persona-ed-outfit" style="min-height:48px"></textarea></div>
            <div><span class="ld-label">Default appearance state</span><input class="ld-persona-ed-default-state" placeholder="Default" /></div>
            <div><span class="ld-label">Appearance states / forms</span><textarea class="ld-persona-ed-states" style="min-height:92px" placeholder="Casual | casual clothes => t-shirt, jeans
Armored [outfit=omit; subject=armored man] | armor, battle gear => heavy plate armor"></textarea></div>
            <div class="ld-help">One per line: <code>Name [count=1boy; outfit=inherit|omit; subject=optional phrase] | recognition phrases =&gt; appearance tags</code>. Only the selected state is injected.</div>
            <div><span class="ld-label">Named looks (clothing)</span><textarea class="ld-persona-ed-looks" style="min-height:74px" placeholder="formal = black suit, tie | aliases: the suit
gym = tank top, shorts | aliases: the gym"></textarea></div>
            <div><span class="ld-label">Default look</span><input class="ld-persona-ed-default-look" placeholder="(none)" /></div>
            <div class="ld-help">A <b>look</b> is clothing, not a body — use appearance states for transformations. One per line: <code>name = outfit tags | aliases: cues | no: negative tags</code>. A look is applied when the passage names it or an alias appears, then ordinary outfit tracking takes over.</div>
            <div><span class="ld-label">Partial features</span><textarea class="ld-persona-ed-features" style="min-height:48px" placeholder="wolf eyes = yellow eyes, slit pupils"></textarea></div>
            <div class="ld-help">Optional, one per line: <code>name = tags</code>. A feature is one piece of a transformation that can show on its own — <code>wolf eyes = yellow eyes, slit pupils</code>. The parser turns these on for a partial change ("only his eyes shifted") instead of switching the whole appearance state, which would transform the entire character.</div>
            <div><span class="ld-label">Named props / visual aliases</span><textarea class="ld-persona-ed-aliases" style="min-height:48px" placeholder="Named weapon = visual description"></textarea></div>
            <div><span class="ld-label">Conditional visible anatomy</span><textarea class="ld-persona-ed-anatomy" style="min-height:48px"></textarea></div>
            <div><span class="ld-label">Conditional anatomy rule</span><select class="ld-persona-ed-anatomy-mode"><option value="relevant">Only when explicitly named and visible in story</option><option value="always">Include in every NSFW/explicit scene</option><option value="manual">Never include automatically</option></select></div>
            <div class="ld-row" style="margin-top:10px"><button class="ld-btn ld-primary ld-lib-ed-save" data-act="persona-save">Save persona</button><button class="ld-btn" data-act="persona-cancel">Cancel</button></div>
            <div class="ld-status ld-persona-ed-status" style="margin-top:6px"></div>
          </div>
          <div class="ld-card">
            <div class="ld-subtitle">Preset manager</div>
            <div class="ld-help">Presets pin the complete story recipe. Studio experiments remain separate until you explicitly save them.</div>
            <button class="ld-btn" data-act="new-preset" style="margin-top:8px">＋ New preset from synced state</button>
            <div class="ld-status ld-preset-status" style="margin-top:6px"></div>
          </div>
          <div class="ld-preset-list" style="display:flex;flex-direction:column;gap:6px"></div>
          <div class="ld-editor ld-card" style="display:none">
            <div class="ld-subtitle">Preset editor</div>
            <span class="ld-label">Name</span><input class="ld-ed-name" />
            <span class="ld-label" style="margin-top:7px">Model</span><input class="ld-ed-model" list="ld-model-catalog-ed" placeholder="— choose or type a model —" /><datalist id="ld-model-catalog-ed"></datalist><div class="ld-hint">Installed models autocomplete. For Draw Things Cloud Compute, type a model from its Official or Community channel — cloud refuses local merges, and the model need not be installed here.</div>
            <div class="ld-row" style="margin-top:7px">
              <div><span class="ld-label">Sampler</span><select class="ld-ed-sampler"><option value="">— choose sampler —</option></select></div>
              <div style="flex:0 0 82px"><span class="ld-label">Steps</span><input class="ld-ed-steps" type="number" min="1" max="150" /></div>
              <div style="flex:0 0 82px"><span class="ld-label">CFG</span><input class="ld-ed-cfg" type="number" step="0.5" min="0" /></div>
            </div>
            <div class="ld-row" style="margin-top:7px">
              <div><span class="ld-label">Width</span><input class="ld-ed-w" type="number" step="64" min="256" /></div>
              <div><span class="ld-label">Height</span><input class="ld-ed-h" type="number" step="64" min="256" /></div>
            </div>
            <span class="ld-label" style="margin-top:9px">LoRAs</span>
            <div class="ld-ed-loras" style="display:flex;flex-direction:column;gap:5px"></div>
            <button class="ld-btn ld-compact" data-act="ed-addlora" style="margin-top:5px">＋ LoRA</button>
            <span class="ld-label" style="margin-top:9px">Quality tags (always first)</span><input class="ld-ed-quality" />
            <div class="ld-help" style="margin-top:11px;padding:7px 9px;border-radius:6px;background:var(--ld-soft, rgba(255,255,255,.04))">
              <strong>Characters have moved.</strong> Who is in a story is now a <strong>cast</strong>, set per chat in the Story tab — so changing this preset no longer changes who is in the scene or what they are wearing. The two profiles below still work and are still the fallback for a chat with no cast bound. Nothing here has been deleted or altered.
            </div>
            <details class="ld-profile-block">
              <summary>Main character identity profile <span style="opacity:.55">(fallback — casts take precedence)</span></summary>
              <div class="ld-profile-fields">
                <div><span class="ld-label">Character source</span><select class="ld-ed-char-link"><option value="">Local profile stored in this preset</option></select></div>
                <div class="ld-help">Link a reusable character from the library, or keep a local one-off character in this preset. Linked library profiles are edited from the Character Library above.</div>
                <div class="ld-profile-grid">
                  <div><span class="ld-label">Anchor / name</span><input class="ld-ed-char-anchor" placeholder="Mara" /></div>
                  <div><span class="ld-label">Count tag</span><input class="ld-ed-char-count" placeholder="1girl" /></div>
                </div>
                  <div style="margin-top:7px"><span class="ld-label">Name in prompts (optional)</span><input class="ld-ed-char-promptname" placeholder="Price" /><div class="ld-hint">Only needed when the name means something to the image model — "Fanny" is booru slang, "Rose" draws roses. A surname does not help; use a name without the word at all.</div></div>
                <div><span class="ld-label">Stable subject phrase</span><input class="ld-ed-char-subject" placeholder="adult woman" /></div>
                <div><span class="ld-label">Always include (direct mode)</span><input class="ld-ed-char-identity" placeholder="futanari" /></div>
                <div><span class="ld-label">Permanent appearance tags</span><textarea class="ld-ed-chartags" style="min-height:58px" placeholder="feminine appearance, tall, curvy, long black hair, green eyes"></textarea></div>
                <div><span class="ld-label">Default outfit tags</span><textarea class="ld-ed-char-outfit" style="min-height:48px" placeholder="black fitted jacket, dark trousers"></textarea></div>
                <div><span class="ld-label">Default appearance state</span><input class="ld-ed-char-default-state" placeholder="Human" /></div>
                <div><span class="ld-label">Appearance states / forms</span><textarea class="ld-ed-char-states" style="min-height:92px" placeholder="Human [count=1boy; outfit=inherit; subject=adult human man] | human form, unshifted => broad shoulders, messy dark brown hair
Hybrid [count=1boy; outfit=inherit; subject=humanoid werewolf] | hybrid form, half-shifted => wolf ears, partial muzzle, furred arms, claws, tail
Wolf [count=1other; outfit=omit; appearance=replace; subject=massive wolf] | wolf form, fully shifted, on four paws => dark brown fur, amber eyes, quadruped"></textarea></div>
                <div class="ld-row ld-mobile-stack"><div><span class="ld-label">Named looks (clothing)</span><textarea class="ld-ed-char-looks" style="min-height:74px" placeholder="formal = black evening gown, heels | aliases: gala, the gown | no: jeans
swim = blue bikini | aliases: the pool"></textarea><div class="ld-hint">A <b>look</b> is a set of clothes, not a body — appearance states are for transformations. A look is applied when the passage names it or one of its <b>aliases</b> appears; from then on ordinary outfit tracking takes over, so an incidental change still sticks. Leave blank if you do not use them.</div></div>
                <div style="flex:0 0 170px"><span class="ld-label">Default look</span><input class="ld-ed-char-default-look" placeholder="(none)" /><div class="ld-hint">Used when nothing names or implies one.</div></div></div>
                <div class="ld-help">Optional, one per line: <code>Name [count=...; outfit=inherit|omit; appearance=inherit|replace; subject=...] | recognition phrases =&gt; appearance tags</code>. Shared traits stay under Permanent appearance; only one saved state is injected at a time. Use <code>appearance=replace</code> for a transformation that should drop the permanent traits entirely — a fully shifted werewolf otherwise keeps its human hair and eye colour alongside its fur.</div>
                <div><span class="ld-label">Partial features</span><textarea class="ld-ed-char-features" style="min-height:48px" placeholder="wolf eyes = yellow eyes, slit pupils
claws = claws, elongated nails
fangs = fangs, sharp teeth"></textarea></div>
                <div class="ld-help">Optional, one per line: <code>name = tags</code>. A feature is one piece of a transformation that can show on its own — <code>wolf eyes = yellow eyes, slit pupils</code>. The parser turns these on for a partial change ("only his eyes shifted") instead of switching the whole appearance state, which would transform the entire character.</div>
                <div><span class="ld-label">Named props / visual aliases</span><textarea class="ld-ed-char-aliases" style="min-height:48px" placeholder="Aegis-fang = single massive warhammer"></textarea></div>
                <div class="ld-help">Optional, one per line: <code>proper name = visual description</code>. The description is injected only when that prop appears in this character's parsed scene.</div>
                <div><span class="ld-label">Conditional visible anatomy</span><textarea class="ld-ed-char-anatomy" style="min-height:48px" placeholder="penis"></textarea></div>
                <div><span class="ld-label">Conditional anatomy rule</span><select class="ld-ed-char-anatomy-mode"><option value="relevant">Only when explicitly named and visible in story</option><option value="always">Include in every NSFW/explicit scene</option><option value="manual">Never include automatically</option></select></div>
                <div class="ld-help">Enter only concrete anatomy that may be hidden by clothing or framing, such as penis. Put identity and presentation tags—femboy, feminine male, trans woman, androgynous—and stable body traits under Permanent appearance. Unsupported phrases are ignored by the Anima compiler.</div>
              </div>
            </details>
            <details class="ld-profile-block">
              <summary>User / persona identity profile</summary>
              <div class="ld-profile-fields">
                <div><span class="ld-label">Persona source</span><select class="ld-ed-persona-link"><option value="">Local profile stored in this preset</option></select></div>
                <div class="ld-help">Link a reusable persona from the library, or keep a local one-off persona in this preset. Linked library profiles are edited from the Persona Library above.</div>
                <div class="ld-profile-grid">
                  <div><span class="ld-label">Anchor / name</span><input class="ld-ed-persona-anchor" placeholder="User" /></div>
                  <div><span class="ld-label">Count tag</span><input class="ld-ed-persona-count" placeholder="1boy" /></div>
                </div>
                  <div style="margin-top:7px"><span class="ld-label">Name in prompts (optional)</span><input class="ld-ed-persona-promptname" placeholder="Price" /><div class="ld-hint">Only needed when the name means something to the image model — "Fanny" is booru slang, "Rose" draws roses. A surname does not help; use a name without the word at all.</div></div>
                <div><span class="ld-label">Stable subject phrase</span><input class="ld-ed-persona-subject" placeholder="adult man" /></div>
                <div><span class="ld-label">Permanent appearance tags</span><textarea class="ld-ed-personatags" style="min-height:58px"></textarea></div>
                <div><span class="ld-label">Default outfit tags</span><textarea class="ld-ed-persona-outfit" style="min-height:48px"></textarea></div>
                <div><span class="ld-label">Default appearance state</span><input class="ld-ed-persona-default-state" placeholder="Default" /></div>
                <div><span class="ld-label">Appearance states / forms</span><textarea class="ld-ed-persona-states" style="min-height:92px"></textarea></div>
                <div class="ld-row ld-mobile-stack"><div><span class="ld-label">Named looks (clothing)</span><textarea class="ld-ed-persona-looks" style="min-height:74px" placeholder="formal = black evening gown, heels | aliases: gala, the gown | no: jeans
swim = blue bikini | aliases: the pool"></textarea><div class="ld-hint">A <b>look</b> is a set of clothes, not a body — appearance states are for transformations. A look is applied when the passage names it or one of its <b>aliases</b> appears; from then on ordinary outfit tracking takes over, so an incidental change still sticks. Leave blank if you do not use them.</div></div>
                <div style="flex:0 0 170px"><span class="ld-label">Default look</span><input class="ld-ed-persona-default-look" placeholder="(none)" /><div class="ld-hint">Used when nothing names or implies one.</div></div></div>
                <div class="ld-help">Optional, one per line: <code>Name [count=...; outfit=inherit|omit; subject=...] | recognition phrases =&gt; appearance tags</code>.</div>
                <div><span class="ld-label">Partial features</span><textarea class="ld-ed-persona-features" style="min-height:48px" placeholder="wolf eyes = yellow eyes, slit pupils"></textarea></div>
                <div class="ld-help">Optional, one per line: <code>name = tags</code>. A feature is one piece of a transformation that can show on its own — <code>wolf eyes = yellow eyes, slit pupils</code>. The parser turns these on for a partial change ("only his eyes shifted") instead of switching the whole appearance state, which would transform the entire character.</div>
                <div><span class="ld-label">Named props / visual aliases</span><textarea class="ld-ed-persona-aliases" style="min-height:48px" placeholder="Named weapon = visual description"></textarea></div>
                <div class="ld-help">Optional, one per line: <code>proper name = visual description</code>. The description is injected only when that prop appears in this persona's parsed scene.</div>
                <div><span class="ld-label">Conditional visible anatomy</span><textarea class="ld-ed-persona-anatomy" style="min-height:48px"></textarea></div>
                <div><span class="ld-label">Conditional anatomy rule</span><select class="ld-ed-persona-anatomy-mode"><option value="relevant">Only when explicitly named and visible in story</option><option value="always">Include in every NSFW/explicit scene</option><option value="manual">Never include automatically</option></select></div>
                <div class="ld-help">Enter only concrete anatomy that may be hidden by clothing or framing, such as penis. Put identity and presentation tags—femboy, feminine male, trans woman, androgynous—and stable body traits under Permanent appearance. Unsupported phrases are ignored by the Anima compiler.</div>
              </div>
            </details>
            <details class="ld-profile-block">
              <summary>Additional cast (saved characters)</summary>
              <div class="ld-profile-fields">
                <div class="ld-help">Add up to 4 saved characters from the Character Library beyond the main character and persona. Each gets its own named ref, locked appearance, states, and anatomy rules in the parser and compiler. The parser illustrates whoever is present in the scene — cast members who do not appear in a passage are simply not drawn.</div>
                <div class="ld-row">
                  <div style="flex:1"><select class="ld-ed-cast-select"><option value="">— choose a saved character —</option></select></div>
                  <button class="ld-btn ld-compact" data-act="ed-cast-add" style="flex:0 0 auto">＋ Add to cast</button>
                </div>
                <div class="ld-ed-cast-list" style="display:flex;flex-direction:column;gap:5px;margin-top:6px"></div>
              </div>
            </details>
            <span class="ld-label" style="margin-top:7px">Scene anchor (default location)</span><input class="ld-ed-scene-anchor" placeholder="mycetheric grove, pink bioluminescent mushrooms, glowing moss" />
            <label class="ld-check" style="display:flex;align-items:center;gap:7px;margin-top:9px;font-size:12px"><input type="checkbox" class="ld-ed-break" style="width:auto" /> Separate each character with BREAK</label>
            <div class="ld-hint">Inserts BREAK between the characters in a multi-subject prompt. BREAK resets the attention chunk, which is what keeps one character's hair, build or clothes from reaching another. Only add BREAK to your quality tags — never to a character's own tags, or it lands mid-description.</div>
            <div class="ld-help">Where this story takes place, as tags. The parser is a separate, stateless call that only sees the current passage and a short recency window — during a long scene the prose stops naming the location, so it can go blind to it and invent one. This is handed over on every request as the established location. LumiDraw updates its own record when a passage clearly moves the characters; this is the starting point and the fallback.</div>
            <span class="ld-label" style="margin-top:7px">Banned tags</span><input class="ld-ed-banned" />
            <span class="ld-label" style="margin-top:9px">Anima artist index</span>
            <div class="ld-help" style="margin-top:2px">An artist tag Anima was never trained on is <strong>ignored in silence</strong> — no error, just a blander image and no way to tell the style did nothing. Paste an artist index here once and LumiDraw will check your <code>@tags</code> and suggest the near miss. Not bundled: 59,000 names is a megabyte of dead weight for everyone who never loads it.</div>
            <textarea class="ld-artist-index" rows="3" placeholder="One artist name per line. A leading @ and a trailing work count are both fine."></textarea>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
              <button class="ld-btn ld-compact" data-act="artist-load">Load index</button>
              <button class="ld-btn ld-compact" data-act="artist-check">Check my tags</button>
              <button class="ld-btn ld-compact" data-act="artist-clear">Clear</button>
            </div>
            <div class="ld-status ld-artist-status" style="font-size:11px"></div>
            <span class="ld-label" style="margin-top:7px">Prompt prefix</span><textarea class="ld-ed-prefix" style="min-height:58px"></textarea>
            <span class="ld-label" style="margin-top:7px">Negative prompt</span><textarea class="ld-ed-negative" style="min-height:58px"></textarea>
            <div class="ld-row" style="margin-top:10px"><button class="ld-btn ld-primary" data-act="ed-save">Save preset</button><button class="ld-btn" data-act="ed-cancel">Cancel</button></div>
            <div class="ld-status ld-ed-status" style="margin-top:6px"></div>
          </div>
        </div>
      </section>

      <section class="ld-view" data-view="settings">
          <nav class="ld-settings-rail" role="tablist">
            <button class="ld-settings-tab ld-active" data-settings-tab="connection">Connection</button>
            <button class="ld-settings-tab" data-settings-tab="parser">Parser</button>
            <button class="ld-settings-tab" data-settings-tab="advanced">Advanced</button>
          </nav>
        <div class="ld-form-view">
          <div data-settings-section="parser" class="ld-card">
            <div class="ld-subtitle">Parser connection</div>
            <div class="ld-row ld-mobile-stack">
              <div><span class="ld-label">Connection</span><div style="display:flex;gap:6px;align-items:center"><select class="ld-parser-conn" style="flex:1"><option value="">— default connection —</option></select><button class="ld-btn ld-compact" data-act="refresh-parser-sources" title="Reload available parser connections">↻</button></div></div>
              <div><span class="ld-label">Model override (leave empty)</span><div style="display:flex;gap:6px;align-items:center"><input class="ld-parser-model" style="flex:1" placeholder="leave empty to use the connection's own model" /><button class="ld-btn ld-compact ld-clear-override" data-act="clear-model-override" title="Go back to the connection's own model" style="display:none">Clear</button></div><div class="ld-model-override-note" style="font-size:11px;margin-top:4px"></div></div>
              <div><span class="ld-label">Temperature</span><input class="ld-parser-temperature" type="number" min="0" max="2" step="0.05" value="0.2" /><div class="ld-hint">Parser sampling temperature. Some models want a specific value; 0.2 is LumiDraw's default.</div></div>
              <div>
                <span class="ld-label">Settings Draw Things refused</span>
                <div style="display:flex;gap:6px;align-items:center">
                  <span class="ld-rejected-keys" style="flex:1;font-size:12px;opacity:.8">none</span>
                  <button class="ld-btn ld-compact" data-act="clear-rejected-keys">Clear</button>
                </div>
                <div class="ld-hint">Draw Things refuses an entire generation if one setting is not in its API, so refused settings are remembered and omitted. Clear this after updating Draw Things to try them again.</div>
              </div>
              <div><span class="ld-label">Parser output budget (tokens)</span><input class="ld-parser-maxtokens" type="number" min="1200" max="32000" step="500" placeholder="12000" /><div class="ld-hint">First-attempt <code>max_tokens</code>. The JSON needs ~700; the rest is headroom for a provider that will not turn reasoning off. Lower it to ~4000 only once the log shows reasoning is genuinely off.</div></div>
              <div><span class="ld-label">Parser request overrides (JSON, advanced)</span><textarea class="ld-parser-overrides" style="min-height:64px;font-family:ui-monospace,monospace;font-size:12px" placeholder='{"reasoning":{"enabled":false}}'></textarea><div class="ld-hint">Merged into the parser request. Use this to force a provider-specific setting — most often turning reasoning off. Check the Spindle log for <code>reasoning_tokens=</code> after a scan to see whether it worked.</div></div>
            </div>
          </div>
          <div data-settings-section="connection" class="ld-card">
            <div class="ld-subtitle">Draw Things API</div>
            <div class="ld-row ld-mobile-stack">
              <div><span class="ld-label">Host</span><input class="ld-host" /></div>
              <div style="flex:0 0 120px"><span class="ld-label">Port</span><input class="ld-port" type="number" /></div>
            </div>
            <div class="ld-section-actions"><button class="ld-btn" data-act="save-settings">Save connections</button><button class="ld-btn" data-act="test">Test Draw Things</button></div>
          </div>
          <div data-settings-section="connection" class="ld-card">
            <div class="ld-subtitle">LumiDraw Bridge catalog</div>
            <div class="ld-row ld-mobile-stack">
              <div><span class="ld-label">Host</span><input class="ld-bridge-host" value="127.0.0.1" /></div>
              <div style="flex:0 0 120px"><span class="ld-label">Port</span><input class="ld-bridge-port" type="number" value="7863" /></div>
            </div>
            <button class="ld-btn" data-act="test-bridge" style="margin-top:7px">Test Bridge and reload catalog</button>
            <div class="ld-status ld-bridge-status" style="margin-top:6px"></div>
            <div class="ld-help" style="margin-top:5px">The extension backend connects locally on your Mac, so catalog dropdowns still work while Lumiverse is open on your phone.</div>
          </div>
          <div data-settings-section="advanced" class="ld-card">
            <div class="ld-subtitle">Draw Things Cloud Compute</div>
            <label class="ld-check"><input type="checkbox" class="ld-cloud-enabled" /> <span>Generate on Draw Things cloud instead of this Mac</span></label>
            <div class="ld-row ld-mobile-stack" style="margin-top:7px">
              <div><span class="ld-label">Relay host</span><input class="ld-cloud-host" value="127.0.0.1" /></div>
              <div style="flex:0 0 120px"><span class="ld-label">Port</span><input class="ld-cloud-port" type="number" value="7864" /></div>
            </div>
            <div style="margin-top:7px"><span class="ld-label">Cloud model</span><input class="ld-cloud-model" placeholder="e.g. flux_2_klein_4b_q8p.ckpt or hf://…" /><div class="ld-hint">A <b>catalog</b> id or Hugging Face link — <b>not</b> a local filename. Cloud Compute only runs models from the Official or Community channels, which is why your local Anima file is refused.</div></div>
            <label class="ld-check" style="margin-top:7px"><input type="checkbox" class="ld-cloud-fallback" checked /> <span>If cloud fails, generate locally instead of not at all</span></label>
            <button class="ld-btn" data-act="test-cloud" style="margin-top:7px">Test cloud relay</button>
            <div class="ld-status ld-cloud-status" style="margin-top:6px"></div>
            <div class="ld-help" style="margin-top:5px">Needs <code>lumidraw-cloud-relay.mjs</code> running on this Mac. Your API key lives in that process and is never sent here. Free tier is 20 generations a month, Draw Things+ is 200.</div>
          </div>
          <div data-settings-section="advanced" class="ld-card">
            <div class="ld-subtitle">Diagnostics</div>
            <button class="ld-btn" data-act="diagnose">Run diagnostics 🔍</button>
            <button class="ld-btn" data-act="safe-report" style="margin-top:7px">Copy report for Claude (no story text)</button>
            <div class="ld-help">Structure only — subject counts, anatomy family, which rules fired, the negative prompt, and the trace. No passage, no scene statement, no caption, no prompt. Safe to paste when the scene is not.</div>
            <textarea class="ld-safe-report" readonly style="min-height:150px;display:none;margin-top:7px;font-family:monospace;font-size:11px"></textarea>
            <textarea class="ld-diag" readonly style="min-height:150px;display:none;margin-top:7px;font-family:monospace;font-size:11px"></textarea>
          </div>
          <div class="ld-status ld-settings-status"></div>
        </div>
      </section>
    </div>

    <div class="ld-lightbox" aria-hidden="true">
      <div class="ld-lightbox-dialog" role="dialog" aria-modal="true" aria-label="Generated image viewer">
        <div class="ld-lightbox-head">
          <span class="ld-lightbox-title">Generated image</span>
          <button class="ld-x ld-lightbox-close" title="Close image viewer" aria-label="Close image viewer">✕</button>
        </div>
        <div class="ld-lightbox-stage">
          <button class="ld-btn ld-lightbox-nav ld-lightbox-prev" title="Previous image" aria-label="Previous image">‹</button>
          <div class="ld-lightbox-image-wrap"><img class="ld-lightbox-image" alt="Generated image" draggable="false" /></div>
          <button class="ld-btn ld-lightbox-nav ld-lightbox-next" title="Next image" aria-label="Next image">›</button>
          <div class="ld-lightbox-zoom-tools" aria-label="Image zoom controls">
            <button class="ld-btn ld-lightbox-zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
            <button class="ld-btn ld-lightbox-zoom-level" title="Reset zoom" aria-label="Reset zoom">100%</button>
            <button class="ld-btn ld-lightbox-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
          </div>
        </div>
        <div class="ld-lightbox-regen" style="display:none">
          <div class="ld-row" style="margin-bottom:7px;align-items:center">
            <button class="ld-btn ld-compact ld-lightbox-reparse" title="Run the parser again over the passage this image came from and load the new prompt below. Nothing is generated and no image is replaced.">Re-run parser <span style="opacity:.6">(prompt only)</span></button>
            <button class="ld-btn ld-compact ld-lightbox-rebuild" title="Re-parse this message once and rebuild EVERY image it produced, each replaced in place. Use after changing a character's tags.">Replace all images in this message</button>
            <span class="ld-lightbox-reparse-info" style="font-size:11px;opacity:.7"></span>
          </div>
          <div class="ld-lightbox-reparse-picker" style="display:none;margin-bottom:7px"></div>
          <span class="ld-label">Prompt</span>
          <textarea class="ld-lightbox-regen-prompt" spellcheck="false" style="min-height:104px"></textarea>
          <span class="ld-label" style="margin-top:6px">Negative prompt</span>
          <textarea class="ld-lightbox-regen-negative" spellcheck="false" style="min-height:44px"></textarea>
          <label class="ld-lightbox-regen-seedrow" style="display:flex;align-items:center;gap:7px;margin-top:7px;font-size:12px">
            <input type="checkbox" class="ld-lightbox-regen-seed" checked />
            <span>Reuse the original seed <span class="ld-lightbox-regen-seedval"></span></span>
          </label>
          <div class="ld-help">Keeping the seed holds the composition steady so prompt edits show their own effect. Uncheck to roll a completely new image.</div>
          <div class="ld-row" style="margin-top:8px">
            <button class="ld-btn ld-primary ld-lightbox-regen-run">Regenerate &amp; replace now</button>
            <button class="ld-btn ld-lightbox-regen-cancel" style="flex:0 0 auto">Cancel</button>
          </div>
          <div class="ld-status ld-lightbox-regen-status" style="margin-top:6px"></div>
        </div>
        <div class="ld-lightbox-foot">
          <div class="ld-lightbox-meta"></div>
          <div class="ld-lightbox-actions">
            <button class="ld-btn ld-lightbox-fix">Fix this image…</button>
            <button class="ld-btn ld-lightbox-insert" title="Adds a SECOND copy of this image at the top of the latest story message. Not needed after a regeneration — that already replaced the image in place.">Add copy to chat</button>
            <button class="ld-btn ld-primary ld-lightbox-done">Done</button>
          </div>
        </div>
      </div>
    </div>

    <div class="ld-story-picker" aria-hidden="true">
      <div class="ld-story-dialog" role="dialog" aria-modal="true" aria-label="Choose a story message">
        <div class="ld-story-head"><span class="ld-story-title">Choose a story message</span><button class="ld-x ld-story-close" title="Close">✕</button></div>
        <div class="ld-story-tools"><input class="ld-story-search" type="search" placeholder="Search message text…" /><div class="ld-story-help">Newest first. Selecting a message runs Parser mode again and adds the new image without deleting existing images.</div></div>
        <div class="ld-story-list"><div class="ld-story-empty">Loading messages…</div></div>
      </div>
    </div>
    <div class="ld-text-editor" aria-hidden="true">
      <div class="ld-text-editor-dialog" id="ld-text-editor-dialog" role="dialog" aria-modal="true" aria-label="Expanded text editor">
        <div class="ld-text-editor-head"><span class="ld-text-editor-title">Edit text</span><button class="ld-x ld-text-editor-close" title="Cancel and close">✕</button></div>
        <textarea class="ld-text-editor-area" spellcheck="true"></textarea>
        <div class="ld-text-editor-actions"><span class="ld-help" style="margin-right:auto">Escape cancels · ⌘/Ctrl+Enter applies</span><button class="ld-btn ld-text-editor-cancel">Cancel</button><button class="ld-btn ld-primary ld-text-editor-apply">Apply</button></div>
      </div>
    </div>
  `)

  const $ = (sel) => dom.query(sel)

  // The backend deliberately keeps `mode` and `autoScan` as separate saved
  // fields for compatibility. The UI presents one honest behavior choice so
  // nobody has to discover that "Direct + unchecked" secretly means manual.
  function storyModeFromBehavior(value) {
    const behavior = String(value || '')
    if (behavior.startsWith('direct')) return 'direct'
    if (behavior.startsWith('parser')) return 'parser'
    if (behavior === 'inline') return 'inline'
    return 'off'
  }

  function storyAutoScanFromBehavior(value) {
    return /-(?:auto)$/.test(String(value || ''))
  }

  function storyBehaviorFromSettings(mode, autoScan) {
    const normalized = storyModeFromBehavior(mode)
    if (normalized === 'direct' || normalized === 'parser') {
      return `${normalized}-${autoScan === false ? 'manual' : 'auto'}`
    }
    return normalized
  }

  function selectedStoryMode() {
    const select = $('.ld-mode')
    return storyModeFromBehavior(select ? select.value : settings.mode)
  }

  function selectedStoryAutoScan() {
    const select = $('.ld-mode')
    return storyAutoScanFromBehavior(select ? select.value : storyBehaviorFromSettings(settings.mode, settings.autoScan))
  }

  function syncLegacyAutoScanField() {
    const legacy = $('.ld-autoscan')
    if (legacy) legacy.checked = selectedStoryAutoScan()
  }

  // Keep a restored/selected tab visible without using scrollIntoView(), which
  // also moves the vertical form and is especially disruptive above a phone
  // keyboard. This adjusts only the tab rail's horizontal position.
  function revealHorizontalItem(item, scrollHost = item && item.parentElement) {
    if (!item || !scrollHost) return
    requestAnimationFrame(() => {
      if (!item.isConnected || !scrollHost.isConnected) return
      const itemRect = item.getBoundingClientRect()
      const hostRect = scrollHost.getBoundingClientRect()
      if (itemRect.left < hostRect.left) scrollHost.scrollLeft -= hostRect.left - itemRect.left + 4
      else if (itemRect.right > hostRect.right) scrollHost.scrollLeft += itemRect.right - hostRect.right + 4
    })
  }

  // LUMIDRAW_UI_RESET_V1_1
  // UI reset: present features by user intent instead of by implementation layer.
  function applyUiResetV11() {
    const storyView = $('.ld-view[data-view="story"]')
    const libraryView = $('.ld-view[data-view="presets"]')
    if (!storyView || !libraryView || storyView.dataset.uiResetV11 === '1') return
    storyView.dataset.uiResetV11 = '1'

    const make = (tag, cls, text) => {
      const el = document.createElement(tag)
      if (cls) el.className = cls
      if (text !== undefined && text !== null) el.textContent = text
      return el
    }
    const addHelp = (parent, text) => {
      if (!text) return null
      const el = make('div', 'ld-help ld-reset-help', text)
      parent.appendChild(el)
      return el
    }
    const field = (label, node, help) => {
      const wrap = make('div', 'ld-reset-field')
      if (label) wrap.appendChild(make('span', 'ld-label', label))
      if (node) wrap.appendChild(node)
      if (help) addHelp(wrap, help)
      return wrap
    }
    const inline = (...nodes) => {
      const row = make('div', 'ld-reset-inline')
      for (const node of nodes) if (node) row.appendChild(node)
      return row
    }
    const checkbox = (node, label, help) => {
      const wrap = make('div', 'ld-reset-check-wrap')
      const lab = make('label', 'ld-reset-check')
      if (node) {
        node.style.width = 'auto'
        lab.appendChild(node)
      }
      lab.appendChild(make('span', '', label))
      wrap.appendChild(lab)
      if (help) addHelp(wrap, help)
      return wrap
    }
    const card = (title, help) => {
      const el = make('section', 'ld-card ld-reset-card')
      if (title) el.appendChild(make('div', 'ld-subtitle', title))
      if (help) addHelp(el, help)
      return el
    }
    const details = (title, help) => {
      const el = make('details', 'ld-reset-details')
      const summary = make('summary', '', title)
      el.appendChild(summary)
      const body = make('div', 'ld-reset-details-body')
      if (help) addHelp(body, help)
      el.appendChild(body)
      return { el, body }
    }
    const section = (name) => {
      const el = make('div', 'ld-reset-section')
      el.dataset.resetSection = name
      return el
    }
    const rail = (items, key, defaultName) => {
      const nav = make('nav', 'ld-reset-rail')
      nav.setAttribute('role', 'tablist')
      const buttons = {}
      for (const [name, label] of items) {
        const btn = make('button', 'ld-reset-tab', label)
        btn.type = 'button'
        btn.setAttribute('role', 'tab')
        btn.dataset.resetTab = name
        nav.appendChild(btn)
        buttons[name] = btn
      }
      const set = (name) => {
        if (!buttons[name]) name = defaultName
        for (const [id, btn] of Object.entries(buttons)) {
          const active = id === name
          btn.classList.toggle('ld-active', active)
          btn.setAttribute('aria-selected', String(active))
        }
        const root = nav.parentElement
        if (root) {
          for (const pane of root.querySelectorAll(':scope > .ld-reset-section')) {
            pane.classList.toggle('ld-active', pane.dataset.resetSection === name)
          }
        }
        revealHorizontalItem(buttons[name], nav)
        try { localStorage.setItem(key, name) } catch { /* best effort */ }
      }
      for (const [name, btn] of Object.entries(buttons)) btn.addEventListener('click', () => set(name))
      nav._setResetTab = set
      nav._defaultResetTab = defaultName
      return nav
    }

    const resetStyle = document.createElement('style')
    resetStyle.setAttribute('data-lumidraw-ui-reset-v11', '1')
    resetStyle.textContent = `
      .ld-reset-rail{display:flex;flex:0 0 auto;gap:5px;flex-wrap:wrap;min-height:38px;margin:0 0 2px;padding:3px;border:1px solid var(--lumiverse-border,#3d4050);border-radius:10px;background:#121318}
      .ld-reset-tab{appearance:none;flex:0 0 auto;white-space:nowrap;border:0;border-radius:7px;padding:7px 11px;background:transparent;color:var(--lumiverse-text-muted,#a2a5b4);font:inherit;font-size:12px;cursor:pointer;touch-action:manipulation}
      .ld-reset-tab:hover{color:var(--lumiverse-text,#eceef4)}
      .ld-reset-tab.ld-active{background:var(--lumiverse-fill,#262833);color:var(--lumiverse-text,#eceef4);font-weight:650}
      .ld-reset-section{display:none;flex:0 0 auto;flex-direction:column;gap:9px}
      .ld-reset-section.ld-active{display:flex}
      .ld-reset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
      .ld-reset-field{min-width:0}
      .ld-reset-field+.ld-reset-field{margin-top:8px}
      .ld-reset-help{margin-top:5px}
      .ld-reset-inline{display:flex;align-items:center;gap:7px;min-width:0}
      .ld-reset-inline>*{min-width:0}
      .ld-reset-inline>input,.ld-reset-inline>select,.ld-reset-inline>textarea{flex:1}
      .ld-reset-check-wrap+.ld-reset-check-wrap{margin-top:7px}
      .ld-reset-check{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer}
      .ld-reset-check input{flex:0 0 auto!important}
      .ld-reset-details{border:1px solid var(--lumiverse-border,#3d4050);border-radius:9px;background:var(--lumiverse-fill-subtle,#1a1b22);overflow:hidden}
      .ld-reset-details>summary{cursor:pointer;padding:9px 11px;font-size:12px;font-weight:650;user-select:none}
      .ld-reset-details-body{padding:0 11px 11px}
      .ld-reset-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
      .ld-reset-preset-line{font-size:12px;margin-top:3px}
      .ld-reset-status{padding:8px 9px;border-radius:8px;background:var(--lumiverse-fill-subtle,#1a1b22)}
      .ld-reset-library-note{margin-bottom:1px}
      .ld-reset-hidden-legacy{display:none!important}
      .ld-reset-save-note{font-size:11px;color:var(--lumiverse-text-muted,#a2a5b4);margin-top:7px}
      @media(max-width:700px){
        .ld-reset-grid{grid-template-columns:1fr}
        .ld-reset-hero{grid-template-columns:1fr}
        .ld-reset-inline{flex-wrap:wrap}
        .ld-reset-rail{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:none;scroll-snap-type:x proximity}
        .ld-reset-rail::-webkit-scrollbar{display:none}
        .ld-reset-tab{scroll-snap-align:start}
      }
    `
    storyView.appendChild(resetStyle)

    const libraryMainTab = $('.ld-main-tab[data-tab="presets"]')
    if (libraryMainTab) libraryMainTab.textContent = 'Library'

    // ---------- Capture the existing controls before rebuilding Story.
    const controls = {
      presetSelect: $('.ld-preset-select'),
      scan: $('[data-act="scan"]'),
      scanOld: $('[data-act="scan-old"]'),
      cancelScan: $('[data-act="cancel-scan"]'),
      mode: $('.ld-mode'),
      autoScan: $('.ld-autoscan'),
      charTags: $('.ld-chartags'),
      strip: $('.ld-strip-directives'),
      sizeImages: $('.ld-size-images'),
      sizeRow: $('.ld-size-images-row'),
      optimizedPreviews: $('.ld-optimized-previews'),
      deleteChatImages: $('.ld-delete-chat-images'),
      minImages: $('.ld-minimg'),
      maxImages: $('.ld-maximg'),
      maxSubjects: $('.ld-maxsubjects'),
      parserEngine: $('.ld-parser-engine'),
      parserEngineNote: $('.ld-parser-engine-note'),
      parserContext: $('.ld-parser-context'),
      loom: $('.ld-use-loom-ledger'),
      direct: $('.ld-direct-mode'),
      parserInstruction: $('.ld-parser-instr'),
      resetParser: $('[data-act="reset-parser"]'),
      protocol: $('.ld-protocol'),
      resetProtocol: $('[data-act="reset-protocol"]'),
      lastStatus: $('.ld-story-last-status'),
      castPick: $('.ld-cast-pick'),
      castCopy: $('[data-act="cast-duplicate"]'),
      chatPersona: $('.ld-chat-persona'),
      fantasy: $('.ld-cast-fantasy'),
      chatLeads: $('.ld-chat-leads'),
      castSummary: $('.ld-cast-summary'),
      castStatus: $('.ld-cast-status'),
      wardrobeRefresh: $('[data-act="wardrobe-refresh"]'),
      wardrobeSync: $('[data-act="wardrobe-sync"]'),
      wardrobeRows: $('.ld-wardrobe-rows'),
      wardrobeAdd: $('.ld-wardrobe-add'),
      wardrobeAddButton: $('[data-act="wardrobe-add"]'),
      wardrobeStatus: $('.ld-wardrobe-status'),
      parserConnection: $('.ld-parser-conn'),
      refreshParserSources: $('[data-act="refresh-parser-sources"]'),
      parserModel: $('.ld-parser-model'),
      parserTemperature: $('.ld-parser-temperature'),
      clearModelOverride: $('[data-act="clear-model-override"]'),
      modelOverrideNote: $('.ld-model-override-note'),
      rejectedKeys: $('.ld-rejected-keys'),
      clearRejectedKeys: $('[data-act="clear-rejected-keys"]'),
      parserMaxTokens: $('.ld-parser-maxtokens'),
      parserOverrides: $('.ld-parser-overrides'),
      debugTitle: $('.ld-parser-debug-title'),
      finalPrompt: $('.ld-story-final-prompt'),
      parsedScene: $('.ld-story-parsed'),
    }
    const oldStudioPresetCard = controls.presetSelect ? controls.presetSelect.closest('.ld-card') : null

    // ---------- STORY
    const storyForm = storyView.querySelector('.ld-form-view')
    const storyRail = rail([
      ['setup', 'Setup'],
      ['cast', 'Cast & wardrobe'],
      ['parser', 'Parser'],
      ['prompting', 'Prompting'],
      ['debug', 'Debug'],
    ], 'lumidraw.storySection.v2', 'setup')
    const setup = section('setup')
    const cast = section('cast')
    const parser = section('parser')
    const prompting = section('prompting')
    const debug = section('debug')

    const hero = card()
    hero.classList.add('ld-reset-hero')
    const heroText = make('div')
    heroText.appendChild(make('div', 'ld-subtitle', 'Story illustrations'))
    const currentLine = make('div', 'ld-reset-preset-line')
    currentLine.appendChild(document.createTextNode('Generation preset: '))
    currentLine.appendChild(make('strong', 'ld-story-preset-name', 'None'))
    heroText.appendChild(currentLine)
    addHelp(heroText, 'Story decides who, where, and what to prompt. The generation preset only decides how Draw Things renders it.')
    const heroActions = inline(controls.scan, controls.scanOld, controls.cancelScan)
    hero.append(heroText, heroActions)
    setup.appendChild(hero)

    const behavior = card('Illustration behavior')
    if (controls.presetSelect) {
      behavior.appendChild(field('Generation preset', controls.presetSelect, 'Model, sampler, steps, dimensions, LoRAs, and Draw Things settings only.'))
    }
    behavior.appendChild(field('Behavior', controls.mode,
      'Choose the prompt pipeline and trigger together. Manual options use the Scan buttons only; automatic options run after each saved story reply. Off means no story illustrations.'))
    // Kept in the DOM only as a compatibility mirror for the backend's saved
    // `autoScan` field. It is no longer a second user-facing control.
    if (controls.autoScan) behavior.appendChild(controls.autoScan)
    behavior.appendChild(checkbox(controls.charTags, 'Use chat character image tags as a fallback'))
    behavior.appendChild(checkbox(controls.strip, 'Hide image-request directives from the story model',
      'Keeps dead image-request markup from teaching the story model to repeat it. Stored messages are not changed.'))
    const imageCount = make('div', 'ld-reset-grid')
    imageCount.appendChild(field('Minimum images', controls.minImages, '0 lets the model decide.'))
    imageCount.appendChild(field('Maximum images', controls.maxImages))
    behavior.appendChild(imageCount)
    behavior.appendChild(field('Maximum characters per image (Direct mode)', controls.maxSubjects,
      '2 keeps the unchanged BREAK format. 3 and 4 use repeated spatial labels and one owner per detail, with no BREAK separators.'))
    setup.appendChild(behavior)

    const display = card('Chat image display')
    display.appendChild(checkbox(controls.sizeImages, 'Set a custom image width',
      'Applies to native LumiDraw images generated with v1.3.3 or newer. Older inline images are left entirely to Lumiverse.'))
    if (controls.sizeRow) display.appendChild(controls.sizeRow)
    display.appendChild(checkbox(controls.optimizedPreviews, 'Use optimized previews (recommended)',
      'History uses Lumiverse’s small cached tier and chat/current images use its large tier. The original stays available for the viewer, regeneration, and download.'))
    display.appendChild(checkbox(controls.deleteChatImages, 'Delete unshared LumiDraw images with a deleted chat',
      'Removes the LumiDraw upload and its cached previews only when no other chat uses it. Draw Things keeps its own generated copy.'))
    setup.appendChild(display)
    if (controls.lastStatus) {
      controls.lastStatus.classList.add('ld-reset-status')
      setup.appendChild(controls.lastStatus)
    }

    const castCard = card('Cast for this chat', 'Characters and personas belong to the story, not to the generation preset.')
    const castTop = make('div', 'ld-reset-grid')
    castTop.appendChild(field('Cast', inline(controls.castPick, controls.castCopy)))
    castTop.appendChild(field('Playing as', controls.chatPersona, 'Remembered for this chat.'))
    castCard.appendChild(castTop)
    castCard.appendChild(checkbox(controls.chatLeads, 'Use this chat’s character and persona as the two leads',
      'Supporting characters still come from the selected cast.'))
    castCard.appendChild(checkbox(controls.fantasy, 'Fantasy setting — do not treat fantasy species as mistakes'))
    if (controls.castSummary) castCard.appendChild(controls.castSummary)
    if (controls.castStatus) castCard.appendChild(controls.castStatus)
    cast.appendChild(castCard)

    const wardrobeCard = card('Wardrobe of record', 'Save and clear affect one character. Sync latest passage parses explicit clothing changes without generating an image; silence changes nothing.')
    wardrobeCard.appendChild(inline(make('span', 'ld-label', 'Current wardrobe'), controls.wardrobeRefresh, controls.wardrobeSync))
    if (controls.wardrobeRows) wardrobeCard.appendChild(controls.wardrobeRows)
    wardrobeCard.appendChild(field('Add a saved character to this chat', inline(controls.wardrobeAdd, controls.wardrobeAddButton)))
    if (controls.wardrobeStatus) wardrobeCard.appendChild(controls.wardrobeStatus)
    cast.appendChild(wardrobeCard)

    const parserBinding = card('Prompt parser')
    parserBinding.classList.add('ld-parser-binding-controls')
    const parserEngineField = field('Engine', controls.parserEngine)
    parserEngineField.classList.add('ld-parser-engine-field')
    parserBinding.appendChild(parserEngineField)
    if (controls.parserEngineNote) parserBinding.appendChild(controls.parserEngineNote)
    const parserSourceGrid = make('div', 'ld-reset-grid')
    parserSourceGrid.appendChild(field('Connection', inline(controls.parserConnection, controls.refreshParserSources)))
    parserSourceGrid.appendChild(field('Model override', inline(controls.parserModel, controls.clearModelOverride), 'Leave empty to use the selected connection’s model.'))
    parserSourceGrid.appendChild(field('Temperature', controls.parserTemperature, 'Sampling temperature for the parser model. Some models/providers require or strongly prefer a particular value.'))
    parserBinding.appendChild(parserSourceGrid)
    if (controls.modelOverrideNote) parserBinding.appendChild(controls.modelOverrideNote)
    // Direct is a first-class illustration mode now, not a hidden Parser toggle.
    // The old checkbox stays only in the legacy source markup; it is detached by
    // the UI reset and no longer controls saved settings.
    const animaContext = make('div', 'ld-anima-context-controls')
    animaContext.style.marginTop = '9px'
    const contextGrid = make('div', 'ld-reset-grid')
    contextGrid.appendChild(field('Reference context', controls.parserContext))
    contextGrid.appendChild(checkbox(controls.loom, 'Use latest <loomledger> as continuity reference'))
    animaContext.appendChild(contextGrid)
    addHelp(animaContext, 'Reference context resolves continuity; only the current story message supplies the illustrated moment.')
    parserBinding.appendChild(animaContext)

    const parserAdvanced = details('Advanced parser settings', 'Normally you should not need these.')
    const parserInstructionLabel = make('span', 'ld-label ld-parser-instruction-label', 'Parser instruction')
    parserAdvanced.body.appendChild(parserInstructionLabel)
    if (controls.parserInstruction) parserAdvanced.body.appendChild(controls.parserInstruction)
    if (controls.resetParser) parserAdvanced.body.appendChild(controls.resetParser)
    const advancedGrid = make('div', 'ld-reset-grid')
    advancedGrid.style.marginTop = '9px'
    advancedGrid.appendChild(field('Maximum output tokens', controls.parserMaxTokens))
    parserAdvanced.body.appendChild(advancedGrid)
    parserAdvanced.body.appendChild(field('Parser request overrides (JSON)', controls.parserOverrides,
      'Provider-specific escape hatch. Leave empty unless you know you need it.'))
    parserBinding.appendChild(parserAdvanced.el)
    parser.appendChild(parserBinding)

    const storyQuality = document.createElement('textarea')
    storyQuality.className = 'ld-story-quality'
    storyQuality.rows = 2
    storyQuality.placeholder = 'masterpiece, best quality, very aesthetic'
    const storyPrefix = document.createElement('textarea')
    storyPrefix.className = 'ld-story-prefix'
    storyPrefix.rows = 2
    storyPrefix.placeholder = 'Optional text/tags added before the compiled scene'
    const storyNegative = document.createElement('textarea')
    storyNegative.className = 'ld-story-negative'
    storyNegative.rows = 2
    storyNegative.placeholder = 'Story-wide negative prompt'
    const storyBanned = document.createElement('textarea')
    storyBanned.className = 'ld-story-banned'
    storyBanned.rows = 2
    storyBanned.placeholder = 'Tags the compiler should remove or avoid'
    const storyAnchor = document.createElement('textarea')
    storyAnchor.className = 'ld-story-scene-anchor'
    storyAnchor.rows = 2
    storyAnchor.placeholder = 'Optional starting location / recurring setting tags'
    const storyBreak = document.createElement('input')
    storyBreak.type = 'checkbox'
    storyBreak.className = 'ld-story-break'

    const promptCard = card('Story prompt defaults',
      'These belong to Story now. Switching image models no longer swaps your characters or story prompt rules.')
    promptCard.appendChild(field('Always include / quality tags', storyQuality))
    promptCard.appendChild(field('Prompt prefix', storyPrefix))
    promptCard.appendChild(field('Negative prompt', storyNegative))
    promptCard.appendChild(field('Banned tags', storyBanned))
    promptCard.appendChild(field('Scene anchor', storyAnchor, 'Starting/fallback location. LumiDraw can still update its scene memory as the story moves.'))
    promptCard.appendChild(checkbox(storyBreak, 'Use BREAK separators when compiling supported prompts'))
    prompting.appendChild(promptCard)

    const inlineGuide = details('Inline mode guidance', 'Instructions given to the story model when Inline mode is active.')
    if (controls.protocol) inlineGuide.body.appendChild(controls.protocol)
    if (controls.resetProtocol) inlineGuide.body.appendChild(controls.resetProtocol)
    prompting.appendChild(inlineGuide.el)

    // The artist vocabulary was embedded in the old preset editor even though it is
    // model/tooling knowledge rather than preset data. Move the existing nodes so
    // their event handlers still bind to exactly the same elements.
    const artistInput = $('.ld-artist-index')
    if (artistInput) {
      const artistStatus = $('.ld-artist-status')
      const artistButtons = [
        $('[data-act="artist-load"]'),
        $('[data-act="artist-check"]'),
        $('[data-act="artist-clear"]'),
      ].filter(Boolean)
      const artist = details('Anima artist index', 'Optional vocabulary checker for @artist tags.')
      artist.body.appendChild(artistInput)
      artist.body.appendChild(inline(...artistButtons))
      if (artistStatus) artist.body.appendChild(artistStatus)
      prompting.appendChild(artist.el)
    }

    const debugCard = card()
    if (controls.debugTitle) debugCard.appendChild(controls.debugTitle)
    else debugCard.appendChild(make('div', 'ld-subtitle ld-parser-debug-title', 'Last parser result'))
    addHelp(debugCard, 'Raw parser/compiler output lives here so the normal Story setup stays readable.')
    debugCard.appendChild(field('Final Draw Things prompt', controls.finalPrompt))
    const parsedDetails = details('Parsed scene / parser reply')
    if (controls.parsedScene) parsedDetails.body.appendChild(controls.parsedScene)
    debugCard.appendChild(parsedDetails.el)
    debug.appendChild(debugCard)
    const dtCompat = details('Draw Things API compatibility', 'If Draw Things rejects a generation setting, LumiDraw remembers it here and omits it on later requests.')
    dtCompat.body.appendChild(field('Rejected settings', inline(controls.rejectedKeys, controls.clearRejectedKeys)))
    debug.appendChild(dtCompat.el)

    storyForm.replaceChildren(storyRail, setup, cast, parser, prompting, debug)

    let savedStoryTab = 'setup'
    try { savedStoryTab = localStorage.getItem('lumidraw.storySection.v2') || 'setup' } catch { /* best effort */ }
    storyRail._setResetTab(savedStoryTab)

    // The preset selector used to live in Studio. Remove the card it came from.
    if (oldStudioPresetCard) oldStudioPresetCard.remove()
    const draftReset = $('[data-act="draft-reset"]')
    if (draftReset) {
      draftReset.textContent = 'Reset generation settings'
      draftReset.title = 'Reload model/settings from the selected generation preset without replacing your Studio prompt text'
    }
    const draftSaveNew = $('[data-act="draft-save-new"]')
    if (draftSaveNew) draftSaveNew.textContent = 'Save as generation preset'

    // ---------- LIBRARY
    const libraryForm = libraryView.querySelector('.ld-form-view')
    const charList = $('.ld-charlib-list')
    const personaList = $('.ld-persona-list')
    const placesInput = $('.ld-places')
    const charCard = charList ? charList.closest('.ld-card') : null
    const personaCard = personaList ? personaList.closest('.ld-card') : null
    const placesCard = placesInput ? placesInput.closest('.ld-card') : null
    const sharedEditor = $('.ld-persona-editor')
    const presetEditor = $('.ld-editor')
    const presetList = $('.ld-preset-list')
    const newPreset = $('[data-act="new-preset"]')
    const presetManager = newPreset ? newPreset.closest('.ld-card') : null

    if (charCard) {
      const title = charCard.querySelector('.ld-subtitle')
      const help = charCard.querySelector('.ld-help')
      if (title) title.textContent = 'Characters'
      if (help) help.textContent = 'Reusable character identities used by casts. They are not stored in generation presets.'
    }
    if (personaCard) {
      const title = personaCard.querySelector('.ld-subtitle')
      const help = personaCard.querySelector('.ld-help')
      if (title) title.textContent = 'Personas'
      if (help) help.textContent = 'Reusable identities for who you are playing. They belong to Story/casts, not generation presets.'
    }
    if (placesCard) {
      const title = placesCard.querySelector('.ld-subtitle')
      if (title) title.textContent = 'Places'
    }
    if (presetManager) {
      const title = presetManager.querySelector('.ld-subtitle')
      const help = presetManager.querySelector('.ld-help')
      if (title) title.textContent = 'Generation presets'
      if (help) help.textContent = 'A generation preset is only the image recipe: model, sampler, steps, dimensions, LoRAs, and Draw Things settings.'
      if (newPreset) newPreset.textContent = '＋ New generation preset'
    }
    if (presetEditor) {
      const title = presetEditor.querySelector('.ld-subtitle')
      if (title) title.textContent = 'Generation preset'
      const quality = presetEditor.querySelector('.ld-ed-quality')
      const saveButton = presetEditor.querySelector('[data-act="ed-save"]')
      const saveRow = saveButton ? saveButton.closest('.ld-row') : null
      if (quality && saveRow) {
        // Keep old inputs in the DOM for backwards-compatible editor code, but the
        // new save path ignores them. This avoids breaking handlers while making
        // the product model unambiguous.
        let node = quality
        while (node && node !== saveRow) {
          const next = node.nextElementSibling
          node.classList.add('ld-reset-hidden-legacy')
          node = next
        }
        if (!presetEditor.querySelector('.ld-reset-generation-note')) {
          const note = make('div', 'ld-help ld-reset-generation-note',
            'Generation-only preset. Story prompting, cast, characters, personas, and places are managed outside this editor.')
          presetEditor.insertBefore(note, saveRow)
        }
      }
    }

    const libRail = rail([
      ['presets', 'Presets'],
      ['characters', 'Characters'],
      ['personas', 'Personas'],
      ['places', 'Places'],
    ], 'lumidraw.librarySection.v2', 'presets')
    const libPresets = section('presets')
    const libCharacters = section('characters')
    const libPersonas = section('personas')
    const libPlaces = section('places')
    if (presetManager) libPresets.appendChild(presetManager)
    if (presetList) libPresets.appendChild(presetList)
    if (presetEditor) libPresets.appendChild(presetEditor)
    if (charCard) libCharacters.appendChild(charCard)
    if (personaCard) libPersonas.appendChild(personaCard)
    if (placesCard) libPlaces.appendChild(placesCard)
    libraryForm.replaceChildren(libRail, libPresets, libCharacters, libPersonas, libPlaces)
    if (sharedEditor) {
      libraryForm.appendChild(sharedEditor)
      sharedEditor.style.display = 'none'
    }
    const originalLibSet = libRail._setResetTab
    libRail._setResetTab = (name) => {
      if (sharedEditor) sharedEditor.style.display = 'none'
      originalLibSet(name)
    }
    for (const button of libRail.querySelectorAll('.ld-reset-tab')) {
      button.addEventListener('click', () => { if (sharedEditor) sharedEditor.style.display = 'none' })
    }
    let savedLibraryTab = 'presets'
    try { savedLibraryTab = localStorage.getItem('lumidraw.librarySection.v2') || 'presets' } catch { /* best effort */ }
    libRail._setResetTab(savedLibraryTab)

    // ---------- SETTINGS: infrastructure only.
    const parserTab = $('.ld-settings-tab[data-settings-tab="parser"]')
    if (parserTab) parserTab.remove()
    const connectionTab = $('.ld-settings-tab[data-settings-tab="connection"]')
    if (connectionTab) connectionTab.textContent = 'Connections'
    const advancedTab = $('.ld-settings-tab[data-settings-tab="advanced"]')
    if (advancedTab) advancedTab.textContent = 'Cloud & diagnostics'
    const parserSettingsCard = $('.ld-card[data-settings-section="parser"]')
    if (parserSettingsCard) parserSettingsCard.remove()
    const saveConnections = $('[data-act="save-settings"]')
    if (saveConnections) {
      saveConnections.style.display = 'none'
      const row = saveConnections.closest('.ld-section-actions')
      if (row && !row.querySelector('.ld-reset-save-note')) {
        row.appendChild(make('span', 'ld-reset-save-note', 'Connection changes save automatically.'))
      }
    }
  }
  applyUiResetV11()

  const launcher = $('.ld-launcher')
  const panel = $('.ld-panel')
  const fullscreenToggle = $('.ld-fullscreen-toggle')
  const textEditor = $('.ld-text-editor')
  const textEditorArea = $('.ld-text-editor-area')
  const textEditorTitle = $('.ld-text-editor-title')
  const lightbox = $('.ld-lightbox')
  const lightboxImage = $('.ld-lightbox-image')
  const lightboxImageWrap = $('.ld-lightbox-image-wrap')
  const lightboxTitle = $('.ld-lightbox-title')
  const lightboxMeta = $('.ld-lightbox-meta')
  const lightboxZoomLevel = $('.ld-lightbox-zoom-level')
  const liveInstance = { panel, launcher, version: EXTENSION_VERSION, cleanup: null }
  window[INSTANCE_KEY] = liveInstance
  const FULLSCREEN_KEY = 'lumidraw_panel_fullscreen_v1'
  let expandedTextarea = null
  let expandedTextareaState = null
  let lightboxIndex = 0
  let lightboxItems = []
  // The prompt an image was actually made with, kept so a re-parse can be undone.
  let reparseOriginalPrompt = ''
  let selectedOutputUrl = null
  let lightboxScale = 1
  let lightboxPanX = 0
  let lightboxPanY = 0
  let lightboxGestureMoved = false
  let lightboxLastTapAt = 0
  let lightboxLastPointerType = ''
  const lightboxPointers = new Map()
  let lightboxPanStart = null
  let lightboxPinchStart = null

  // ------------------------------------------------------------------ helpers
  function setStatus(sel, msg, kind) {
    const el = $(sel)
    if (!el) return
    el.textContent = msg || ''
    el.classList.remove('ld-err', 'ld-good')
    if (kind) el.classList.add(kind === 'err' ? 'ld-err' : 'ld-good')
    if (el.classList.contains('ld-gen-status')) {
      const bar = el.closest('.ld-global-status')
      if (bar) bar.style.display = msg ? 'block' : 'none'
    }
  }

  function flattenHistoryImages() {
    const out = []
    for (const entry of history || []) {
      for (const image of entry.images || []) out.push({ image, entry })
    }
    return out
  }

  function findHistoryImage(imageUrl) {
    if (!imageUrl) return null
    return flattenHistoryImages().find(({ image }) => image.url === imageUrl) || null
  }

  function normalizeAltText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  }

  // The host rebuilds chats and rewrites image URLs to its own canonical form,
  // so a chat image's src is usually NOT the URL History recorded. The alt
  // text survives that rewrite, and LumiDraw wrote it from the compiled
  // prompt — so it identifies the History entry when the URL cannot.
  function findHistoryImageByAlt(altText) {
    const alt = normalizeAltText(altText)
    if (alt.length < 20) return null
    const matches = flattenHistoryImages().filter(({ entry }) => {
      const recorded = normalizeAltText(entry.origin && entry.origin.alt)
      if (recorded) return recorded === alt
      return normalizeAltText(entry.prompt).includes(alt)
    })
    if (!matches.length) return null
    // Prefer an exact recorded-alt hit; otherwise the newest prompt match.
    const exact = matches.find(({ entry }) => normalizeAltText(entry.origin && entry.origin.alt) === alt)
    return exact || matches[0]
  }

  // --- the fixable index ------------------------------------------------------
  // Chat rows are virtualized by current Lumiverse. Do not poll the document for
  // images: rows are mounted/unmounted while scrolling, and a document-wide scan
  // plus class mutation creates work exactly when the virtualizer is busiest.
  // The history index stays cached, but matching now happens only when an image is
  // actually clicked.
  let fixableSource = null
  let fixableByUrl = new Map()
  let fixableByAlt = new Map()
  let fixablePrompts = []

  // Detected by reference rather than hooked into all nine places history is
  // assigned — every one of them replaces the array, and a missed hook would be
  // a silently stale index.
  function ensureFixableIndex() {
    if (fixableSource === history) return
    fixableSource = history
    fixableByUrl = new Map()
    fixableByAlt = new Map()
    fixablePrompts = []
    for (const item of flattenHistoryImages()) {
      if (item.image && item.image.url && !fixableByUrl.has(item.image.url)) {
        fixableByUrl.set(item.image.url, item)
      }
      const recorded = normalizeAltText(item.entry && item.entry.origin && item.entry.origin.alt)
      if (recorded && !fixableByAlt.has(recorded)) fixableByAlt.set(recorded, item)
      else if (!recorded) {
        const prompt = normalizeAltText(item.entry && item.entry.prompt)
        if (prompt) fixablePrompts.push({ prompt, item })
      }
    }
  }

  function findHistoryImageForChatImage(img) {
    ensureFixableIndex()
    const original = img.getAttribute('data-lumidraw-original-url') || (img.dataset && img.dataset.lumidrawOriginalUrl) || ''
    if (original && fixableByUrl.has(original)) return fixableByUrl.get(original)
    const src = img.getAttribute('src') || img.src || ''
    if (src && fixableByUrl.has(src)) return fixableByUrl.get(src)
    const alt = normalizeAltText(img.getAttribute('alt') || '')
    // The old length guard, kept: a short alt matches far too much.
    if (alt.length < 20) return null
    if (fixableByAlt.has(alt)) return fixableByAlt.get(alt)
    const hit = fixablePrompts.find((entry) => entry.prompt.includes(alt))
    return hit ? hit.item : null
  }

  function currentOutputItem() {
    const selected = findHistoryImage(selectedOutputUrl)
    if (selected) return selected
    const first = flattenHistoryImages()[0] || null
    selectedOutputUrl = first ? first.image.url : null
    return first
  }

  function clampNumber(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value))
  }

  function clampLightboxPan() {
    if (lightboxScale <= 1 || !lightboxImageWrap || !lightboxImage) {
      lightboxPanX = 0
      lightboxPanY = 0
      return
    }
    const maxX = Math.max(0, ((lightboxImage.clientWidth || 0) * lightboxScale - lightboxImageWrap.clientWidth) / 2)
    const maxY = Math.max(0, ((lightboxImage.clientHeight || 0) * lightboxScale - lightboxImageWrap.clientHeight) / 2)
    lightboxPanX = clampNumber(lightboxPanX, -maxX, maxX)
    lightboxPanY = clampNumber(lightboxPanY, -maxY, maxY)
  }

  function applyLightboxTransform() {
    clampLightboxPan()
    lightboxImage.style.transform = `translate3d(${lightboxPanX}px, ${lightboxPanY}px, 0) scale(${lightboxScale})`
    if (lightboxZoomLevel) lightboxZoomLevel.textContent = `${Math.round(lightboxScale * 100)}%`
  }

  function resetLightboxZoom() {
    lightboxScale = 1
    lightboxPanX = 0
    lightboxPanY = 0
    lightboxPointers.clear()
    lightboxPanStart = null
    lightboxPinchStart = null
    applyLightboxTransform()
  }

  function setLightboxZoom(nextScale, focalClientX = null, focalClientY = null) {
    const previousScale = lightboxScale
    const clamped = clampNumber(Number(nextScale) || 1, 1, 6)
    if (clamped === previousScale) return
    if (focalClientX !== null && focalClientY !== null && previousScale > 0) {
      const rect = lightboxImageWrap.getBoundingClientRect()
      const focalX = focalClientX - (rect.left + rect.width / 2)
      const focalY = focalClientY - (rect.top + rect.height / 2)
      lightboxPanX = focalX - ((focalX - lightboxPanX) / previousScale) * clamped
      lightboxPanY = focalY - ((focalY - lightboxPanY) / previousScale) * clamped
    }
    lightboxScale = clamped
    if (lightboxScale === 1) {
      lightboxPanX = 0
      lightboxPanY = 0
    }
    applyLightboxTransform()
  }

  function toggleLightboxZoom(clientX, clientY) {
    if (lightboxScale > 1.05) resetLightboxZoom()
    else setLightboxZoom(2, clientX, clientY)
  }

  function renderLightbox() {
    const item = lightboxItems[lightboxIndex]
    if (!item) { closeLightbox(); return }
    const { image, entry } = item
    resetLightboxZoom()
    lightboxImage.src = image.url
    lightboxImage.alt = (entry.prompt || 'Generated image').slice(0, 180)
    lightboxTitle.textContent = `Image ${lightboxIndex + 1} of ${lightboxItems.length}`
    const details = [entry.model, entry.seed !== undefined ? `seed ${entry.seed}` : '', entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '', entry.prompt || ''].filter(Boolean)
    lightboxMeta.textContent = details.join(' · ')
    lightboxMeta.title = details.join(' · ')
    $('.ld-lightbox-prev').disabled = lightboxItems.length < 2
    $('.ld-lightbox-next').disabled = lightboxItems.length < 2
    // Moving to another image abandons an open edit rather than silently
    // applying it to the wrong picture.
    closeRegenPanel()
  }

  function closeRegenPanel() {
    const box = $('.ld-lightbox-regen')
    if (box) box.style.display = 'none'
    setStatus('.ld-lightbox-regen-status', '')
  }

  function openRegenPanel() {
    const item = lightboxItems[lightboxIndex]
    if (!item) return
    const { entry } = item
    const box = $('.ld-lightbox-regen')
    if (!box) return
    $('.ld-lightbox-regen-prompt').value = entry.prompt || ''
    reparseOriginalPrompt = ''
    if ($('.ld-lightbox-reparse-info')) {
      $('.ld-lightbox-reparse-info').textContent = ''
      $('.ld-lightbox-reparse-info').style.color = ''
    }
    if ($('.ld-lightbox-reparse-picker')) {
      $('.ld-lightbox-reparse-picker').style.display = 'none'
      $('.ld-lightbox-reparse-picker').innerHTML = ''
    }
    $('.ld-lightbox-regen-negative').value = entry.negativePrompt || ''
    const seedKnown = entry.seed !== undefined && entry.seed !== 'random'
    const seedBox = $('.ld-lightbox-regen-seed')
    seedBox.checked = seedKnown
    seedBox.disabled = !seedKnown
    $('.ld-lightbox-regen-seedval').textContent = seedKnown ? `(${entry.seed})` : '(the original seed was random and was not recorded)'
    box.style.display = 'block'
    setStatus('.ld-lightbox-regen-status', 'Edit the prompt, then press “Regenerate & replace now”. That one button does everything: it generates the new image AND swaps it into the story message in place. There is no separate accept step.')
    // Say which of the message's moments this image was. Opened later, one
    // image out of three is otherwise unidentifiable.
    const info = $('.ld-lightbox-reparse-info')
    const origin = entry.origin || {}
    const rebuild = $('.ld-lightbox-rebuild')
    if (rebuild) {
      rebuild.style.display = origin.sceneCount > 1 ? '' : 'none'
      rebuild.textContent = `Replace all ${origin.sceneCount} images in this message`
    }
    if (info && origin.sceneCount > 1 && origin.sceneIndex) {
      info.textContent = `moment ${origin.sceneIndex} of ${origin.sceneCount}`
      info.title = origin.sceneStatement || ''
    }

    // The panel scrolls, and scrolling the prompt box into view pushed
    // everything above it — including "Re-run parser" — off the top, where on a
    // phone it is invisible until you think to scroll up. Open at the top and
    // let the panel show its own controls first.
    box.scrollTop = 0
    const prompt = $('.ld-lightbox-regen-prompt')
    // Focusing pops the on-screen keyboard, which on a narrow screen covers
    // most of the panel before the user has read any of it.
    const narrow = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 840px)').matches
      : false
    if (!narrow) {
      try { prompt.focus({ preventScroll: true }) } catch { prompt.focus() }
    }
  }

  function openLightbox(imageUrl) {
    lightboxItems = flattenHistoryImages()
    const found = lightboxItems.findIndex(({ image }) => image.url === imageUrl)
    if (found < 0 && imageUrl) return false
    lightboxIndex = found >= 0 ? found : 0
    if (!lightboxItems.length) return false
    renderLightbox()
    lightbox.classList.add('ld-open')
    lightbox.setAttribute('aria-hidden', 'false')
    document.body.classList.add('ld-fullscreen-lock')
    return true
  }

  function closeLightbox() {
    clickedChatImageUrl = ''
    clickedChatPlacementId = ''
    lightbox.classList.remove('ld-open')
    lightbox.setAttribute('aria-hidden', 'true')
    lightboxImage.removeAttribute('src')
    resetLightboxZoom()
    closeRegenPanel()
    if (!panel.classList.contains('ld-fullscreen')) document.body.classList.remove('ld-fullscreen-lock')
  }

  function moveLightbox(delta) {
    if (!lightboxItems.length) return
    clickedChatImageUrl = ''   // the handle belonged to the previous image
    clickedChatPlacementId = ''
    lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length
    renderLightbox()
  }

  const MAIN_VIEW_KEY = 'lumidraw_main_view_v2'
  const MOBILE_TAB_KEY = 'lumidraw_mobile_studio_tab_v2'

  function setMainView(name, persist = true) {
    const allowed = new Set(['studio', 'story', 'presets', 'settings'])
    const next = allowed.has(name) ? name : 'studio'
    let activeTab = null
    for (const tab of dom.queryAll('.ld-main-tab')) {
      const active = tab.getAttribute('data-tab') === next
      tab.classList.toggle('ld-active', active)
      tab.setAttribute('aria-current', active ? 'page' : 'false')
      if (active) activeTab = tab
    }
    for (const view of dom.queryAll('.ld-view')) {
      view.classList.toggle('ld-active', view.getAttribute('data-view') === next)
    }
    revealHorizontalItem(activeTab)
    if (persist) {
      try { localStorage.setItem(MAIN_VIEW_KEY, next) } catch { /* best effort */ }
    }
  }

  function setMobileTab(name, persist = true) {
    const allowed = new Set(['create', 'tune', 'library', 'stack', 'history'])
    const next = allowed.has(name) ? name : 'create'
    for (const tab of dom.queryAll('.ld-mobile-tab')) {
      tab.classList.toggle('ld-active', tab.getAttribute('data-mobile-tab') === next)
    }
    for (const pane of dom.queryAll('[data-mobile-panel]')) {
      pane.classList.toggle('ld-mobile-active', pane.getAttribute('data-mobile-panel') === next)
    }
    if (persist) {
      try { localStorage.setItem(MOBILE_TAB_KEY, next) } catch { /* best effort */ }
    }
  }

  function renderHeaderState() {
    const presetEl = $('.ld-header-preset')
    const workspaceEl = $('.ld-header-workspace')
    const bridgeEl = $('.ld-header-bridge')
    const bridgeDot = $('.ld-header-bridge-dot')
    const storyPreset = $('.ld-story-preset-name')
    const presetName = activePreset || 'None'
    if (presetEl) presetEl.textContent = presetName
    if (storyPreset) storyPreset.textContent = presetName

    if (workspaceEl) {
      if (!draftConfig) workspaceEl.textContent = 'Not loaded'
      else {
        const model = String(draftConfig.model || '').replace(/\.ckpt$/i, '')
        workspaceEl.textContent = `${draftDirty ? 'Modified' : 'Ready'}${model ? ' · ' + model : ''}`
      }
    }

    const bridge = catalog.bridge || {}
    if (bridgeEl) {
      bridgeEl.textContent = bridge.connected
        ? `${bridge.version || 'Connected'} · ${catalog.models.length} models · ${catalog.loras.length} LoRAs`
        : 'Offline · remembered catalog'
    }
    if (bridgeDot) {
      bridgeDot.classList.toggle('ld-online', !!bridge.connected)
      bridgeDot.classList.toggle('ld-offline', !bridge.connected)
    }
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
        negativePrompt: $('.ld-negative') ? $('.ld-negative').value : '',
        label: `generation preset “${preset.name}”`,
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
        // Stamped so a restored draft can say which preset it came from. Without
        // this the workspace silently shows one preset's negative prompt while
        // another is active, which is indistinguishable from a bug.
        presetName: activePreset || '',
      }))
    } catch { /* best effort */ }
  }

  function loadDraftLocal() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') }
    catch { return null }
  }

  function populateSelect(select, values, currentValue = '', placeholder = '') {
    if (!select) return
    const current = String(currentValue || '')
    select.innerHTML = ''
    if (placeholder) {
      const blank = document.createElement('option')
      blank.value = ''
      blank.textContent = placeholder
      select.appendChild(blank)
    }
    const seen = new Set()
    for (const raw of values || []) {
      const value = String(raw || '').trim()
      if (!value || seen.has(value.toLowerCase())) continue
      seen.add(value.toLowerCase())
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.appendChild(option)
    }
    if (current && !seen.has(current.toLowerCase())) {
      const option = document.createElement('option')
      option.value = current
      option.textContent = current + ' (saved)'
      select.insertBefore(option, placeholder ? select.children[1] || null : select.firstChild)
    }
    select.value = current
  }

  function renderCatalogStatus() {
    const bridge = catalog.bridge || {}
    let message
    let kind
    if (bridge.connected) {
      const version = bridge.version ? ` ${bridge.version}` : ''
      message = `Bridge${version} connected · ${catalog.models.length} image models · ${catalog.loras.length} LoRAs · ${catalog.samplers.length} samplers`
      kind = 'good'
    } else {
      message = `Bridge offline — using remembered catalog${bridge.error ? ': ' + bridge.error : ''}`
      kind = 'err'
    }
    setStatus('.ld-catalog-status', message, kind)
    setStatus('.ld-bridge-status', message, kind)
    renderHeaderState()
    renderLoraLibrary()
    refreshDtSettingsOptions()
  }

  // A free-text field needs no option injected; a value simply IS the value.
  function ensureDraftModelOption(value) {
    const field = $('.ld-draft-model')
    if (field && value && !field.value) field.value = value
  }

  function populateDatalist(id, values) {
    const list = document.getElementById(id)
    if (!list) return
    list.innerHTML = ''
    const seen = new Set()
    for (const raw of values || []) {
      const value = String(raw || '').trim()
      if (!value || seen.has(value.toLowerCase())) continue
      seen.add(value.toLowerCase())
      const option = document.createElement('option')
      option.value = value
      list.appendChild(option)
    }
  }

  function draftLoraRow(file, weight) {
    const row = document.createElement('div')
    row.className = 'ld-row'
    const fileInput = document.createElement('select')
    fileInput.className = 'ld-lora-file'
    populateSelect(fileInput, catalog.loras, file || '', '— choose LoRA —')
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

  function addLoraToDraft(file) {
    const value = String(file || '').trim()
    if (!value) return
    const box = $('.ld-draft-loras')
    if (!box) return
    const selects = [...box.querySelectorAll('.ld-lora-file')]
    const existing = selects.find((select) => select.value === value)
    if (existing) {
      existing.focus()
      setMobileTab('stack')
      setStatus('.ld-draft-status', `“${value}” is already in the active stack.`)
      return
    }
    const blank = selects.find((select) => !select.value)
    if (blank) {
      blank.value = value
      blank.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      box.appendChild(draftLoraRow(value, 1))
    }
    onDraftControlChange()
    setMobileTab('stack')
    setStatus('.ld-draft-status', `Added “${value}” to the temporary Studio stack.`, 'good')
  }

  function refreshDtSettingsOptions() {
    // Catalog arrives after first paint, so any select fed by it is rebuilt
    // once the model/LoRA lists are known.
    if ($('.ld-dt-settings')) renderDtSettings()
  }

  function renderLoraLibrary() {
    const grid = $('.ld-lora-grid')
    const count = $('.ld-lora-count')
    if (!grid) return
    const query = String(($('.ld-lora-search') && $('.ld-lora-search').value) || '').trim().toLowerCase()
    const items = (catalog.loras || []).filter((file) => !query || String(file).toLowerCase().includes(query))
    if (count) count.textContent = `${items.length}${query ? ' matching' : ' installed'}`
    grid.innerHTML = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'ld-lora-empty'
      empty.textContent = query ? 'No installed LoRAs match that search.' : 'No LoRAs are available from the Bridge catalog.'
      grid.appendChild(empty)
      return
    }
    for (const file of items) {
      const card = document.createElement('div')
      card.className = 'ld-lora-card'
      const main = document.createElement('div')
      main.className = 'ld-lora-card-main'
      const name = document.createElement('div')
      name.className = 'ld-lora-card-name'
      name.textContent = String(file).split('/').pop().replace(/_lora_f16\.ckpt$/i, '').replace(/\.ckpt$/i, '').replace(/_/g, ' ')
      name.title = file
      const path = document.createElement('div')
      path.className = 'ld-lora-card-path'
      path.textContent = file
      main.appendChild(name)
      main.appendChild(path)
      const add = document.createElement('button')
      add.className = 'ld-btn ld-compact'
      add.textContent = 'Add'
      add.title = `Add ${file} to the active Studio stack`
      add.addEventListener('click', () => addLoraToDraft(file))
      card.appendChild(main)
      card.appendChild(add)
      grid.appendChild(card)
    }
  }

  // --- full Draw Things settings editor --------------------------------------
  //
  // Controls are generated from the synced config rather than a hard-coded
  // list, so the key names are always Draw Things' own and a DT update adds
  // its new settings here automatically. The table below only supplies nicer
  // labels, grouping, and dropdown sources for the settings worth curating.

  const DT_CORE_KEYS = new Set(['model', 'sampler', 'steps', 'guidance_scale', 'width', 'height', 'loras'])

  const DT_FIELD_META = {
    shift: { group: 'Sampling', label: 'Shift', step: 0.1 },
    clip_skip: { group: 'Sampling', label: 'CLIP skip', step: 1, min: 1 },
    strength: { group: 'Sampling', label: 'Denoising strength', step: 0.05, min: 0, max: 1 },
    seed_mode: { group: 'Sampling', label: 'Seed mode', options: ['Legacy', 'TorchCPU Compatible', 'Scale Alike', 'NVIDIA GPU Compatible'] },
    resolution_dependent_shift: { group: 'Sampling', label: 'Resolution-dependent shift' },
    sampler_timesteps: { group: 'Sampling', label: 'Sampler timesteps' },
    stochastic_sampling_gamma: { group: 'Sampling', label: 'Stochastic sampling gamma', step: 0.05 },

    refiner_model: { group: 'Refiner', label: 'Refiner model', source: 'models', allowEmpty: true },
    refiner_start: { group: 'Refiner', label: 'Refiner start', step: 0.05, min: 0, max: 1 },

    hires_fix: { group: 'High-res fix', label: 'High-res fix' },
    hires_fix_width: { group: 'High-res fix', label: 'First-pass width', step: 64, min: 128 },
    hires_fix_height: { group: 'High-res fix', label: 'First-pass height', step: 64, min: 128 },
    hires_fix_strength: { group: 'High-res fix', label: 'High-res strength', step: 0.05, min: 0, max: 1 },

    upscaler: { group: 'Upscaling', label: 'Upscaler', source: 'models', allowEmpty: true },
    upscaler_scale: { group: 'Upscaling', label: 'Upscaler scale', step: 1, min: 0 },

    tiled_decoding: { group: 'Tiling', label: 'Tiled decoding' },
    tiled_diffusion: { group: 'Tiling', label: 'Tiled diffusion' },

    image_guidance: { group: 'Guidance', label: 'Image guidance', step: 0.1 },
    guidance_embed: { group: 'Guidance', label: 'Guidance embed', step: 0.1 },
    speed_up_with_guidance_embed: { group: 'Guidance', label: 'Speed up with guidance embed' },
    negative_guidance_scale: { group: 'Guidance', label: 'Negative guidance scale', step: 0.5 },
    clip_weight: { group: 'Guidance', label: 'CLIP weight', step: 0.05 },

    mask_blur: { group: 'Masking', label: 'Mask blur', step: 0.5, min: 0 },
    mask_blur_outset: { group: 'Masking', label: 'Mask blur outset', step: 1 },
    preserve_original_after_inpaint: { group: 'Masking', label: 'Preserve original after inpaint' },
  }

  const DT_GROUP_ORDER = ['Sampling', 'Refiner', 'High-res fix', 'Upscaling', 'Guidance', 'Tiling', 'Masking', 'Other Draw Things settings']

  function dtFieldMeta(key) {
    const meta = DT_FIELD_META[key] || {}
    return {
      group: meta.group || 'Other Draw Things settings',
      label: meta.label || key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      // Any *_model key is a checkpoint reference; offer the catalog.
      source: meta.source || (/(^|_)model$/.test(key) ? 'models' : ''),
      ...meta,
    }
  }

  function dtControlKind(key, value) {
    const meta = dtFieldMeta(key)
    if (meta.options) return 'select'
    if (meta.source) return 'select'
    if (typeof value === 'boolean') return 'bool'
    if (typeof value === 'number') return 'number'
    if (value && typeof value === 'object') return 'json'
    return 'text'
  }

  function dtSelectValues(meta) {
    if (meta.options) return meta.options
    if (meta.source === 'models') return catalog.models || []
    if (meta.source === 'samplers') return catalog.samplers || []
    if (meta.source === 'loras') return (catalog.loras || []).map((l) => l.file || l.name || l)
    return []
  }

  function buildDtField(key, value) {
    const meta = dtFieldMeta(key)
    const kind = dtControlKind(key, value)
    const wrap = document.createElement('div')
    wrap.className = 'ld-dt-field'

    if (kind === 'bool') {
      const label = document.createElement('label')
      label.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:12px'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.style.width = 'auto'
      input.checked = !!value
      input.setAttribute('data-dt-key', key)
      input.setAttribute('data-dt-kind', 'bool')
      input.addEventListener('change', onDraftControlChange)
      label.appendChild(input)
      label.appendChild(document.createTextNode(' ' + meta.label))
      wrap.appendChild(label)
      return wrap
    }

    const caption = document.createElement('span')
    caption.className = 'ld-label'
    caption.textContent = meta.label
    caption.title = key
    wrap.appendChild(caption)

    let input
    if (kind === 'select') {
      input = document.createElement('select')
      const values = dtSelectValues(meta)
      const current = value === undefined || value === null ? '' : String(value)
      const all = [...values]
      if (current && !all.some((v) => String(v) === current)) all.unshift(current)
      input.innerHTML = (meta.allowEmpty !== false ? '<option value="">— none —</option>' : '') +
        all.map((v) => {
          const option = document.createElement('option')
          option.value = String(v)
          option.textContent = String(v)
          return option.outerHTML
        }).join('')
      input.value = current
    } else if (kind === 'json') {
      input = document.createElement('textarea')
      input.style.minHeight = '52px'
      input.value = JSON.stringify(value, null, 0)
    } else if (kind === 'number') {
      input = document.createElement('input')
      input.type = 'number'
      if (meta.step !== undefined) input.step = String(meta.step)
      if (meta.min !== undefined) input.min = String(meta.min)
      if (meta.max !== undefined) input.max = String(meta.max)
      input.value = value === undefined || value === null ? '' : String(value)
    } else {
      input = document.createElement('input')
      input.type = 'text'
      input.value = value === undefined || value === null ? '' : String(value)
    }
    input.setAttribute('data-dt-key', key)
    input.setAttribute('data-dt-kind', kind)
    // Keep the workspace snapshot current while a number/text field is being
    // edited. Mobile browsers can defer "change" until well after a nearby
    // button tap; listening to input prevents Update preset from racing a
    // visibly edited high-res width or height.
    if (kind !== 'select') input.addEventListener('input', onDraftControlChange)
    input.addEventListener('change', onDraftControlChange)
    wrap.appendChild(input)
    return wrap
  }

  function renderDtSettings() {
    const box = $('.ld-dt-settings')
    if (!box) return
    box.innerHTML = ''
    const config = draftConfig || {}
    const keys = Object.keys(config)
      .filter((key) => !DT_CORE_KEYS.has(key))
      .sort((a, b) => a.localeCompare(b))
    if (!keys.length) {
      box.innerHTML = '<div class="ld-status">Press <strong>Sync ⟳</strong> to read every setting Draw Things currently has. They all become editable here.</div>'
      return
    }
    const grouped = new Map()
    for (const key of keys) {
      const group = dtFieldMeta(key).group
      if (!grouped.has(group)) grouped.set(group, [])
      grouped.get(group).push(key)
    }
    const order = [...DT_GROUP_ORDER.filter((g) => grouped.has(g)), ...[...grouped.keys()].filter((g) => !DT_GROUP_ORDER.includes(g))]
    for (const group of order) {
      const details = document.createElement('details')
      details.className = 'ld-profile-block'
      details.open = group !== 'Other Draw Things settings'
      const summary = document.createElement('summary')
      summary.textContent = `${group} (${grouped.get(group).length})`
      details.appendChild(summary)
      const body = document.createElement('div')
      body.className = 'ld-profile-fields'
      for (const key of grouped.get(group)) body.appendChild(buildDtField(key, config[key]))
      details.appendChild(body)
      box.appendChild(details)
    }
  }

  function readDtSettingsFromControls(config) {
    for (const el of dom.queryAll('.ld-dt-settings [data-dt-key]')) {
      const key = el.getAttribute('data-dt-key')
      const kind = el.getAttribute('data-dt-kind')
      if (!key) continue
      if (kind === 'bool') { config[key] = el.checked; continue }
      const raw = el.value
      if (raw === '') { delete config[key]; continue }
      if (kind === 'number') {
        const num = Number(raw)
        if (Number.isFinite(num)) config[key] = num
        else delete config[key]
        continue
      }
      if (kind === 'json') {
        try { config[key] = JSON.parse(raw) }
        catch { /* keep the previous value rather than writing malformed JSON */ }
        continue
      }
      config[key] = raw
    }
    return config
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
    readDtSettingsFromControls(config)
    return config
  }

  function renderDraftControls() {
    const config = draftConfig || {}
    ensureDraftModelOption(config.model || '')
    $('.ld-draft-model').value = config.model || ''
    populateSelect($('.ld-draft-sampler'), catalog.samplers, config.sampler || '', '— choose sampler —')
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
    renderDtSettings()
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

  function partialFeaturesToText(value) {
    if (Array.isArray(value)) {
      return value.map((item) => item && typeof item === 'object'
        ? `${item.name || ''} = ${(Array.isArray(item.tags) ? item.tags.join(', ') : item.tags || '')}`.trim()
        : String(item || '').trim()).filter((line) => line && line !== '=').join('\n')
    }
    return String(value || '')
  }

  function visualAliasesToText(value) {
    if (Array.isArray(value)) {
      return value.map((item) => item && typeof item === 'object'
        ? `${item.name || ''} = ${item.description || ''}`.trim()
        : String(item || '').trim()).filter((line) => line && line !== '=').join('\n')
    }
    return String(value || '')
  }

  function appearanceStatesToText(value) {
    if (!Array.isArray(value)) return String(value || '')
    return value.map((state) => {
      if (!state || typeof state !== 'object') return String(state || '').trim()
      const directives = []
      if (state.countTag) directives.push(`count=${state.countTag}`)
      if (state.outfitPolicy && state.outfitPolicy !== 'inherit') directives.push(`outfit=${state.outfitPolicy}`)
      if (state.subject) directives.push(`subject=${state.subject}`)
      const directiveText = directives.length ? ` [${directives.join('; ')}]` : ''
      const recognition = Array.isArray(state.recognition) ? state.recognition.join(', ') : String(state.recognition || '')
      const left = `${state.name || ''}${directiveText}${recognition ? ` | ${recognition}` : ''}`.trim()
      const appearance = Array.isArray(state.appearance) ? state.appearance.join(', ') : String(state.appearance || state.appearanceTags || '')
      return left && appearance ? `${left} => ${appearance}` : ''
    }).filter(Boolean).join('\n')
  }

  // Looks are the CLOTHING analogue of appearance states, and edit the same way:
  //   formal = black gown, heels | aliases: gala, the gown | no: jeans
  function looksToText(value) {
    if (!Array.isArray(value)) return String(value || '')
    return value.map((look) => {
      if (!look || typeof look !== 'object') return String(look || '').trim()
      const outfit = Array.isArray(look.outfit) ? look.outfit.join(', ') : String(look.outfit || '')
      if (!look.name || !outfit) return ''
      const parts = [`${look.name} = ${outfit}`]
      const aliases = Array.isArray(look.aliases) ? look.aliases.join(', ') : String(look.aliases || '')
      if (aliases) parts.push(`aliases: ${aliases}`)
      const negative = Array.isArray(look.negative) ? look.negative.join(', ') : String(look.negative || '')
      if (negative) parts.push(`no: ${negative}`)
      return parts.join(' | ')
    }).filter(Boolean).join('\n')
  }

  // Places use the same line form as Looks, for the same reason: it is typeable,
  // diffable, and pasteable between installs without a bespoke editor.
  function placesToText(list) {
    if (!Array.isArray(list)) return String(list || '')
    return list.map((place) => {
      if (!place || typeof place !== 'object') return String(place || '').trim()
      const tags = Array.isArray(place.tags) ? place.tags.join(', ') : String(place.tags || '')
      if (!place.name || !tags) return ''
      const parts = [`${place.name} = ${tags}`]
      const aliases = Array.isArray(place.aliases) ? place.aliases.join(', ') : String(place.aliases || '')
      if (aliases) parts.push(`aliases: ${aliases}`)
      const negative = Array.isArray(place.negative) ? place.negative.join(', ') : String(place.negative || '')
      if (negative) parts.push(`no: ${negative}`)
      return parts.join(' | ')
    }).filter(Boolean).join('\n')
  }

  function placesFromText(text) {
    return String(text || '').split(/\r?\n/).map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return null
      const [head, ...rest] = trimmed.split('|')
      const eq = head.indexOf('=')
      if (eq < 0) return null
      const place = { name: head.slice(0, eq).trim(), tags: head.slice(eq + 1).trim(), aliases: '', negative: '' }
      for (const part of rest) {
        const value = part.trim()
        const alias = /^(?:aliases?|cues?)\s*:/i.exec(value)
        if (alias) { place.aliases = value.slice(alias[0].length).trim(); continue }
        const negative = /^(?:no|negative|not)\s*:/i.exec(value)
        if (negative) place.negative = value.slice(negative[0].length).trim()
      }
      return place.name && place.tags ? place : null
    }).filter(Boolean)
  }

  function renderPlaces() {
    const field = $('.ld-places')
    if (field) field.value = placesToText(places)
  }

  function profileFromPreset(preset, kind) {
    const p = preset || {}
    const profile = (kind === 'character' ? p.characterProfile : p.personaProfile) || {}
    const legacyTags = kind === 'character' ? (p.characterTags || '') : (p.personaTags || '')
    return {
      anchor: profile.anchor || '',
      countTag: profile.countTag || '',
      subject: profile.subject || '',
      identityTags: profile.identityTags || '',
      appearanceTags: profile.appearanceTags || legacyTags || '',
      defaultOutfitTags: profile.defaultOutfitTags || '',
      visualAliases: visualAliasesToText(profile.visualAliases),
      anatomyTags: profile.anatomyTags || '',
      anatomyMode: profile.anatomyMode || 'relevant',
      appearanceStates: appearanceStatesToText(profile.appearanceStates || profile.forms),
      looks: looksToText(profile.looks),
      defaultLook: profile.defaultLook || '',
      defaultAppearanceState: profile.defaultAppearanceState || profile.defaultForm || '',
    }
  }

  function editorProfile(kind) {
    const prefix = kind === 'character' ? 'char' : 'persona'
    const appearanceSelector = kind === 'character' ? '.ld-ed-chartags' : '.ld-ed-personatags'
    return {
      anchor: $(`.ld-ed-${prefix}-anchor`).value.trim(),
      promptName: $(`.ld-ed-${prefix}-promptname`) ? $(`.ld-ed-${prefix}-promptname`).value.trim() : '',
      countTag: $(`.ld-ed-${prefix}-count`).value.trim(),
      subject: $(`.ld-ed-${prefix}-subject`).value.trim(),
      // The one fact that must never drift. Checked after the parser writes, and
      // only ever put back — never used to rewrite anything it chose.
      identityTags: $(`.ld-ed-${prefix}-identity`) ? $(`.ld-ed-${prefix}-identity`).value.trim() : '',
      appearanceTags: $(appearanceSelector).value.trim(),
      defaultOutfitTags: $(`.ld-ed-${prefix}-outfit`).value.trim(),
      visualAliases: $(`.ld-ed-${prefix}-aliases`).value.trim(),
      partialFeatures: $(`.ld-ed-${prefix}-features`).value.trim(),
      anatomyTags: $(`.ld-ed-${prefix}-anatomy`).value.trim(),
      anatomyMode: $(`.ld-ed-${prefix}-anatomy-mode`).value || 'relevant',
      appearanceStates: $(`.ld-ed-${prefix}-states`).value.trim(),
      looks: $(`.ld-ed-${prefix}-looks`).value.trim(),
      defaultLook: $(`.ld-ed-${prefix}-default-look`).value.trim(),
      defaultAppearanceState: $(`.ld-ed-${prefix}-default-state`).value.trim(),
    }
  }

  function writeEditorProfile(kind, profile) {
    const value = profile || {}
    const prefix = kind === 'character' ? 'char' : 'persona'
    const appearanceSelector = kind === 'character' ? '.ld-ed-chartags' : '.ld-ed-personatags'
    $(`.ld-ed-${prefix}-anchor`).value = value.anchor || ''
    if ($(`.ld-ed-${prefix}-promptname`)) $(`.ld-ed-${prefix}-promptname`).value = value.promptName || ''
    $(`.ld-ed-${prefix}-count`).value = value.countTag || ''
    $(`.ld-ed-${prefix}-subject`).value = value.subject || ''
    $(appearanceSelector).value = value.appearanceTags || ''
    $(`.ld-ed-${prefix}-outfit`).value = value.defaultOutfitTags || ''
    $(`.ld-ed-${prefix}-aliases`).value = visualAliasesToText(value.visualAliases)
    $(`.ld-ed-${prefix}-features`).value = partialFeaturesToText(value.partialFeatures)
    $(`.ld-ed-${prefix}-anatomy`).value = value.anatomyTags || ''
    $(`.ld-ed-${prefix}-anatomy-mode`).value = value.anatomyMode || 'relevant'
    $(`.ld-ed-${prefix}-states`).value = appearanceStatesToText(value.appearanceStates || value.forms)
    $(`.ld-ed-${prefix}-looks`).value = looksToText(value.looks)
    $(`.ld-ed-${prefix}-default-look`).value = value.defaultLook || ''
    $(`.ld-ed-${prefix}-default-state`).value = value.defaultAppearanceState || value.defaultForm || ''
  }

  function linkedPersonaProfile(id) {
    const entry = personas.find((item) => item && item.id === id)
    return entry && entry.profile ? profileFromPreset({ personaProfile: entry.profile }, 'persona') : null
  }

  function linkedCharacterProfile(id) {
    const entry = characters.find((item) => item && item.id === id)
    return entry && entry.profile ? profileFromPreset({ characterProfile: entry.profile }, 'character') : null
  }

  function renderCharacterLinkSelect(selectedId = '') {
    const select = $('.ld-ed-char-link')
    if (!select) return
    select.innerHTML = '<option value="">Local profile stored in this preset</option>' + characters.map((item) => {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = item.name
      return option.outerHTML
    }).join('')
    select.value = selectedId || ''
  }

  function setCharacterFieldsLinked(linked) {
    const selectors = [
      '.ld-ed-char-anchor', '.ld-ed-char-count', '.ld-ed-char-subject', '.ld-ed-char-identity', '.ld-ed-chartags',
      '.ld-ed-char-outfit', '.ld-ed-char-default-state', '.ld-ed-char-states',
      '.ld-ed-char-aliases', '.ld-ed-char-features', '.ld-ed-char-anatomy', '.ld-ed-char-anatomy-mode',
    ]
    for (const selector of selectors) {
      const control = $(selector)
      if (control) control.disabled = !!linked
    }
  }

  function applyCharacterLink(id, fallbackProfile = null) {
    const linked = id ? linkedCharacterProfile(id) : null
    if (linked) writeEditorProfile('character', linked)
    else if (fallbackProfile) writeEditorProfile('character', fallbackProfile)
    setCharacterFieldsLinked(!!linked)
  }

  function renderCastEditor() {
    const list = $('.ld-ed-cast-list')
    const select = $('.ld-ed-cast-select')
    if (!list || !select) return
    // Selectable = library characters not already in the cast and not the main character link.
    const mainId = $('.ld-ed-char-link') ? $('.ld-ed-char-link').value : ''
    select.innerHTML = '<option value="">— choose a saved character —</option>' + characters
      .filter((item) => item && !editorCastIds.includes(item.id) && item.id !== mainId)
      .map((item) => {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.name
        return option.outerHTML
      }).join('')
    list.innerHTML = ''
    if (!editorCastIds.length) {
      list.innerHTML = '<div class="ld-status">No additional cast members. Up to 4 saved characters can join the main character and persona.</div>'
      return
    }
    for (const id of editorCastIds) {
      const entry = characters.find((item) => item && item.id === id)
      const chip = document.createElement('div')
      chip.className = 'ld-preset-item'
      const name = document.createElement('span')
      name.className = 'ld-preset-name'
      name.textContent = entry ? entry.name : `(missing character ${id.slice(0, 12)}…)`
      const remove = document.createElement('button')
      remove.className = 'ld-x'
      remove.textContent = '✕'
      remove.title = 'Remove from cast'
      remove.addEventListener('click', () => {
        editorCastIds = editorCastIds.filter((castId) => castId !== id)
        renderCastEditor()
      })
      chip.appendChild(name)
      chip.appendChild(remove)
      list.appendChild(chip)
    }
  }

  function renderPersonaLinkSelect(selectedId = '') {
    const select = $('.ld-ed-persona-link')
    if (!select) return
    select.innerHTML = '<option value="">Local profile stored in this preset</option>' + personas.map((item) => {
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = item.name
      return option.outerHTML
    }).join('')
    select.value = selectedId || ''
  }

  function setPersonaFieldsLinked(linked) {
    const selectors = [
      '.ld-ed-persona-anchor', '.ld-ed-persona-count', '.ld-ed-persona-subject', '.ld-ed-personatags',
      '.ld-ed-persona-outfit', '.ld-ed-persona-default-state', '.ld-ed-persona-states',
      '.ld-ed-persona-aliases', '.ld-ed-persona-features', '.ld-ed-persona-anatomy', '.ld-ed-persona-anatomy-mode',
    ]
    for (const selector of selectors) {
      const control = $(selector)
      if (control) control.disabled = !!linked
    }
  }

  function applyPersonaLink(id, fallbackProfile = null) {
    const linked = id ? linkedPersonaProfile(id) : null
    if (linked) writeEditorProfile('persona', linked)
    else if (fallbackProfile) writeEditorProfile('persona', fallbackProfile)
    setPersonaFieldsLinked(!!linked)
  }

  function libraryPersonaProfile() {
    return {
      anchor: $('.ld-persona-ed-anchor').value.trim(),
      promptName: $('.ld-persona-ed-promptname') ? $('.ld-persona-ed-promptname').value.trim() : '',
      countTag: $('.ld-persona-ed-count').value.trim(),
      subject: $('.ld-persona-ed-subject').value.trim(),
      identityTags: $('.ld-persona-ed-identity') ? $('.ld-persona-ed-identity').value.trim() : '',
      appearanceTags: $('.ld-persona-ed-tags').value.trim(),
      defaultOutfitTags: $('.ld-persona-ed-outfit').value.trim(),
      defaultAppearanceState: $('.ld-persona-ed-default-state').value.trim(),
      appearanceStates: $('.ld-persona-ed-states').value.trim(),
      looks: $('.ld-persona-ed-looks').value.trim(),
      defaultLook: $('.ld-persona-ed-default-look').value.trim(),
      visualAliases: $('.ld-persona-ed-aliases').value.trim(),
      partialFeatures: $('.ld-persona-ed-features').value.trim(),
      anatomyTags: $('.ld-persona-ed-anatomy').value.trim(),
      anatomyMode: $('.ld-persona-ed-anatomy-mode').value || 'relevant',
    }
  }

  function writeLibraryPersona(profile) {
    const value = profile || {}
    $('.ld-persona-ed-anchor').value = value.anchor || ''
    if ($('.ld-persona-ed-promptname')) $('.ld-persona-ed-promptname').value = value.promptName || ''
    $('.ld-persona-ed-count').value = value.countTag || ''
    $('.ld-persona-ed-subject').value = value.subject || ''
    if ($('.ld-persona-ed-identity')) $('.ld-persona-ed-identity').value = value.identityTags || ''
    $('.ld-persona-ed-tags').value = value.appearanceTags || ''
    $('.ld-persona-ed-outfit').value = value.defaultOutfitTags || ''
    $('.ld-persona-ed-default-state').value = value.defaultAppearanceState || value.defaultForm || ''
    $('.ld-persona-ed-states').value = appearanceStatesToText(value.appearanceStates || value.forms)
    $('.ld-persona-ed-looks').value = looksToText(value.looks)
    $('.ld-persona-ed-default-look').value = value.defaultLook || ''
    $('.ld-persona-ed-aliases').value = visualAliasesToText(value.visualAliases)
    $('.ld-persona-ed-features').value = partialFeaturesToText(value.partialFeatures)
    $('.ld-persona-ed-anatomy').value = value.anatomyTags || ''
    $('.ld-persona-ed-anatomy-mode').value = value.anatomyMode || 'relevant'
  }



  function stopScanElapsedTimer() {
    if (scanElapsedTimer) clearInterval(scanElapsedTimer)
    scanElapsedTimer = null
  }

  function renderLiveScanStatus() {
    const cancelButton = $('[data-act="cancel-scan"]')
    const scanButton = $('[data-act="scan"]')
    const oldButton = $('[data-act="scan-old"]')
    const scan = liveScanStatus
    const active = !!(scan && !['done', 'cancelled', 'error'].includes(scan.stage))
    const modeNow = selectedStoryMode()
    const parserDriven = modeNow === 'parser' || modeNow === 'direct'
    if (cancelButton) {
      cancelButton.style.display = active ? '' : 'none'
      cancelButton.disabled = !active || scan.cancellable === false
      cancelButton.textContent = scan && scan.stage === 'cancelling' ? 'Cancelling…' : 'Cancel parser'
    }
    if (scanButton) scanButton.disabled = active || !parserDriven
    // Direct is a rescanning mode too. openStoryPicker already accepts both —
    // this gate was left behind when Direct was promoted from a checkbox to a
    // mode, so the button it guards sat greyed out while the thing behind it
    // worked perfectly.
    if (oldButton) {
      oldButton.disabled = active || !parserDriven
    }
    if (!scan || !scan.startedAt) {
      stopScanElapsedTimer()
      return
    }
    const update = () => {
      const elapsed = Math.max(0, Math.round((Date.now() - Number(scan.startedAt)) / 1000))
      const message = scan.messageId ? `message ${scan.messageId.slice(0, 8)}…` : 'story message'
      // The backend heartbeats every running scan every 10 s. Silence beyond
      // 45 s means the scan (or the backend) is dead — say so and stop the
      // eternally climbing counter instead of impersonating progress.
      const silence = liveScanStatusAt ? Date.now() - liveScanStatusAt : 0
      if (!['done', 'cancelled', 'error'].includes(scan.stage) && silence > 45000) {
        setStatus('.ld-gen-status', `Scan lost contact with the backend after ${elapsed}s (no updates for ${Math.round(silence / 1000)}s). It will not complete — run the parser again, or reload the extension if this repeats.`, 'err')
        liveScanStatus = { ...scan, stage: 'error', cancellable: false }
        stopScanElapsedTimer()
        renderLiveScanStatus()
        return
      }
      const stageLabel = String(scan.stage || 'working').replace(/_/g, ' ')
      setStatus('.ld-gen-status', `${stageLabel[0].toUpperCase() + stageLabel.slice(1)} ${message} · ${elapsed}s${scan.note ? ' — ' + scan.note : ''}`, scan.stage === 'error' ? 'err' : (scan.stage === 'done' ? 'good' : undefined))
      if (['done', 'cancelled', 'error'].includes(scan.stage)) stopScanElapsedTimer()
    }
    update()
    if (active && !scanElapsedTimer) scanElapsedTimer = setInterval(update, 1000)
    if (!active) stopScanElapsedTimer()
  }

  function renderStoryStatus() {
    const el = $('.ld-story-last-status')
    if (!el) return
    if (!autoStatus || !autoStatus.at) {
      el.textContent = 'Auto illustrations idle.'
      return
    }
    const mode = autoStatus.mode ? String(autoStatus.mode) : 'auto'
    const status = autoStatus.status ? String(autoStatus.status) : 'idle'
    const note = autoStatus.note ? String(autoStatus.note) : ''
    const when = new Date(autoStatus.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    el.textContent = `Last auto illustration • ${mode} • ${status} • ${when}${note ? ' — ' + note : ''}`
  }

  function renderStoryDebug() {
    const prompt = $('.ld-story-final-prompt')
    const parsed = $('.ld-story-parsed')
    if (!prompt || !parsed) return
    const debug = storyDebug || null
    prompt.value = debug && debug.lastCompiledPrompt ? debug.lastCompiledPrompt : ''
    parsed.value = debug ? JSON.stringify({
      mode: debug.mode,
      parserEngine: debug.parserEngine || null,
      debugSource: debug.debugSource || null,
      selectedEntryIndex: debug.selectedEntryIndex || null,
      sourceMessageId: debug.sourceMessageId || null,
      sourceSwipeId: Number.isInteger(debug.sourceSwipeId) ? debug.sourceSwipeId : null,
      sourceSwipeCount: Number(debug.sourceSwipeCount) || 0,
      sourceContentSource: debug.sourceContentSource || null,
      subjectBinding: debug.subjectBinding,
      error: debug.error || null,
      rawReply: debug.rawReply || null,
      contextMessageCount: debug.contextMessageCount || 0,
      ledgerFound: !!debug.ledgerFound,
      contextPreview: debug.contextPreview || '',
      ledgerPreview: debug.ledgerPreview || '',
      entries: debug.entries || [],
      at: debug.at || null,
    }, null, 2) : ''
  }

  function currentDraftBundle() {
    return {
      config: readDraftConfigFromControls(),
      extra: null,
      promptPrefix: '',
      negativePrompt: $('.ld-negative').value || '',
      qualityTags: '',
      characterTags: '',
      personaTags: '',
      characterProfile: null,
      personaProfile: null,
      bannedTags: '',
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
      return String(item.preview || '').toLowerCase().includes(query) || String(item.turn || '').includes(query) || String(item.chatTurn || '').includes(query)
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
      number.textContent = `Chat message ${item.chatTurn || '?'} · story ${item.turn}`
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
      button.addEventListener('click', () => runStoryScan(item.id, `chat message ${item.chatTurn || item.turn}`, true))
      list.appendChild(button)
    }
  }

  async function openStoryPicker() {
    const mode = selectedStoryMode()
    if (mode !== 'parser' && mode !== 'direct') {
      setStatus('.ld-gen-status', 'Choose Parser or Direct mode in the Story tab before rescanning an old message.', 'err')
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

  async function runStoryScan(messageId, label = 'latest story message', force = false) {
    closeStoryPicker()
    liveScanStatus = {
      stage: 'starting', note: `Scanning ${label}.`, messageId: messageId || '',
      startedAt: Date.now(), cancellable: true,
    }
    renderLiveScanStatus()
    try {
      const payload = { force: !!force }
      if (messageId !== undefined && messageId !== null && messageId !== '') payload.messageId = messageId
      const res = await call('scan_story', payload)
      const refreshed = await call('init', {}, 15000)
      const mountChatId = activeChatIdFromCtx()
      if (mountChatId) await refreshImagePlacements(mountChatId).catch((error) => console.log('[LumiDraw] image refresh after Scan failed:', error.message))
      history = refreshed.history
      storyDebug = res.storyDebug || refreshed.storyDebug || storyDebug
      autoStatus = refreshed.lastAutoStatus || autoStatus
      renderHistory()
      renderStoryDebug(); renderStoryStatus()
      liveScanStatus = {
        ...(liveScanStatus || {}),
        stage: res.cancelled ? 'cancelled' : (res.mode === 'busy' ? 'error' : 'done'),
        note: res.note || `Done (${res.mode}).`,
        cancellable: false,
      }
      renderLiveScanStatus()
    } catch (e) {
      liveScanStatus = { ...(liveScanStatus || {}), stage: 'error', note: e.message, cancellable: false }
      renderLiveScanStatus()
    }
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

  // Safari lays fixed overlays out against the full page viewport even after
  // the on-screen keyboard has reduced the visible area. Track visualViewport
  // so the editor follows the screen the user can actually see.
  function syncTextEditorViewport() {
    if (!textEditor.classList.contains('ld-open')) return
    const viewport = window.visualViewport
    const height = Math.max(1, Math.round(viewport ? viewport.height : window.innerHeight))
    const top = Math.max(0, Math.round(viewport ? viewport.offsetTop : 0))
    textEditor.style.setProperty('--ld-editor-viewport-height', `${height}px`)
    textEditor.style.setProperty('--ld-editor-viewport-top', `${top}px`)
  }

  function rememberTextareaState(textarea) {
    let start = 0
    let end = 0
    let direction = 'none'
    try {
      start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : 0
      end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start
      direction = textarea.selectionDirection || 'none'
    } catch { /* selection may be unavailable on an unfocused mobile field */ }
    const scrollHost = textarea.closest('.ld-form-view, .ld-pane-body, .ld-lightbox-regen, .ld-story-list')
    return {
      start,
      end,
      direction,
      textareaScrollTop: textarea.scrollTop || 0,
      scrollHost,
      hostScrollTop: scrollHost ? scrollHost.scrollTop : 0,
      hostScrollLeft: scrollHost ? scrollHost.scrollLeft : 0,
    }
  }

  function openTextEditor(textarea) {
    if (!textarea) return
    expandedTextarea = textarea
    expandedTextareaState = rememberTextareaState(textarea)
    textEditorTitle.textContent = textareaTitle(textarea)
    textEditorArea.value = textarea.value || ''
    textEditor.classList.add('ld-open')
    textEditor.setAttribute('aria-hidden', 'false')
    document.body.classList.add('ld-fullscreen-lock')
    syncTextEditorViewport()
    requestAnimationFrame(() => {
      try { textEditorArea.focus({ preventScroll: true }) } catch { textEditorArea.focus() }
      const state = expandedTextareaState
      if (state) {
        try { textEditorArea.setSelectionRange(state.start, state.end, state.direction) } catch { /* best effort */ }
        textEditorArea.scrollTop = state.textareaScrollTop
      }
      syncTextEditorViewport()
    })
  }

  function closeTextEditor(apply) {
    const origin = expandedTextarea
    const state = expandedTextareaState
    if (apply && origin) {
      origin.value = textEditorArea.value
      origin.dispatchEvent(new Event('input', { bubbles: true }))
      origin.dispatchEvent(new Event('change', { bubbles: true }))
    }
    expandedTextarea = null
    expandedTextareaState = null
    textEditor.classList.remove('ld-open')
    textEditor.setAttribute('aria-hidden', 'true')
    document.body.classList.toggle('ld-fullscreen-lock', lightbox.classList.contains('ld-open') ||
      (panel.classList.contains('ld-fullscreen') && panel.classList.contains('ld-open')))
    requestAnimationFrame(() => {
      // Do not refocus the small source field: that would reopen the keyboard
      // and ask Safari to scroll the panel a second time. Just restore its
      // container and internal scroll positions.
      if (origin && origin.isConnected && state) origin.scrollTop = state.textareaScrollTop
      if (state && state.scrollHost && state.scrollHost.isConnected) {
        state.scrollHost.scrollTop = state.hostScrollTop
        state.scrollHost.scrollLeft = state.hostScrollLeft
      }
    })
  }

  function decorateTextareas() {
    for (const textarea of dom.queryAll('.ld-panel textarea, .ld-lightbox textarea')) {
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
      button.setAttribute('aria-haspopup', 'dialog')
      button.setAttribute('aria-controls', 'ld-text-editor-dialog')
      button.addEventListener('click', () => openTextEditor(textarea))
      wrapper.appendChild(button)
    }
  }

  function renderChips() {
    const el = $('.ld-config-chips')
    if (!el) return
    if (!draftConfig) {
      el.innerHTML = '<span class="ld-status">No workspace loaded yet — choose a preset or press Sync.</span>'
      renderHeaderState()
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
    renderHeaderState()
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
    renderHeaderState()
  }

  // One shared editor serves both libraries; libEditorKind decides which one
  // the Save button writes to.
  function openPersonaEditor(id = null, kind = 'persona') {
    libEditorKind = kind === 'character' ? 'character' : 'persona'
    personaEditorId = id || null
    const source = libEditorKind === 'character' ? characters : personas
    const entry = id ? source.find((item) => item && item.id === id) : null
    $('.ld-persona-editor').style.display = 'block'
    const title = $('.ld-lib-ed-title')
    if (title) title.textContent = libEditorKind === 'character' ? 'Character library editor' : 'Persona library editor'
    const saveButton = $('.ld-lib-ed-save')
    if (saveButton) saveButton.textContent = libEditorKind === 'character' ? 'Save character' : 'Save persona'
    $('.ld-persona-ed-name').value = entry ? (entry.name || '') : ''
    writeLibraryPersona(entry && entry.profile ? entry.profile : {})
    setStatus('.ld-persona-ed-status', entry
      ? `Editing reusable ${libEditorKind}.`
      : `Create a reusable ${libEditorKind} that can be linked into multiple presets.`)
    if ($('.ld-persona-editor').scrollIntoView) $('.ld-persona-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function renderCharacterList() {
    const list = $('.ld-charlib-list')
    if (!list) return
    list.innerHTML = ''
    if (!characters.length) {
      list.innerHTML = '<div class="ld-status">No reusable characters yet.</div>'
      renderCharacterLinkSelect($('.ld-ed-char-link') ? $('.ld-ed-char-link').value : '')
      renderCastEditor()
      return
    }
    for (const character of characters) {
      const item = document.createElement('div')
      item.className = 'ld-preset-item'
      const name = document.createElement('span')
      name.className = 'ld-preset-name'
      name.textContent = character.name || 'Unnamed character'
      const detail = document.createElement('span')
      detail.className = 'ld-preset-model'
      const profile = character.profile || {}
      const formCount = Array.isArray(profile.appearanceStates) ? profile.appearanceStates.length : (String(profile.appearanceStates || '').trim() ? String(profile.appearanceStates).split(/\r?\n/).filter(Boolean).length : 0)
      // TELLING TWO "FANNY PRICE"S APART. A story can invent somebody you already
      // have, and this list showed a name and an anchor — which are identical for
      // both — so the wrong one got edited and the right one looked broken. Say
      // which the story invented, and show the tags, because the tags are the
      // whole difference between them.
      const story = profile.declaredByStory ? 'invented by a story' : ''
      const someTags = String(profile.appearanceTags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4).join(', ')
      detail.textContent = [profile.anchor || '', story, someTags,
        formCount ? `${formCount} state${formCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
      if (story) { name.style.opacity = '.72'; name.title = 'This one was written by a story, not by you. Its tags are a guess.' }
      name.appendChild(detail)
      name.addEventListener('click', () => openPersonaEditor(character.id, 'character'))
      const edit = document.createElement('button')
      edit.className = 'ld-append'; edit.textContent = 'Edit'; edit.style.flex = '0 0 auto'; edit.style.width = 'auto'; edit.style.padding = '3px 8px'
      edit.addEventListener('click', (event) => { event.stopPropagation(); openPersonaEditor(character.id, 'character') })
      const del = document.createElement('button')
      del.className = 'ld-x'; del.textContent = '✕'; del.title = 'Delete reusable character'
      del.addEventListener('click', async (event) => {
        event.stopPropagation()
        if (!confirm(`Delete reusable character “${character.name}”? Presets linked to it will fall back to their stored local copy, and it will leave any casts that include it.`)) return
        try {
          const result = await call('delete_character', { id: character.id })
          characters = result.characters || []
          renderCharacterList()
          setStatus('.ld-charlib-status', `Deleted “${character.name}”.`, 'good')
        } catch (error) { setStatus('.ld-charlib-status', error.message, 'err') }
      })
      item.appendChild(name); item.appendChild(edit); item.appendChild(del)
      list.appendChild(item)
    }
    renderCharacterLinkSelect($('.ld-ed-char-link') ? $('.ld-ed-char-link').value : '')
    renderCastEditor()
  }

  function renderPersonaList() {
    const list = $('.ld-persona-list')
    if (!list) return
    list.innerHTML = ''
    if (!personas.length) {
      list.innerHTML = '<div class="ld-status">No reusable personas yet.</div>'
      renderPersonaLinkSelect($('.ld-ed-persona-link') ? $('.ld-ed-persona-link').value : '')
      return
    }
    for (const persona of personas) {
      const item = document.createElement('div')
      item.className = 'ld-preset-item'
      const name = document.createElement('span')
      name.className = 'ld-preset-name'
      name.textContent = persona.name || 'Unnamed persona'
      const detail = document.createElement('span')
      detail.className = 'ld-preset-model'
      const profile = persona.profile || {}
      const formCount = Array.isArray(profile.appearanceStates) ? profile.appearanceStates.length : (String(profile.appearanceStates || '').trim() ? String(profile.appearanceStates).split(/\r?\n/).filter(Boolean).length : 0)
      detail.textContent = [profile.anchor || '', formCount ? `${formCount} state${formCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
      name.appendChild(detail)
      name.addEventListener('click', () => openPersonaEditor(persona.id))
      const edit = document.createElement('button')
      edit.className = 'ld-append'; edit.textContent = 'Edit'; edit.style.flex = '0 0 auto'; edit.style.width = 'auto'; edit.style.padding = '3px 8px'
      edit.addEventListener('click', (event) => { event.stopPropagation(); openPersonaEditor(persona.id) })
      const del = document.createElement('button')
      del.className = 'ld-x'; del.textContent = '✕'; del.title = 'Delete reusable persona'
      del.addEventListener('click', async (event) => {
        event.stopPropagation()
        if (!confirm(`Delete reusable persona “${persona.name}”? Presets linked to it will fall back to their stored local persona copy.`)) return
        try {
          const result = await call('delete_persona', { id: persona.id })
          personas = result.personas || []
          renderPersonaList()
          setStatus('.ld-persona-status', `Deleted “${persona.name}”.`, 'good')
        } catch (error) { setStatus('.ld-persona-status', error.message, 'err') }
      })
      item.appendChild(name); item.appendChild(edit); item.appendChild(del)
      list.appendChild(item)
    }
    renderPersonaLinkSelect($('.ld-ed-persona-link') ? $('.ld-ed-persona-link').value : '')
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
    // This adds a NEW copy at the top of the latest message. When the image is
    // already placed in a story message — every parser/inline image is — that
    // is almost never what was wanted, so make the consequence explicit before
    // duplicating it.
    const alreadyPlaced = !!(entry && entry.origin && entry.origin.messageId)
    if (alreadyPlaced && !confirm(
      'This image is already placed in a story message.\n\n' +
      '"Add copy to chat" does NOT replace it — it adds a SECOND copy at the top of the latest message.\n\n' +
      'To replace an image, use "Fix this image…" instead (that replaces it in place).\n\n' +
      'Add a duplicate copy anyway?'
    )) {
      setStatus('.ld-gen-status', 'Cancelled — nothing was added.')
      return
    }
    setStatus('.ld-gen-status', 'Adding to chat…')
    try {
      const recipeConfig = entry && entry.recipe && entry.recipe.config ? entry.recipe.config : null
      const res = await call('append_to_chat', {
        imageUrl: img.url,
        imageId: img.id || '',
        alt: (entry && entry.prompt) ? entry.prompt.slice(0, 120) : 'Generated image',
        width: recipeConfig && recipeConfig.width,
        height: recipeConfig && recipeConfig.height,
      })
      setStatus('.ld-gen-status', res.mode === 'mounted'
        ? 'Added a native LumiDraw image to the latest story message.'
        : (res.mode === 'inserted' ? 'Added a copy at the top of the latest story message.' : 'Added image to chat.'), 'good')
    } catch (e) {
      setStatus('.ld-gen-status', e.message, 'err')
    }
  }

  function loadHistoryImage(entry, image) {
    if (!entry || !image) return
    selectedOutputUrl = image.url
    $('.ld-prompt').value = entry.prompt || ''
    const hasSavedNegative = Object.prototype.hasOwnProperty.call(entry, 'negativePrompt')
    if (hasSavedNegative) {
      $('.ld-negative').value = entry.negativePrompt || ''
      onDraftControlChange()
    }
    $('.ld-seed').value = (entry.seed !== undefined && entry.seed !== null && entry.seed !== 'random') ? entry.seed : ''
    renderCurrentOutput()
    if (window.matchMedia && window.matchMedia('(max-width: 840px)').matches) setMobileTab('create')
    setStatus('.ld-gen-status', hasSavedNegative
      ? 'Loaded this history image, prompt, negative prompt, and seed into Create.'
      : 'Loaded this history image, prompt, and seed into Create. This older history item did not save its negative prompt.', 'good')
  }

  function renderCurrentOutput() {
    const stage = $('.ld-current-output')
    if (!stage) return
    stage.innerHTML = ''
    const item = currentOutputItem()
    const entry = item && item.entry
    const image = item && item.image
    if (!entry || !image) {
      const empty = document.createElement('div')
      empty.className = 'ld-output-empty'
      empty.textContent = 'Your newest image will appear here.'
      stage.appendChild(empty)
      return
    }
    const hit = document.createElement('button')
    hit.type = 'button'
    hit.className = 'ld-image-hit'
    hit.title = 'Open image viewer'
    hit.setAttribute('aria-label', 'Open generated image viewer')
    const img = document.createElement('img')
    setPreviewImageSource(img, image.url, 'lg')
    img.alt = (entry.prompt || 'Generated image').slice(0, 160)
    img.draggable = false
    hit.addEventListener('click', () => openLightbox(image.url))
    hit.appendChild(img)
    const meta = document.createElement('div')
    meta.className = 'ld-output-meta'
    const parts = [entry.model, entry.seed !== undefined ? `seed ${entry.seed}` : '', entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : ''].filter(Boolean)
    meta.textContent = parts.join(' · ')
    meta.title = `${parts.join(' · ')}
${entry.prompt || ''}`.trim()
    stage.appendChild(hit)
    stage.appendChild(meta)
  }

  function renderHistory() {
    renderCurrentOutput()
    const el = $('.ld-history')
    if (!el) return
    el.innerHTML = ''
    if (!history.length) {
      const empty = document.createElement('div')
      empty.className = 'ld-lora-empty'
      empty.textContent = 'No recent images yet.'
      el.appendChild(empty)
      return
    }
    for (const entry of history) {
      for (const img of entry.images || []) {
        const wrap = document.createElement('div')
        wrap.className = 'ld-thumb'
        const hit = document.createElement('button')
        hit.type = 'button'
        hit.className = 'ld-image-hit'
        hit.title = `${entry.model}
seed ${entry.seed}
${entry.prompt || ''}`.trim()
        hit.setAttribute('aria-label', 'Load generated image into Create')
        const im = document.createElement('img')
        setPreviewImageSource(im, img.url, 'sm')
        im.alt = (entry.prompt || 'Generated image').slice(0, 160)
        im.draggable = false
        im.loading = 'lazy'
        im.decoding = 'async'
        hit.addEventListener('click', () => loadHistoryImage(entry, img))
        hit.appendChild(im)
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
        wrap.appendChild(hit)
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
          negativePrompt: $('.ld-negative') ? $('.ld-negative').value : '',
          label: `generation preset “${preset.name}”`,
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
    const settingCount = Object.keys(res.captured || {}).length
    setStatus(statusSel, `Captured ${res.captured.model || '(no model)'} · ${settingCount} setting${settingCount === 1 ? '' : 's'}`, 'good')
  }

  async function doGenerate() {
    if (busy) return
    draftConfig = readDraftConfigFromControls()
    if (!draftConfig) {
      setStatus('.ld-gen-status', 'No workspace settings yet — choose a preset or press Sync.', 'err')
      return
    }
    if (!draftConfig.model) {
      setStatus('.ld-gen-status', 'No model set — Draw Things will use whatever is selected in its own UI.')
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
        // Studio is fully isolated. Add any quality tags, subjects, or other
        // prompt text manually in the prompt field when you want them.
        negativePrompt: bundle.negativePrompt,
        seed: seedRaw === '' ? undefined : Number(seedRaw),
        config: bundle.config,
        extra: null,
      })
      history = res.history
      selectedOutputUrl = res.entry && res.entry.images && res.entry.images[0] ? res.entry.images[0].url : null
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
    const maxH = Math.min(820, Math.max(320, (openAbove ? spaceAbove : spaceBelow) - 4))
    panel.style.maxHeight = maxH + 'px'
    const pw = panel.offsetWidth || 1180
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

  // Settings was a flat scroll of five unrelated cards, where a cloud panel for a
  // feature Eric does not use sat as prominently as the Draw Things connection he
  // cannot work without.
  //
  // Sections are assigned by ATTRIBUTE, never by relocating markup. An earlier
  // attempt did move blocks and silently carried a help paragraph away from its
  // own checkbox — the kind of damage no syntax check catches and no test I could
  // write would have seen. Tagging cannot lose a control, because it never
  // touches one.
  const SETTINGS_SECTION_KEY = 'lumidraw.settingsSection'

  function setSettingsSection(name, persist = true) {
    const next = ['connection', 'advanced'].includes(name) ? name : 'connection'
    let activeTab = null
    for (const tab of dom.queryAll('.ld-settings-tab')) {
      const active = tab.getAttribute('data-settings-tab') === next
      tab.classList.toggle('ld-active', active)
      tab.setAttribute('aria-selected', String(active))
      if (active) activeTab = tab
    }
    for (const card of dom.queryAll('[data-settings-section]')) {
      card.style.display = card.getAttribute('data-settings-section') === next ? '' : 'none'
    }
    revealHorizontalItem(activeTab)
    if (persist) {
      try { localStorage.setItem(SETTINGS_SECTION_KEY, next) } catch { /* best effort */ }
    }
  }

  for (const tab of dom.queryAll('.ld-settings-tab')) {
    tab.addEventListener('click', () => setSettingsSection(tab.getAttribute('data-settings-tab')))
  }
  try { setSettingsSection(localStorage.getItem(SETTINGS_SECTION_KEY) || 'connection', false) }
  catch { setSettingsSection('connection', false) }

  for (const tab of dom.queryAll('.ld-main-tab')) {
    tab.addEventListener('click', () => setMainView(tab.getAttribute('data-tab')))
  }
  for (const tab of dom.queryAll('.ld-mobile-tab')) {
    tab.addEventListener('click', () => setMobileTab(tab.getAttribute('data-mobile-tab')))
  }
  try { setMainView(localStorage.getItem(MAIN_VIEW_KEY) || 'studio', false) } catch { setMainView('studio', false) }
  try { setMobileTab(localStorage.getItem(MOBILE_TAB_KEY) || 'create', false) } catch { setMobileTab('create', false) }

  fullscreenToggle.addEventListener('click', () => setFullscreen(!panel.classList.contains('ld-fullscreen')))
  $('.ld-min').addEventListener('click', () => {
    panel.classList.remove('ld-open')
    document.body.classList.remove('ld-fullscreen-lock')
  })
  $('.ld-lightbox-close').addEventListener('click', closeLightbox)
  $('.ld-lightbox-done').addEventListener('click', closeLightbox)
  $('.ld-lightbox-prev').addEventListener('click', () => moveLightbox(-1))
  $('.ld-lightbox-next').addEventListener('click', () => moveLightbox(1))
  $('.ld-lightbox-zoom-out').addEventListener('click', () => setLightboxZoom(lightboxScale / 1.25))
  $('.ld-lightbox-zoom-in').addEventListener('click', () => setLightboxZoom(lightboxScale * 1.25))
  $('.ld-lightbox-zoom-level').addEventListener('click', resetLightboxZoom)
  lightboxImage.addEventListener('load', resetLightboxZoom)
  lightboxImageWrap.addEventListener('wheel', (event) => {
    event.preventDefault()
    setLightboxZoom(lightboxScale * (event.deltaY < 0 ? 1.15 : (1 / 1.15)), event.clientX, event.clientY)
  }, { passive: false })
  lightboxImageWrap.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    lightboxLastPointerType = event.pointerType || ''
    lightboxGestureMoved = false
    try { lightboxImageWrap.setPointerCapture(event.pointerId) } catch { /* best effort */ }
    lightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (lightboxPointers.size === 1) {
      lightboxPanStart = { x: event.clientX, y: event.clientY, panX: lightboxPanX, panY: lightboxPanY }
      lightboxPinchStart = null
    } else if (lightboxPointers.size === 2) {
      const points = [...lightboxPointers.values()]
      lightboxPinchStart = {
        distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) || 1,
        scale: lightboxScale,
      }
      lightboxPanStart = null
    }
  })
  lightboxImageWrap.addEventListener('pointermove', (event) => {
    if (!lightboxPointers.has(event.pointerId)) return
    const previous = lightboxPointers.get(event.pointerId)
    lightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 2) lightboxGestureMoved = true
    if (lightboxPointers.size >= 2 && lightboxPinchStart) {
      const points = [...lightboxPointers.values()].slice(0, 2)
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) || 1
      const midpointX = (points[0].x + points[1].x) / 2
      const midpointY = (points[0].y + points[1].y) / 2
      setLightboxZoom(lightboxPinchStart.scale * (distance / lightboxPinchStart.distance), midpointX, midpointY)
      return
    }
    if (lightboxPointers.size === 1 && lightboxPanStart && lightboxScale > 1) {
      lightboxPanX = lightboxPanStart.panX + (event.clientX - lightboxPanStart.x)
      lightboxPanY = lightboxPanStart.panY + (event.clientY - lightboxPanStart.y)
      applyLightboxTransform()
    }
  })
  const endLightboxPointer = (event) => {
    const wasTouch = event.pointerType === 'touch'
    const wasSingle = lightboxPointers.size === 1
    lightboxPointers.delete(event.pointerId)
    try { lightboxImageWrap.releasePointerCapture(event.pointerId) } catch { /* best effort */ }
    if (wasTouch && wasSingle && !lightboxGestureMoved) {
      const now = Date.now()
      if (now - lightboxLastTapAt < 320) {
        toggleLightboxZoom(event.clientX, event.clientY)
        lightboxLastTapAt = 0
      } else {
        lightboxLastTapAt = now
      }
    }
    if (lightboxPointers.size === 1) {
      const remaining = [...lightboxPointers.values()][0]
      lightboxPanStart = { x: remaining.x, y: remaining.y, panX: lightboxPanX, panY: lightboxPanY }
      lightboxPinchStart = null
    } else if (!lightboxPointers.size) {
      lightboxPanStart = null
      lightboxPinchStart = null
    }
  }
  lightboxImageWrap.addEventListener('pointerup', endLightboxPointer)
  lightboxImageWrap.addEventListener('pointercancel', endLightboxPointer)
  lightboxImageWrap.addEventListener('dblclick', (event) => {
    if (lightboxLastPointerType === 'touch') return
    event.preventDefault()
    toggleLightboxZoom(event.clientX, event.clientY)
  })
  $('.ld-lightbox-insert').addEventListener('click', () => {
    const item = lightboxItems[lightboxIndex]
    if (item) appendToChat(item.image, item.entry)
  })
  $('.ld-lightbox-fix').addEventListener('click', () => {
    const box = $('.ld-lightbox-regen')
    if (box && box.style.display === 'block') closeRegenPanel()
    else openRegenPanel()
  })
  // Re-parse: run the parser again over the source passage and load the result
  // into the prompt box. Deliberately does NOT generate — the whole point is to
  // read the new prompt before spending Draw Things time on it.
  $('.ld-lightbox-reparse').addEventListener('click', async () => {
    const item = lightboxItems[lightboxIndex]
    if (!item) return
    const button = $('.ld-lightbox-reparse')
    const promptBox = $('.ld-lightbox-regen-prompt')
    const picker = $('.ld-lightbox-reparse-picker')
    const info = $('.ld-lightbox-reparse-info')
    if (!reparseOriginalPrompt) reparseOriginalPrompt = promptBox.value
    button.disabled = true
    const label = button.textContent
    button.textContent = 'Parsing…'
    info.textContent = ''
    picker.style.display = 'none'
    picker.innerHTML = ''
    // Attempts are counted per SOURCE image. Re-parse used to send an identical
    // request every time; the backend now shows the parser what it produced last
    // and asks for something different, and the count decides how hard it pushes.
    const attempt = (reparseAttempts.get(item.image.url) || 0) + 1
    reparseAttempts.set(item.image.url, attempt)
    setStatus('.ld-lightbox-regen-status', attempt > 1
      ? `Re-reading the passage — attempt ${attempt}. The previous ${attempt - 1} reading${attempt > 2 ? 's were' : ' was'} sent back as rejected, so it will look for a different moment.`
      : 'Re-reading the original passage with the current parser model — nothing is being generated.')
    try {
      const res = await call('reparse_image', {
        imageUrl: item.image.url,
        // Whatever is typed in Settings right now, saved or not — trying a
        // model should not require committing to it first.
        parserModel: $('.ld-parser-model') ? $('.ld-parser-model').value.trim() : undefined,
        parserConnection: $('.ld-parser-conn') ? $('.ld-parser-conn').value : undefined,
        mode: selectedStoryMode(),
        attempt,
      }, 300000)
      const results = Array.isArray(res.results) ? res.results : []
      const usable = results.filter((entry) => entry && entry.ok)
      const tokenNote = res.reasoningTokens != null && res.reasoningTokens > 0 ? ` · ${res.reasoningTokens} reasoning tokens` : ''
      const org = item.entry.origin || {}
      const moment = org.sceneCount > 1 && org.sceneIndex ? `moment ${org.sceneIndex} of ${org.sceneCount} · ` : ''
      info.textContent = `${moment}${res.model || 'parser'} · ${((res.parserMs || 0) / 1000).toFixed(1)}s${tokenNote}`
      info.title = res.requestedModel && res.requestedModel !== res.model
        ? `Requested "${res.requestedModel}" but the request resolved to "${res.model}".`
        : ''
      if (res.overrideNote) {
        info.style.color = 'var(--ld-warn, #e0a458)'
        setStatus('.ld-lightbox-regen-status', res.overrideNote, 'err')
      } else {
        info.style.color = ''
      }
      if (!usable.length) {
        setStatus('.ld-lightbox-regen-status', res.note || 'The parser produced no usable scene. The prompt below is unchanged.', 'err')
        return
      }
      const syncReparseDebug = (entry, index, source = 'image reparse candidate') => {
        const mode = res.mode || selectedStoryMode()
        storyDebug = {
          ...(storyDebug || {}),
          mode,
          parserEngine: res.parserEngine || (mode === 'direct' ? 'direct' : null),
          debugSource: source,
          selectedEntryIndex: Number.isInteger(index) ? index + 1 : null,
          subjectBinding: mode === 'direct' ? true : !!(storyDebug && storyDebug.subjectBinding),
          rawReply: res.rawReply || null,
          lastCompiledPrompt: entry && entry.prompt ? entry.prompt : '',
          entries: usable.map((candidate, candidateIndex) => ({
            index: candidateIndex + 1,
            selected: candidateIndex === index,
            anchor: candidate.anchor || '',
            momentEvidence: candidate.momentEvidence || '',
            sceneStatement: candidate.sceneStatement || '',
            prompt: candidate.prompt || '',
          })),
          at: Date.now(),
        }
        renderStoryDebug()
      }
      const applyResult = (entry, index) => {
        promptBox.value = entry.prompt || ''
        $('.ld-lightbox-regen-negative').value = entry.negativePrompt || ''
        syncReparseDebug(entry, index)
      }
      applyResult(usable[0], 0)
      // Several scenes usually come back; let the user flip between them and
      // back to what was there before, since comparison is the point.
      if (usable.length >= 1) {
        picker.style.display = 'block'
        const row = document.createElement('div')
        row.className = 'ld-row'
        row.style.flexWrap = 'wrap'
        const originIndex = Number((item.entry.origin || {}).sceneIndex || 0)
        usable.forEach((entry, index) => {
          const chip = document.createElement('button')
          chip.className = 'ld-btn ld-compact'
          // "Scene 2" says nothing. A few words of what is happening lets you
          // choose by meaning instead of by counting.
          const gist = String(entry.sceneStatement || '').replace(/\s+/g, ' ').trim()
          const short = gist.length > 34 ? gist.slice(0, 33).replace(/[\s,]+\S*$/, '') + '…' : gist
          const marker = originIndex && originIndex === index + 1 ? '● ' : ''
          chip.textContent = short ? `${marker}${index + 1}. ${short}` : `${marker}Scene ${index + 1}`
          chip.title = [
            gist,
            entry.anchor ? `Anchored at: "${entry.anchor}"` : '',
            originIndex && originIndex === index + 1 ? 'Same position in the reply as the image you are fixing.' : '',
          ].filter(Boolean).join('\n')
          chip.style.textAlign = 'left'
          chip.addEventListener('click', () => applyResult(entry, index))
          row.appendChild(chip)
        })
        if (reparseOriginalPrompt) {
          const revert = document.createElement('button')
          revert.className = 'ld-btn ld-compact'
          revert.textContent = 'Original'
          revert.title = 'Put the prompt this image was actually made with back in the box'
          revert.addEventListener('click', () => {
            promptBox.value = reparseOriginalPrompt
            syncReparseDebug({ prompt: reparseOriginalPrompt }, null, 'original image prompt')
          })
          row.appendChild(revert)
        }
        picker.appendChild(row)
        const box = $('.ld-lightbox-regen')
        if (box) box.scrollTop = 0
      }
      const rejected = results.length - usable.length
      if (!res.overrideNote) setStatus('.ld-lightbox-regen-status',
        `${res.note || 'Parsed.'}${rejected ? ` ${rejected} scene(s) were rejected by the compiler.` : ''} Read the prompt, then press Regenerate & replace when you are happy with it.`,
        'good')
    } catch (error) {
      setStatus('.ld-lightbox-regen-status', error.message, 'err')
    } finally {
      button.disabled = false
      button.textContent = label
    }
  })
  async function refreshRejectedKeys(clear = false) {
    const label = $('.ld-rejected-keys')
    if (!label) return
    try {
      const res = await call('dt_rejected_keys', clear ? { clear: true } : {})
      const keys = Array.isArray(res.keys) ? res.keys : []
      label.textContent = keys.length ? keys.join(', ') : 'none'
      label.style.opacity = keys.length ? '1' : '.6'
    } catch (error) {
      label.textContent = error.message
    }
  }
  // The connection refresh button had no click handler at all. It rendered, it
  // looked pressable, and switching models meant reloading the panel.
  const refreshConn = $('[data-act="refresh-parser-sources"]')
  if (refreshConn) {
    refreshConn.addEventListener('click', async () => {
      refreshConn.disabled = true
      const label = refreshConn.textContent
      refreshConn.textContent = '…'
      try {
        await reloadParserSources(true)
        setStatus('.ld-settings-status', 'Connections reloaded.', 'good')
      } catch (error) {
        setStatus('.ld-settings-status', 'Could not reload connections: ' + error.message, 'err')
      } finally {
        refreshConn.disabled = false
        refreshConn.textContent = label
      }
    })
  }

  // There is deliberately no "Use connection model" button. Copying the connection's
  // model into the override is what the connection dropdown already means, and a
  // redundant override is the exact state that used to make switching connections
  // do nothing. The dropdown on the left is the model; this field is the exception.

  // The override silently beats the connection dropdown, so switching
  // connections can change nothing at all while looking like it changed
  // everything. Say so where the field is.
  // ------------------------------------------------------------------ native story images
  // 1.3.5 keeps SimTracker-style extension-owned mounts, but restores LumiDraw's
  // original scene placement: every image owns its own mount and that mount is
  // inserted immediately after the rendered paragraph containing the parser's
  // saved anchor. The assistant message itself is never rewritten with <img>.
  const removeImageMountStyle = dom.addStyle(`
    .ld-message-image-host {
      display:block; width:100%; max-width:100%; margin:12px 0; box-sizing:border-box;
    }
    .ld-chat-image-item {
      display:block; max-width:100%; margin:0 auto; box-sizing:border-box;
    }
    .ld-chat-image {
      display:block; width:100%; max-width:100%; height:auto; max-height:none;
      object-fit:contain; box-sizing:border-box; border-radius:8px; cursor:pointer;
    }
  `)

  const escapeAttr = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // CHARACTER_MESSAGE_RENDERED is useful even when the payload does not carry
  // chatId; messageId is enough to satisfy an already-known render intent.
  function readImageEventContext(payload) {
    if (typeof payload === 'string' || typeof payload === 'number') {
      return { messageId: String(payload), chatId: '', isUser: null }
    }
    if (!payload || typeof payload !== 'object') return { messageId: '', chatId: '', isUser: null }
    const nested = payload.message && typeof payload.message === 'object' ? payload.message : {}
    const messageId = String(payload.messageId || payload.message_id || payload.id || nested.id || nested.messageId || nested.message_id || '')
    const chatId = String(payload.chatId || payload.chat_id || (payload.chat && payload.chat.id) || nested.chatId || nested.chat_id || '')
    const role = String(payload.role || nested.role || nested.sender || '').toLowerCase()
    const isUser = typeof payload.is_user === 'boolean' ? payload.is_user
      : (typeof nested.is_user === 'boolean' ? nested.is_user : (role === 'user' ? true : null))
    return { messageId, chatId, isUser }
  }

  function activeChatIdFromCtx() {
    try {
      if (ctx && typeof ctx.getActiveChat === 'function') {
        const active = ctx.getActiveChat()
        const id = active && (active.chatId || active.chat_id || active.id)
        if (id) return String(id)
      }
    } catch { /* best effort */ }
    return String(lastSeenChatId || imagePlacementChatId || '')
  }

  function findMountedMessageElement(messageId) {
    const id = String(messageId || '')
    if (!id) return null
    if (ctx.dom && typeof ctx.dom.findMessageElement === 'function') {
      try {
        const node = ctx.dom.findMessageElement(id)
        if (node) return node
      } catch { /* fallback below */ }
    }
    return document.querySelector(`[data-message-id="${CSS.escape(id)}"]`) ||
      document.querySelector(`[data-messageid="${CSS.escape(id)}"]`)
  }

  function cancelImageAttachRetry(messageId) {
    const id = String(messageId || '')
    const timer = imageAttachRetryTimers.get(id)
    if (timer) clearTimeout(timer)
    imageAttachRetryTimers.delete(id)
  }

  function clearImagePlacementMount(placementId) {
    const id = String(placementId || '')
    const mount = imagePlacementMounts.get(id)
    if (mount) dom.uninject(mount)
    imagePlacementMounts.delete(id)
    imagePlacementRenderKeys.delete(id)
    imagePlacementMountMessages.delete(id)
  }

  function clearImageMessageMount(messageId) {
    const id = String(messageId || '')
    for (const [placementId, mountedMessageId] of [...imagePlacementMountMessages.entries()]) {
      if (mountedMessageId === id) clearImagePlacementMount(placementId)
    }
    pendingImageMessageIds.delete(id)
    cancelImageAttachRetry(id)
  }

  function placementsForMessage(messageId) {
    const id = String(messageId || '')
    return imagePlacements
      .filter((item) => item && String(item.messageId || '') === id &&
        (!imagePlacementChatId || String(item.chatId || '') === imagePlacementChatId))
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0))
  }

  function placementRenderKey(item) {
    return [item.placementId, item.url, item.width, item.height, item.alt, item.anchor, item.source].join('|')
  }

  function placementMarkup(item) {
    const width = Math.max(1, Number(item.width) || 768)
    const height = Math.max(1, Number(item.height) || 1024)
    const id = escapeAttr(item.placementId)
    const originalUrl = String(item.url || '')
    const displayUrl = previewUrl(originalUrl, 'lg')
    return `<div class="ld-message-image-host" data-lumidraw-placement-host="${id}">
      <div class="ld-chat-image-item" data-lumidraw-placement-id="${id}" data-intrinsic-width="${width}">
        <img class="ld-chat-image" data-lumidraw-image="1" data-lumidraw-placement-id="${id}"
          data-lumidraw-original-url="${escapeAttr(originalUrl)}" src="${escapeAttr(displayUrl)}" alt="${escapeAttr(item.alt || 'Generated image')}"
          width="${width}" height="${height}" loading="lazy" decoding="async" />
      </div>
    </div>`
  }

  function configuredChatImageWidth(intrinsic = 0) {
    const enabled = !!($('.ld-size-images') && $('.ld-size-images').checked)
    if (enabled) {
      const raw = Number($('.ld-image-width') ? $('.ld-image-width').value : 0)
      return Math.min(1200, Math.max(200, raw || 500))
    }
    const own = Number(intrinsic) || 0
    return own > 0 ? Math.min(1200, Math.max(200, own)) : 720
  }

  function applyNativeImageSizingToMount(mount) {
    if (!mount || !mount.querySelectorAll) return
    for (const item of mount.querySelectorAll('.ld-chat-image-item')) {
      const px = configuredChatImageWidth(item.getAttribute('data-intrinsic-width'))
      item.style.setProperty('width', `${px}px`, 'important')
      item.style.setProperty('max-width', '100%', 'important')
      const img = item.querySelector('.ld-chat-image')
      if (img) {
        setPreviewImageSource(img, img.dataset.lumidrawOriginalUrl || img.getAttribute('src') || '', 'lg')
        img.style.setProperty('width', '100%', 'important')
        img.style.setProperty('max-width', '100%', 'important')
        img.style.setProperty('height', 'auto', 'important')
        img.style.setProperty('max-height', 'none', 'important')
      }
    }
  }

  function normalizeAnchorText(value) {
    return String(value || '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  function messageContentRoot(messageNode) {
    if (!messageNode || !messageNode.querySelector) return messageNode
    return messageNode.querySelector('[data-component="MessageContent"]') ||
      messageNode.querySelector('[data-component="BubbleMessage"] [class*="prose"]') ||
      messageNode.querySelector('[class*="prose"]') ||
      messageNode.querySelector('[class*="messageContent"]') ||
      messageNode
  }

  // The parser anchor is copied verbatim from the story passage. Markdown may
  // split that sentence across <em>/<strong>/links, so compare each rendered
  // block's textContent rather than looking for one literal DOM text node.
  function findAnchorBlock(contentRoot, anchor) {
    const wanted = normalizeAnchorText(anchor)
    if (!contentRoot || !wanted || wanted.length < 5) return null
    const selector = 'p,li,blockquote,pre,h1,h2,h3,h4,h5,h6'
    const candidates = contentRoot.querySelectorAll ? [...contentRoot.querySelectorAll(selector)] : []
    for (const block of candidates) {
      if (normalizeAnchorText(block.textContent).includes(wanted)) return block
    }
    // Some themes/renderers use plain immediate divs instead of <p>. Limit this
    // fallback to direct children so we don't choose the entire message wrapper.
    for (const block of [...(contentRoot.children || [])]) {
      if (block.matches && block.matches('.ld-message-image-host')) continue
      if (normalizeAnchorText(block.textContent).includes(wanted)) return block
    }
    return null
  }

  function placementInjectionTarget(messageNode, item) {
    const contentRoot = messageContentRoot(messageNode)
    const anchorBlock = findAnchorBlock(contentRoot, item.anchor)
    if (anchorBlock) return { target: anchorBlock, position: 'afterend', anchored: true }

    // Match the pre-1.3.3 behavior: if a story anchor cannot be placed, put the
    // image at the TOP rather than silently moving it to the end of the scene.
    // A manual Studio insertion has no story anchor, so keeping it at the end is
    // less surprising there.
    if (String(item.source || '') === 'manual') {
      return { target: contentRoot || messageNode, position: 'beforeend', anchored: false }
    }
    return { target: contentRoot || messageNode, position: 'afterbegin', anchored: false }
  }

  // Returns true when every placement for this message has a live mount. A
  // missing virtualized row is not an error; keep the message pending and let
  // CHARACTER_MESSAGE_RENDERED satisfy it when Lumiverse mounts the row.
  function renderImagesIntoMessage(messageId) {
    const id = String(messageId || '')
    if (!id) return false
    const items = placementsForMessage(id)
    if (!items.length) { clearImageMessageMount(id); return true }

    const messageNode = findMountedMessageElement(id)
    if (!messageNode) {
      pendingImageMessageIds.add(id)
      return false
    }

    const wantedIds = new Set(items.map((item) => String(item.placementId || '')).filter(Boolean))
    let rebuild = false
    for (const [placementId, mountedMessageId] of imagePlacementMountMessages.entries()) {
      if (mountedMessageId === id && !wantedIds.has(placementId)) { rebuild = true; break }
    }
    if (!rebuild) {
      for (const item of items) {
        const placementId = String(item.placementId || '')
        const mount = imagePlacementMounts.get(placementId)
        if (!mount || !mount.isConnected || imagePlacementRenderKeys.get(placementId) !== placementRenderKey(item)) {
          rebuild = true
          break
        }
      }
    }

    if (!rebuild) {
      for (const item of items) applyNativeImageSizingToMount(imagePlacementMounts.get(String(item.placementId || '')))
      pendingImageMessageIds.delete(id)
      cancelImageAttachRetry(id)
      return true
    }

    // Rebuild this message as one mount per image. Work backwards so two images
    // sharing one paragraph anchor preserve their saved order when each uses
    // insertAdjacentHTML('afterend').
    clearImageMessageMount(id)
    let complete = true
    for (const item of [...items].reverse()) {
      const placementId = String(item.placementId || '')
      if (!placementId) continue
      const where = placementInjectionTarget(messageNode, item)
      if (!where.target) { complete = false; continue }
      let mount = null
      try {
        mount = ctx.dom && typeof ctx.dom.inject === 'function'
          ? ctx.dom.inject(where.target, placementMarkup(item), where.position)
          : dom.inject(where.target, placementMarkup(item), where.position)
      } catch (error) {
        console.warn('[LumiDraw] anchored native image inject failed:', error && error.message ? error.message : error)
      }
      if (!mount) { complete = false; continue }
      imagePlacementMounts.set(placementId, mount)
      imagePlacementRenderKeys.set(placementId, placementRenderKey(item))
      imagePlacementMountMessages.set(placementId, id)
      applyNativeImageSizingToMount(mount)
    }

    if (complete) {
      pendingImageMessageIds.delete(id)
      cancelImageAttachRetry(id)
      return true
    }
    pendingImageMessageIds.add(id)
    return false
  }

  // One event-scoped retry burst handles the common race where the backend
  // finishes just before React mounts the final message. This is not polling:
  // after two frames + one short settle retry we wait for Lumiverse's own
  // CHARACTER_MESSAGE_RENDERED event, like SimTracker's render intent.
  function scheduleImageAttach(messageId) {
    const id = String(messageId || '')
    if (!id || !placementsForMessage(id).length) return false
    pendingImageMessageIds.add(id)
    if (renderImagesIntoMessage(id)) return true
    requestAnimationFrame(() => {
      if (!pendingImageMessageIds.has(id)) return
      if (renderImagesIntoMessage(id)) return
      requestAnimationFrame(() => {
        if (pendingImageMessageIds.has(id)) renderImagesIntoMessage(id)
      })
    })
    cancelImageAttachRetry(id)
    const timer = setTimeout(() => {
      imageAttachRetryTimers.delete(id)
      if (pendingImageMessageIds.has(id)) renderImagesIntoMessage(id)
    }, 180)
    imageAttachRetryTimers.set(id, timer)
    return false
  }

  async function refreshImagePlacements(chatId = '') {
    const seq = ++imagePlacementRefreshSeq
    const wantedChat = String(chatId || activeChatIdFromCtx() || '')
    const res = await call('get_image_mounts', { chatId: wantedChat }, 15000)
    if (seq !== imagePlacementRefreshSeq) return
    const nextChatId = String(res.chatId || wantedChat || '')
    if (imagePlacementChatId && nextChatId && imagePlacementChatId !== nextChatId) {
      for (const placementId of [...imagePlacementMounts.keys()]) clearImagePlacementMount(placementId)
    }
    imagePlacementChatId = nextChatId
    if (nextChatId) lastSeenChatId = nextChatId
    imagePlacements = Array.isArray(res.placements) ? res.placements : []
    const activePlacementIds = new Set(imagePlacements.map((item) => String(item && item.placementId || '')).filter(Boolean))
    for (const placementId of [...imagePlacementMounts.keys()]) {
      if (!activePlacementIds.has(placementId)) clearImagePlacementMount(placementId)
    }
    const messageIds = new Set(imagePlacements.map((item) => String(item && item.messageId || '')).filter(Boolean))
    for (const id of messageIds) scheduleImageAttach(id)
  }

  // Pre-1.3.3 images remain canonical message content owned by Lumiverse's
  // inline-image renderer. LumiDraw deliberately leaves them alone.
  function applyImageSize() {
    const on = $('.ld-size-images') && $('.ld-size-images').checked
    const row = $('.ld-size-images-row')
    if (row) row.style.display = on ? 'flex' : 'none'
    for (const mount of imagePlacementMounts.values()) applyNativeImageSizingToMount(mount)
  }

  // The slider and the number box are two views of one value.
  for (const [from, to] of [['.ld-image-width', '.ld-image-width-num'], ['.ld-image-width-num', '.ld-image-width']]) {
    const el = $(from)
    if (!el) continue
    el.addEventListener('input', () => {
      const mirror = $(to)
      if (mirror) mirror.value = el.value
      applyImageSize()
      scheduleSettingsSave()
    })
  }
  if ($('.ld-size-images')) {
    $('.ld-size-images').addEventListener('change', () => { applyImageSize(); scheduleSettingsSave() })
  }
  if ($('.ld-optimized-previews')) {
    $('.ld-optimized-previews').addEventListener('change', () => {
      settings.optimizedPreviews = $('.ld-optimized-previews').checked
      renderHistory()
      refreshNativePreviewSources()
      scheduleSettingsSave()
    })
  }
  if ($('.ld-delete-chat-images')) {
    $('.ld-delete-chat-images').addEventListener('change', scheduleSettingsSave)
  }

  // --- wardrobe of record -----------------------------------------------------
  // The compiler corrects the parser toward what it remembers, so a wrong record
  // is worse than no record: it is defended. This is the correction.
  let wardrobeLibrary = []

  function renderWardrobeRows(rows) {
    const box = $('.ld-wardrobe-rows')
    if (!box) return
    if (!rows || !rows.length) {
      box.innerHTML = '<div class="ld-help" style="margin:0">No characters here yet. This chat starts from its current Lumiverse character/persona; add saved characters here or refresh to read story declarations.</div>'
      return
    }
    box.innerHTML = rows.map((row) => {
      const name = String(row.name || row.ref).replace(/[<>&]/g, '')
      const attrName = name.replace(/"/g, '')
      const ref = String(row.ref || '').replace(/[<>&"]/g, '')
      const tags = String(row.tags || '').replace(/"/g, '&quot;')
      const hint = row.tags ? '' : (row.fallback ? `falls back to: ${String(row.fallback).replace(/[<>&]/g, '')}` : 'nothing recorded')
      const sourceLabels = {
        manual: 'manually set',
        'latest-passage': 'synced from latest passage',
        'scene-card': 'updated from the scene card',
        'story-parser': 'updated by the story parser',
        'story-declaration': 'updated by the story declaration',
        remembered: 'remembered wardrobe',
        default: 'saved character default',
        none: 'no clothing recorded',
      }
      const source = sourceLabels[String(row.wardrobeSource || '')] || 'remembered wardrobe'
      const when = Number(row.wardrobeAt) > 0
        ? ` · ${new Date(Number(row.wardrobeAt)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : ''
      const evidenceText = String(row.wardrobeEvidence || '').replace(/[<>&]/g, '').trim()
      const evidence = evidenceText ? ` · “${evidenceText.slice(0, 120)}”` : ''
      const provenance = `<div class="ld-help ld-wardrobe-provenance" style="margin:2px 0 0 2px">Current source: ${source}${when}${evidence}</div>`
      // A story-declared character can be removed; one you wrote by hand is only
      // unlinked from this preset. The mark says which, so the button is never a
      // surprise. "any chat" means it predates chat scoping and cannot be
      // attributed — it will keep showing up everywhere until it goes.
      const mark = row.declared
        ? '<span title="added by the story rather than by you — × deletes it" style="opacity:.55">  (story)</span>'
        : ''
      // WHAT THIS ROW CONTRIBUTES. The input edits clothes; these are the tags
      // that describe the person, and they were invisible — so a story's guess
      // at somebody looked exactly like the version you wrote yourself.
      const appearanceText = String(row.appearance || '').replace(/[<>&]/g, '')
      const appearance = appearanceText
        ? '<div style="font-size:10px;opacity:.5;margin-left:2px">' + appearanceText + '</div>'
        : ''
      // Swap a story-invented character for one you wrote. The story's version is
      // a guess at somebody you may already have properly written elsewhere — in
      // a lorebook, say — and this is how you say "use mine".
      const swap = row.id
        ? `<select class="ld-wardrobe-swap" data-id="${row.id}" title="Use a character from your library instead" style="max-width:120px">` +
          `<option value="">— use mine —</option>` +
          wardrobeLibrary.filter((item) => item.id !== row.id)
            .map((item) => `<option value="${String(item.id).replace(/"/g, '')}">${String(item.name || '').replace(/[<>&]/g, '')}</option>`)
            .join('') + '</select>'
        : ''
      const remove = row.id
        ? `<button class="ld-btn ld-compact" data-act="wardrobe-drop" data-id="${row.id}" data-name="${name}" data-declared="${row.declared ? '1' : ''}" title="${row.declared ? 'Delete this character — the story invented it' : "Remove from this chat's cast; the saved character is kept"}" style="padding:2px 7px">×</button>`
        : ''
      // WHERE THESE TAGS LIVE, and a way to get there. "LumiDraw has the Fanny
      // character saved somehow, somewhere cause the image it produced used the
      // lumicast tags. But I can't find where it is to edit it." A row that
      // produced tags but gives no route to the thing that owns them is the
      // difference between saved and editable.
      const where = row.source === 'library'
        ? 'a saved character — click to edit it'
        : row.source === 'cast'
          ? 'stored in the bound cast'
          : row.source === 'chat'
            ? 'the active chat character/persona'
            : 'no profile behind this row — only a wardrobe note'
      const opener = (row.source === 'library' && row.id)
        ? `<a href="#" class="ld-wardrobe-open" data-id="${row.id}" title="${where}" style="min-width:96px;font-size:12px;opacity:.8;text-decoration:underline;cursor:pointer">${name}${row.orphan ? ' *' : ''}${mark}</a>`
        : `<span title="${where}" style="min-width:96px;font-size:12px;opacity:.8">${name}${row.orphan ? ' *' : ''}${mark}</span>`
      return `<div class="ld-wardrobe-row" data-ref="${ref}" style="margin-bottom:8px">
      <div style="display:flex;gap:6px;align-items:center">
        ${opener}
        <input class="ld-wardrobe-input" data-ref="${ref}" style="flex:1" value="${tags}" placeholder="${hint}" />
        <button class="ld-btn ld-compact" data-act="wardrobe-save-one" data-ref="${ref}" data-name="${attrName}" title="Save only ${attrName}'s current outfit">Save</button>
        <button class="ld-btn ld-compact" data-act="wardrobe-clear-one" data-ref="${ref}" data-name="${attrName}" title="Clear only ${attrName}'s current outfit and return to the saved default"${row.tags ? '' : ' disabled'}>Clear</button>
        ${swap}
        ${remove}
      </div>
      ${provenance}
      ${appearance}
      </div>`
    }).join('')
  }

  // The wardrobe record is keyed by chat, but the settings panel is not opened by
  // a chat event and so has never known which chat it is looking at. It sent
  // nothing and let the backend guess with chats.getActive — and when the host
  // does not answer that, the key collapses to '' and EVERY chat shares one
  // wardrobe bucket. Two stories with the same cast then overwrite each other,
  // invisibly, in both directions.
  //
  // The events already carry a chat id. Remembering the last one we saw is a far
  // better answer than a guess, because it is the chat whose messages actually
  // reached us.
  function renderCasts(res) {
    const pick = $('.ld-cast-pick')
    if (!pick) return
    const casts = res.casts || []
    const esc = (value) => String(value || '').replace(/[<>&"]/g, '')
    pick.innerHTML = ['<option value="">(none — use this chat only)</option>']
      .concat(casts.map((cast) =>
        `<option value="${esc(cast.id)}"${cast.id === res.boundId ? ' selected' : ''}>${esc(cast.name)}</option>`))
      .join('')
    const active = casts.find((cast) => cast.id === res.boundId)
    const personaPick = $('.ld-chat-persona')
    if (personaPick) {
      personaPick.innerHTML = ['<option value="">(none — use the cast\'s persona)</option>']
        .concat((res.personas || []).map((item) =>
          `<option value="${esc(item.id)}"${item.id === res.personaId ? ' selected' : ''}>${esc(item.name)}</option>`))
        .join('')
    }
    const fantasyBox = $('.ld-cast-fantasy')
    if (fantasyBox) fantasyBox.checked = !!(active && active.fantasy)
    const summary = $('.ld-cast-summary')
    if (summary) {
      const who = active
        ? [active.character, active.persona, ...(active.members || [])].filter(Boolean).join(' · ') || 'Nobody in this cast yet.'
        : 'No saved cast bound — this chat uses its current character/persona plus anyone you add here.'
      // Sharing a cast is legitimate — the same two people really can be in two
      // stories — but it means a character one story introduces joins the other's
      // list too. Copy is the answer, and it is one button away.
      const shared = res.sharedWith > 0
        ? `  ·  shared with ${res.sharedWith} other chat${res.sharedWith === 1 ? '' : 's'}: a character introduced in either one joins both. Press Copy to give this story its own.`
        : ''
      summary.textContent = who + shared
      summary.style.color = res.sharedWith > 0 ? 'var(--ld-warn, #d9a441)' : ''
    }
  }

  async function loadCasts(payload = {}) {
    const requestedChatId = String(payload.chatId || lastSeenChatId || '')
    try {
      const res = await call('casts', { ...payload, chatId: requestedChatId }, 15000)
      // A slow reply from the chat we just left must never repaint the new chat's panel.
      if (requestedChatId && lastSeenChatId && requestedChatId !== String(lastSeenChatId)) return res
      renderCasts(res)
      return res
    } catch (e) {
      if (!requestedChatId || requestedChatId === String(lastSeenChatId || '')) setStatus('.ld-cast-status', e.message, 'err')
      return null
    }
  }

  if ($('.ld-cast-pick')) {
    $('.ld-cast-pick').addEventListener('change', async (event) => {
      const res = await loadCasts({ bind: event.target.value })
      if (!res) return
      setStatus('.ld-cast-status', res.boundId
        ? 'This chat now uses that cast. Images and the wardrobe follow it.'
        : 'No saved cast bound — this chat now uses its own current character/persona.', 'good')
      loadWardrobe(true)
    })
  }
  async function artistCall(payload, done) {
    try { done(await call('artist_index', payload, 20000)) }
    catch (e) { setStatus('.ld-artist-status', e.message, 'err') }
  }
  const artistReport = (res) => {
    if (!res.count) return setStatus('.ld-artist-status', 'No index loaded — artist tags are not being checked.', '')
    if (!(res.problems || []).length) {
      const checked = (res.checked || []).length
      return setStatus('.ld-artist-status',
        `${res.count.toLocaleString()} names loaded. ${checked ? `All ${checked} artist tag${checked === 1 ? '' : 's'} in this preset are known.` : 'This preset has no artist tags.'}`, 'good')
    }
    setStatus('.ld-artist-status', res.problems.map((item) =>
      item.suggestion ? `${item.tag} is unknown — did you mean ${item.suggestion}?` : `${item.tag} is unknown`).join(' · '), 'err')
  }
  if ($('[data-act="artist-load"]')) {
    $('[data-act="artist-load"]').addEventListener('click', () => {
      const box = $('.ld-artist-index')
      if (!box || !box.value.trim()) return setStatus('.ld-artist-status', 'Paste an artist list first.', 'err')
      setStatus('.ld-artist-status', 'Reading…', '')
      artistCall({ text: box.value }, (res) => {
        // Not kept in the box: a megabyte of names in a textarea makes the panel
        // crawl, and it is saved now anyway.
        box.value = ''
        setStatus('.ld-artist-status', `${res.count.toLocaleString()} artist names loaded.`, 'good')
      })
    })
  }
  if ($('[data-act="artist-check"]')) {
    $('[data-act="artist-check"]').addEventListener('click', () => artistCall({}, artistReport))
  }
  if ($('[data-act="artist-clear"]')) {
    $('[data-act="artist-clear"]').addEventListener('click', () => artistCall({ clear: true }, () =>
      setStatus('.ld-artist-status', 'Index cleared. Artist tags are no longer checked.', '')))
  }

  if ($('.ld-chat-persona')) {
    $('.ld-chat-persona').addEventListener('change', async (event) => {
      const label = event.target.options[event.target.selectedIndex].textContent
      try {
        const res = await call('casts', { chatId: lastSeenChatId, persona: event.target.value }, 15000)
        renderCasts(res)
        loadWardrobe(true)
        setStatus('.ld-cast-status', event.target.value
          ? `This chat is played as ${label}.`
          : "This chat falls back to the cast's persona.", 'good')
      } catch (e) { setStatus('.ld-cast-status', e.message, 'err') }
    })
  }

  if ($('.ld-cast-fantasy')) {
    $('.ld-cast-fantasy').addEventListener('change', async (event) => {
      const castId = $('.ld-cast-pick') && $('.ld-cast-pick').value
      if (!castId) { setStatus('.ld-cast-status', 'Bind a cast first.', 'err'); return }
      await loadCasts({ castId, fantasy: event.target.checked })
      setStatus('.ld-cast-status', event.target.checked
        ? 'Fantasy setting. Elves and pointed ears will not be negated in this story.'
        : 'Contemporary setting. Stray fantasy species will be negated again.', 'good')
    })
  }
  if ($('[data-act="cast-duplicate"]')) {
    $('[data-act="cast-duplicate"]').addEventListener('click', async () => {
      const current = $('.ld-cast-pick') && $('.ld-cast-pick').value
      if (!current) { setStatus('.ld-cast-status', 'Pick a cast to copy first.', 'err'); return }
      const res = await loadCasts({ duplicate: current })
      if (!res) return
      setStatus('.ld-cast-status', 'Copied. This chat uses the copy; the original story keeps its own.', 'good')
      loadWardrobe(true)
    })
  }

  async function loadWardrobe(quiet = true, scan = false, explicitChatId = '') {
    const requestedChatId = String(explicitChatId || lastSeenChatId || '')
    try {
      const res = await call('wardrobe', { chatId: requestedChatId, scan }, 30000)
      // Chat switches can happen while this request is in flight. Keep old data from
      // flashing back into the panel after the new chat is already active.
      if (requestedChatId && lastSeenChatId && requestedChatId !== String(lastSeenChatId)) return res
      wardrobeLibrary = res.library || []
      // The Characters tab was loaded once, at init. A story that invents
      // somebody mid-chat writes a real, editable character the panel never
      // hears about — so the tab keeps showing the list from when it opened and
      // the new entry looks like it does not exist. It did; it was just never
      // sent. Any wardrobe read now refreshes it.
      if (Array.isArray(res.characters)) { characters = res.characters; renderCharacterList() }
      renderWardrobeRows(res.rows)
      renderWardrobeAdd(res.rows)
      if (quiet) return
      const where = res.chatId
        ? `Read from "${res.preset || 'no preset'}" · chat ${String(res.chatId).slice(-8)}`
        : `Read from "${res.preset || 'no preset'}" · NO CHAT IDENTIFIED — every chat is sharing one wardrobe record`
      const found = res.added && res.added.length ? ` Added from the story: ${res.added.join(', ')}.` : ''
      // The answer to "refresh doesn't change the wardrobe of record": now it can,
      // and when it does it says whose clothes changed.
      const wore = res.dressed && res.dressed.length
        ? ` The story re-dressed ${res.dressed.map((item) => item.name).join(', ')}.` : ''
      setStatus('.ld-wardrobe-status', scan
        ? where + '.' + found + wore
        : `Reloaded this chat's saved wardrobe state.`, res.chatId ? 'good' : 'err')
    } catch (e) {
      setStatus('.ld-wardrobe-status', e.message, 'err')
    }
  }

  function renderWardrobeAdd(rows) {
    const select = $('.ld-wardrobe-add')
    if (!select) return
    const present = new Set((rows || []).map((row) => row.id).filter(Boolean))
    const options = wardrobeLibrary.filter((item) => !present.has(item.id))
    select.innerHTML = '<option value="">— add someone from your library —</option>' + options.map((item) => {
      // Two entries can share a name. Say which one the story invented and show
      // the start of its tags, or the picker is a coin flip.
      const label = String(item.name || '') + (item.story ? '  (story\u2019s version)' : '') +
        (item.tags ? '  \u00b7 ' + item.tags : '')
      const option = document.createElement('option')
      option.value = item.id
      option.textContent = label
      return option.outerHTML
    }).join('')
  }

  if ($('[data-act="wardrobe-add"]')) {
    $('[data-act="wardrobe-add"]').addEventListener('click', async () => {
      const select = $('.ld-wardrobe-add')
      if (!select || !select.value) { setStatus('.ld-wardrobe-status', 'Pick a saved character first.', 'err'); return }
      const label = select.options[select.selectedIndex].textContent
      try {
        const res = await call('wardrobe', { chatId: lastSeenChatId, add: select.value }, 15000)
        wardrobeLibrary = res.library || wardrobeLibrary
        if (Array.isArray(res.characters)) { characters = res.characters; renderCharacterList() }
        renderWardrobeRows(res.rows)
        renderWardrobeAdd(res.rows)
        setStatus('.ld-wardrobe-status', `Added ${label.split('  ')[0]} to this chat's cast.`, 'good')
      } catch (e) { setStatus('.ld-wardrobe-status', e.message, 'err') }
    })
  }

  if ($('[data-act="wardrobe-refresh"]')) {
    $('[data-act="wardrobe-refresh"]').addEventListener('click', () => {
      setStatus('.ld-wardrobe-status', 'Reloading the saved wardrobe…', '')
      loadWardrobe(false, false)
    })
  }
  if ($('[data-act="wardrobe-sync"]')) {
    $('[data-act="wardrobe-sync"]').addEventListener('click', async (event) => {
      const button = event.currentTarget
      const oldText = button.textContent
      button.disabled = true
      button.textContent = 'Syncing…'
      setStatus('.ld-wardrobe-status', 'Parsing the latest story passage for explicit clothing changes. No image will be generated…', '')
      try {
        const res = await call('wardrobe', { chatId: lastSeenChatId, syncLatest: true }, 300000)
        wardrobeLibrary = res.library || wardrobeLibrary
        if (Array.isArray(res.characters)) { characters = res.characters; renderCharacterList() }
        renderWardrobeRows(res.rows)
        renderWardrobeAdd(res.rows)
        loadCasts({ chatId: lastSeenChatId }).catch(() => {})
        const updates = res.synced || []
        const ignored = res.syncRejected || []
        if (updates.length) {
          const names = updates.map((item) => item.name).join(', ')
          const suffix = ignored.length ? ` ${ignored.length} unsupported proposal${ignored.length === 1 ? ' was' : 's were'} ignored.` : ''
          setStatus('.ld-wardrobe-status', `Synced ${names} from the latest passage. No image was generated.${suffix}`, 'good')
        } else {
          const suffix = ignored.length ? ` ${ignored[0]}` : ''
          setStatus('.ld-wardrobe-status', `The latest passage established no usable clothing change, so nothing was changed.${suffix}`, ignored.length ? 'err' : 'good')
        }
      } catch (e) {
        setStatus('.ld-wardrobe-status', e.message, 'err')
      } finally {
        button.disabled = false
        button.textContent = oldText
      }
    })
  }
  // The save button is created by renderWardrobeRows, so the listener is delegated.
  if ($('.ld-wardrobe-rows')) {
    $('.ld-wardrobe-rows').addEventListener('change', async (event) => {
      const swapEl = event.target.closest('.ld-wardrobe-swap')
      if (!swapEl || !swapEl.value) return
      const from = swapEl.getAttribute('data-id')
      const label = swapEl.options[swapEl.selectedIndex].textContent
      try {
        const res = await call('wardrobe', { chatId: lastSeenChatId, replace: { from, to: swapEl.value } }, 15000)
        wardrobeLibrary = res.library || wardrobeLibrary
        if (Array.isArray(res.characters)) { characters = res.characters; renderCharacterList() }
        renderWardrobeRows(res.rows)
        renderWardrobeAdd(res.rows)
        setStatus('.ld-wardrobe-status', `Now using your saved ${label}. The story's version was replaced.`, 'good')
      } catch (e) {
        setStatus('.ld-wardrobe-status', e.message, 'err')
      }
    })
    $('.ld-wardrobe-rows').addEventListener('click', async (event) => {
      const swapEl = event.target.closest('.ld-wardrobe-swap')
      if (swapEl) return
      // Take me to the thing that owns these tags.
      const open = event.target.closest('.ld-wardrobe-open')
      if (open) {
        event.preventDefault()
        setMainView('presets')
        openPersonaEditor(open.getAttribute('data-id'), 'character')
        return
      }
      const drop = event.target.closest('[data-act="wardrobe-drop"]')
      if (drop) {
        const name = drop.getAttribute('data-name') || 'this character'
        const declared = !!drop.getAttribute('data-declared')
        const question = declared
          ? `Delete ${name}? The story invented this one, so nothing you wrote is lost.`
          : `Remove ${name} from this chat's cast? The character itself is kept in the Characters tab.`
        if (!window.confirm(question)) return
        try {
          const res = await call('wardrobe', { chatId: lastSeenChatId, remove: [drop.getAttribute('data-id')] }, 15000)
          renderWardrobeRows(res.rows)
          setStatus('.ld-wardrobe-status', `${name} removed.`, 'good')
        } catch (e) {
          setStatus('.ld-wardrobe-status', e.message, 'err')
        }
        return
      }
      const save = event.target.closest('[data-act="wardrobe-save-one"]')
      const clear = event.target.closest('[data-act="wardrobe-clear-one"]')
      if (!save && !clear) return
      const button = save || clear
      const ref = button.getAttribute('data-ref')
      const name = button.getAttribute('data-name') || ref || 'Character'
      const row = button.closest('.ld-wardrobe-row')
      const input = row && row.querySelector('.ld-wardrobe-input')
      if (!ref || !input) return
      const set = { [ref]: clear ? '' : input.value }
      try {
        const res = await call('wardrobe', { set, chatId: lastSeenChatId }, 15000)
        renderWardrobeRows(res.rows)
        const returned = (res.rows || []).find((item) => String(item.ref || '') === String(ref)) || {}
        setStatus('.ld-wardrobe-status', clear
          ? (returned.fallback
            ? `${name}'s current outfit was cleared. The saved character default is now the fallback.`
            : `${name}'s current outfit was cleared. No clothing is recorded until the story or you establishes it.`)
          : `Saved only ${name}'s current outfit. Other characters were untouched.`, 'good')
      } catch (e) {
        setStatus('.ld-wardrobe-status', e.message, 'err')
      }
    })
  }

  function refreshModelOverrideNote() {
    const note = $('.ld-model-override-note')
    const input = $('.ld-parser-model')
    const sel = $('.ld-parser-conn')
    if (!note || !input) return
    const typed = input.value.trim()
    const connModel = sel && sel.selectedOptions && sel.selectedOptions[0]
      ? (sel.selectedOptions[0].dataset.model || '') : ''
    const clearBtn = $('.ld-clear-override')
    if (clearBtn) clearBtn.style.display = typed ? '' : 'none'
    if (typed && connModel && typed !== connModel) {
      note.textContent = `Override in effect — requests go to "${typed}", not the connection's "${connModel}". Switching connections will not change the model until you clear this.`
      note.style.color = 'var(--ld-warn, #e0a458)'
    } else if (typed && connModel) {
      note.textContent = `This is already the connection's model — clearing it changes nothing except that switching connections will work again.`
      note.style.color = 'var(--ld-warn, #e0a458)'
    } else if (typed) {
      note.textContent = `Override in effect — requests go to "${typed}".`
      note.style.color = 'var(--ld-warn, #e0a458)'
    } else {
      note.textContent = connModel ? `Using ${connModel} from the connection.` : ''
      note.style.color = ''
    }
  }
  const clearOverride = $('[data-act="clear-model-override"]')
  if (clearOverride) {
    clearOverride.addEventListener('click', () => {
      const input = $('.ld-parser-model')
      if (!input) return
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      refreshModelOverrideNote()
      setStatus('.ld-settings-status', "Cleared — the connection's own model will be used.", 'good')
    })
  }
  if ($('.ld-parser-model')) $('.ld-parser-model').addEventListener('input', refreshModelOverrideNote)
  if ($('.ld-parser-conn')) $('.ld-parser-conn').addEventListener('change', refreshModelOverrideNote)

  const clearRejected = $('[data-act="clear-rejected-keys"]')
  if (clearRejected) {
    clearRejected.addEventListener('click', async () => {
      await refreshRejectedKeys(true)
      setStatus('.ld-settings-status', 'Cleared. Draw Things will be offered every setting again on the next generation.', 'good')
    })
  }

  // Lumiverse listens for arrow keys on the document to swipe messages. Even
  // with the handler above, the event keeps travelling — so typing in the fix
  // panel is contained at its own boundary.
  const regenBox = $('.ld-lightbox-regen')
  if (regenBox) {
    regenBox.addEventListener('keydown', (event) => {
      if (isTextEntry(event.target) && event.key !== 'Escape') event.stopPropagation()
    }, true)
  }

  // One parse, every image in the message rebuilt. The motivating case is a
  // character's tags changing after the images were already written into the
  // story — the scenes are fine, the compile is what is stale.
  const rebuildButton = $('.ld-lightbox-rebuild')
  if (rebuildButton) {
    rebuildButton.addEventListener('click', async () => {
      const item = lightboxItems[lightboxIndex]
      if (!item) return
      const org = item.entry.origin || {}
      const total = Number(org.sceneCount || 0)
      if (total > 1 && !window.confirm(
        `Rebuild all ${total} images from this message?\n\nThe parser runs once, then each image is regenerated and replaced in place. ` +
        `The old images stay in History. This takes about ${total} generations.`)) return

      rebuildButton.disabled = true
      const label = rebuildButton.textContent
      setStatus('.ld-lightbox-regen-status', 'Re-parsing once, then rebuilding every image in this message…')
      try {
        const res = await call('regenerate_message_images', {
          imageUrl: item.image.url,
          parserModel: $('.ld-parser-model') ? $('.ld-parser-model').value.trim() : undefined,
          parserConnection: $('.ld-parser-conn') ? $('.ld-parser-conn').value : undefined,
          mode: selectedStoryMode(),
        }, 1800000)
        history = Array.isArray(res.history) ? res.history : history
        renderHistory()
        lightboxItems = flattenHistoryImages()
        const first = (res.replaced || []).find((entry) => entry.ok && entry.newUrl)
        if (first) {
          const at = lightboxItems.findIndex(({ image }) => image.url === first.newUrl)
          if (at >= 0) lightboxIndex = at
        }
        renderLightbox()
        const failed = (res.replaced || []).filter((entry) => !entry.ok).length
        setStatus('.ld-lightbox-regen-status', res.note || 'Done.', failed ? 'err' : 'good')
        setStatus('.ld-gen-status', res.note || 'Rebuilt the message images.', failed ? 'err' : 'good')
      } catch (error) {
        setStatus('.ld-lightbox-regen-status', error.message, 'err')
      } finally {
        rebuildButton.disabled = false
        rebuildButton.textContent = label
      }
    })
  }

  $('.ld-lightbox-regen-cancel').addEventListener('click', closeRegenPanel)
  $('.ld-lightbox-regen-run').addEventListener('click', async () => {
    const item = lightboxItems[lightboxIndex]
    if (!item) return
    const button = $('.ld-lightbox-regen-run')
    const oldUrl = item.image.url
    const prompt = $('.ld-lightbox-regen-prompt').value.trim()
    if (!prompt) { setStatus('.ld-lightbox-regen-status', 'The prompt cannot be empty.', 'err'); return }
    button.disabled = true
    const originalLabel = button.textContent
    button.textContent = 'Generating…'
    setStatus('.ld-lightbox-regen-status', 'Generating a replacement — this takes as long as a normal story image.')
    try {
      const res = await call('regenerate_image', {
        imageUrl: oldUrl,
        chatImageUrl: clickedChatImageUrl,
        placementId: clickedChatPlacementId,
        prompt,
        negativePrompt: $('.ld-lightbox-regen-negative').value,
        reuseSeed: $('.ld-lightbox-regen-seed').checked && !$('.ld-lightbox-regen-seed').disabled,
      }, 600000)
      history = Array.isArray(res.history) ? res.history : history
      renderHistory()
      // Re-point the viewer at the new image so you can immediately judge it
      // and, if it is still wrong, fix it again.
      lightboxItems = flattenHistoryImages()
      const next = lightboxItems.findIndex(({ image }) => image.url === res.newUrl)
      if (next >= 0) lightboxIndex = next
      renderLightbox()
      if (res.replaced) {
        setStatus('.ld-lightbox-regen-status', '✓ Done — this image has replaced the old one in the story message, in its original position. Nothing else to press: close with Done. (Do NOT press "Add copy to chat" — that would add a second copy.)', 'good')
      } else {
        setStatus('.ld-lightbox-regen-status', res.note || 'Regenerated.', 'err')
      }
      setStatus('.ld-gen-status', res.replaced ? 'Replaced an image in the story message.' : (res.note || 'Regenerated.'), res.replaced ? 'good' : 'err')
    } catch (error) {
      setStatus('.ld-lightbox-regen-status', error.message, 'err')
    } finally {
      button.disabled = false
      button.textContent = originalLabel || 'Regenerate & replace'
    }
  })
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox()
  })

  // Clicking a LumiDraw-generated image anywhere in the chat transcript opens
  // it in the viewer, ready to fix. Deliberately conservative: the click is
  // only intercepted when the image URL is one LumiDraw actually produced, so
  // avatars, host UI, and anything inside our own panel behave normally.
  function onDocumentImageClick(event) {
    const target = event.target
    if (!target || target.tagName !== 'IMG') return
    if (panel.contains(target) || lightbox.contains(target)) return
    const found = findHistoryImageForChatImage(target)
    if (!found) return
    event.preventDefault()
    event.stopPropagation()
    // Remember the URL the chat is actually displaying. It is the only exact
    // handle on WHICH image was clicked when a message holds several, and it
    // is what the backend will swap — preserving the image's position in the
    // story rather than guessing at a similar-looking one.
    const clickedSrc = target.getAttribute('data-lumidraw-original-url') ||
      (target.dataset && target.dataset.lumidrawOriginalUrl) || target.getAttribute('src') || target.src || ''
    const placementHost = target.closest('[data-lumidraw-placement-id]')
    const placementId = target.getAttribute('data-lumidraw-placement-id') ||
      (placementHost && placementHost.getAttribute('data-lumidraw-placement-id')) || ''
    if (openLightbox(found.image.url)) {
      clickedChatImageUrl = clickedSrc
      clickedChatPlacementId = placementId
      openRegenPanel()
    }
  }
  document.addEventListener('click', onDocumentImageClick, true)

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
  const textEditorViewport = window.visualViewport
  if (textEditorViewport) {
    textEditorViewport.addEventListener('resize', syncTextEditorViewport)
    textEditorViewport.addEventListener('scroll', syncTextEditorViewport)
  }
  window.addEventListener('resize', syncTextEditorViewport)
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

  async function loadCatalog(refresh = false) {
    setStatus('.ld-catalog-status', refresh ? 'Rescanning Bridge catalog…' : 'Loading catalog…')
    try {
      const res = await call('list_models', { refresh }, refresh ? 40000 : 20000)
      catalog = {
        models: res.models || [],
        samplers: res.samplers || [],
        loras: res.loras || [],
        source: res.source || 'memory',
        bridge: res.bridge || null,
        currentRecipe: res.currentRecipe || null,
      }
      const editorModelValue = $('.ld-ed-model') ? $('.ld-ed-model').value : ''
      populateDatalist('ld-model-catalog-ed', catalog.models.map((model) => model.file))
      if ($('.ld-ed-model') && editorModelValue) $('.ld-ed-model').value = editorModelValue
      const draftModelValue = (draftConfig && draftConfig.model) || ($('.ld-draft-model') && $('.ld-draft-model').value) || ''
      populateDatalist('ld-model-catalog', catalog.models.map((model) => model.file))
      if ($('.ld-draft-model') && draftModelValue) $('.ld-draft-model').value = draftModelValue
      const editorSamplerValue = $('.ld-ed-sampler') ? $('.ld-ed-sampler').value : ''
      populateSelect($('.ld-ed-sampler'), catalog.samplers, editorSamplerValue, '— choose sampler —')
      if (draftConfig) renderDraftControls()
      else populateSelect($('.ld-draft-sampler'), catalog.samplers, '', '— choose sampler —')
      renderCatalogStatus()
      return res
    } catch (e) {
      catalog.bridge = { connected: false, error: e.message }
      renderCatalogStatus()
      console.log('[LumiDraw] catalog load failed:', e.message)
      throw e
    }
  }

  function loraRow(file, weight) {
    const row = document.createElement('div')
    row.className = 'ld-row'
    const fi = document.createElement('select')
    fi.className = 'ld-lora-file'
    populateSelect(fi, catalog.loras, file || '', '— choose LoRA —')
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
    $('.ld-ed-model').value = c.model || ''
    populateSelect($('.ld-ed-sampler'), catalog.samplers, c.sampler || '', '— choose sampler —')
    $('.ld-ed-steps').value = c.steps !== undefined ? c.steps : ''
    $('.ld-ed-cfg').value = c.guidance_scale !== undefined ? c.guidance_scale : ''
    $('.ld-ed-w').value = c.width || ''
    $('.ld-ed-h').value = c.height || ''
    const lbox = $('.ld-ed-loras')
    lbox.innerHTML = ''
    for (const l of c.loras || []) lbox.appendChild(loraRow(l.file || l.name || '', l.weight))
    if (!(c.loras || []).length) lbox.appendChild(loraRow('', 1))
    $('.ld-ed-quality').value = p ? (p.qualityTags || '') : (seed ? (seed.qualityTags || '') : '')
    const localCharacter = profileFromPreset(p || seed || {}, 'character')
    const characterLibraryId = (p && p.characterLibraryId) || (seed && seed.characterLibraryId) || ''
    renderCharacterLinkSelect(characterLibraryId)
    writeEditorProfile('character', localCharacter)
    applyCharacterLink(characterLibraryId, localCharacter)
    const localPersona = profileFromPreset(p || seed || {}, 'persona')
    const personaLibraryId = (p && p.personaLibraryId) || (seed && seed.personaLibraryId) || ''
    renderPersonaLinkSelect(personaLibraryId)
    writeEditorProfile('persona', localPersona)
    applyPersonaLink(personaLibraryId, localPersona)
    editorCastIds = Array.isArray(p && p.castLibraryIds) ? [...p.castLibraryIds]
      : (Array.isArray(seed && seed.castLibraryIds) ? [...seed.castLibraryIds] : [])
    renderCastEditor()
    $('.ld-ed-banned').value = p ? (p.bannedTags || '') : (seed ? (seed.bannedTags || '') : '')
    $('.ld-ed-scene-anchor').value = p ? (p.sceneAnchor || '') : (seed ? (seed.sceneAnchor || '') : '')
    if ($('.ld-ed-break')) {
      const source = p || seed || {}
      $('.ld-ed-break').checked = source.useBreakSeparators === true ||
        (source.useBreakSeparators === undefined && /\bBREAK\b/.test(String(source.qualityTags || '')))
    }
    $('.ld-ed-prefix').value = p ? (p.promptPrefix || '') : (seed ? (seed.promptPrefix || '') : '')
    $('.ld-ed-negative').value = p ? (p.negativePrompt || '') : (seed ? (seed.negativePrompt || '') : '')
    setStatus('.ld-ed-status', p ? '' : (seed ? 'Starting from the current workspace.' : (syncedConfig ? 'Starting from the last synced recipe.' : 'No synced recipe yet — Sync in Studio first for model/sampler defaults.')))
    if (box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  for (const refreshButton of dom.queryAll('[data-act="refresh-catalog"]')) {
    refreshButton.addEventListener('click', async () => {
      try {
        await loadCatalog(true)
        setStatus('.ld-gen-status', 'Bridge catalog refreshed.', 'good')
      } catch (error) {
        setStatus('.ld-gen-status', error.message, 'err')
      }
    })
  }

  const refreshHistoryButton = $('[data-act="refresh-history"]')
  if (refreshHistoryButton) {
    refreshHistoryButton.addEventListener('click', async () => {
      const originalText = refreshHistoryButton.textContent
      refreshHistoryButton.classList.add('ld-pressed')
      refreshHistoryButton.disabled = true
      refreshHistoryButton.textContent = 'Refreshing…'
      setStatus('.ld-gen-status', 'Reloading image history…')
      try {
        const res = await call('get_history', {}, 20000)
        history = Array.isArray(res.history) ? res.history : []
        renderHistory()
        currentOutputItem()
        setStatus('.ld-gen-status', `History refreshed · ${flattenHistoryImages().length} image(s).`, 'good')
      } catch (error) {
        setStatus('.ld-gen-status', error.message, 'err')
      } finally {
        refreshHistoryButton.disabled = false
        refreshHistoryButton.textContent = originalText || 'Refresh ⟳'
        setTimeout(() => refreshHistoryButton.classList.remove('ld-pressed'), 120)
      }
    })
  }
  const loraSearch = $('.ld-lora-search')
  if (loraSearch) loraSearch.addEventListener('input', renderLoraLibrary)

  $('[data-act="save-places"]').addEventListener('click', async () => {
    try {
      const result = await call('save_places', { places: placesFromText($('.ld-places').value) })
      places = result.places || []
      renderPlaces()
      setStatus('.ld-places-status',
        places.length ? `Saved ${places.length} place${places.length === 1 ? '' : 's'}.` : 'No places saved.', 'good')
    } catch (error) {
      // Re-rendering here would discard what they typed, which is the last thing
      // anyone wants after a validation error.
      setStatus('.ld-places-status', error.message, 'err')
    }
  })

  $('[data-act="safe-report"]').addEventListener('click', async () => {
    try {
      const res = await call('diagnostic_report', {})
      const field = $('.ld-safe-report')
      field.style.display = 'block'
      field.value = res.report || res.note || 'Nothing to report yet.'
      field.select()
      try { document.execCommand('copy') } catch { /* selection is enough */ }
      setStatus('.ld-settings-status', res.report
        ? 'Copied. It contains no story text — counts, tag families, rule outcomes and the negative prompt only.'
        : (res.note || ''), res.report ? 'good' : 'err')
    } catch (error) {
      setStatus('.ld-settings-status', error.message, 'err')
    }
  })

  $('[data-act="new-persona"]').addEventListener('click', () => openPersonaEditor(null, 'persona'))
  $('[data-act="new-character"]').addEventListener('click', () => openPersonaEditor(null, 'character'))
  $('[data-act="persona-cancel"]').addEventListener('click', () => {
    $('.ld-persona-editor').style.display = 'none'
    personaEditorId = null
  })
  $('[data-act="persona-save"]').addEventListener('click', async () => {
    try {
      const name = $('.ld-persona-ed-name').value.trim()
      const kind = libEditorKind === 'character' ? 'character' : 'persona'
      if (!name) throw new Error(`${kind === 'character' ? 'Character' : 'Persona'} needs a library name.`)
      const result = await call(kind === 'character' ? 'save_character' : 'save_persona', {
        id: personaEditorId || '',
        name,
        profile: libraryPersonaProfile(),
      })
      personaEditorId = result.entry && result.entry.id ? result.entry.id : personaEditorId
      if (kind === 'character') {
        characters = result.characters || []
        renderCharacterList()
        const selected = $('.ld-ed-char-link') ? $('.ld-ed-char-link').value : ''
        if (selected && selected === personaEditorId) applyCharacterLink(selected)
        setStatus('.ld-persona-ed-status', `Saved reusable character “${name}”.`, 'good')
        setStatus('.ld-charlib-status', `Character library updated · ${characters.length} saved.`, 'good')
      } else {
        personas = result.personas || []
        renderPersonaList()
        const selected = $('.ld-ed-persona-link') ? $('.ld-ed-persona-link').value : ''
        if (selected && selected === personaEditorId) applyPersonaLink(selected)
        setStatus('.ld-persona-ed-status', `Saved reusable persona “${name}”.`, 'good')
        setStatus('.ld-persona-status', `Persona library updated · ${personas.length} saved.`, 'good')
      }
    } catch (error) { setStatus('.ld-persona-ed-status', error.message, 'err') }
  })
  $('.ld-ed-char-link').addEventListener('change', (event) => {
    const id = event.target.value || ''
    applyCharacterLink(id)
    renderCastEditor()
    setStatus('.ld-ed-status', id
      ? 'This preset now links to the selected reusable character. Edit it in the Character Library.'
      : 'This preset now uses its local character fields.')
  })
  $('[data-act="ed-cast-add"]').addEventListener('click', () => {
    const select = $('.ld-ed-cast-select')
    const id = select ? select.value : ''
    if (!id) { setStatus('.ld-ed-status', 'Choose a saved character to add to the cast.', 'err'); return }
    if (editorCastIds.length >= 4) { setStatus('.ld-ed-status', 'A preset cast holds at most 4 additional characters.', 'err'); return }
    if (!editorCastIds.includes(id)) editorCastIds.push(id)
    renderCastEditor()
  })
  $('.ld-ed-persona-link').addEventListener('change', (event) => {
    const id = event.target.value || ''
    applyPersonaLink(id)
    setStatus('.ld-ed-status', id
      ? 'This preset now links to the selected reusable persona. Edit it in the Persona Library.'
      : 'This preset now uses its local persona fields.')
  })

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
    if (!bundle.config) {
      setStatus('.ld-draft-status', 'No workspace settings to save yet — press Sync first.', 'err')
      return
    }
    openEditor(null, bundle)
  })

  $('[data-act="draft-save-active"]').addEventListener('click', async () => {
    try {
      if (!activePreset) throw new Error('No active preset selected. Choose one or use Save as new preset.')
      const bundle = currentDraftBundle()
      const existing = presets.find((item) => item.name === activePreset) || {}
      const result = await call('save_preset', {
        name: activePreset,
        config: bundle.config,
        extra: existing.extra || null,
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
    if (control) {
      control.addEventListener('input', onDraftControlChange)
      if (control.tagName === 'SELECT') control.addEventListener('change', onDraftControlChange)
    }
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

  $('[data-act="scan"]').addEventListener('click', () => runStoryScan(null, 'the latest story message', false))
  $('[data-act="cancel-scan"]').addEventListener('click', async () => {
    const btn = $('[data-act="cancel-scan"]')
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…' }
    try {
      const res = await call('cancel_story_scan', {}, 15000)
      liveScanStatus = {
        ...(liveScanStatus || {}),
        stage: res.cancelled ? 'cancelling' : 'cancelled',
        note: res.note || (res.cancelled ? 'Cancellation requested.' : 'No scan was running.'),
        cancellable: false,
      }
      renderLiveScanStatus()
    } catch (e) {
      liveScanStatus = { ...(liveScanStatus || {}), stage: 'error', note: e.message, cancellable: false }
      renderLiveScanStatus()
    }
  })
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
  // Arrow keys mean "move the cursor" inside a text field and nothing else.
  // Treating them as image navigation there made the prompt box unusable — and
  // the keystroke also reached Lumiverse underneath, swiping the message.
  const isTextEntry = (node) => {
    if (!node) return false
    if (node.isContentEditable) return true
    const tag = String(node.tagName || '').toUpperCase()
    return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT'
  }

  const onStoryPickerKeyDown = (event) => {
    const typing = isTextEntry(event.target)
    if (lightbox.classList.contains('ld-open')) {
      // Escape still closes from anywhere; a text field swallows the rest.
      if (event.key === 'Escape') {
        if (typing) { event.target.blur(); event.stopPropagation(); return }
        closeLightbox()
      } else if (typing) {
        // Stop it here so the host does not treat the keystroke as a swipe.
        event.stopPropagation()
        return
      } else if (event.key === 'ArrowLeft') moveLightbox(-1)
      else if (event.key === 'ArrowRight') moveLightbox(1)
      else return
      event.preventDefault()
      return
    }
    if (typing) return
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
    const engine = $('.ld-parser-engine') ? $('.ld-parser-engine').value : 'legacy'
    $('.ld-parser-instr').value = parserDefaultFor(engine)
    pushSettings('Parser instruction reset for the selected engine.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
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
    const storyMode = selectedStoryMode()
    const storyAutoScan = selectedStoryAutoScan()
    syncLegacyAutoScanField()
    const res = await call('save_settings', {
      host: $('.ld-host').value,
      port: $('.ld-port').value,
      bridgeHost: $('.ld-bridge-host').value,
      bridgePort: $('.ld-bridge-port').value,
      cloudEnabled: $('.ld-cloud-enabled').checked,
      cloudHost: $('.ld-cloud-host').value,
      cloudPort: $('.ld-cloud-port').value,
      cloudModel: $('.ld-cloud-model').value,
      cloudFallback: $('.ld-cloud-fallback').checked,
      mode: storyMode,
      autoScan: storyAutoScan,
      parserEngine: $('.ld-parser-engine').value,
      parserConnection: $('.ld-parser-conn').value,
      parserModel: $('.ld-parser-model').value,
      parserTemperature: $('.ld-parser-temperature') ? Number($('.ld-parser-temperature').value) : 0.2,
      parserRequestOverrides: $('.ld-parser-overrides') ? $('.ld-parser-overrides').value : '',
      parserMaxTokens: $('.ld-parser-maxtokens') ? Number($('.ld-parser-maxtokens').value) || 12000 : 12000,
      parserInstruction: $('.ld-parser-instr').value,
      protocol: $('.ld-protocol').value,
      maxImages: $('.ld-maximg').value,
      minImages: $('.ld-minimg').value,
      maxSubjects: $('.ld-maxsubjects') ? $('.ld-maxsubjects').value : 2,
      autoCharTags: $('.ld-chartags').checked,
      directMode: storyMode === 'direct',
      chatLeads: $('.ld-chat-leads') ? $('.ld-chat-leads').checked : true,
      stripImageDirectives: $('.ld-strip-directives').checked,
      sizeChatImages: $('.ld-size-images') ? $('.ld-size-images').checked : false,
      chatImageWidth: $('.ld-image-width') ? Number($('.ld-image-width').value) || 500 : 500,
      optimizedPreviews: $('.ld-optimized-previews') ? $('.ld-optimized-previews').checked : true,
      deleteImagesWithChats: $('.ld-delete-chat-images') ? $('.ld-delete-chat-images').checked : true,
      parserContextMessages: $('.ld-parser-context').value,
      useLoomLedger: $('.ld-use-loom-ledger').checked,
      storyQualityTags: $('.ld-story-quality') ? $('.ld-story-quality').value : '',
      storyPromptPrefix: $('.ld-story-prefix') ? $('.ld-story-prefix').value : '',
      storyNegativePrompt: $('.ld-story-negative') ? $('.ld-story-negative').value : '',
      storyBannedTags: $('.ld-story-banned') ? $('.ld-story-banned').value : '',
      storySceneAnchor: $('.ld-story-scene-anchor') ? $('.ld-story-scene-anchor').value : '',
      storyUseBreakSeparators: $('.ld-story-break') ? $('.ld-story-break').checked : false,
    })
    settings = res.settings
    updateScanLabel()
    if (statusMsg) setStatus('.ld-settings-status', statusMsg, 'good')
    return res
  }

  function parserDefaultFor(engine) {
    return engine === 'anima'
      ? (defaults.animaParserInstruction || '')
      : (defaults.legacyParserInstruction || defaults.parserInstruction || '')
  }

  function updateParserEngineUI() {
    const mode = selectedStoryMode()
    const direct = mode === 'direct'
    const engine = $('.ld-parser-engine') ? $('.ld-parser-engine').value : (settings.parserEngine || 'legacy')
    const note = $('.ld-parser-engine-note')
    const label = $('.ld-parser-instruction-label')
    const title = $('.ld-parser-debug-title')
    const engineField = $('.ld-parser-engine-field')
    const instruction = $('.ld-parser-instr')
    const resetInstruction = $('[data-act="reset-parser"]')
    if (engineField) engineField.style.display = direct ? 'none' : ''
    if (note) note.textContent = direct
      ? 'Direct mode has its own built-in parser rules: the parser receives character sheets, wardrobe, place/context and writes the finished image prompt. LumiDraw does not run the scene compiler afterward.'
      : engine === 'anima'
        ? 'Structured JSON uses the current message plus optional reference context and Loom continuity, then LumiDraw compiles the final prompt.'
        : 'Known-good fallback: instruction-only parsing. The returned tag prompt goes directly to Draw Things without identity JSON or the Anima compiler.'
    if (label) {
      label.textContent = engine === 'anima' ? 'Anima hybrid scene-extraction guidance' : 'Legacy parser instruction'
      label.style.display = direct ? 'none' : ''
    }
    if (instruction) instruction.style.display = direct ? 'none' : ''
    if (resetInstruction) resetInstruction.style.display = direct ? 'none' : ''
    if (title) title.textContent = direct
      ? 'Last Direct prompt'
      : engine === 'anima' ? 'Last Anima hybrid compile' : 'Last legacy parser result'
    const contextControls = $('.ld-anima-context-controls')
    if (contextControls) contextControls.style.display = (direct || engine === 'anima') ? '' : 'none'
  }

  function updateScanLabel() {
    const btn = $('[data-act="scan"]')
    const oldBtn = $('[data-act="scan-old"]')
    const mode = selectedStoryMode()
    const parserDriven = mode === 'parser' || mode === 'direct'
    const engine = $('.ld-parser-engine') ? $('.ld-parser-engine').value : 'legacy'
    if (btn) {
      btn.textContent = mode === 'off'
        ? 'Scan latest 📖 (Off)'
        : mode === 'direct'
          ? 'Scan latest 📖 (Direct)'
          : mode === 'parser'
            ? `Scan latest 📖 (${engine === 'anima' ? 'Anima hybrid' : 'Legacy'})`
            : `Scan latest 📖 (${mode})`
      btn.disabled = !parserDriven
      btn.title = parserDriven
        ? `Run ${mode === 'direct' ? 'Direct' : 'Parser'} manually on the latest assistant message`
        : 'Manual scanning is available with a Parser or Direct manual/automatic behavior'
    }
    if (oldBtn) {
      oldBtn.disabled = !parserDriven
      oldBtn.title = parserDriven
        ? `Choose any assistant message in the current chat and run ${mode === 'direct' ? 'Direct mode' : 'the selected Parser engine'} on it`
        : 'Old-message rescanning is available in Parser or Direct mode'
    }
    const bindingControls = $('.ld-parser-binding-controls')
    if (bindingControls) bindingControls.style.display = parserDriven ? '' : 'none'
    updateParserEngineUI()
  }


  async function reloadParserSources(preferSelected = true) {
    const sel = $('.ld-parser-conn')
    const modelInput = $('.ld-parser-model')
    const previousId = preferSelected ? (sel ? sel.value : '') : ''
    const previousModelValue = modelInput ? modelInput.value : ''
    const previousOptionModel = sel && sel.selectedOptions && sel.selectedOptions[0] ? (sel.selectedOptions[0].dataset.model || '') : ''
    const cres = await call('list_connections', {}, 10000)
    const connections = Array.isArray(cres.connections) ? cres.connections : []
    if (sel) {
      sel.innerHTML = '<option value="">— default connection —</option>' +
        connections.map((c) => {
          const o = document.createElement('option')
          o.value = c.id
          o.textContent = c.name + (c.model ? ' — ' + c.model : '')
          o.dataset.model = c.model || ''
          return o.outerHTML
        }).join('')
      if (previousId && connections.some((c) => String(c.id) === String(previousId))) sel.value = previousId
      else sel.value = settings.parserConnection || ''
    }
    const currentModel = sel && sel.selectedOptions && sel.selectedOptions[0] ? (sel.selectedOptions[0].dataset.model || '') : ''
    // The override field is never filled in automatically. Writing the connection's
    // own model in here used to turn a connection choice into a sticky override that
    // outlived the connection it came from — switching connections then changed
    // nothing. The connection's model is shown as a placeholder instead.
    if (modelInput) {
      modelInput.placeholder = currentModel
        ? 'leave empty to use ' + currentModel
        : 'leave empty to use the connection\'s own model'
      clearAutoFilledModelOverride(connections)
    }
    return connections
  }

  // One-time repair for setups polluted by the old auto-fill: an override that is
  // exactly some connection's own model was written by the picker, not typed. It is
  // either a no-op or actively wrong, so drop it and say so.
  function clearAutoFilledModelOverride(connections) {
    const stored = String(settings.parserModel || '').trim()
    if (!stored) return false
    if (!Array.isArray(connections) || !connections.some((c) => String(c.model || '').trim() === stored)) return false
    settings.parserModel = ''
    const input = $('.ld-parser-model')
    if (input) input.value = ''
    console.log('[LumiDraw] cleared the model override "' + stored + '" — it was written by the connection picker, not typed. Requests now follow the selected connection.')
    try { call('save_settings', { parserModel: '' }, 10000) } catch (e) {}
    return true
  }

  // All settings text fields auto-save as you type (debounced).
  let settingsSaveTimer = null
  function scheduleSettingsSave() {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = setTimeout(() => {
      pushSettings('Settings saved.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
    }, 900)
  }
  for (const sel of ['.ld-parser-instr', '.ld-protocol', '.ld-parser-model', '.ld-parser-temperature', '.ld-parser-overrides', '.ld-parser-maxtokens', '.ld-story-quality', '.ld-story-prefix', '.ld-story-negative', '.ld-story-banned', '.ld-story-scene-anchor', '.ld-host', '.ld-port', '.ld-bridge-host', '.ld-bridge-port', '.ld-cloud-host', '.ld-cloud-port', '.ld-cloud-model']) {
    const el = $(sel)
    if (el) el.addEventListener('input', () => {
      clearTimeout(settingsSaveTimer)
      settingsSaveTimer = setTimeout(() => {
        pushSettings('Settings saved.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
      }, 900)
    })
  }

  // Story controls save themselves immediately — no Save press needed.
  for (const sel of ['.ld-mode', '.ld-maximg', '.ld-minimg', '.ld-maxsubjects', '.ld-chartags', '.ld-strip-directives', '.ld-parser-engine', '.ld-parser-conn', '.ld-parser-context', '.ld-use-loom-ledger', '.ld-chat-leads', '.ld-story-break']) {
    const el = $(sel)
    if (el) el.addEventListener('change', () => {
      if (sel === '.ld-mode') {
        syncLegacyAutoScanField()
        updateScanLabel()
        renderLiveScanStatus()
      }
      if (sel === '.ld-parser-conn') {
        const conn = $('.ld-parser-conn')
        const modelInput = $('.ld-parser-model')
        const selectedModel = conn && conn.selectedOptions && conn.selectedOptions[0] ? (conn.selectedOptions[0].dataset.model || '') : ''
        // Choosing a connection must not write an override. It used to, which meant
        // the first connection you picked kept running after you switched away from it.
        if (modelInput) {
          modelInput.placeholder = selectedModel
            ? 'leave empty to use ' + selectedModel
            : 'leave empty to use the connection\'s own model'
        }
        refreshModelOverrideNote()
      }
      if (sel === '.ld-parser-engine') {
        const previousEngine = settings.parserEngine || 'legacy'
        const currentText = $('.ld-parser-instr').value.trim()
        const previousDefault = parserDefaultFor(previousEngine).trim()
        const nextEngine = $('.ld-parser-engine').value
        if (!currentText || currentText === previousDefault) $('.ld-parser-instr').value = parserDefaultFor(nextEngine)
        updateParserEngineUI()
        updateScanLabel()
      }
      pushSettings('Story settings saved.').catch((e) => setStatus('.ld-settings-status', e.message, 'err'))
    })
  }

  $('[data-act="test-bridge"]').addEventListener('click', async () => {
    setStatus('.ld-bridge-status', 'Connecting to LumiDraw Bridge…')
    try {
      await pushSettings()
      const result = await call('test_bridge', {}, 12000)
      await loadCatalog(true)
      const count = result.health && result.health.counts
      setStatus('.ld-bridge-status', `Bridge ${result.health.version || ''} connected${count ? ` · ${count.models || 0} raw model files · ${count.loras || 0} LoRAs` : ''}.`, 'good')
    } catch (error) {
      setStatus('.ld-bridge-status', error.message, 'err')
    }
  })

  $('[data-act="test-cloud"]').addEventListener('click', async () => {
    setStatus('.ld-cloud-status', 'Checking the cloud relay…')
    try {
      await pushSettings()
      const { cloud } = await call('cloud_status', {}, 15000)
      if (!cloud.reachable) {
        setStatus('.ld-cloud-status',
          `No relay on ${$('.ld-cloud-host').value}:${$('.ld-cloud-port').value}. ` +
          'Start it with: node lumidraw-cloud-relay.mjs', 'err')
        return
      }
      if (!cloud.cli) {
        setStatus('.ld-cloud-status',
          'Relay is up, but media-generation-kit-cli was not found on its PATH. ' +
          'Build it, or set LUMIDRAW_CLOUD_CLI to its path.', 'err')
        return
      }
      if (!cloud.authenticated) {
        setStatus('.ld-cloud-status',
          'Relay and CLI are up, but the API key was not accepted. ' +
          'Check DRAWTHINGS_API_KEY, or run `media-generation-kit-cli auth login`.', 'err')
        return
      }
      setStatus('.ld-cloud-status', 'Relay connected and authenticated. Cloud generation is ready.', 'good')
    } catch (error) {
      setStatus('.ld-cloud-status', error.message, 'err')
    }
  })

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

  // Native message-tag interception. Lumiverse requires the exact
  // registerTagInterceptor(options, handler) signature.
  let inlineInterceptorReady = false
  let parserInterceptorReady = false
  ;(() => {
    const m = ctx.messages

    if (!m || typeof m.registerTagInterceptor !== 'function') {
      console.log('[LumiDraw] messages.registerTagInterceptor unavailable')
      ctx.sendToBackend({
        type: 'frontend_status', requestId: makeId(),
        version: EXTENSION_VERSION, historyRefresh: !!refreshHistoryButton,
        inlineInterceptor: false, parserInterceptor: false,
        generationEndedListener: false, renderedEventListener: false,
        note: 'messages.registerTagInterceptor unavailable',
      })
      return
    }

    const onInlineTag = (payload) => {
      try {
        // Inline pregeneration is useful during streaming, once the complete
        // closing tag has been recognized by Lumiverse.
        let body = String(payload && payload.content || '').trim()
        const attrs = payload && payload.attrs || {}
        let aspect = String(attrs.aspect || '')
        if (!body && payload && payload.fullMatch) {
          const mm = /<dt-image([^>]*)>([\s\S]*?)<\/dt-image>/.exec(payload.fullMatch)
          if (mm) {
            body = String(mm[2] || '').trim()
            aspect = aspect || ((/aspect\s*=\s*"([^"]+)"/.exec(mm[1] || '') || [])[1] || '')
          }
        }
        if (!body) return
        ctx.sendToBackend({ type: 'pregenerate', requestId: makeId(), body, aspect })
      } catch (e) {
        console.log('[LumiDraw] dt-image interceptor error:', e.message)
      }
    }

    let lastParserKey = ''
    const parserInterceptorRegisteredAt = Date.now()
    const parserTagBootGraceMs = 15000
    const onParserTrigger = (payload) => {
      try {
        // The tag interceptor may fire during streaming and again after the
        // message commits. Parser must run only at the committed boundary.
        if (payload && payload.isStreaming === true) return
        // Registering the interceptor can replay every committed tag already in
        // the rendered chat. Those are backlog, not new generations. The real
        // GENERATION_ENDED listener remains active during this short window, so
        // a genuinely new reply is still illustrated.
        if (Date.now() - parserInterceptorRegisteredAt < parserTagBootGraceMs) {
          console.log('[LumiDraw] ignored parser tag replayed during startup')
          return
        }
        const messageId = String(payload && payload.messageId || '')
        const chatId = String(payload && payload.chatId || '')
        const key = `${chatId}:${messageId}:${String(payload && payload.fullMatch || '')}`
        if (key && key === lastParserKey) return
        lastParserKey = key
        console.log('[LumiDraw] committed parser trigger received')
        ctx.sendToBackend({
          type: 'parser_trigger', requestId: makeId(),
          messageId, chatId,
        })
      } catch (e) {
        console.log('[LumiDraw] parser trigger error:', e.message)
      }
    }

    try {
      m.registerTagInterceptor(
        { tagName: 'dt-image', removeFromMessage: false },
        onInlineTag,
      )
      inlineInterceptorReady = true
    } catch (e) {
      console.log('[LumiDraw] dt-image interceptor registration failed:', e.message)
    }

    try {
      m.registerTagInterceptor(
        { tagName: 'lumidraw-parse', attrs: { request: 'generate' }, removeFromMessage: true },
        onParserTrigger,
      )
      parserInterceptorReady = true
    } catch (e) {
      console.log('[LumiDraw] parser interceptor registration failed:', e.message)
    }

    ctx.sendToBackend({
      type: 'frontend_status', requestId: makeId(),
      version: EXTENSION_VERSION, historyRefresh: !!refreshHistoryButton,
      inlineInterceptor: inlineInterceptorReady, parserInterceptor: parserInterceptorReady,
      generationEndedListener: false, renderedEventListener: false,
      note: parserInterceptorReady ? 'Native parser trigger listener ready' : 'Parser trigger listener unavailable',
    })
  })()

  // Saved-message lifecycle events are more reliable than asking the story
  // model to emit a private XML tag. They also preserve the browser's operator
  // user scope when forwarded to the backend. The backend deduplicates these
  // against its own events and the tag interceptor.
  ;(() => {
    let generationEndedReady = false
    let renderedReady = false
    if (ctx.events && typeof ctx.events.on === 'function') {
      try {
        const off = ctx.events.on('GENERATION_ENDED', (payload) => {
          try {
            if (!payload || payload.error) return
            const context = readImageEventContext(payload)
            const chatId = context.chatId || activeChatIdFromCtx()
            if (!context.messageId || !chatId) return
            lastSeenChatId = String(chatId)
            const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
            ctx.sendToBackend({
              type: 'generation_ended', requestId: makeId(),
              messageId: context.messageId,
              chatId: String(chatId),
              content: String(payload.content || eventMessage.content || eventMessage.text || ''),
            })
          } catch (error) {
            console.log('[LumiDraw] GENERATION_ENDED forwarding failed:', error.message)
          }
        })
        if (typeof off === 'function') imageLifecycleUnsubs.push(off)
        generationEndedReady = true
      } catch (error) {
        console.log('[LumiDraw] GENERATION_ENDED listener unavailable:', error.message)
      }
      try {
        const off = ctx.events.on('CHARACTER_MESSAGE_RENDERED', (payload) => {
          try {
            const context = readImageEventContext(payload)
            if (!context.messageId || context.isUser === true) return
            const chatId = context.chatId || activeChatIdFromCtx()
            if (chatId) lastSeenChatId = String(chatId)

            // This is the important 1.3.4 fix: messageId alone is enough to
            // satisfy a pending image render intent. SimTracker does the same.
            if (chatId && imagePlacementChatId && imagePlacementChatId !== String(chatId)) {
              refreshImagePlacements(String(chatId)).then(() => scheduleImageAttach(context.messageId)).catch(() => {})
            } else {
              scheduleImageAttach(context.messageId)
            }

            if (chatId) {
              ctx.sendToBackend({
                type: 'character_message_rendered', requestId: makeId(),
                messageId: context.messageId,
                chatId: String(chatId),
              })
            }
          } catch (error) {
            console.log('[LumiDraw] CHARACTER_MESSAGE_RENDERED forwarding failed:', error.message)
          }
        })
        if (typeof off === 'function') imageLifecycleUnsubs.push(off)
        renderedReady = true
      } catch (error) {
        console.log('[LumiDraw] CHARACTER_MESSAGE_RENDERED listener unavailable:', error.message)
      }
    }
    if (ctx.events && typeof ctx.events.on === 'function') {
      try {
        const off = ctx.events.on('CHAT_SWITCHED', (payload) => {
          const context = readImageEventContext(payload)
          const eventChatId = String(context.chatId || (payload && (payload.chatId || payload.id || (payload.chat && payload.chat.id))) || '')
          lastSeenChatId = eventChatId
          for (const placementId of [...imagePlacementMounts.keys()]) clearImagePlacementMount(placementId)
          for (const timer of imageAttachRetryTimers.values()) clearTimeout(timer)
          imageAttachRetryTimers.clear()
          pendingImageMessageIds.clear()
          imagePlacements = []
          imagePlacementChatId = ''

          // Cast + wardrobe are chat state just as much as image placements are.
          // 1.3.6 only refreshed the images here, so the panel could display and edit
          // the previous story until some unrelated event happened to refresh it.
          const rows = $('.ld-wardrobe-rows')
          if (rows) rows.innerHTML = '<div class="ld-help" style="margin:0">Loading this chat…</div>'
          const summary = $('.ld-cast-summary')
          if (summary) summary.textContent = 'Loading this chat…'
          setStatus('.ld-wardrobe-status', '', '')
          setStatus('.ld-cast-status', '', '')

          const rehydrate = (chatId) => {
            const id = String(chatId || '')
            if (!id) return
            lastSeenChatId = id
            refreshImagePlacements(id).catch((error) => console.log('[LumiDraw] image refresh after chat switch failed:', error.message))
            loadCasts({ chatId: id }).catch(() => {})
            loadWardrobe(true, false, id).catch(() => {})
          }
          if (eventChatId) rehydrate(eventChatId)
          else {
            // Some host builds emit CHAT_SWITCHED before the payload contains an id.
            // Give getActiveChat one task turn to settle instead of reusing the old id.
            setTimeout(() => rehydrate(activeChatIdFromCtx()), 0)
          }
        })
        if (typeof off === 'function') imageLifecycleUnsubs.push(off)
      } catch (error) {
        console.log('[LumiDraw] CHAT_SWITCHED image listener unavailable:', error.message)
      }
      try {
        const off = ctx.events.on('MESSAGE_SWIPED', (payload) => {
          const context = readImageEventContext(payload)
          const messageId = context.messageId
          if (!messageId) return
          clearImageMessageMount(messageId)
          imagePlacements = imagePlacements.filter((item) => String(item && item.messageId || '') !== messageId)
        })
        if (typeof off === 'function') imageLifecycleUnsubs.push(off)
      } catch (error) {
        console.log('[LumiDraw] MESSAGE_SWIPED image listener unavailable:', error.message)
      }
      try {
        const off = ctx.events.on('MESSAGE_DELETED', (payload) => {
          const context = readImageEventContext(payload)
          const messageId = context.messageId
          if (!messageId) return
          clearImageMessageMount(messageId)
          imagePlacements = imagePlacements.filter((item) => String(item && item.messageId || '') !== messageId)
        })
        if (typeof off === 'function') imageLifecycleUnsubs.push(off)
      } catch (error) {
        console.log('[LumiDraw] MESSAGE_DELETED image listener unavailable:', error.message)
      }
    }

    ctx.sendToBackend({
      type: 'frontend_status', requestId: makeId(),
      version: EXTENSION_VERSION, historyRefresh: !!refreshHistoryButton,
      inlineInterceptor: inlineInterceptorReady, parserInterceptor: parserInterceptorReady,
      generationEndedListener: generationEndedReady,
      renderedEventListener: renderedReady,
      note: `Auto event fan-in: generation-ended=${generationEndedReady ? 'ready' : 'missing'}, rendered=${renderedReady ? 'ready' : 'missing'}`,
    })
  })()

  // ------------------------------------------------------------------ boot
  let initialized = false
  async function tryInit() {
    if (initialized) return true
    try {
      const res = await call('init', {}, 8000)
      settings = res.settings; presets = res.presets; personas = res.personas || []; characters = res.characters || []; places = res.places || []; history = res.history; storyDebug = res.storyDebug || null; autoStatus = res.lastAutoStatus || null
      defaults = res.defaults || defaults
      $('.ld-host').value = settings.host
      $('.ld-port').value = settings.port
      $('.ld-bridge-host').value = settings.bridgeHost || '127.0.0.1'
      $('.ld-bridge-port').value = settings.bridgePort || 7863
      $('.ld-cloud-enabled').checked = !!settings.cloudEnabled
      $('.ld-cloud-host').value = settings.cloudHost || '127.0.0.1'
      $('.ld-cloud-port').value = settings.cloudPort || 7864
      $('.ld-cloud-model').value = settings.cloudModel || ''
      $('.ld-cloud-fallback').checked = settings.cloudFallback !== false
      $('.ld-mode').value = storyBehaviorFromSettings(settings.mode || 'off', settings.autoScan)
      $('.ld-autoscan').checked = settings.autoScan !== false
      $('.ld-maximg').value = settings.maxImages || 2
      $('.ld-minimg').value = settings.minImages || 0
      if ($('.ld-maxsubjects')) $('.ld-maxsubjects').value = String(settings.maxSubjects || 2)
      $('.ld-chartags').checked = settings.autoCharTags !== false
      // Direct mode is represented by the main mode selector. The backend
      // still mirrors directMode for compatibility with older saved settings.
      if ($('.ld-chat-leads')) $('.ld-chat-leads').checked = settings.chatLeads !== false
      $('.ld-strip-directives').checked = settings.stripImageDirectives !== false
      if ($('.ld-size-images')) {
        const width = Number(settings.chatImageWidth) || 500
        $('.ld-size-images').checked = !!settings.sizeChatImages
        if ($('.ld-image-width')) $('.ld-image-width').value = width
        if ($('.ld-image-width-num')) $('.ld-image-width-num').value = width
        applyImageSize()
      }
      if ($('.ld-optimized-previews')) $('.ld-optimized-previews').checked = settings.optimizedPreviews !== false
      if ($('.ld-delete-chat-images')) $('.ld-delete-chat-images').checked = settings.deleteImagesWithChats !== false
      $('.ld-parser-engine').value = settings.parserEngine || 'legacy'
      $('.ld-parser-context').value = String(settings.parserContextMessages ?? 2)
      $('.ld-use-loom-ledger').checked = settings.useLoomLedger !== false
      try {
        await reloadParserSources(false)
      } catch (e) { console.log('[LumiDraw] connections list failed:', e.message) }
      $('.ld-parser-conn').value = settings.parserConnection || ''
      $('.ld-parser-model').value = settings.parserModel || ''
      if ($('.ld-parser-temperature')) $('.ld-parser-temperature').value = Number.isFinite(Number(settings.parserTemperature)) ? Number(settings.parserTemperature) : 0.2
      if ($('.ld-parser-overrides')) $('.ld-parser-overrides').value = settings.parserRequestOverrides || ''
      if ($('.ld-parser-maxtokens')) $('.ld-parser-maxtokens').value = settings.parserMaxTokens || 12000
      refreshModelOverrideNote()
      refreshRejectedKeys()
      $('.ld-parser-instr').value = settings.parserInstruction || parserDefaultFor(settings.parserEngine || 'legacy')
      $('.ld-protocol').value = settings.protocol || defaults.protocol || ''
      if ($('.ld-story-quality')) $('.ld-story-quality').value = settings.storyQualityTags || ''
      if ($('.ld-story-prefix')) $('.ld-story-prefix').value = settings.storyPromptPrefix || ''
      if ($('.ld-story-negative')) $('.ld-story-negative').value = settings.storyNegativePrompt || ''
      if ($('.ld-story-banned')) $('.ld-story-banned').value = settings.storyBannedTags || ''
      if ($('.ld-story-scene-anchor')) $('.ld-story-scene-anchor').value = settings.storySceneAnchor || ''
      if ($('.ld-story-break')) $('.ld-story-break').checked = settings.storyUseBreakSeparators === true
      await loadCatalog()
      if (settings.activePreset) { activePreset = settings.activePreset }
      if (activePreset) {
        const p = presets.find((x) => x.name === activePreset)
        if (p) { syncedConfig = { ...p.config } }
        else activePreset = null
      }
      const savedDraft = loadDraftLocal()
      // A draft belonging to a preset you have since switched away from is not
      // restored over the top of the one you are actually using. Its negative
      // prompt would look like it came from the active preset, and diagnosing a
      // preset is impossible if it can be wearing another preset's settings.
      const draftBelongsElsewhere = savedDraft && savedDraft.presetName && activePreset &&
        savedDraft.presetName !== activePreset
      if (savedDraft && savedDraft.config && savedDraft.config.model && !draftBelongsElsewhere) {
        draftConfig = savedDraft.config
        renderDraftControls()
        $('.ld-negative').value = savedDraft.negativePrompt || ''
        renderChips()
        setStatus('.ld-draft-status', savedDraft.presetName
          ? `Restored your last workspace draft from “${savedDraft.presetName}”.`
          : 'Restored your last workspace draft.')
      } else if (activePreset) {
        const p = presets.find((x) => x.name === activePreset)
        if (p) {
          hydrateDraftFromSource({
            config: p.config || {},
            negativePrompt: $('.ld-negative') ? $('.ld-negative').value : '',
            label: `generation preset “${p.name}”`,
          }, { force: true })
        }
      }
      renderCharacterList(); renderPersonaList(); renderPlaces(); renderPresetSelect(); renderPresetList(); renderHistory(); renderChips(); renderStoryDebug(); renderStoryStatus()
      const bootChatId = activeChatIdFromCtx()
      if (bootChatId) {
        lastSeenChatId = String(bootChatId)
        refreshImagePlacements(bootChatId).catch((error) => console.log('[LumiDraw] native image placement refresh failed:', error.message))
      }
      loadCasts(bootChatId ? { chatId: String(bootChatId) } : {}).catch(() => {})
      loadWardrobe(true, false, bootChatId ? String(bootChatId) : '').catch(() => {})
      updateScanLabel()
      initialized = true
      // The header shows the version the BACKEND reports, which comes from the
      // installed spindle.json manifest. It used to be a literal in the markup, so
      // it read v0.42.3 through six releases while the manifest said otherwise —
      // there is no version to display that the installed extension does not own.
      const installed = String(res.version || '').trim()
      const versionEl = $('.ld-version')
      if (versionEl) versionEl.textContent = installed ? `v${installed}` : ''
      const launcher = $('.ld-launcher')
      if (launcher && installed) {
        launcher.title = `LumiDraw Studio v${installed}`
        launcher.setAttribute('aria-label', `LumiDraw Studio v${installed}`)
      }
      // A half-installed extension is a real failure mode — copying backend.js and
      // forgetting frontend.js leaves two versions running against each other, and
      // every symptom of that looks like a bug in the feature instead.
      if (installed && installed !== EXTENSION_VERSION) {
        console.warn(`[LumiDraw] version mismatch — frontend.js is v${EXTENSION_VERSION}, ` +
          `the installed manifest says v${installed}. One of the files did not get copied.`)
        if (versionEl) {
          versionEl.textContent = `v${installed} · UI v${EXTENSION_VERSION}`
          versionEl.style.color = 'var(--ld-warn, #e0a458)'
          versionEl.title = 'The frontend and the manifest disagree — one file was not copied.'
        }
      }
      console.log(`[LumiDraw] backend connected — UI v${EXTENSION_VERSION}, installed v${installed || 'unknown'}`)
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

  const cleanup = () => {
    if (typeof rescanInputActionUnsub === 'function') rescanInputActionUnsub()
    if (rescanInputAction && typeof rescanInputAction.destroy === 'function') rescanInputAction.destroy()
    window.removeEventListener('keydown', onStoryPickerKeyDown)
    window.removeEventListener('resize', syncTextEditorViewport)
    if (textEditorViewport) {
      textEditorViewport.removeEventListener('resize', syncTextEditorViewport)
      textEditorViewport.removeEventListener('scroll', syncTextEditorViewport)
    }
    document.removeEventListener('click', onDocumentImageClick, true)
    for (const unsubscribe of imageLifecycleUnsubs.splice(0)) { try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* ignore */ } }
    for (const timer of imageAttachRetryTimers.values()) clearTimeout(timer)
    imageAttachRetryTimers.clear()
    pendingImageMessageIds.clear()
    for (const placementId of [...imagePlacementMounts.keys()]) clearImagePlacementMount(placementId)
    try { removeImageMountStyle() } catch { /* ignore */ }
    closeLightbox()
    document.body.classList.remove('ld-fullscreen-lock')
    if (window[INSTANCE_KEY] === liveInstance) delete window[INSTANCE_KEY]
    unsub()
    removeStyle()
    dom.cleanup()
  }
  liveInstance.cleanup = cleanup
  return cleanup
}
