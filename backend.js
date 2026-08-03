// LumiDraw Studio — backend
// Runs in Spindle's Bun process runtime. Talks to the Draw Things HTTP API
// (A1111-compatible surface with DT-native payload keys) on localhost.
//
// Empirically verified against Draw Things (July 2026):
//   - GET  /                    → full current config as JSON (exact model names)
//   - GET  /sdapi/v1/options    → DT-native option keys
//   - POST /sdapi/v1/txt2img    → honors a top-level "model" key per request
//   - Unknown payload keys are REJECTED loudly ({"error":"HTTPException",
//     "detail":"Unrecognized keys: [...]"}), so we send a conservative
//     whitelist and surface DT's own error text when something is off.
//   - /sdapi/v1/sd-models, /loras, /samplers, /progress do NOT exist (404).

/* global spindle */

const SETTINGS_FILE = 'settings.json'
const PRESETS_FILE = 'presets.json'
const HISTORY_FILE = 'history.json'
const STORY_DEBUG_FILE = 'story_debug.json'

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 7862,
  mode: 'off',            // 'off' | 'inline' | 'parser'
  autoScan: true,         // auto-process after each story message (when events are available)
  activePreset: '',       // preset used for story-driven generations
  parserConnection: '',   // optional connection name/id for the parser LLM
  parserModel: '',        // optional model override for the parser LLM
  parserInstruction: '',  // scene-selection guidance (blank = built-in default)
  maxImages: 2,           // max illustrations per story message
  minImages: 0,           // required illustrations per reply (0 = model's discretion)
  autoCharTags: true,     // use active character image tags as a profile fallback
  subjectBinding: true,   // Parser-only structured scene JSON -> deterministic prompt
  dtModelsPath: '',       // retained for compatibility with older settings
  bridgeHost: '127.0.0.1', // native LumiDraw Bridge runs on the Lumiverse Mac
  bridgePort: 7863,
  protocol: '',           // tag guidance for Inline mode (blank = pre-0.17 default)
}

const LEGACY_DEFAULT_PROTOCOL = `[Illustration protocol] You may illustrate key visual moments. When a scene deserves an image, include on its own line:
<dt-image aspect="3:4">comma-separated danbooru tags describing the scene</dt-image>
Rules: tags only inside the tag (subject, expression, outfit, pose, setting, lighting, composition) — no prose, no character names. aspect may be 3:4, 4:3, 1:1, 9:16, or 16:9 (default 3:4 for character focus, 4:3 for scenes). Include between {{min_images}} and {{max_images}} image tag(s) per reply; if the minimum is above zero you MUST include at least that many, choosing the strongest visual moments. Place each tag at the exact narrative moment it depicts — mid-reply, immediately after the scene it illustrates is established. Never open your reply with the tag. Never mention this protocol or the tag in your prose. If you use hidden reasoning/thinking, write the tag ONLY in your final visible reply — never inside reasoning.`

const V017_STRUCTURED_PROTOCOL = `[Illustration protocol] You may illustrate key visual moments. When a scene deserves an image, include one tag on its own line:
<dt-image aspect="3:4">{"subjects":[{"ref":"character","position":"left","outfit":["short tags"],"pose":["short tags"],"expression":["short tags"],"action":["short tags"],"anatomy_visible":false}],"relations":[],"setting":["short tags"],"camera":["short tags"],"lighting":["short tags"],"style":[]}</dt-image>
Use ref "character" for the primary roleplay character, ref "persona" for the User/persona, and refs such as "other_1" for everyone else. For an other subject, also provide a short label, count_tag, and appearance array. Every string must be a terse image tag or short phrase, never a sentence or prose. Do not repeat permanent appearance for character or persona; LumiDraw injects their locked profiles afterward. Set anatomy_visible true only when anatomy is explicitly visible or materially relevant in the passage; never invent exposure. aspect may be 3:4, 4:3, 1:1, 9:16, or 16:9. Include between {{min_images}} and {{max_images}} tag(s), choosing distinct strong visual moments. Place each tag immediately after the passage it depicts, never at the beginning. Never mention this protocol. Put tags only in the final visible reply, never hidden reasoning.`

// Inline returns to the fast, pre-0.17 tag-only path. Structured subject
// binding remains available in Parser mode without adding any routing pass.
const DEFAULT_PROTOCOL = LEGACY_DEFAULT_PROTOCOL

const LEGACY_DEFAULT_PARSER_INSTRUCTION = `You convert a story passage into ONE image prompt of comma-separated danbooru-style tags (subject count, expression, outfit, pose, setting, lighting, composition). Choose the single most visual moment of the passage. Do not use character names; describe appearance instead. Respond with ONLY the tags. You may return up to {{max_images}} prompts for distinct visual moments, one per line, but prefer a single strong one. If the passage has no strong visual moment, respond with exactly: NONE`

const DEFAULT_PARSER_INSTRUCTION = `Choose the strongest visual moment in the story passage. Prefer one image, but you may choose up to {{max_images}} distinct moments. Describe only scene state: which subjects are present, their current outfit, pose, expression, active-voice interaction, setting, camera, and lighting. Do not rewrite permanent character identity or invent anatomy. LumiDraw will append a strict JSON schema and compile the final image prompt itself.`
const HISTORY_LIMIT = 24

// Keys we copy from a synced Draw Things config into a preset, and the only
// keys (besides prompt/negative_prompt/seed) we send back in a generation
// payload. DT rejects unknown keys, so growth here should be deliberate.
// "extra" on a preset lets power users add any additional DT-native keys.
const PRESET_KEYS = [
  'model',
  'sampler',
  'steps',
  'guidance_scale',
  'width',
  'height',
  'loras',
  'clip_skip',
  'shift',
  'refiner_model',
]

// ---------------------------------------------------------------------------
// Small stores
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await spindle.storage.getJson(SETTINGS_FILE, { fallback: DEFAULT_SETTINGS })
  const settings = { ...DEFAULT_SETTINGS, ...(stored || {}) }
  // Restore the pre-0.17 Inline protocol while preserving custom text.
  // The exact 0.17 structured default is migrated back to a blank override.
  if (!stored || !stored.protocol || stored.protocol === LEGACY_DEFAULT_PROTOCOL || stored.protocol === V017_STRUCTURED_PROTOCOL) {
    settings.protocol = ''
  }
  if (settings.subjectBinding !== false && (!stored || !stored.parserInstruction || stored.parserInstruction === LEGACY_DEFAULT_PARSER_INSTRUCTION)) {
    settings.parserInstruction = ''
  }
  return settings
}

async function getPresets() {
  return spindle.storage.getJson(PRESETS_FILE, { fallback: [] })
}

async function savePresets(presets) {
  await spindle.storage.setJson(PRESETS_FILE, presets, { indent: 2 })
}

async function getHistory() {
  return spindle.storage.getJson(HISTORY_FILE, { fallback: [] })
}

async function pushHistory(entry) {
  const history = await getHistory()
  history.unshift(entry)
  const trimmed = history.slice(0, HISTORY_LIMIT)
  await spindle.storage.setJson(HISTORY_FILE, trimmed, { indent: 2 })
  return trimmed
}


async function getStoryDebug() {
  return spindle.storage.getJson(STORY_DEBUG_FILE, { fallback: null })
}

async function saveStoryDebug(debug) {
  const value = { ...(debug || {}), at: Date.now() }
  await spindle.storage.setJson(STORY_DEBUG_FILE, value, { indent: 2 })
  return value
}

// ---------------------------------------------------------------------------
// Draw Things client
// ---------------------------------------------------------------------------

function baseUrl(settings) {
  return `http://${settings.host}:${settings.port}`
}

async function dtFetch(settings, path, options = {}, timeoutMs = 15000) {
  const url = `${baseUrl(settings)}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text }
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${timeoutMs / 1000}s`
      : (err && err.message) || String(err)
    throw new Error(`Could not reach Draw Things at ${url} (${reason}). ` +
      'Check that the API Server is enabled (HTTP protocol) and the port matches.')
  } finally {
    clearTimeout(timer)
  }
}

async function dtCurrentConfig(settings) {
  const res = await dtFetch(settings, '/')
  if (!res.ok || !res.json) {
    throw new Error(`Draw Things answered but not with config JSON (HTTP ${res.status}).`)
  }
  return res.json
}

function extractDtError(res) {
  if (res.json) {
    return res.json.detail || res.json.error || res.text
  }
  return res.text || `HTTP ${res.status}`
}

function buildPayload({ prompt, negativePrompt, seed, config, extra }) {
  const payload = {}

  // Power-user extras are allowed only for keys that are not controlled by
  // the visible preset editor. Older presets may contain stale hidden copies
  // of model / LoRA / sampler values; those must never override what the UI
  // currently shows.
  const protectedKeys = new Set([
    ...PRESET_KEYS,
    'prompt',
    'negative_prompt',
    'seed',
    'batch_count',
  ])
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (!protectedKeys.has(k) && v !== undefined && v !== null && v !== '') {
        payload[k] = v
      }
    }
  }

  // The visible preset is authoritative.
  for (const key of PRESET_KEYS) {
    const value = config ? config[key] : undefined
    if (value !== undefined && value !== null && value !== '') {
      payload[key] = value
    }
  }

  payload.prompt = prompt || ''
  if (negativePrompt) payload.negative_prompt = negativePrompt
  const parsedSeed = Number(seed)
  if (Number.isFinite(parsedSeed) && parsedSeed >= 0) payload.seed = parsedSeed

  // Story and manual actions in LumiDraw are one-image operations. Draw Things
  // otherwise may reuse the batch count currently selected in its own UI.
  payload.batch_count = 1
  return payload
}

async function dtGenerate(settings, payload) {
  spindle.log.info('[lumidraw] Draw Things payload: ' + JSON.stringify({
    model: payload.model,
    sampler: payload.sampler,
    steps: payload.steps,
    guidance_scale: payload.guidance_scale,
    width: payload.width,
    height: payload.height,
    loras: payload.loras,
    clip_skip: payload.clip_skip,
    shift: payload.shift,
    batch_count: payload.batch_count,
  }))
  const res = await dtFetch(settings, '/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 600000) // generations can be slow on-device; 10 min budget
  if (!res.ok || !res.json || !Array.isArray(res.json.images) || res.json.images.length === 0) {
    throw new Error(`Draw Things rejected the generation: ${extractDtError(res)}`)
  }
  if (res.json.images.length > 1) {
    spindle.log.warn(`[lumidraw] Draw Things returned ${res.json.images.length} images despite batch_count=1; keeping only the first.`)
  }
  return [res.json.images[0]]
}

// ---------------------------------------------------------------------------
// LumiDraw Bridge client — native catalog helper on the Lumiverse Mac
// ---------------------------------------------------------------------------

const DEFAULT_SAMPLERS = [
  'Euler A Trailing',
  'Euler A',
  'Euler',
  'DPM++ 2M Karras',
  'DPM++ 2M',
  'DPM++ SDE Karras',
  'DPM++ SDE',
  'DPM++ 2M SDE Karras',
  'DPM++ 2M SDE',
  'DPM++ 3M SDE Karras',
  'DPM++ 3M SDE',
  'DPM++ 2S A Karras',
  'DPM++ 2S A',
  'DDIM',
  'UniPC',
  'LCM',
  'TCD',
]

function bridgeBaseUrl(settings) {
  const host = String(settings.bridgeHost || DEFAULT_SETTINGS.bridgeHost).trim()
  const port = Number(settings.bridgePort) || DEFAULT_SETTINGS.bridgePort
  return `http://${host}:${port}`
}

async function bridgeFetch(settings, path, options = {}, timeoutMs = 12000) {
  const url = `${bridgeBaseUrl(settings)}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = json && (json.error || json.message)
      throw new Error(detail || text || `HTTP ${res.status}`)
    }
    if (!json) throw new Error('Bridge returned a non-JSON response.')
    return json
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${timeoutMs / 1000}s`
      : ((err && err.message) || String(err))
    throw new Error(`Could not reach LumiDraw Bridge at ${url} (${reason})`)
  } finally {
    clearTimeout(timer)
  }
}

function uniqueByLower(values) {
  const out = []
  const seen = new Set()
  for (const value of values || []) {
    const text = String(value || '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

function looksLikeImageModel(item, currentModelSet = new Set()) {
  const file = String((item && (item.file || item.name)) || '').trim()
  if (!file) return false
  const lower = file.toLowerCase()
  if (currentModelSet.has(lower)) return true
  if (item && item.confidence === 'high' && !item.subtype) return true

  // Draw Things stores support weights beside checkpoints. Keep likely image
  // checkpoints while excluding obvious text/video/auxiliary weights.
  const excluded = [
    /(^|[_-])vae([_.-]|$)/,
    /(^|[_-])clip([_.-]|$)/,
    /(^|[_-])t5([_.-]|$)/,
    /(^|[_-])llama([_.-]|$)/,
    /(^|[_-])tokenizer([_.-]|$)/,
    /(^|[_-])text[_-]?encoder([_.-]|$)/,
    /^qwen[_-]?3(?:[_.-]|$)/,
    /^ltx(?:[_.-]|$)/,
    /^wan(?:[_.-]|$)/,
  ]
  if (excluded.some((pattern) => pattern.test(lower))) return false
  const size = Number(item && item.sizeBytes)
  if (Number.isFinite(size) && size > 0 && size < 50 * 1024 * 1024) return false
  return true
}

async function getBridgeCatalog(settings, refresh = false) {
  const suffix = refresh ? '?refresh=1' : ''
  return bridgeFetch(settings, `/catalog${suffix}`, {}, refresh ? 30000 : 12000)
}

async function dtSamplerCandidates(settings) {
  try {
    const res = await dtFetch(settings, '/sdapi/v1/options', {}, 8000)
    if (!res.ok || !res.json || typeof res.json !== 'object') return []
    const found = []
    const visit = (value, keyHint = '', depth = 0) => {
      if (depth > 5 || value === null || value === undefined) return
      if (Array.isArray(value)) {
        if (/sampler/i.test(keyHint)) {
          for (const item of value) {
            if (typeof item === 'string') found.push(item)
            else if (item && typeof item === 'object') {
              const name = item.name || item.label || item.value || item.id
              if (typeof name === 'string') found.push(name)
            }
          }
        }
        for (const item of value) visit(item, keyHint, depth + 1)
        return
      }
      if (typeof value !== 'object') {
        if (/sampler/i.test(keyHint) && typeof value === 'string') found.push(value)
        return
      }
      for (const [key, child] of Object.entries(value)) {
        visit(child, key, depth + 1)
      }
    }
    visit(res.json)
    return uniqueByLower(found)
  } catch (err) {
    spindle.log.warn('[lumidraw] Draw Things sampler options unavailable: ' + err.message)
    return []
  }
}


// ---------------------------------------------------------------------------
// Story-driven generation (v0.5): inline <dt-image> tags + parser mode
// ---------------------------------------------------------------------------

const PROCESSED_FILE = 'processed.json'
const pregenCache = new Map()   // fingerprint -> generated entry
const pregenInflight = new Set()
const tagFingerprint = (body) => String(body || '').trim().toLowerCase().replace(/\s+/g, ' ')
const TAG_RE = /<dt-image([^>]*)>([\s\S]*?)<\/dt-image>/g
const PARSER_TRIGGER_TAG = '<lumidraw-parse request="generate"></lumidraw-parse>'
const PARSER_TRIGGER_RE = /<lumidraw-parse\b[^>]*><\/lumidraw-parse>|<lumidraw-parse\b[^>]*>[\s\S]*?<\/lumidraw-parse>|<lumidraw-parse\b[^>]*\/>/gi

function stripBannedTags(sceneTags, bannedCsv) {
  if (!bannedCsv || !sceneTags) return sceneTags
  const banned = new Set(bannedCsv.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))
  if (!banned.size) return sceneTags
  return sceneTags.split(',').map((t) => t.trim())
    .filter((t) => t && !banned.has(t.toLowerCase()))
    .join(', ')
}

function stripThinking(text) {
  return String(text || '')
    .replace(/<think(?:ing)?[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<reasoning[^>]*>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
}

async function wasProcessed(messageId) {
  const list = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
  return list.includes(messageId)
}

async function markProcessed(messageId) {
  const list = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
  list.push(messageId)
  await spindle.storage.setJson(PROCESSED_FILE, list.slice(-50), { indent: 0 })
}

function aspectDims(config, aspectStr) {
  const bw = Number(config.width) || 768
  const bh = Number(config.height) || 768
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(String(aspectStr || '').trim())
  if (!m) return { width: bw, height: bh }
  const ratio = Number(m[1]) / Number(m[2])
  const area = bw * bh
  const r64 = (v) => Math.max(256, Math.round(v / 64) * 64)
  return { width: r64(Math.sqrt(area * ratio)), height: r64(Math.sqrt(area / ratio)) }
}

async function resolveActiveChatId(userId) {
  if (!spindle.chats) return null
  for (const fn of ['getActive', 'getActiveChat', 'active']) {
    if (typeof spindle.chats[fn] === 'function') {
      try {
        let active
        try { active = await spindle.chats[fn](userId) }
        catch { active = await spindle.chats[fn]() }
        const id = active && (active.id || active.chatId || active)
        if (id) return id
      } catch { /* try next */ }
    }
  }
  return null
}

async function fetchMessages(userId) {
  const chatApi = spindle.chat || spindle.chats
  if (!chatApi || typeof chatApi.getMessages !== 'function') {
    throw new Error('Chat read API unavailable (chats permission granted?).')
  }
  const chatId = await resolveActiveChatId(userId)
  const shapes = [
    [chatId, userId],
    [{ chatId, userId }],
    [chatId],
    [undefined, userId],
    [{ userId }],
    [],
  ]
  const errs = []
  for (const args of shapes) {
    if (args.length && args[0] === null) continue
    try {
      const res = await chatApi.getMessages(...args)
      const arr = Array.isArray(res) ? res : (res && (res.messages || res.items))
      if (Array.isArray(arr) && arr.length) {
        const ts = (m) => m.createdAt || m.created_at || m.timestamp || 0
        if (arr.length > 1 && ts(arr[0]) > ts(arr[arr.length - 1])) arr.reverse()
        return { messages: arr, chatId }
      }
      errs.push(`${args.length} arg(s): empty/unrecognized result`)
    } catch (e) { errs.push(`${args.length} arg(s): ${e.message}`) }
  }
  throw new Error('Could not read chat messages (chatId ' + (chatId ? 'resolved' : 'NOT resolved') + '). Tried: ' + errs.join(' | '))
}

function messageBits(m) {
  const contentKey = ('content' in m) ? 'content' : ('text' in m) ? 'text' : ('message' in m) ? 'message' : null
  const role = (m.role || m.sender || '').toString().toLowerCase()
  return {
    id: m.id || m.messageId,
    contentKey,
    content: contentKey ? m[contentKey] : null,
    createdAt: m.createdAt || m.created_at || m.timestamp || null,
    isAssistant: role.includes('assistant') || role.includes('char') || role === 'ai',
  }
}

function storyPreview(content, maxLength = 260) {
  const clean = stripThinking(content)
    .replace(TAG_RE, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return '(No visible prose)'
  return clean.length > maxLength ? clean.slice(0, maxLength - 1).trimEnd() + '…' : clean
}

function stripParserTrigger(text) {
  return String(text || '').replace(PARSER_TRIGGER_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

async function listStoryMessages(userId, requestedLimit = 120) {
  const { messages, chatId } = await fetchMessages(userId)
  const limit = Math.max(1, Math.min(500, Number(requestedLimit) || 120))
  const processed = new Set(await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] }))
  const eligible = []

  for (let idx = 0; idx < messages.length; idx++) {
    const message = messages[idx]
    const bits = messageBits(message)
    if (!bits.id || !bits.isAssistant || !bits.contentKey || typeof bits.content !== 'string') continue
    eligible.push({ ...bits, chatTurn: idx + 1 })
  }

  const total = eligible.length
  const items = eligible.slice(-limit).reverse().map((bits, newestIndex) => ({
    id: String(bits.id),
    turn: total - newestIndex,
    chatTurn: bits.chatTurn,
    preview: storyPreview(bits.content),
    createdAt: bits.createdAt,
    processed: processed.has(bits.id) || processed.has(String(bits.id)),
    hasImage: /!\[[^\]]*\]\([^)]*\)/.test(bits.content),
    isLatest: newestIndex === 0,
  }))

  return { chatId, total, messages: items }
}

async function updateMessageContent(messageId, contentKey, newContent, userId, chatId) {
  const chatApi = spindle.chat || spindle.chats
  const errs = []
  const shapes = []
  if (chatId) {
    shapes.push(
      [{ id: messageId, chatId, [contentKey]: newContent, userId }],
      [chatId, messageId, { [contentKey]: newContent }, userId],
      [chatId, messageId, { [contentKey]: newContent }],
    )
  }
  shapes.push(
    [messageId, { [contentKey]: newContent }, userId],
    [{ id: messageId, [contentKey]: newContent, userId }],
    [messageId, { [contentKey]: newContent }],
  )
  for (const args of shapes) {
    try { await chatApi.updateMessage(...args); return } catch (e) { errs.push(e.message) }
  }
  throw new Error('updateMessage failed: ' + errs.join(' | '))
}

async function generateAndUpload({ prompt, negativePrompt, config, extra, dims }, userId) {
  const settings = await getSettings()
  const merged = dims ? { ...config, ...dims } : config
  const payloadOut = buildPayload({ prompt, negativePrompt, config: merged, extra })
  if (!payloadOut.model) throw new Error('Active preset has no model.')
  const started = Date.now()
  const images = await dtGenerate(settings, payloadOut)
  const uploads = []
  for (const b64 of images) {
    const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
    const opts = { data: bytes, filename: `lumidraw-${Date.now()}.png`, mime_type: 'image/png' }
    let dto
    try { dto = await spindle.images.upload({ ...opts, userId }) }
    catch { dto = await spindle.images.upload(opts, userId) }
    uploads.push({ id: dto.id, url: dto.url })
  }
  const entry = {
    at: started,
    durationMs: Date.now() - started,
    model: payloadOut.model,
    prompt: payloadOut.prompt,
    negativePrompt: payloadOut.negative_prompt || '',
    seed: payloadOut.seed !== undefined ? payloadOut.seed : 'random',
    images: uploads,
  }
  const history = await pushHistory(entry)
  notifyFrontend(userId, 'history_updated', { history, entry })
  return entry
}


function notifyFrontend(userId, type, data = {}) {
  try { spindle.sendToFrontend({ type, ...data }, userId) } catch (e) {
    spindle.log.warn('[lumidraw] notifyFrontend failed for ' + type + ': ' + e.message)
  }
}

let lastAutoStatus = {
  at: 0,
  mode: '',
  status: 'idle',
  note: '',
  messageId: '',
}

function setAutoStatus(userId, patch = {}) {
  lastAutoStatus = {
    ...lastAutoStatus,
    ...patch,
    at: Date.now(),
  }
  notifyFrontend(userId, 'auto_status', { status: lastAutoStatus })
}

async function resolveMacros(text, userId, chatId) {
  if (!text || !text.includes('{{')) return text
  const mac = spindle.macros
  if (mac) {
    for (const fn of ['resolve', 'process', 'render', 'expand', 'evaluate', 'substitute']) {
      if (typeof mac[fn] === 'function') {
        try {
          let out = null
          const shapes = [
            () => mac[fn](text, { userId, chatId }),
            () => mac[fn](text, chatId, userId),
            () => mac[fn](text, { chatId }),
            () => mac[fn](text, { userId }),
            () => mac[fn](text),
          ]
          for (const s of shapes) {
            try { out = await s(); if (out !== null && out !== undefined) break } catch { /* next shape */ }
          }
          const resolved = (typeof out === 'string') ? out
            : (out && typeof out.text === 'string') ? out.text : null
          if (resolved !== null) {
            if (resolved !== text) {
              spindle.log.info('[lumidraw] macros resolved via macros.' + fn)
            } else if (resolved.includes('{{')) {
              spindle.log.warn('[lumidraw] macros.' + fn + ' returned text unchanged — macro may be unknown: ' + text.slice(0, 120))
            }
            return resolved
          }
        } catch (e) { spindle.log.warn('[lumidraw] macro resolve failed via ' + fn + ': ' + e.message) }
      }
    }
    spindle.log.warn('[lumidraw] no macro method matched. spindle.macros keys: ' + Object.keys(mac).join(', '))
  }
  return text
}

async function getCharacterImageTags(userId, chatId) {
  try {
    const chatsApi = spindle.chats
    const charsApi = spindle.characters
    if (!chatsApi || !charsApi || typeof charsApi.get !== 'function') return ''
    let chat = null
    if (typeof chatsApi.get === 'function') {
      for (const args of [[chatId, userId], [{ chatId, userId }], [chatId]]) {
        try { const r = await chatsApi.get(...args); if (r) { chat = r; break } } catch { /* next */ }
      }
    }
    const charId = chat && (chat.characterId || chat.character_id ||
      (Array.isArray(chat.characterIds) && chat.characterIds[0]) ||
      (Array.isArray(chat.characters) && (chat.characters[0]?.id || chat.characters[0])))
    if (!charId) {
      if (chat) spindle.log.info('[lumidraw] chat DTO has no obvious character id. Keys: ' + Object.keys(chat).join(', '))
      return ''
    }
    let ch = null
    for (const args of [[charId, userId], [{ id: charId, userId }], [charId]]) {
      try { const r = await charsApi.get(...args); if (r) { ch = r; break } } catch { /* next */ }
    }
    if (!ch || typeof ch !== 'object') return ''
    for (const key of ['base_tags', 'baseTags', 'image_tags', 'imageTags', 'visual_tags', 'visualTags', 'appearance_tags', 'appearanceTags']) {
      if (typeof ch[key] === 'string' && ch[key].trim()) return ch[key].trim()
    }
    spindle.log.info('[lumidraw] character card has no tag field. Keys: ' + Object.keys(ch).join(', '))
    return ''
  } catch (e) {
    spindle.log.warn('[lumidraw] character tag fetch failed: ' + e.message)
    return ''
  }
}


// ---------------------------------------------------------------------------
// Structured subject binding compiler (v0.17)
// ---------------------------------------------------------------------------

const COUNT_TAG_RE = /^(?:[1-9]\d*)?(?:boy|girl|other|man|woman|male|female)s?$/i
const VALID_ASPECTS = new Set(['3:4', '4:3', '1:1', '9:16', '16:9'])

// Parser scene fields cannot invent genital anatomy for a saved identity.
// Conditional anatomy must come from the profile and be explicitly named in
// the source passage as well as marked visible by the parser.
const EXPLICIT_ANATOMY_RE = /\b(?:penis|penises|cock|cocks|dick|dicks|phallus|vagina|vaginas|vulva|vulvas|pussy|pussies|testicle|testicles|testes|scrotum|genital|genitals|futa|futanari)\b/i
const ANATOMY_ALIAS_GROUPS = [
  { profile: /\b(?:penis|cock|dick|phallus|male genitals?)\b/i, passage: /\b(?:penis|cock|dick|phallus|male genitals?)\b/i },
  { profile: /\b(?:vagina|vulva|pussy|female genitals?)\b/i, passage: /\b(?:vagina|vulva|pussy|female genitals?)\b/i },
  { profile: /\b(?:testicles?|testes|balls?|scrotum)\b/i, passage: /\b(?:testicles?|testes|balls?|scrotum)\b/i },
]

function normalizeIdentityText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function anatomyExplicitlyMentioned(anatomyTags, passage, anchor = '', requireOwnership = false) {
  const text = String(passage || '')
  if (!text.trim()) return false
  const owner = normalizeIdentityText(anchor).split(' ')[0]
  for (const tag of anatomyTags || []) {
    const sources = []
    for (const group of ANATOMY_ALIAS_GROUPS) {
      if (group.profile.test(String(tag || ''))) sources.push(group.passage.source)
    }
    if (!sources.length) {
      const literal = normalizeIdentityText(tag)
      if (literal) sources.push('\\b' + literal.split(/\s+/).map(escapeRegExp).join('\\s+') + '\\b')
    }
    for (const source of sources) {
      const term = new RegExp(source, 'i')
      if (!term.test(text)) continue
      if (!requireOwnership) return true
      if (!owner) continue
      const ownerEsc = escapeRegExp(owner)
      const possessive = new RegExp(`\\b${ownerEsc}(?:'s|’s)\\b[^.!?\\n]{0,48}(?:${source})`, 'i')
      const ofOwner = new RegExp(`(?:${source})[^.!?\\n]{0,32}\\b(?:of|belonging to)\\s+${ownerEsc}\\b`, 'i')
      if (possessive.test(text) || ofOwner.test(text)) return true
    }
  }
  return false
}

function removeInventedAnatomy(items) {
  return (items || []).filter((item) => !EXPLICIT_ANATOMY_RE.test(String(item || '')))
}

function scrubInventedAnatomyPhrase(value) {
  return String(value || '').replace(EXPLICIT_ANATOMY_RE, '').replace(/\s{2,}/g, ' ').trim()
}

function uniqueStrings(items) {
  const out = []
  const seen = new Set()
  for (const item of items || []) {
    const value = String(item || '').trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (!seen.has(key)) { seen.add(key); out.push(value) }
  }
  return out
}

function tagsFrom(value, maxItems = 40) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/)
  return uniqueStrings(raw.map((v) => String(v || '').trim()).filter(Boolean)).slice(0, maxItems)
}

function shortPhrase(value, label, maxWords = 10, maxChars = 96, allowEmpty = true) {
  let text = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!text && allowEmpty) return ''
  if (!text) throw new Error(`${label} is required.`)
  text = text.replace(/[.!?]+$/g, '').trim()
  if (text.length > maxChars) throw new Error(`${label} is too long (${text.length}/${maxChars} characters).`)
  if (/\r|\n/.test(text)) throw new Error(`${label} must be one short phrase, not prose.`)
  if (/[{}<>]/.test(text)) throw new Error(`${label} contains unsupported markup.`)
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length > maxWords) throw new Error(`${label} must stay under ${maxWords} words; prose is rejected.`)
  return text
}

function shortList(value, label, { maxItems = 12, maxWords = 7, maxChars = 72 } = {}) {
  const raw = Array.isArray(value) ? value : tagsFrom(value, maxItems)
  const out = []
  for (const item of raw.slice(0, maxItems)) {
    const cleaned = shortPhrase(item, label, maxWords, maxChars, true)
    if (cleaned) out.push(cleaned)
  }
  return uniqueStrings(out)
}

function normalizeAnatomyMode(value) {
  const mode = String(value || 'relevant').toLowerCase()
  return ['always', 'relevant', 'manual'].includes(mode) ? mode : 'relevant'
}

function normalizeProfile(raw, fallbackTags, fallbackRef) {
  const source = raw && typeof raw === 'object' ? raw : {}
  let appearance = tagsFrom(source.appearanceTags || fallbackTags)
  let countTag = shortPhrase(source.countTag || '', `${fallbackRef} count tag`, 3, 24, true)
  if (!countTag) {
    const found = appearance.find((tag) => COUNT_TAG_RE.test(tag))
    if (found) countTag = found
  }
  if (countTag) appearance = appearance.filter((tag) => tag.toLowerCase() !== countTag.toLowerCase())
  return {
    ref: fallbackRef,
    anchor: shortPhrase(source.anchor || '', `${fallbackRef} anchor`, 6, 64, true) || fallbackRef,
    countTag,
    subject: shortPhrase(source.subject || '', `${fallbackRef} subject phrase`, 8, 72, true),
    appearance: shortList(appearance, `${fallbackRef} appearance`, { maxItems: 32, maxWords: 7, maxChars: 72 }),
    defaultOutfit: shortList(source.defaultOutfitTags || '', `${fallbackRef} default outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    anatomy: shortList(source.anatomyTags || '', `${fallbackRef} anatomy`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    anatomyMode: normalizeAnatomyMode(source.anatomyMode),
  }
}

async function resolveProfile(profile, userId, chatId) {
  const resolveOne = async (value) => shortPhrase(await resolveMacros(value, userId, chatId), 'profile field', 10, 96, true)
  const resolveMany = async (values, label) => {
    const out = []
    for (const value of values || []) {
      const resolved = await resolveMacros(value, userId, chatId)
      out.push(...shortList(resolved, label, { maxItems: 40, maxWords: 7, maxChars: 72 }))
    }
    return uniqueStrings(out)
  }
  return {
    ...profile,
    anchor: await resolveOne(profile.anchor),
    countTag: await resolveOne(profile.countTag),
    subject: await resolveOne(profile.subject),
    appearance: await resolveMany(profile.appearance, `${profile.ref} appearance`),
    defaultOutfit: await resolveMany(profile.defaultOutfit, `${profile.ref} outfit`),
    anatomy: await resolveMany(profile.anatomy, `${profile.ref} anatomy`),
  }
}

async function getStoryProfiles(preset, settings, userId, chatId) {
  const activeCharacterTags = preset.characterTags ||
    (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
  const character = normalizeProfile(preset.characterProfile, activeCharacterTags, 'character')
  const persona = normalizeProfile(preset.personaProfile, preset.personaTags || '', 'persona')
  return {
    character: await resolveProfile(character, userId, chatId),
    persona: await resolveProfile(persona, userId, chatId),
  }
}

function parseJsonObject(text, label = 'structured scene') {
  let raw = String(text || '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error(`${label} did not contain a JSON object.`)
  raw = raw.slice(first, last + 1)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
  try { return JSON.parse(raw) }
  catch (error) { throw new Error(`${label} JSON could not be parsed: ${error.message}`) }
}

function normalizeSceneSubject(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fallbackRef = `other_${index + 1}`
  let ref = shortPhrase(source.ref || fallbackRef, `subject ${index + 1} ref`, 3, 32, false).toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!ref) ref = fallbackRef
  const known = ref === 'character' || ref === 'persona'
  return {
    ref,
    label: shortPhrase(source.label || '', `subject ${index + 1} label`, 7, 72, known),
    countTag: shortPhrase(source.count_tag || source.countTag || '', `subject ${index + 1} count tag`, 3, 24, true),
    position: shortPhrase(source.position || '', `subject ${index + 1} position`, 4, 40, true),
    appearance: shortList(source.appearance || [], `subject ${index + 1} appearance`, { maxItems: 24, maxWords: 7, maxChars: 72 }),
    outfit: shortList(source.outfit || [], `subject ${index + 1} outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    pose: shortList(source.pose || [], `subject ${index + 1} pose`, { maxItems: 10, maxWords: 7, maxChars: 72 }),
    expression: shortList(source.expression || [], `subject ${index + 1} expression`, { maxItems: 8, maxWords: 7, maxChars: 72 }),
    action: shortList(source.action || [], `subject ${index + 1} action`, { maxItems: 10, maxWords: 8, maxChars: 80 }),
    anatomyVisible: source.anatomy_visible === true || source.anatomyVisible === true,
  }
}

function normalizeScene(raw) {
  const source = raw && raw.scene && typeof raw.scene === 'object' ? raw.scene : raw
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Scene must be a JSON object.')
  const subjectsRaw = Array.isArray(source.subjects) ? source.subjects : []
  if (!subjectsRaw.length) throw new Error('Structured scene needs at least one subject.')
  if (subjectsRaw.length > 6) throw new Error('Structured scene supports at most six subjects.')
  const subjects = subjectsRaw.map(normalizeSceneSubject)
  const refs = new Set(subjects.map((subject) => subject.ref))
  if (refs.size !== subjects.length) throw new Error('Each structured subject needs a unique ref.')
  const relationsRaw = Array.isArray(source.relations) ? source.relations : []
  const relations = relationsRaw.slice(0, 8).map((relation, index) => {
    const item = relation && typeof relation === 'object' ? relation : {}
    const actor = shortPhrase(item.actor || '', `relation ${index + 1} actor`, 3, 32, false).toLowerCase().replace(/[^a-z0-9_]/g, '_')
    const target = shortPhrase(item.target || '', `relation ${index + 1} target`, 3, 32, true).toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!refs.has(actor)) throw new Error(`Relation actor “${actor}” is not one of the scene subjects.`)
    if (target && !refs.has(target)) throw new Error(`Relation target “${target}” is not one of the scene subjects.`)
    return {
      actor,
      target,
      action: shortPhrase(item.action || item.verb || '', `relation ${index + 1} action`, 9, 84, false),
      details: shortList(item.details || [], `relation ${index + 1} details`, { maxItems: 6, maxWords: 7, maxChars: 72 }),
    }
  })
  const aspectRaw = String(source.aspect || '').trim()
  return {
    subjects,
    relations,
    setting: shortList(source.setting || [], 'setting', { maxItems: 14, maxWords: 7, maxChars: 72 }),
    camera: shortList(source.camera || [], 'camera', { maxItems: 10, maxWords: 7, maxChars: 72 }),
    lighting: shortList(source.lighting || [], 'lighting', { maxItems: 10, maxWords: 7, maxChars: 72 }),
    style: shortList(source.style || [], 'style', { maxItems: 10, maxWords: 7, maxChars: 72 }),
    aspect: VALID_ASPECTS.has(aspectRaw) ? aspectRaw : '',
  }
}

function parseInlineScene(body) {
  return normalizeScene(parseJsonObject(body, 'inline scene'))
}

function parseParserScenes(text, maxImages) {
  const root = parseJsonObject(text, 'parser reply')
  if (/^\s*NONE\s*$/i.test(String(root && root.result || ''))) return []
  const items = Array.isArray(root.images) ? root.images : (root.scene ? [root] : [])
  if (!items.length) throw new Error('Parser JSON must contain an images array.')
  return items.slice(0, maxImages).map((item, index) => ({
    anchor: shortPhrase(item.anchor || '', `image ${index + 1} anchor`, 14, 120, false),
    scene: normalizeScene(item.scene || item),
  }))
}

function applyBannedToList(items, bannedCsv) {
  if (!bannedCsv) return items || []
  const banned = new Set(tagsFrom(bannedCsv).map((tag) => tag.toLowerCase()))
  return (items || []).filter((item) => !banned.has(String(item).toLowerCase()))
}

function applyBannedToScene(scene, bannedCsv) {
  if (!bannedCsv) return scene
  return {
    ...scene,
    subjects: scene.subjects.map((subject) => ({
      ...subject,
      appearance: applyBannedToList(subject.appearance, bannedCsv),
      outfit: applyBannedToList(subject.outfit, bannedCsv),
      pose: applyBannedToList(subject.pose, bannedCsv),
      expression: applyBannedToList(subject.expression, bannedCsv),
      action: applyBannedToList(subject.action, bannedCsv),
    })),
    relations: scene.relations.map((relation) => ({ ...relation, details: applyBannedToList(relation.details, bannedCsv) })),
    setting: applyBannedToList(scene.setting, bannedCsv),
    camera: applyBannedToList(scene.camera, bannedCsv),
    lighting: applyBannedToList(scene.lighting, bannedCsv),
    style: applyBannedToList(scene.style, bannedCsv),
  }
}

function profileMatchesSubject(profile, subject) {
  if (!profile || !subject) return false
  const anchor = normalizeIdentityText(profile.anchor)
  if (!anchor || anchor === 'character' || anchor === 'persona') return false
  const first = anchor.split(' ')[0]
  const candidates = [subject.label, String(subject.ref || '').replace(/_/g, ' ')]
    .map(normalizeIdentityText).filter(Boolean)
  return candidates.some((candidate) => candidate === anchor || candidate === first || anchor.startsWith(candidate + ' '))
}

function bindKnownSubjectRefs(scene, profiles) {
  const remap = new Map()
  const claimed = new Set(scene.subjects
    .filter((subject) => subject.ref === 'character' || subject.ref === 'persona')
    .map((subject) => subject.ref))
  for (const subject of scene.subjects) {
    if (subject.ref === 'character' || subject.ref === 'persona') continue
    const matches = []
    if (profileMatchesSubject(profiles.character, subject)) matches.push('character')
    if (profileMatchesSubject(profiles.persona, subject)) matches.push('persona')
    if (matches.length === 1 && !claimed.has(matches[0])) {
      remap.set(subject.ref, matches[0])
      claimed.add(matches[0])
    }
  }
  const subjects = scene.subjects.map((subject) => ({ ...subject, ref: remap.get(subject.ref) || subject.ref }))
  if (new Set(subjects.map((subject) => subject.ref)).size !== subjects.length) {
    throw new Error('Parser produced duplicate references for the same saved subject.')
  }
  const relations = scene.relations.map((relation) => ({
    ...relation,
    actor: remap.get(relation.actor) || relation.actor,
    target: relation.target ? (remap.get(relation.target) || relation.target) : '',
  }))
  return { ...scene, subjects, relations }
}

function applyAnatomyFirewall(scene) {
  const knownRefs = new Set(['character', 'persona'])
  return {
    ...scene,
    subjects: scene.subjects.map((subject) => knownRefs.has(subject.ref) ? {
      ...subject,
      appearance: [],
      outfit: removeInventedAnatomy(subject.outfit),
      pose: removeInventedAnatomy(subject.pose),
      expression: removeInventedAnatomy(subject.expression),
      action: removeInventedAnatomy(subject.action),
    } : subject),
    relations: scene.relations.map((relation) => ({
      ...relation,
      action: scrubInventedAnatomyPhrase(relation.action),
      details: removeInventedAnatomy(relation.details),
    })).filter((relation) => relation.action),
  }
}

function positionLead(position) {
  const value = String(position || '').toLowerCase()
  if (value.includes('left')) return 'On the left'
  if (value.includes('right')) return 'On the right'
  if (value.includes('foreground')) return 'In the foreground'
  if (value.includes('background')) return 'In the background'
  if (value.includes('center')) return 'In the center'
  return 'In the scene'
}

function profileForSubject(subject, profiles) {
  if (subject.ref === 'character') return profiles.character
  if (subject.ref === 'persona') return profiles.persona
  return null
}

function subjectDescriptor(subject, profiles, sourcePassage = '', requireAnatomyOwner = false) {
  const profile = profileForSubject(subject, profiles)
  const anchor = profile ? profile.anchor : (subject.label || subject.ref.replace(/_/g, ' '))
  const noun = profile ? profile.subject : subject.label
  const appearance = profile ? profile.appearance : subject.appearance
  const outfit = subject.outfit.length ? subject.outfit : (profile ? profile.defaultOutfit : [])
  const anatomyAllowed = profile && (
    profile.anatomyMode === 'always' ||
    (profile.anatomyMode === 'relevant' && subject.anatomyVisible && anatomyExplicitlyMentioned(profile.anatomy, sourcePassage, profile.anchor, requireAnatomyOwner))
  )
  const anatomy = anatomyAllowed ? profile.anatomy : []
  const countTag = profile ? profile.countTag : subject.countTag
  return { subject, profile, anchor, noun, appearance, outfit, anatomy, countTag }
}


function normalizeVisualPhrase(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text
    .replace(/hooks? the back of the knee of/gi, 'curls a bare heel behind the knee of')
    .replace(/one heel hooked behind (his|her|their) knee/gi, 'one bare heel curled behind $1 knee')
    .replace(/hooked behind (his|her|their) knee/gi, 'curled behind $1 knee')
    .replace(/hooking (his|her|their) knee/gi, 'curling a bare heel behind $1 knee')
    .replace(/sitting on counter/gi, 'sitting on the clearly visible counter edge')
    .replace(/seated on counter/gi, 'seated on the clearly visible counter edge')
}

function normalizeVisualList(list) {
  return uniqueStrings((Array.isArray(list) ? list : []).map(normalizeVisualPhrase).filter(Boolean))
}

function findSupportSurface(setting) {
  const joined = (Array.isArray(setting) ? setting.join(', ') : String(setting || '')).toLowerCase()
  const surfaces = [
    ['countertop', /countertop/],
    ['counter edge', /counter/],
    ['bar stool', /bar stool|stool/],
    ['chair', /chair/],
    ['bed', /bed/],
    ['couch', /couch|sofa/],
    ['floor', /floor/],
    ['wall', /wall/],
  ]
  for (const [label, re] of surfaces) if (re.test(joined)) return label
  return ''
}

function supportLead(item, scene) {
  const poseText = normalizeVisualList(item.subject.pose).join(', ').toLowerCase()
  if (!/(sitting|seated|perched|kneeling|leaning|lying)/.test(poseText)) return ''
  const surface = findSupportSurface(scene.setting)
  if (!surface) return ''
  if (/(sitting|seated|perched)/.test(poseText)) return `${item.anchor} is supported by the clearly visible ${surface}.`
  if (/(kneeling)/.test(poseText)) return `${item.anchor} is grounded against the clearly visible ${surface}.`
  if (/(leaning)/.test(poseText)) return `${item.anchor} braces against the clearly visible ${surface}.`
  if (/(lying)/.test(poseText)) return `${item.anchor} lies against the clearly visible ${surface}.`
  return ''
}

function compileStructuredScene(scene, profiles, sourcePassage = '') {
  const descriptors = scene.subjects.map((subject) => subjectDescriptor(subject, profiles, sourcePassage, scene.subjects.length > 1)).map((item) => ({
    ...item,
    appearance: normalizeVisualList(item.appearance),
    outfit: normalizeVisualList(item.outfit),
    anatomy: normalizeVisualList(item.anatomy),
    pose: normalizeVisualList(item.subject.pose),
    expression: normalizeVisualList(item.subject.expression),
    action: normalizeVisualList(item.subject.action),
  }))
  const countTags = uniqueStrings(descriptors.map((item) => item.countTag).filter(Boolean))
  const tailSetting = normalizeVisualList(scene.setting)
  const tailCamera = normalizeVisualList(scene.camera)
  const tailLighting = normalizeVisualList(scene.lighting)
  const tailStyle = normalizeVisualList(scene.style)

  if (descriptors.length === 1) {
    const item = descriptors[0]
    return uniqueStrings([
      ...countTags, 'solo', item.noun, ...item.appearance, ...item.anatomy,
      ...item.outfit, ...item.pose, ...item.expression,
      ...item.action, ...tailSetting, ...tailCamera, ...tailLighting, ...tailStyle,
    ]).filter(Boolean).join(', ')
  }

  const lines = []
  const heading = uniqueStrings([
    ...countTags,
    `exactly ${descriptors.length} subjects`,
    'single image', 'unified composition', 'same frame',
    'no split screen', 'no panels', 'no collage', 'no duplicate character', 'no extra characters',
  ]).filter(Boolean).join(', ')
  if (heading) lines.push(heading + '.')

  for (const item of descriptors) {
    const lead = supportLead(item, scene)
    if (lead) lines.push(lead)
  }

  const byRef = new Map(descriptors.map((item) => [item.subject.ref, item]))
  for (const relation of scene.relations) {
    const actor = byRef.get(relation.actor)
    const target = relation.target ? byRef.get(relation.target) : null
    const actorName = actor ? actor.anchor : relation.actor
    const targetName = target ? target.anchor : relation.target
    let clause = `${actorName} ${normalizeVisualPhrase(relation.action)}`.trim()
    if (targetName) clause += ` ${targetName}`
    const detailBits = normalizeVisualList(relation.details)
    if (detailBits.length) clause += `; ${detailBits.join(', ')}`
    lines.push(`Shared interaction: ${clause}.`)
  }

  for (const item of descriptors) {
    const identity = uniqueStrings([item.anchor, item.noun]).filter(Boolean).join(', ')
    const chunks = []
    if (item.appearance.length) chunks.push(item.appearance.join(', '))
    if (item.anatomy.length) chunks.push(`anatomy: ${item.anatomy.join(', ')}`)
    if (item.outfit.length) chunks.push(`wearing: ${item.outfit.join(', ')}`)
    if (item.pose.length) chunks.push(`pose: ${item.pose.join(', ')}`)
    if (item.expression.length) chunks.push(`expression: ${item.expression.join(', ')}`)
    const filteredActions = item.action.filter((part) => !scene.relations.some((relation) => relation.actor === item.subject.ref && normalizeVisualPhrase(relation.action).toLowerCase().includes(part.toLowerCase())))
    if (filteredActions.length) chunks.push(`action: ${filteredActions.join(', ')}`)
    lines.push(`${identity || 'Subject'}${chunks.length ? '; ' + chunks.join('; ') : ''}.`)
  }
  if (tailSetting.length) lines.push(`Setting: ${tailSetting.join(', ')}.`)
  if (tailCamera.length) lines.push(`Camera: ${tailCamera.join(', ')}.`)
  if (tailLighting.length) lines.push(`Lighting: ${tailLighting.join(', ')}.`)
  if (tailStyle.length) lines.push(`Style: ${tailStyle.join(', ')}.`)
  return lines.join(' ')
}

function profileSchemaHints(profiles) {
  const hints = []
  for (const ref of ['character', 'persona']) {
    const profile = profiles[ref]
    if (!profile) continue
    const label = [profile.anchor, profile.subject].filter(Boolean).join(' — ')
    hints.push(`- ref "${ref}" means ${label || ref}. Do not output permanent appearance for this ref.`)
  }
  return hints.join('\n')
}

function structuredParserSchema(maxImages, profiles) {
  return `\n\nSTRICT OUTPUT CONTRACT — this overrides any conflicting formatting request above.
Return ONLY one compact JSON object, no markdown and no prose:
{"images":[{"anchor":"5-12 exact consecutive words copied from the passage","scene":{"subjects":[{"ref":"character|persona|other_1","label":"required only for other refs","count_tag":"1girl|1boy|1other etc","position":"left|right|center|foreground|background","appearance":["other subjects only"],"outfit":["short tags"],"pose":["short tags"],"expression":["short tags"],"action":["short tags"],"anatomy_visible":false}],"relations":[{"actor":"subject ref","action":"short action phrase","target":"subject ref","details":["short tags"]}],"setting":["short tags"],"camera":["short tags"],"lighting":["short tags"],"style":["short tags"],"aspect":"3:4|4:3|1:1|9:16|16:9"}}]}
Return at most ${maxImages} image object(s). If no image is warranted, return {"images":[]}.
Every array value must be a terse image tag or phrase of at most 7 words. Never write a descriptive paragraph. Never include permanent appearance for ref "character" or "persona"; LumiDraw inserts their locked profiles. A relation actor performs its action on the target; use active visual wording such as "bites the jaw of", never passive wording. Set anatomy_visible true only when the passage explicitly names and visibly depicts that subject's saved anatomy; sexual context, lowered clothing, arousal, nudity, or post-sex context alone are not enough. Never place genital/anatomy terms in appearance, outfit, pose, expression, action, relation action, or details. LumiDraw alone controls saved anatomy.
Known subject refs:\n${profileSchemaHints(profiles)}`
}

async function compileSceneWithPreset(sceneInput, preset, settings, userId, chatId, sourcePassage = '') {
  const rawProfiles = await getStoryProfiles(preset, settings, userId, chatId)
  const filterProfile = (profile) => ({
    ...profile,
    appearance: applyBannedToList(profile.appearance, preset.bannedTags),
    defaultOutfit: applyBannedToList(profile.defaultOutfit, preset.bannedTags),
    anatomy: applyBannedToList(profile.anatomy, preset.bannedTags),
  })
  const profiles = { character: filterProfile(rawProfiles.character), persona: filterProfile(rawProfiles.persona) }
  let scene = normalizeScene(sceneInput)
  scene = bindKnownSubjectRefs(scene, profiles)
  scene = applyAnatomyFirewall(scene)
  scene = applyBannedToScene(scene, preset.bannedTags)
  const core = compileStructuredScene(scene, profiles, sourcePassage)
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  const prompt = [preset.qualityTags, prefix, core].filter(Boolean).join(', ')
  return { prompt, core, scene, profiles, aspect: scene.aspect }
}

async function compileInlineBody(body, preset, settings, userId, chatId) {
  const resolved = await resolveMacros(body, userId, chatId)
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  const charTags = preset.characterTags || (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
  const lead = [preset.qualityTags, charTags].filter(Boolean).join(', ')
  const core = stripBannedTags(resolved, preset.bannedTags)
  return { prompt: [lead, prefix, core].filter(Boolean).join(', '), core, scene: null, profiles: null, aspect: '', format: 'legacy-inline' }
}

async function quietLLM(system, user, settings, userId, structured = false) {
  const candidates = []
  const g = spindle.generation || spindle.llm || spindle.generate
  if (g) {
    if (typeof g.quiet === 'function') candidates.push(['generation.quiet', (o) => g.quiet(o)])
    if (typeof g.generate === 'function') candidates.push(['generation.generate', (o) => g.generate(o)])
    if (typeof g.raw === 'function') candidates.push(['generation.raw', (o) => g.raw(o)])
    if (typeof g === 'function') candidates.push(['generate()', (o) => g(o)])
  }
  if (typeof spindle.quietGenerate === 'function') candidates.push(['quietGenerate', (o) => spindle.quietGenerate(o)])
  if (!candidates.length) {
    throw new Error('No LLM generation API found. spindle surface: ' + Object.keys(spindle).join(', ') +
      ' — send me this list and I will pin the parser call.')
  }
  // The host's generate API reads the prompt field (system/messages shapes
  // were observed to be ignored), so the instruction rides inside the prompt
  // itself — stated before the passage and reinforced after it.
  const finalReminder = structured
    ? '\n----- END PASSAGE -----\n\nReturn only the compact JSON object required above. No prose, no markdown fences, no explanations.'
    : '\n----- END PASSAGE -----\n\nNow respond with ONLY the output the instruction above requires, formatted as one line per image:\n<short verbatim anchor quote of 5-12 words copied exactly from the passage> ||| <comma-separated tag prompt>\nThe anchor marks where in the passage the image belongs. No prose, no explanations, nothing else.'
  const combined = system +
    '\n\n----- STORY PASSAGE -----\n' + user +
    finalReminder
  const opts = {
    userId,
    prompt: combined,
    system,
    messages: [{ role: 'user', content: combined }],
  }
  if (settings.parserConnection) { opts.connection = settings.parserConnection; opts.connectionId = settings.parserConnection }
  if (settings.parserModel) opts.model = settings.parserModel
  const errs = []
  for (const [name, fn] of candidates) {
    try {
      let res
      try { res = await fn(opts) }
      catch (e1) {
        if (/userId/i.test(e1.message || '')) res = await fn(opts, userId)
        else throw e1
      }
      const text = (res && (res.text || res.content ||
        (res.choices && res.choices[0] && (res.choices[0].text || (res.choices[0].message && res.choices[0].message.content))))) ||
        (typeof res === 'string' ? res : null)
      if (text) {
        spindle.log.info('[lumidraw] parser via ' + name + ' → raw reply: ' + text.trim().slice(0, 500))
        return text.trim()
      }
      errs.push(`${name}: unrecognized response shape (${res ? Object.keys(res).join(',') : res})`)
    } catch (e) { errs.push(`${name}: ${e.message}`) }
  }
  throw new Error('Parser LLM call failed: ' + errs.join(' | '))
}

let storyScanInFlight = false

async function scanStory(userId, options = {}) {
  if (storyScanInFlight) {
    return {
      mode: 'busy',
      processed: 0,
      skipped: true,
      note: 'A story scan is already running. LumiDraw skipped this duplicate request.',
    }
  }
  storyScanInFlight = true
  try {
    return await scanStoryCore(userId, options)
  } finally {
    storyScanInFlight = false
  }
}

async function scanStoryCore(userId, options = {}) {
  // Keep compatibility with older internal callers that passed a boolean.
  if (typeof options === 'boolean') options = { force: options }
  const force = !!options.force
  const requestedMessageId = options.messageId === undefined || options.messageId === null
    ? ''
    : String(options.messageId)
  const settings = await getSettings()
  if (settings.mode === 'off') return { mode: 'off', note: 'Story illustrations is set to Off — choose Inline or Parser in the Settings tab (it saves automatically now).' }
  const presets = await getPresets()
  const preset = presets.find((p) => p.name === settings.activePreset)
  if (!preset) {
    return { mode: settings.mode, note: 'No active preset selected — pick one in the Generate tab first.' }
  }

  const { messages, chatId } = await fetchMessages(userId)
  let target = null
  if (requestedMessageId) {
    for (const message of messages) {
      const bits = messageBits(message)
      if (String(bits.id) === requestedMessageId && bits.isAssistant && bits.contentKey && typeof bits.content === 'string') {
        target = bits
        break
      }
    }
    if (!target) {
      return { mode: settings.mode, note: 'That story message could not be found. Reopen the message picker and try again.' }
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const bits = messageBits(messages[i])
      if (bits.isAssistant && bits.contentKey && typeof bits.content === 'string') { target = bits; break }
    }
  }
  if (!target) return { mode: settings.mode, note: 'No story message found.' }

  // ------------------------- inline: process <dt-image> tags ---------------
  const visibleContent = stripParserTrigger(stripThinking(target.content))
  const tags = [...visibleContent.matchAll(TAG_RE)].slice(0, settings.maxImages || 2)
  if (tags.length) {
    let content = target.content
    let done = 0
    const debugEntries = []
    for (const m of tags) {
      const attrs = m[1] || ''
      const body = (m[2] || '').trim()
      if (!body) continue
      try {
        const compiled = await compileInlineBody(body, preset, settings, userId, chatId)
        const tagAspect = (/aspect\s*=\s*"([^"]+)"/.exec(attrs) || [])[1]
        const dims = aspectDims(preset.config, tagAspect || compiled.aspect)
        const fp = tagFingerprint(body)
        // wait up to 90s for a streaming pregeneration already underway
        for (let w = 0; w < 90 && pregenInflight.has(fp); w++) {
          await new Promise((r) => setTimeout(r, 1000))
        }
        let entry = pregenCache.get(fp)
        if (entry) {
          pregenCache.delete(fp)
          spindle.log.info('[lumidraw] used pregenerated image for tag')
        } else {
          entry = await generateAndUpload({
            prompt: compiled.prompt,
            negativePrompt: preset.negativePrompt,
            config: preset.config,
            extra: preset.extra,
            dims,
          }, userId)
        }
        const md = `![${compiled.core.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`
        content = content.replace(m[0], md)
        debugEntries.push({
          format: compiled.format,
          raw: body,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
        })
        done++
      } catch (e) {
        spindle.log.warn('[lumidraw] tag generation failed: ' + e.message)
        content = content.replace(m[0], `*[image failed: ${e.message.slice(0, 120)}]*`)
        debugEntries.push({ format: 'rejected', raw: body, error: e.message })
      }
    }
    await updateMessageContent(target.id, target.contentKey, content, userId, chatId)
    const storyDebug = await saveStoryDebug({
      mode: 'inline',
      subjectBinding: false,
      entries: debugEntries,
      lastCompiledPrompt: debugEntries.find((entry) => entry.compiledPrompt)?.compiledPrompt || '',
    })
    return { mode: 'inline', processed: done, note: `${done}/${tags.length} tag(s) illustrated.`, storyDebug }
  }

  // ------------------------- parser: derive a prompt from prose -------------
  if (settings.mode === 'parser') {
    if (!force && target.id && await wasProcessed(target.id)) {
      return { mode: 'parser', note: 'This message was already illustrated — choose it again to force another parser run.' }
    }
    const usingCustom = !!(settings.parserInstruction && settings.parserInstruction.trim())
    const passage = stripParserTrigger(stripThinking(target.content)).replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(-6000)

    if (settings.subjectBinding !== false) {
      const profiles = await getStoryProfiles(preset, settings, userId, chatId)
      const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
        .replaceAll('{{max_images}}', String(settings.maxImages || 2))
      const resolvedGuidance = await resolveMacros(guidance, userId, chatId)
      const instruction = resolvedGuidance + structuredParserSchema(settings.maxImages || 2, profiles)
      const instrLabel = usingCustom ? `custom guidance + structured compiler (${instruction.length} chars)` : 'structured subject compiler'
      const out = await quietLLM(instruction, passage, settings, userId, true)
      let parsed
      try {
        parsed = parseParserScenes(out, settings.maxImages || 2)
      } catch (error) {
        const storyDebug = await saveStoryDebug({
          mode: 'parser',
          subjectBinding: true,
          rawReply: out,
          error: error.message,
          entries: [],
          lastCompiledPrompt: '',
        })
        if (PARSER_TRIGGER_RE.test(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
        return {
          mode: 'parser',
          note: `Parser returned invalid structured data — nothing generated (no cost). ${error.message} Raw start: ${out.slice(0, 140)}`,
          storyDebug,
        }
      }
      if (!parsed.length) {
        if (PARSER_TRIGGER_RE.test(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
        if (target.id) await markProcessed(target.id)
        const storyDebug = await saveStoryDebug({ mode: 'parser', subjectBinding: true, rawReply: out, entries: [], lastCompiledPrompt: '' })
        return { mode: 'parser', note: `Parser (${instrLabel}) judged no visual moment.`, storyDebug }
      }

      const mds = []
      const debugEntries = []
      for (const item of parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2)))) {
        const compiled = await compileSceneWithPreset(item.scene, preset, settings, userId, chatId, passage)
        const dims = aspectDims(preset.config, compiled.aspect)
        const entry = await generateAndUpload({
          prompt: compiled.prompt,
          negativePrompt: preset.negativePrompt,
          config: preset.config,
          extra: preset.extra,
          dims,
        }, userId)
        mds.push(`![${compiled.core.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`)
        debugEntries.push({
          anchor: item.anchor,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
        })
      }

      let newContent = target.content
      const topMds = []
      const generatedParsed = parsed.slice(0, mds.length)
      for (let i = 0; i < mds.length; i++) {
        const anchor = generatedParsed[i] ? generatedParsed[i].anchor : ''
        let placed = false
        if (anchor && anchor.length >= 5) {
          let idx = newContent.indexOf(anchor)
          if (idx < 0) idx = newContent.toLowerCase().indexOf(anchor.toLowerCase())
          if (idx >= 0) {
            let paraEnd = newContent.indexOf('\n\n', idx)
            if (paraEnd < 0) paraEnd = newContent.length
            newContent = newContent.slice(0, paraEnd) + '\n\n' + mds[i] + newContent.slice(paraEnd)
            placed = true
          }
        }
        if (!placed) topMds.push(mds[i])
      }
      if (topMds.length) newContent = `${topMds.join('\n\n')}\n\n${newContent}`
      newContent = stripParserTrigger(newContent)
      newContent = stripParserTrigger(newContent)
    await updateMessageContent(target.id, target.contentKey, newContent, userId, chatId)
      if (target.id) await markProcessed(target.id)
      const storyDebug = await saveStoryDebug({
        mode: 'parser',
        subjectBinding: true,
        rawReply: out,
        entries: debugEntries,
        lastCompiledPrompt: debugEntries[0]?.compiledPrompt || '',
      })
      return {
        mode: 'parser',
        processed: mds.length,
        note: `Illustrated ${mds.length} moment(s) via ${instrLabel}. First compiled prompt: ${(debugEntries[0]?.compiledPrompt || '').slice(0, 120)}`,
        storyDebug,
      }
    }

    // Legacy parser compatibility: the old tag-only parser remains available
    // behind the Subject binding toggle for comparison and rollback.
    let instruction = (settings.parserInstruction || LEGACY_DEFAULT_PARSER_INSTRUCTION)
      .replaceAll('{{max_images}}', String(settings.maxImages || 2))
    if (preset.personaTags) {
      instruction += '\n\nUser/persona visual tags — use ONLY when the User is visibly present in the chosen moment, and only the visible parts (respect POV): ' + preset.personaTags
    }
    const instrLabel = usingCustom ? `custom instruction (${instruction.length} chars)` : 'legacy tag instruction'
    const out = await quietLLM(await resolveMacros(instruction, userId, chatId), passage, settings, userId, false)
    if (/^\s*NONE\s*$/i.test(out)) {
      if (PARSER_TRIGGER_RE.test(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
      if (target.id) await markProcessed(target.id)
      return { mode: 'parser', note: `Parser (${instrLabel}) judged no visual moment (NONE).` }
    }
    const looksLikeTags = (line) => {
      const commas = (line.match(/,/g) || []).length
      const words = line.split(/\s+/).length
      return commas >= 3 && words / (commas + 1) <= 4
    }
    const allLines = out.split('\n').map((line) => line.replace(/^["'`\s]+|["'`\s]+$/g, ''))
      .filter((line) => line && !/^NONE$/i.test(line))
    const parsed = allLines.map((line) => {
      const parts = line.split('|||')
      if (parts.length >= 2) return { anchor: parts[0].trim().replace(/^["'`]+|["'`]+$/g, ''), tags: parts.slice(1).join('|||').trim() }
      return { anchor: '', tags: line }
    }).filter((item) => looksLikeTags(item.tags)).slice(0, settings.maxImages || 2)
    if (!parsed.length) {
      if (PARSER_TRIGGER_RE.test(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
      return { mode: 'parser', note: `Parser (${instrLabel}) returned prose instead of tags — nothing generated (no cost). Raw start: ` + out.slice(0, 160) }
    }
    const lines = parsed.map((item) => stripBannedTags(item.tags, preset.bannedTags)).filter(Boolean)
    const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
    const charTags = preset.characterTags || (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
    const lead = [preset.qualityTags, charTags].filter(Boolean).join(', ')
    const mds = []
    let firstPrompt = ''
    for (const line of lines) {
      const prompt = [lead, prefix, line].filter(Boolean).join(', ')
      if (!firstPrompt) firstPrompt = line
      const entry = await generateAndUpload({
        prompt,
        negativePrompt: preset.negativePrompt,
        config: preset.config,
        extra: preset.extra,
      }, userId)
      mds.push(`![${line.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`)
    }
    let newContent = target.content
    const topMds = []
    for (let i = 0; i < mds.length; i++) {
      const anchor = parsed[i] ? parsed[i].anchor : ''
      let placed = false
      if (anchor && anchor.length >= 5) {
        let idx = newContent.indexOf(anchor)
        if (idx < 0) idx = newContent.toLowerCase().indexOf(anchor.toLowerCase())
        if (idx >= 0) {
          let paraEnd = newContent.indexOf('\n\n', idx)
          if (paraEnd < 0) paraEnd = newContent.length
          newContent = newContent.slice(0, paraEnd) + '\n\n' + mds[i] + newContent.slice(paraEnd)
          placed = true
        }
      }
      if (!placed) topMds.push(mds[i])
    }
    if (topMds.length) newContent = `${topMds.join('\n\n')}\n\n${newContent}`
    await updateMessageContent(target.id, target.contentKey, newContent, userId, chatId)
    if (target.id) await markProcessed(target.id)
    const storyDebug = await saveStoryDebug({
      mode: 'parser', subjectBinding: false, rawReply: out,
      entries: parsed.map((item, index) => ({ anchor: item.anchor, compiledPrompt: [lead, prefix, lines[index]].filter(Boolean).join(', ') })),
      lastCompiledPrompt: [lead, prefix, lines[0]].filter(Boolean).join(', '),
    })
    return { mode: 'parser', processed: mds.length, note: `Illustrated ${mds.length} moment(s) via ${instrLabel}. First prompt: ` + firstPrompt.slice(0, 120), storyDebug }
  }

  return { mode: settings.mode, note: 'No <dt-image> tags in the selected story message.' }
}

// ---------------------------------------------------------------------------
// Model catalog: remembered from every sync/preset, plus optional fs scan of
// Draw Things' models folder (backend runs on the same Mac).
// ---------------------------------------------------------------------------

const MODELS_FILE = 'models.json'

async function rememberModels(config) {
  const known = await spindle.storage.getJson(MODELS_FILE, { fallback: { models: [], samplers: [], loras: [] } })
  const addTo = (arr, v) => { if (v && !arr.includes(v)) arr.push(v) }
  addTo(known.models, config.model)
  addTo(known.models, config.refiner_model)
  addTo(known.samplers, config.sampler)
  for (const l of config.loras || []) addTo(known.loras, l.file || l.name || l)
  await spindle.storage.setJson(MODELS_FILE, known, { indent: 2 })
}

async function rememberCatalog({ models = [], samplers = [], loras = [] }) {
  const known = await spindle.storage.getJson(MODELS_FILE, { fallback: { models: [], samplers: [], loras: [] } })
  known.models = uniqueByLower([...(known.models || []), ...models])
  known.samplers = uniqueByLower([...(known.samplers || []), ...samplers])
  known.loras = uniqueByLower([...(known.loras || []), ...loras])
  await spindle.storage.setJson(MODELS_FILE, known, { indent: 2 })
  return known
}

async function buildCatalog(settings, { refresh = false } = {}) {
  let bridgeCatalog = null
  let bridgeError = null
  try {
    bridgeCatalog = await getBridgeCatalog(settings, refresh)
  } catch (err) {
    bridgeError = err.message
    spindle.log.warn('[lumidraw] Bridge catalog unavailable: ' + bridgeError)
  }

  const currentRecipe = bridgeCatalog && bridgeCatalog.currentDrawThingsRecipe
  const currentModelSet = new Set([currentRecipe && currentRecipe.model].filter(Boolean).map((v) => String(v).toLowerCase()))
  const bridgeModels = bridgeCatalog
    ? (bridgeCatalog.models || []).filter((item) => looksLikeImageModel(item, currentModelSet)).map((item) => item.file || item.name)
    : []
  const bridgeLoras = bridgeCatalog
    ? (bridgeCatalog.loras || []).map((item) => item.file || item.name)
    : []
  const bridgeSamplers = uniqueByLower([
    currentRecipe && currentRecipe.sampler,
    ...((bridgeCatalog && bridgeCatalog.samplers) || []),
  ])

  const optionSamplers = await dtSamplerCandidates(settings)
  let known = await spindle.storage.getJson(MODELS_FILE, { fallback: { models: [], samplers: [], loras: [] } })
  if (bridgeCatalog || optionSamplers.length) {
    known = await rememberCatalog({ models: bridgeModels, loras: bridgeLoras, samplers: [...bridgeSamplers, ...optionSamplers] })
  }

  const models = uniqueByLower([
    currentRecipe && currentRecipe.model,
    ...bridgeModels,
    ...(known.models || []),
  ]).sort((a, b) => a.localeCompare(b))
  const loras = uniqueByLower([
    ...bridgeLoras,
    ...((currentRecipe && currentRecipe.loras) || []),
    ...(known.loras || []),
  ]).sort((a, b) => a.localeCompare(b))
  const samplers = uniqueByLower([
    currentRecipe && currentRecipe.sampler,
    ...optionSamplers,
    ...(known.samplers || []),
    ...DEFAULT_SAMPLERS,
  ])

  return {
    models: models.map((file) => ({ file, name: file })),
    samplers,
    loras,
    source: bridgeCatalog ? 'bridge+memory' : 'memory',
    currentRecipe: currentRecipe || null,
    bridge: {
      connected: !!bridgeCatalog,
      url: bridgeBaseUrl(settings),
      version: bridgeCatalog && bridgeCatalog.version,
      generatedAt: bridgeCatalog && bridgeCatalog.generatedAt,
      filesystemReadable: !!(bridgeCatalog && bridgeCatalog.access && bridgeCatalog.access.filesystemReadable),
      rawCounts: (bridgeCatalog && bridgeCatalog.summary) || null,
      filteredModelCount: bridgeModels.length,
      loraCount: bridgeLoras.length,
      error: bridgeError,
    },
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function ok(payload, requestId, data) {
  return { type: `${payload.type}:result`, requestId, ok: true, ...data }
}

function fail(payload, requestId, err) {
  const message = (err && err.message) || String(err)
  spindle.log.warn(`[lumidraw] ${payload.type} failed: ${message}`)
  return { type: `${payload.type}:result`, requestId, ok: false, error: message }
}

let lastUserId = null

spindle.onFrontendMessage(async (payload, userId) => {
  if (userId) lastUserId = userId
  const requestId = payload && payload.requestId
  let reply
  try {
    switch (payload && payload.type) {
      case 'init': {
        const [settings, presets, history, storyDebug] = await Promise.all([
          getSettings(), getPresets(), getHistory(), getStoryDebug(),
        ])
        reply = ok(payload, requestId, {
          settings, presets, history, storyDebug, lastAutoStatus,
          version: (spindle.manifest && spindle.manifest.version) || '0.17.3',
          defaults: { protocol: DEFAULT_PROTOCOL, parserInstruction: DEFAULT_PARSER_INSTRUCTION },
        })
        break
      }

      case 'save_settings': {
        const prev = await getSettings()
        const settings = {
          ...prev,
          host: String(payload.host || prev.host || DEFAULT_SETTINGS.host).trim(),
          port: Number(payload.port) || prev.port || DEFAULT_SETTINGS.port,
        }
        for (const k of ['mode', 'parserConnection', 'parserModel', 'parserInstruction', 'protocol', 'dtModelsPath', 'bridgeHost']) {
          if (payload[k] !== undefined) settings[k] = String(payload[k])
        }
        if (payload.bridgePort !== undefined) settings.bridgePort = Number(payload.bridgePort) || DEFAULT_SETTINGS.bridgePort
        if (payload.autoScan !== undefined) settings.autoScan = !!payload.autoScan
        if (payload.autoCharTags !== undefined) settings.autoCharTags = !!payload.autoCharTags
        if (payload.subjectBinding !== undefined) settings.subjectBinding = !!payload.subjectBinding
        if (payload.maxImages !== undefined) {
          settings.maxImages = Math.max(1, Math.min(4, Number(payload.maxImages) || 2))
        }
        if (payload.minImages !== undefined) {
          settings.minImages = Math.max(0, Math.min(4, Number(payload.minImages) || 0))
        }
        await spindle.storage.setJson(SETTINGS_FILE, settings, { indent: 2 })
        reply = ok(payload, requestId, { settings })
        break
      }

      case 'set_active_preset': {
        const prev = await getSettings()
        prev.activePreset = String(payload.name || '')
        await spindle.storage.setJson(SETTINGS_FILE, prev, { indent: 2 })
        reply = ok(payload, requestId, { activePreset: prev.activePreset })
        break
      }

      case 'diagnose': {
        const report = {}
        const chatId = await resolveActiveChatId(userId)
        report.chatIdResolved = !!chatId

        // 1) Macro probe: resolve a battery of candidate names with context
        const probeNames = ['char', 'character', 'char_prompt', 'character_prompt',
          'char_tags', 'char_image_tags', 'character_tags', 'image_tags',
          'char_visual', 'appearance', 'persona', 'persona_prompt', 'persona_tags', 'user']
        const probe = probeNames.map((n) => `${n}=[{{${n}}}]`).join('\n')
        try {
          report.macroProbe = await resolveMacros(probe, userId, chatId)
        } catch (e) { report.macroProbe = 'probe failed: ' + e.message }
        report.macroApiMethods = spindle.macros ? Object.keys(spindle.macros) : null
        for (const listFn of ['list', 'getAll', 'available', 'names']) {
          if (spindle.macros && typeof spindle.macros[listFn] === 'function') {
            try {
              const r = await spindle.macros[listFn](chatId ? { chatId, userId } : undefined)
              report['macros.' + listFn] = Array.isArray(r) ? r.slice(0, 80) : r
            } catch (e) { report['macros.' + listFn] = 'error: ' + e.message }
          }
        }

        // 2) Active character DTO fields (string fields previewed)
        try {
          const chars = spindle.characters
          let ch = null
          const tries = [
            () => chars && typeof chars.getActive === 'function' && chars.getActive(userId),
            () => chars && typeof chars.getActive === 'function' && chars.getActive({ chatId, userId }),
            () => chars && typeof chars.getForChat === 'function' && chars.getForChat(chatId, userId),
            () => chars && typeof chars.get === 'function' && chars.get({ chatId, userId }),
          ]
          for (const t of tries) {
            try { const r = await t(); if (r) { ch = Array.isArray(r) ? r[0] : r; break } } catch { /* next */ }
          }
          if (ch && typeof ch === 'object') {
            const fields = {}
            for (const [k, v] of Object.entries(ch)) {
              if (typeof v === 'string') fields[k] = v.length > 120 ? v.slice(0, 120) + `…(${v.length})` : v
              else if (v && typeof v === 'object') fields[k] = '<' + (Array.isArray(v) ? 'array:' + v.length : 'object: ' + Object.keys(v).slice(0, 10).join(',')) + '>'
              else fields[k] = String(v)
            }
            report.character = fields
          } else {
            report.character = 'not found. characters API methods: ' + (chars ? Object.keys(chars).join(', ') : 'none')
          }
        } catch (e) { report.character = 'error: ' + e.message }

        // 2b) Native Image Gen + personas surfaces (where character prompt
        // presets likely live, per Swarm Studio's hydration feature)
        report.imageGenApiMethods = spindle.imageGen ? Object.keys(spindle.imageGen) : null
        for (const fn of ['getConfig', 'getSettings', 'getState', 'getPresets', 'getCharacterPrompts', 'getPromptPresets', 'listPresets', 'getConnections']) {
          if (spindle.imageGen && typeof spindle.imageGen[fn] === 'function') {
            try {
              const r = await spindle.imageGen[fn](userId)
              report['imageGen.' + fn] = typeof r === 'object' && r ? Object.keys(r).slice(0, 30) : String(r).slice(0, 200)
            } catch (e) { report['imageGen.' + fn] = 'error: ' + e.message }
          }
        }
        report.presetsApiMethods = spindle.presets ? Object.keys(spindle.presets) : null
        report.charactersApiMethods = spindle.characters ? Object.keys(spindle.characters) : null
        report.personasApiMethods = spindle.personas ? Object.keys(spindle.personas) : null

        // 3) Connections (for the parser picker)
        try {
          const conns = spindle.connections
          report.connectionsApiMethods = conns ? Object.keys(conns) : null
          for (const fn of ['list', 'getAll', 'get']) {
            if (conns && typeof conns[fn] === 'function') {
              try {
                const r = await conns[fn](userId)
                const arr = Array.isArray(r) ? r : (r && (r.connections || r.items))
                if (Array.isArray(arr)) {
                  report.connections = arr.slice(0, 20).map((c) => ({
                    id: c.id || c.connectionId, name: c.name || c.label, model: c.model || c.defaultModel,
                  }))
                  break
                }
              } catch (e) { report['connections.' + fn] = 'error: ' + e.message }
            }
          }
        } catch (e) { report.connections = 'error: ' + e.message }

        reply = ok(payload, requestId, { report: JSON.stringify(report, null, 2) })
        break
      }

      case 'list_connections': {
        let out = []
        try {
          const conns = spindle.connections
          for (const args of [[userId], [{ userId }], []]) {
            try {
              const r = await conns.list(...args)
              const arr = Array.isArray(r) ? r : (r && (r.connections || r.items))
              if (Array.isArray(arr)) {
                out = arr.map((c) => ({ id: c.id || c.connectionId, name: c.name || c.label || '(unnamed)', model: c.model || c.defaultModel || '' }))
                break
              }
            } catch { /* next */ }
          }
        } catch { /* leave empty */ }
        reply = ok(payload, requestId, { connections: out })
        break
      }


      case 'parser_trigger': {
        reply = ok(payload, requestId, { accepted: true })
        setTimeout(async () => {
          try {
            const settings = await getSettings()
            if (settings.mode !== 'parser' || settings.autoScan === false) return
            setAutoStatus(userId, { mode: 'parser', status: 'running', note: 'Parser trigger received — scanning latest story message…' })
            const r = await scanStory(userId, { force: false })
            const status = r && r.processed ? 'generated' : (r && /already illustrated|no visual moment|No story message found|No <dt-image>/i.test(r.note || '') ? 'idle' : 'done')
            setAutoStatus(userId, { mode: 'parser', status, note: (r && r.note) || '' })
          } catch (e) {
            spindle.log.warn('[lumidraw] parser trigger failed: ' + e.message)
            setAutoStatus(userId, { mode: 'parser', status: 'error', note: e.message })
          }
        }, 1200)
        break
      }

      case 'pregenerate': {
        // Fired by the frontend streaming tag interceptor the moment a
        // <dt-image> tag completes mid-reply: start Draw Things early so the
        // image is ready when the message finishes.
        const body = String(payload.body || '').trim()
        const aspect = payload.aspect || ''
        if (!body) { reply = ok(payload, requestId, { started: false }); break }
        const fp = tagFingerprint(body)
        if (pregenCache.has(fp) || pregenInflight.has(fp)) { reply = ok(payload, requestId, { started: false, dup: true }); break }
        const settings = await getSettings()
        const presets = await getPresets()
        const preset = presets.find((p) => p.name === settings.activePreset)
        if (!preset || settings.mode !== 'inline') { reply = ok(payload, requestId, { started: false }); break }
        pregenInflight.add(fp)
        reply = ok(payload, requestId, { started: true })
        ;(async () => {
          try {
            const chatId = await resolveActiveChatId(userId)
            const compiled = await compileInlineBody(body, preset, settings, userId, chatId)
            const dims = aspectDims(preset.config, aspect || compiled.aspect)
            const entry = await generateAndUpload({
              prompt: compiled.prompt, negativePrompt: preset.negativePrompt, config: preset.config, extra: preset.extra, dims,
            }, userId)
            pregenCache.set(fp, entry)
            if (pregenCache.size > 8) pregenCache.delete(pregenCache.keys().next().value)
            spindle.log.info('[lumidraw] pregenerated image for streaming tag (' + fp.slice(0, 60) + '…)')
          } catch (e) {
            spindle.log.warn('[lumidraw] pregeneration failed: ' + e.message)
          } finally { pregenInflight.delete(fp) }
        })()
        break
      }

      case 'list_models': {
        const presets = await getPresets()
        for (const p of presets) { try { await rememberModels(p.config || {}) } catch { /* ok */ } }
        const history = await getHistory()
        for (const h of history) { try { await rememberModels({ model: h.model }) } catch { /* ok */ } }
        const settings = await getSettings()
        const catalog = await buildCatalog(settings, { refresh: !!payload.refresh })
        reply = ok(payload, requestId, catalog)
        break
      }

      case 'test_bridge': {
        const settings = await getSettings()
        const health = await bridgeFetch(settings, '/health', {}, 8000)
        reply = ok(payload, requestId, { health, url: bridgeBaseUrl(settings) })
        break
      }

      case 'list_story_messages': {
        const result = await listStoryMessages(userId, payload.limit)
        reply = ok(payload, requestId, result)
        break
      }

      case 'scan_story': {
        const result = await scanStory(userId, {
          force: !!payload.force,
          messageId: payload.messageId,
        })
        reply = ok(payload, requestId, result)
        break
      }

      case 'test_connection': {
        const settings = await getSettings()
        const config = await dtCurrentConfig(settings)
        reply = ok(payload, requestId, {
          model: config.model || '(none reported)',
          sampler: config.sampler || '',
        })
        break
      }

      case 'sync_state': {
        // Reads whatever recipe Draw Things is currently showing (the settings
        // of the selected image / workspace) and returns the preset-relevant
        // slice plus the full config for reference.
        const settings = await getSettings()
        const config = await dtCurrentConfig(settings)
        const captured = {}
        for (const key of PRESET_KEYS) {
          if (config[key] !== undefined) captured[key] = config[key]
        }
        try { await rememberModels(captured) } catch { /* best-effort */ }
        reply = ok(payload, requestId, { captured, fullConfig: config })
        break
      }

      case 'save_preset': {
        const name = String(payload.name || '').trim()
        if (!name) throw new Error('Preset needs a name.')
        if (!payload.config || !payload.config.model) {
          throw new Error('Preset has no model — sync from Draw Things first.')
        }
        const presets = await getPresets()
        const preset = {
          name,
          config: payload.config,
          extra: payload.extra || null,
          promptPrefix: payload.promptPrefix || '',
          negativePrompt: payload.negativePrompt || '',
          qualityTags: payload.qualityTags || '',
          characterTags: payload.characterTags || '',
          personaTags: payload.personaTags || '',
          characterProfile: payload.characterProfile && typeof payload.characterProfile === 'object' ? payload.characterProfile : null,
          personaProfile: payload.personaProfile && typeof payload.personaProfile === 'object' ? payload.personaProfile : null,
          bannedTags: payload.bannedTags || '',
          updatedAt: Date.now(),
        }
        try { await rememberModels(preset.config || {}) } catch { /* best-effort */ }
        const idx = presets.findIndex((p) => p.name === name)
        if (idx >= 0) presets[idx] = preset
        else presets.push(preset)
        presets.sort((a, b) => a.name.localeCompare(b.name))
        await savePresets(presets)
        reply = ok(payload, requestId, { presets })
        break
      }

      case 'delete_preset': {
        const presets = (await getPresets()).filter((p) => p.name !== payload.name)
        await savePresets(presets)
        reply = ok(payload, requestId, { presets })
        break
      }

      case 'generate': {
        const settings = await getSettings()
        let manualPrompt = payload.prompt || ''
        manualPrompt = [payload.qualityTags, payload.characterTags, manualPrompt].filter(Boolean).join(', ')
        manualPrompt = await resolveMacros(manualPrompt, userId, await resolveActiveChatId(userId))
        const payloadOut = buildPayload({
          prompt: manualPrompt,
          negativePrompt: payload.negativePrompt,
          seed: payload.seed,
          config: payload.config,
          extra: payload.extra,
        })
        if (!payloadOut.model) {
          throw new Error('No model set — sync from Draw Things or pick a preset first.')
        }
        const started = Date.now()
        const images = await dtGenerate(settings, payloadOut)

        // Persist to Lumiverse's image library (tagged to this extension).
        // Operator-scoped installs require an explicit userId on user-owned
        // resources; try both accepted call shapes.
        const uploads = []
        for (const b64 of images) {
          const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
          const opts = {
            data: bytes,
            filename: `lumidraw-${Date.now()}.png`,
            mime_type: 'image/png',
          }
          let dto
          try {
            dto = await spindle.images.upload({ ...opts, userId })
          } catch (eA) {
            try {
              dto = await spindle.images.upload(opts, userId)
            } catch (eB) {
              throw new Error(`Image upload failed: ${eA.message} / ${eB.message}`)
            }
          }
          uploads.push({ id: dto.id, url: dto.url })
        }

        const entry = {
          at: started,
          durationMs: Date.now() - started,
          model: payloadOut.model,
          prompt: payloadOut.prompt,
          negativePrompt: payloadOut.negative_prompt || '',
          seed: payloadOut.seed !== undefined ? payloadOut.seed : 'random',
          images: uploads,
        }
        const history = await pushHistory(entry)
        reply = ok(payload, requestId, { entry, history })
        break
      }

      case 'append_to_chat': {
        // Places a generated image INTO the latest story message (prepended
        // at its top) via getMessages + updateMessage. Falls back to
        // appending a new assistant message if in-place editing fails.
        const { imageUrl, alt, chatId } = payload
        if (!imageUrl) throw new Error('No image URL to add.')
        const md = `![${(alt || 'Generated image').replace(/[\[\]]/g, '')}](${imageUrl})`

        const chatApi = spindle.chat || spindle.chats
        if (!chatApi) {
          throw new Error('Chat API unavailable — check that the chats + chat_mutation permissions were granted.')
        }

        // Resolve a chat id if the frontend didn't supply one.
        let targetChatId = chatId
        if (!targetChatId && spindle.chats) {
          for (const fn of ['getActive', 'getActiveChat', 'active']) {
            if (typeof spindle.chats[fn] === 'function') {
              try {
                let active
                try { active = await spindle.chats[fn](userId) }
                catch { active = await spindle.chats[fn]() }
                targetChatId = active && (active.id || active.chatId || active)
                if (targetChatId) break
              } catch { /* try next shape */ }
            }
          }
        }

        const attempts = []

        // --- preferred path: prepend into the latest assistant message ---
        let inserted = false
        if (typeof chatApi.getMessages === 'function' && typeof chatApi.updateMessage === 'function') {
          let messages = null
          for (const args of [
            [targetChatId, userId],
            [{ chatId: targetChatId, userId }],
            [targetChatId],
            [],
          ]) {
            try {
              const res = await chatApi.getMessages(...args)
              const arr = Array.isArray(res) ? res : (res && (res.messages || res.items))
              if (Array.isArray(arr) && arr.length) { messages = arr; break }
            } catch (e) { attempts.push(`getMessages(${args.length} args): ${e.message}`) }
          }
          if (messages) {
            // newest last is the common order; verify by timestamps when present
            const ts = (m) => m.createdAt || m.created_at || m.timestamp || 0
            if (messages.length > 1 && ts(messages[0]) > ts(messages[messages.length - 1])) {
              messages = [...messages].reverse()
            }
            const isAssistant = (m) => {
              const r = (m.role || m.sender || '').toString().toLowerCase()
              return r.includes('assistant') || r.includes('char') || r === 'ai'
            }
            let target = null
            for (let i = messages.length - 1; i >= 0; i--) {
              if (isAssistant(messages[i])) { target = messages[i]; break }
            }
            if (!target) target = messages[messages.length - 1]
            const messageId = target.id || target.messageId
            const contentKey = ('content' in target) ? 'content'
              : ('text' in target) ? 'text'
              : ('message' in target) ? 'message' : null
            if (messageId && contentKey) {
              const newContent = `${md}\n\n${target[contentKey] || ''}`
              for (const args of [
                [messageId, { [contentKey]: newContent }, userId],
                [{ id: messageId, chatId: targetChatId, [contentKey]: newContent, userId }],
                [messageId, { [contentKey]: newContent }],
                [targetChatId, messageId, { [contentKey]: newContent }],
              ]) {
                try {
                  await chatApi.updateMessage(...args)
                  inserted = true
                  break
                } catch (e) { attempts.push(`updateMessage(${args.length} args): ${e.message}`) }
              }
            } else {
              attempts.push(`could not identify id/content on message DTO. Keys: ${Object.keys(target).join(',')}`)
            }
          }
        } else {
          attempts.push('getMessages/updateMessage not exposed: ' +
            JSON.stringify({ chat: spindle.chat ? Object.keys(spindle.chat) : null }))
        }

        // --- fallback: append as a fresh assistant message ---
        let appendedNew = false
        if (!inserted && typeof chatApi.appendMessage === 'function') {
          const message = { role: 'assistant', content: md }
          for (const args of [
            [targetChatId, message, userId],
            [{ chatId: targetChatId, ...message, userId }],
            [{ chatId: targetChatId, ...message }],
          ]) {
            try { await chatApi.appendMessage(...args); appendedNew = true; break }
            catch (e) { attempts.push(`appendMessage(${args.length} args): ${e.message}`) }
          }
        }

        if (!inserted && !appendedNew) {
          throw new Error('Could not add image to chat. Tried: ' + attempts.join(' | ') +
            ' — send me this text and I will pin the exact signatures.')
        }
        reply = ok(payload, requestId, { mode: inserted ? 'inserted' : 'appended-new' })
        break
      }

      case 'remove_from_chat': {
        // Finds the message containing this image's markdown and strips it.
        const { imageUrl } = payload
        if (!imageUrl) throw new Error('No image URL to remove.')
        const chatApi = spindle.chat || spindle.chats
        if (!chatApi || typeof chatApi.getMessages !== 'function' || typeof chatApi.updateMessage !== 'function') {
          throw new Error('Chat editing API unavailable.')
        }
        const attempts = []
        const { messages, chatId: rmChatId } = await fetchMessages(userId)

        const needle = `](${imageUrl})`
        let removed = false
        for (const m of messages) {
          const contentKey = ('content' in m) ? 'content' : ('text' in m) ? 'text' : ('message' in m) ? 'message' : null
          if (!contentKey || typeof m[contentKey] !== 'string') continue
          if (!m[contentKey].includes(needle)) continue
          const esc = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp('!\\[[^\\]]*\\]\\(' + esc + '\\)\\n?\\n?')
          const newContent = m[contentKey].replace(re, '').replace(/^\s+/, '')
          const messageId = m.id || m.messageId
          try {
            await updateMessageContent(messageId, contentKey, newContent, userId, rmChatId)
            removed = true
          } catch (e) { attempts.push(e.message) }
          break
        }
        if (!removed) {
          throw new Error('That image was not found in the current chat' +
            (attempts.length ? ' (' + attempts.join(' | ') + ')' : '') + '.')
        }
        reply = ok(payload, requestId, { removed: true })
        break
      }

      case 'delete_image': {
        const { imageUrl, imageId } = payload
        if (!imageUrl && !imageId) throw new Error('Nothing to delete.')
        // best-effort: remove from chat first (ignore not-found)
        try {
          const { messages, chatId: dChatId } = await fetchMessages(userId)
          const needle = `](${imageUrl})`
          for (const m of messages) {
            const bits = messageBits(m)
            if (!bits.contentKey || typeof bits.content !== 'string' || !bits.content.includes(needle)) continue
            const esc = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const re = new RegExp('!\\[[^\\]]*\\]\\(' + esc + '\\)\\n?\\n?')
            await updateMessageContent(bits.id, bits.contentKey, bits.content.replace(re, '').replace(/^\s+/, ''), userId, dChatId)
            break
          }
        } catch { /* not in a chat / no chat open — fine */ }
        // delete the owned image itself
        let deleted = false
        if (imageId && spindle.images) {
          for (const fn of ['delete', 'remove']) {
            if (typeof spindle.images[fn] !== 'function') continue
            for (const args of [[imageId, userId], [{ id: imageId, userId }], [imageId]]) {
              try { await spindle.images[fn](...args); deleted = true; break } catch { /* next */ }
            }
            if (deleted) break
          }
        }
        // scrub from history
        const history = await getHistory()
        for (const entry of history) {
          entry.images = (entry.images || []).filter((im) => im.url !== imageUrl && im.id !== imageId)
        }
        const cleaned = history.filter((e) => e.images && e.images.length)
        await spindle.storage.setJson(HISTORY_FILE, cleaned, { indent: 2 })
        reply = ok(payload, requestId, { history: cleaned, deleted })
        break
      }


      case 'get_history': {
        const history = await getHistory()
        reply = ok(payload, requestId, { history })
        break
      }

      case 'clear_history': {
        if (payload.deleteImages) {
          const history = await getHistory()
          let n = 0
          for (const entry of history) {
            for (const im of entry.images || []) {
              if (!im.id || !spindle.images) continue
              for (const fn of ['delete', 'remove']) {
                if (typeof spindle.images[fn] !== 'function') continue
                let done = false
                for (const args of [[im.id, userId], [{ id: im.id, userId }], [im.id]]) {
                  try { await spindle.images[fn](...args); done = true; n++; break } catch { /* next */ }
                }
                if (done) break
              }
            }
          }
          spindle.log.info('[lumidraw] cleared history, deleted ' + n + ' image(s)')
        }
        await spindle.storage.setJson(HISTORY_FILE, [], { indent: 2 })
        reply = ok(payload, requestId, { history: [] })
        break
      }

      default:
        return // not ours / malformed — ignore quietly
    }
  } catch (err) {
    reply = fail(payload, requestId, err)
  }
  spindle.sendToFrontend(reply, userId)
})

// Inline protocol injection (documented interceptor API).
if (typeof spindle.registerInterceptor === 'function') {
  spindle.registerInterceptor(async (a, b) => {
    try {
      // Shape-agnostic: hosts may pass (messagesArray, ctx) or a single
      // wrapper object holding .messages. Mirror back whatever we got.
      const wrapped = !Array.isArray(a) && a && Array.isArray(a.messages)
      const messages = Array.isArray(a) ? a : (wrapped ? a.messages : null)
      const settings = await getSettings()
      if (!messages) {
        spindle.log.warn('[lumidraw] interceptor invoked with unrecognized arg shape: ' +
          (a === null ? 'null' : typeof a) + (a && typeof a === 'object' ? ' keys=' + Object.keys(a).join(',') : ''))
        return a
      }
      spindle.log.info(`[lumidraw] interceptor invoked (mode=${settings.mode}, msgs=${messages.length}, wrapped=${wrapped})`)
      if (settings.mode !== 'inline' && settings.mode !== 'parser') return a
      if (settings.mode === 'inline') {
        let protocolText = (settings.protocol || DEFAULT_PROTOCOL)
          .replaceAll('{{max_images}}', String(settings.maxImages || 2))
          .replaceAll('{{min_images}}', String(settings.minImages || 0))
        try {
          const presets = await getPresets()
          const ap = presets.find((p) => p.name === settings.activePreset)
          if (ap && ap.personaTags) {
            protocolText += '\nWhen the User/persona is visibly present in an illustrated moment, represent them with these tags (include only the parts actually visible; respect POV framing): ' + ap.personaTags
          }
        } catch (error) {
          spindle.log.warn('[lumidraw] could not add persona hints to inline protocol: ' + error.message)
        }
        const injected = { role: 'system', content: protocolText }
        const out = [...messages, injected]
        spindle.log.info('[lumidraw] inline protocol injected (' + injected.content.length + ' chars)')
        return wrapped ? { ...a, messages: out } : out
      }
      if (settings.mode === 'parser' && settings.autoScan !== false) {
        const triggerText = [
          'At the very end of the assistant reply, if there is any visually illustratable moment, append exactly one line containing this XML tag and nothing else on that line:',
          PARSER_TRIGGER_TAG,
          'Do not output Markdown image syntax. Do not describe the tag. Do not output more than one trigger tag.',
          'If there is no clear illustratable moment, do not output the tag.',
        ].join('\n')
        const injected = { role: 'system', content: triggerText }
        const out = [...messages, injected]
        spindle.log.info('[lumidraw] parser trigger protocol injected (' + injected.content.length + ' chars)')
        return wrapped ? { ...a, messages: out } : out
      }
      return a
    } catch (e) {
      spindle.log.warn('[lumidraw] interceptor error: ' + e.message)
      return a
    }
  })
  spindle.log.info('[lumidraw] inline protocol interceptor registered')
} else {
  spindle.log.warn('[lumidraw] registerInterceptor not available — inline protocol injection disabled')
}

// Auto-scan after story generations, if an events surface exists.
let scanInFlight = false
let lastAutoHandledMessageId = ''
;(() => {
  const toastSafe = (msg) => {
    try { if (typeof spindle.toast === 'function') spindle.toast(msg) } catch { /* signature mismatch */ }
    try { if (spindle.toast && typeof spindle.toast.show === 'function') spindle.toast.show(msg) } catch { /* ok */ }
  }
  const latestAssistantBits = async (uid) => {
    const { messages } = await fetchMessages(uid)
    for (let i = messages.length - 1; i >= 0; i--) {
      const bits = messageBits(messages[i])
      if (bits.isAssistant && bits.contentKey && typeof bits.content === 'string') return bits
    }
    return null
  }
  const runAutoScan = async (uid, attempt = 0) => {
    try {
      const latest = await latestAssistantBits(uid)
      if (!latest) {
        if (attempt < 6) return setTimeout(() => runAutoScan(uid, attempt + 1), 2000)
        setAutoStatus(uid, { mode: 'auto', status: 'idle', note: 'No assistant story message was available yet.' })
        return
      }
      if (latest.id && latest.id === lastAutoHandledMessageId) return
      setAutoStatus(uid, { mode: 'auto', status: 'running', messageId: latest.id || '', note: 'Scanning the newest story message…' })
      const r = await scanStory(uid, { messageId: latest.id })
      spindle.log.info('[lumidraw] auto-scan: ' + JSON.stringify(r))
      if (latest.id) lastAutoHandledMessageId = latest.id
      const status = r && r.processed ? 'generated' : (r && /nothing generated|no visual moment|already illustrated|No <dt-image>|No story message found/i.test(r.note || '') ? 'idle' : 'done')
      setAutoStatus(uid, { mode: r && r.mode ? r.mode : 'auto', status, messageId: latest.id || '', note: (r && r.note) || '' })
      if (r && r.processed) toastSafe(`LumiDraw: illustrated ${r.processed} moment(s)`)
    } catch (e) {
      spindle.log.warn('[lumidraw] auto-scan failed: ' + e.message)
      setAutoStatus(uid, { mode: 'auto', status: 'error', note: e.message })
    } finally {
      scanInFlight = false
    }
  }
  const handler = async (evt) => {
    try {
      const settings = await getSettings()
      if (settings.mode === 'off' || !settings.autoScan) return
      if (settings.mode === 'parser') return
      const uid = (evt && (evt.userId || (evt.payload && evt.payload.userId))) || lastUserId
      if (!uid || scanInFlight) return
      scanInFlight = true
      setTimeout(() => runAutoScan(uid, 0), 1800)
    } catch (e) {
      scanInFlight = false
      setAutoStatus(lastUserId, { mode: 'auto', status: 'error', note: e.message })
    }
  }
  let registered = false
  const on = (typeof spindle.on === 'function') ? spindle.on.bind(spindle)
    : (spindle.events && typeof spindle.events.on === 'function') ? spindle.events.on.bind(spindle.events)
    : null
  if (on) {
    for (const ev of ['GENERATION_ENDED', 'MESSAGE_ADDED', 'CHAT_MESSAGE_ADDED', 'MESSAGE_CREATED']) {
      try { on(ev, handler); registered = true } catch (e) { spindle.log.warn('[lumidraw] ' + ev + ' registration failed: ' + e.message) }
    }
  }
  if (registered) spindle.log.info('[lumidraw] auto-scan registered on available story events')
  else spindle.log.warn('[lumidraw] auto-scan unavailable — use the "Scan story now" button.')
})()

spindle.log.info('[lumidraw] spindle API surface: ' + Object.keys(spindle).join(', '))
spindle.log.info('[lumidraw] backend loaded v' + ((spindle.manifest && spindle.manifest.version) || '0.17.4'))
