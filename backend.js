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
  parserInstruction: '',  // selected engine instruction (blank = that engine's built-in default)
  parserEngine: 'legacy',  // 'legacy' (v0.13 instruction-only) | 'anima' (structured JSON compiler)
  maxImages: 2,           // max illustrations per story message
  minImages: 0,           // required illustrations per reply (0 = model's discretion)
  autoCharTags: true,     // use active character image tags as a profile fallback
  subjectBinding: false,  // legacy compatibility mirror of parserEngine === 'anima'
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

const DEFAULT_PARSER_INSTRUCTION = `Choose the strongest visual moment in the story passage. Prefer one image, but you may choose up to {{max_images}} distinct moments. Extract a compact visual skeleton: subjects, current clothing, expressions, poses, support surfaces, the base body arrangement, direct contact points, setting, camera, and lighting. Do not rewrite permanent character identity or invent anatomy. LumiDraw will keep the final prompt mostly Danbooru/Gelbooru-style tags and inject only a few short ownership-safe natural-language anchors where tags are prone to character bleed or spatial ambiguity.`
const V0181_ANIMA_PARSER_INSTRUCTION = `Choose the strongest visual moment in the story passage. Prefer one image, but you may choose up to {{max_images}} distinct moments. Describe only scene state: which subjects are present, their current outfit, pose, expression, active-voice interaction, setting, camera, and lighting. Do not rewrite permanent character identity or invent anatomy. LumiDraw will append a strict JSON schema and compile the final image prompt itself.`
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
  // 0.18 introduces an explicit engine selector. Existing installs enter the
  // known-good v0.13 instruction-only path until the user deliberately chooses
  // the experimental Anima hybrid compiler.
  if (!['legacy', 'anima'].includes(settings.parserEngine)) settings.parserEngine = 'legacy'
  if (!stored || !stored.parserEngine) settings.parserEngine = 'legacy'
  settings.subjectBinding = settings.parserEngine === 'anima' // backward-compatible debug/profile flag
  if (settings.parserEngine === 'anima' && (!stored || !stored.parserInstruction || stored.parserInstruction === LEGACY_DEFAULT_PARSER_INSTRUCTION || stored.parserInstruction === V0181_ANIMA_PARSER_INSTRUCTION)) {
    settings.parserInstruction = ''
  }
  if (settings.parserEngine === 'legacy' && stored && (stored.parserInstruction === DEFAULT_PARSER_INSTRUCTION || stored.parserInstruction === V0181_ANIMA_PARSER_INSTRUCTION)) {
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

function hasParserTrigger(text) {
  PARSER_TRIGGER_RE.lastIndex = 0
  return PARSER_TRIGGER_RE.test(String(text || ''))
}

function stripParserTrigger(text) {
  PARSER_TRIGGER_RE.lastIndex = 0
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

async function generateAndUpload({ prompt, negativePrompt, config, extra, dims }, userId, scan = null) {
  assertStoryScanActive(scan)
  const settings = await getSettings()
  const merged = dims ? { ...config, ...dims } : config
  const payloadOut = buildPayload({ prompt, negativePrompt, config: merged, extra })
  if (!payloadOut.model) throw new Error('Active preset has no model.')
  const started = Date.now()
  const images = await dtGenerate(settings, payloadOut)
  assertStoryScanActive(scan)
  const uploads = []
  for (const b64 of images) {
    assertStoryScanActive(scan)
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
  assertStoryScanActive(scan)
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

// This profile field is deliberately narrow. Identity and presentation terms
// such as "feminine male", "femboy", or "trans woman" belong in the
// permanent appearance profile; only concrete anatomy may pass this boundary.
const CONDITIONAL_ANATOMY_RULES = [
  { canonical: 'penis', pattern: /\b(?:penis|penises|cock|cocks|dick|dicks|phallus|male genitals?)\b/i },
  { canonical: 'vulva', pattern: /\b(?:vagina|vaginas|vulva|vulvas|pussy|pussies|female genitals?)\b/i },
  { canonical: 'testicles', pattern: /\b(?:testicle|testicles|testes|balls?|scrotum)\b/i },
  { canonical: 'clitoris', pattern: /\b(?:clitoris|clit)\b/i },
  { canonical: 'anus', pattern: /\b(?:anus|anal opening)\b/i },
]

function normalizeConditionalAnatomy(items) {
  const out = []
  for (const item of items || []) {
    const text = String(item || '').trim()
    if (!text) continue
    const match = CONDITIONAL_ANATOMY_RULES.find((rule) => rule.pattern.test(text))
    if (match && !out.includes(match.canonical)) out.push(match.canonical)
  }
  return out
}

// Named props are stored as compact visual aliases. Each line uses:
//   Aegis-fang = single massive warhammer
// The proper name is retained for story continuity while the descriptor gives
// Anima a visual concept it is more likely to understand.
function normalizeVisualAliases(value, label = 'visual alias') {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\r\n;]+/).map((line) => line.trim()).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const entry of raw.slice(0, 12)) {
    let name = ''
    let description = ''
    if (entry && typeof entry === 'object') {
      name = String(entry.name || entry.key || '').trim()
      description = String(entry.description || entry.visual || entry.value || '').trim()
    } else {
      const match = String(entry || '').match(/^\s*([^=]{1,64}?)\s*=\s*(.{1,96})\s*$/)
      if (!match) continue
      name = match[1].trim()
      description = match[2].trim()
    }
    name = shortPhrase(name, `${label} name`, 6, 64, true)
    description = shortPhrase(description, `${label} description`, 10, 96, true)
    if (!name || !description) continue
    const key = normalizeIdentityText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ name, description })
    if (out.length >= 8) break
  }
  return out
}

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
    visualAliases: normalizeVisualAliases(source.visualAliases || source.namedVisualAliases || '', `${fallbackRef} visual alias`),
    anatomy: normalizeConditionalAnatomy(shortList(source.anatomyTags || '', `${fallbackRef} conditional anatomy`, { maxItems: 12, maxWords: 7, maxChars: 72 })),
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
    visualAliases: normalizeVisualAliases(await Promise.all((profile.visualAliases || []).map(async (alias) => ({
      name: await resolveMacros(alias.name, userId, chatId),
      description: await resolveMacros(alias.description, userId, chatId),
    }))), `${profile.ref} visual alias`),
    anatomy: normalizeConditionalAnatomy(await resolveMany(profile.anatomy, `${profile.ref} conditional anatomy`)),
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
    support: shortPhrase(source.support || source.support_surface || source.supportSurface || '', `subject ${index + 1} support surface`, 7, 72, true),
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
    safety: ['safe', 'sensitive', 'nsfw', 'explicit'].includes(String(source.safety || source.rating || '').trim().toLowerCase())
      ? String(source.safety || source.rating || '').trim().toLowerCase()
      : '',
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
    .replace(/\bbracs\b/gi, 'braces')
    .replace(/\btogue\b/gi, 'tongue')
    .replace(/\bandrogenous\b/gi, 'androgynous')
    .replace(/\bhooks? the back of the knee of\b/gi, 'curls a bare heel behind the knee of')
    .replace(/\bone heel hooked behind (his|her|their) knee\b/gi, 'one bare heel curled behind $1 knee')
    .replace(/\bhooked behind (his|her|their) knee\b/gi, 'curled behind $1 knee')
    .replace(/\bhooking (his|her|their) knee\b/gi, 'curling a bare heel behind $1 knee')
    .replace(/\bsitting on counter\b/gi, 'sitting on the clearly visible counter edge')
    .replace(/\bseated on counter\b/gi, 'seated on the clearly visible counter edge')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function normalizeVisualList(list) {
  return uniqueStrings((Array.isArray(list) ? list : []).map(normalizeVisualPhrase).filter(Boolean))
}

function animaTag(value) {
  let tag = normalizeVisualPhrase(value).trim()
  if (!tag) return ''
  // Anima expects spaces rather than underscores, except for score_* tags.
  if (!/^score_[1-9]$/i.test(tag)) tag = tag.replace(/_/g, ' ')
  tag = tag.toLowerCase()
  // "default outfit" is an editor placeholder, not a useful Anima tag.
  if (tag === 'default outfit') return ''
  return tag
}

function animaTagList(list) {
  return uniqueStrings((Array.isArray(list) ? list : []).map(animaTag).filter(Boolean))
}

function naturalList(items) {
  const values = uniqueStrings(items || [])
  if (!values.length) return ''
  if (values.length === 1) return values[0]
  if (values.length === 2) return values[0] + ' and ' + values[1]
  return values.slice(0, -1).join(', ') + ', and ' + values[values.length - 1]
}

function sentenceName(value, fallback = 'The subject') {
  const text = String(value || '').trim()
  if (!text) return fallback
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function articleFor(value) {
  const text = String(value || '').trim().toLowerCase()
  return /^[aeiou]/.test(text) ? 'an' : 'a'
}

function aggregateCountTags(descriptors) {
  const sums = new Map()
  const passthrough = []
  for (const item of descriptors) {
    const raw = animaTag(item.countTag)
    if (!raw) continue
    const match = /^(\d+)?\s*(girl|boy|other|woman|man|female|male)s?$/.exec(raw)
    if (!match) { passthrough.push(raw); continue }
    const count = Number(match[1] || 1)
    const kind = match[2]
    sums.set(kind, (sums.get(kind) || 0) + count)
  }
  const aggregated = []
  for (const [kind, count] of sums.entries()) {
    aggregated.push(`${count}${kind}${count === 1 ? '' : 's'}`)
  }
  return uniqueStrings([...aggregated, ...passthrough])
}

function findSupportSurface(setting) {
  const joined = (Array.isArray(setting) ? setting.join(', ') : String(setting || '')).toLowerCase()
  const surfaces = [
    ['countertop', /countertop/],
    ['counter edge', /\bcounter\b/],
    ['bar stool', /bar stool|\bstool\b/],
    ['chair', /\bchair\b/],
    ['bed', /\bbed\b/],
    ['couch', /\bcouch\b|\bsofa\b/],
    ['floor', /\bfloor\b/],
    ['wall', /\bwall\b/],
    ['table', /\btable\b/],
    ['desk', /\bdesk\b/],
  ]
  for (const [label, pattern] of surfaces) if (pattern.test(joined)) return label
  return ''
}

function supportForSubject(item, scene) {
  if (item.subject.support) return animaTag(item.subject.support)
  return findSupportSurface(scene.setting)
}

function poseWithSupport(item, scene) {
  const poses = animaTagList(item.pose)
  if (!poses.length) return poses
  const support = supportForSubject(item, scene)
  if (!support) return poses
  const joined = poses.join(', ')
  if (joined.includes(support) || /countertop|counter edge|bar stool|stool|chair|bed|couch|sofa|floor|wall|table|desk/.test(joined)) return poses
  if (/(sitting|seated|perched)/.test(joined)) poses[0] = `${poses[0]} on the clearly visible ${support}`
  else if (/leaning/.test(joined)) poses[0] = `${poses[0]} against the clearly visible ${support}`
  else if (/lying/.test(joined)) poses[0] = `${poses[0]} on the clearly visible ${support}`
  else if (/kneeling/.test(joined) && support === 'floor') poses[0] = `${poses[0]} on the clearly visible floor`
  return uniqueStrings(poses)
}

function cleanAppearanceForNoun(items, noun) {
  const nounText = animaTag(noun)
  let values = animaTagList(items)
  values = values.map((value) => {
    if (/\b(?:man|male)\b/.test(nounText)) {
      if (value === 'large man') return 'large'
      if (value === 'tall male') return 'tall'
    }
    return value
  })
  if (/trans woman|trans female/.test(nounText)) {
    values = values.filter((value) => !['trans female', 'trans woman', 'female', 'woman'].includes(value))
  } else if (/\bwoman\b|\bfemale\b/.test(nounText)) {
    values = values.filter((value) => !['female', 'woman'].includes(value))
  }
  if (/\bman\b|\bmale\b/.test(nounText)) {
    values = values.filter((value) => !['male', 'man'].includes(value))
  }
  if (values.includes('extremely muscular')) values = values.filter((value) => value !== 'muscular')
  return uniqueStrings(values)
}

function visibleAnatomySentence(item, scene) {
  if (!item.anatomy.length) return ''
  // A safe/sensitive scene must never receive an exposed-anatomy sentence.
  // This also prevents a profile override from contradicting the safety tag.
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return ''
  const anchor = sentenceName(item.anchor)
  const anatomy = normalizeConditionalAnatomy(item.anatomy)
  if (anatomy.includes('penis')) return `${anchor}'s penis is visibly exposed.`
  if (anatomy.includes('vulva')) return `${anchor}'s vulva is visibly exposed.`
  if (anatomy.includes('testicles')) return `${anchor}'s testicles are visibly exposed.`
  if (anatomy.includes('clitoris')) return `${anchor}'s clitoris is visibly exposed.`
  if (anatomy.includes('anus')) return `${anchor}'s anus is visibly exposed.`
  return ''
}

function comparableAction(value) {
  return animaTag(value)
    .replace(/\b(?:him|her|them|his|hers|their|theirs)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function actionDuplicatesRelation(action, subjectRef, relations) {
  const actionText = comparableAction(action)
  if (!actionText) return true
  return (relations || []).some((relation) => {
    if (relation.actor !== subjectRef) return false
    const candidates = [relation.action, ...(relation.details || [])].map(comparableAction).filter(Boolean)
    return candidates.some((relationText) => relationText.includes(actionText) || actionText.includes(relationText))
  })
}

function resolveCrossSubjectPronouns(value, item, descriptors) {
  let text = String(value || '')
  if ((descriptors || []).length !== 2) return text
  const other = descriptors.find((candidate) => candidate.subject.ref !== item.subject.ref)
  if (!other || !other.anchor) return text
  const name = sentenceName(other.anchor)
  text = text
    .replace(/\bher\s+(?=[a-z])/gi, `${name}'s `)
    .replace(/\bhis\s+(?=[a-z])/gi, `${name}'s `)
    .replace(/\btheir\s+(?=[a-z])/gi, `${name}'s `)
    .replace(/\bhim\b/gi, name)
    .replace(/\bher\b/gi, name)
    .replace(/\bthem\b/gi, name)
  return text
}

function outfitCaptionSentences(anchor, outfit) {
  const clothes = []
  const states = []
  for (const value of outfit || []) {
    const tag = animaTag(value)
    if (/^(?:nude|naked|topless|bottomless|shirtless|barefoot|bare feet|bare legs|bare thighs)$/.test(tag)) states.push(tag)
    else clothes.push(tag)
  }
  const sentences = []
  if (clothes.length) sentences.push(`${anchor} wears ${naturalList(clothes)}.`)
  for (const state of uniqueStrings(states)) {
    if (state === 'nude' || state === 'naked') sentences.push(`${anchor} is nude.`)
    else if (state === 'barefoot' || state === 'bare feet') sentences.push(`${anchor} is barefoot.`)
    else if (state === 'bare legs') sentences.push(`${anchor}'s legs are bare.`)
    else if (state === 'bare thighs') sentences.push(`${anchor}'s thighs are bare.`)
    else sentences.push(`${anchor} is ${state}.`)
  }
  return sentences
}

function outfitExposureState(outfit) {
  const joined = animaTagList(outfit).join(', ')
  return {
    joined,
    upperExposed: /\b(?:shirtless|topless|nude|naked|bare shoulders?|sleeveless|open chest|open shirt|off shoulder|one shoulder bare)\b/.test(joined),
    midriffExposed: /\b(?:nude|naked|bare midriff|midriff|crop top|cropped shirt|open shirt|open jacket)\b/.test(joined),
    earsCovered: /\b(?:helmet|full helmet|hood|hooded|headwrap)\b/.test(joined),
    upperCovered: /\b(?:armor|armour|shirt|robe|coat|jacket|tunic|sweater|hoodie|dress|uniform)\b/.test(joined),
  }
}

function appearanceTraitVisible(tag, outfit) {
  const value = animaTag(tag)
  if (!value) return false
  const state = outfitExposureState(outfit)
  if (/\b(?:tattoo|body marking|scar|birthmark)\b/.test(value)) {
    const upperRegion = /\b(?:shoulder|arm|chest|torso|back|rib|navel|stomach|abdomen)\b/.test(value)
    if ((upperRegion || state.upperCovered) && state.upperCovered && !state.upperExposed) return false
  }
  if (/\bnavel piercing\b/.test(value) && state.upperCovered && !state.midriffExposed) return false
  if (/\bear piercing\b/.test(value) && state.earsCovered) return false
  return true
}

function filterAppearanceByVisibility(appearance, outfit) {
  return (appearance || []).filter((tag) => appearanceTraitVisible(tag, outfit))
}

function signaturePriority(tag) {
  const value = animaTag(tag)
  if (/\b(?:round glasses|glasses|eyewear|goggles|monocle|eyepatch)\b/.test(value)) return 1
  if (/\b(?:pointed elf ears|elf ears|horns?|wings?|tail)\b/.test(value)) return 2
  if (/\b(?:tattoo|scar|birthmark|body marking)\b/.test(value)) return 3
  if (/\bpiercing\b/.test(value)) return 4
  return 99
}

function signatureOwnershipSentence(tag, anchor) {
  const value = animaTag(tag)
  if (!value || signaturePriority(value) >= 99) return ''
  const name = sentenceName(anchor)
  if (/\b(?:glasses|eyewear|goggles|monocle|eyepatch)\b/.test(value)) return `${name} wears ${value}.`
  return `${name} has ${value}.`
}

function aliasMentioned(text, alias) {
  const haystack = normalizeIdentityText(text)
  const needle = normalizeIdentityText(alias && alias.name)
  return !!needle && haystack.includes(needle)
}

function subjectSceneText(item, scene) {
  const subject = item.subject || {}
  const relationBits = []
  for (const relation of scene.relations || []) {
    if (relation.actor === subject.ref || relation.target === subject.ref) {
      relationBits.push(relation.action, ...(relation.details || []))
    }
  }
  return [
    ...(subject.outfit || []),
    ...(subject.pose || []),
    subject.support || '',
    ...(subject.action || []),
    ...relationBits,
  ].filter(Boolean).join(', ')
}

function aliasDescriptorWithArticle(description) {
  const value = String(description || '').trim()
  if (!value) return ''
  if (/^(?:a|an|the)\s+/i.test(value)) return value
  return `${articleFor(value)} ${value}`
}

function aliasIsSheathable(description) {
  return /\b(?:sword|dagger|knife|blade|rapier|saber|sabre)\b/i.test(String(description || ''))
}

function normalizeAliasTag(tag, alias) {
  let value = normalizeVisualPhrase(tag)
  if (!aliasMentioned(value, alias)) return value
  if (/\bsheathed\b/i.test(value) && !aliasIsSheathable(alias.description)) {
    value = value.replace(/\bsheathed\b/gi, 'carried on back')
  }
  return value
}

function activeAliasesForSubject(item, scene) {
  const aliases = item.profile && Array.isArray(item.profile.visualAliases) ? item.profile.visualAliases : []
  const text = subjectSceneText(item, scene)
  return aliases.filter((alias) => aliasMentioned(text, alias)).slice(0, 2)
}

function aliasOwnershipSentence(alias, item, scene) {
  const name = sentenceName(item.anchor)
  const subjectText = normalizeIdentityText(subjectSceneText(item, scene))
  const prop = String(alias.name || '').trim()
  const description = aliasDescriptorWithArticle(alias.description)
  if (!prop || !description) return ''
  if (/\b(?:hold|holds|holding|wield|wields|wielding|grip|grips|gripping)\b/.test(subjectText)) {
    return `${name} holds ${prop}, ${description}.`
  }
  if (/\b(?:carry|carries|carrying|sheathed|on back|at back)\b/.test(subjectText)) {
    return `${name} carries ${prop}, ${description}.`
  }
  return `${prop} is ${name}'s ${String(alias.description || '').trim()}.`
}

function subjectOwnershipAnchors(item, scene) {
  const anchors = []
  const signature = [...(item.appearance || [])]
    .filter((tag) => appearanceTraitVisible(tag, item.outfit))
    .sort((a, b) => signaturePriority(a) - signaturePriority(b))
    .find((tag) => signaturePriority(tag) < 99)
  if (signature) {
    const sentence = signatureOwnershipSentence(signature, item.anchor)
    if (sentence) anchors.push(sentence)
  }
  for (const alias of activeAliasesForSubject(item, scene)) {
    const sentence = aliasOwnershipSentence(alias, item, scene)
    if (sentence) anchors.push(sentence)
    if (anchors.length >= 2) break
  }
  return uniqueStrings(anchors).slice(0, 2)
}

function subjectTagLine(item, scene, descriptors) {
  const anchor = sentenceName(item.anchor)
  const noun = animaTag(item.noun) || 'subject'
  const poses = poseWithSupport(item, scene).map((part) => resolveCrossSubjectPronouns(part, item, descriptors))
  const actions = item.action
    .filter((part) => !actionDuplicatesRelation(part, item.subject.ref, scene.relations))
    .map((part) => resolveCrossSubjectPronouns(part, item, descriptors))
  const aliases = activeAliasesForSubject(item, scene)
  const normalizeWithAliases = (part) => {
    let value = part
    for (const alias of aliases) value = normalizeAliasTag(value, alias)
    return animaTag(value)
  }
  // In multi-subject scenes the ownership sentence already carries the proper
  // name, so repeat only the visual descriptor in the tag block. Solo scenes
  // retain both name and descriptor because they do not receive prose anchors.
  const aliasTags = aliases.flatMap((alias) => descriptors.length > 1
    ? [alias.description]
    : [alias.name, alias.description])
  const tags = uniqueStrings([
    noun,
    ...filterAppearanceByVisibility(item.appearance, item.outfit),
    ...item.outfit,
    ...poses,
    ...item.expression,
    ...actions,
    ...aliasTags,
  ].map(normalizeWithAliases).filter(Boolean))
  return [anchor, ...tags].filter(Boolean).join(', ')
}

function relationSentence(relation, byRef) {
  const actor = byRef.get(relation.actor)
  const target = relation.target ? byRef.get(relation.target) : null
  const actorName = sentenceName(actor ? actor.anchor : relation.actor)
  const targetName = target ? sentenceName(target.anchor) : ''
  const action = normalizeVisualPhrase(relation.action)
  if (!action) return ''
  let sentence = `${actorName} ${action}`
  if (targetName && !sentence.toLowerCase().includes(targetName.toLowerCase())) sentence += ` ${targetName}`
  return sentence.replace(/\s+([,.])/g, '$1').replace(/\s{2,}/g, ' ').trim() + '.'
}

function compileStructuredScene(scene, profiles, sourcePassage = '') {
  const descriptors = scene.subjects.map((subject) => subjectDescriptor(subject, profiles, sourcePassage, true)).map((item) => ({
    ...item,
    appearance: cleanAppearanceForNoun(item.appearance, item.noun),
    outfit: animaTagList(item.outfit),
    anatomy: animaTagList(item.anatomy),
    pose: animaTagList(item.subject.pose),
    expression: animaTagList(item.subject.expression),
    action: animaTagList(item.subject.action),
  }))

  const sections = []
  const headerTags = []
  if (scene.safety) headerTags.push(scene.safety)
  headerTags.push(...aggregateCountTags(descriptors))
  if (headerTags.length) sections.push(headerTags.join(', '))

  // Natural language is intentionally surgical: at most three short spatial /
  // ownership anchors. Everything else remains tag-oriented for Anima.
  const byRef = new Map(descriptors.map((item) => [item.subject.ref, item]))
  const relationAnchors = []
  if (descriptors.length > 1) {
    for (const relation of scene.relations) {
      // Natural language is reserved for cross-subject geometry. Solo scenes
      // remain tag-only unless explicit anatomy ownership truly needs a line.
      if (!relation.target || relation.target === relation.actor) continue
      const sentence = relationSentence(relation, byRef)
      if (sentence) relationAnchors.push(sentence)
      if (relationAnchors.length >= 3) break
    }
  }
  if (relationAnchors.length) sections.push(relationAnchors.join(' '))

  for (const item of descriptors) {
    // Signature ownership anchors are used only in multi-subject scenes, where
    // glasses, markings, species features, and named props are most likely to
    // bleed onto the wrong subject. Keep solo prompts tag-only and compact.
    if (descriptors.length > 1) {
      const ownership = subjectOwnershipAnchors(item, scene)
      if (ownership.length) sections.push(ownership.join(' '))
    }
    const line = subjectTagLine(item, scene, descriptors)
    if (line) sections.push(line)
    const anatomy = visibleAnatomySentence(item, scene)
    if (anatomy) sections.push(anatomy)
  }

  const positionTags = []
  for (const item of descriptors) {
    const pos = animaTag(item.subject.position)
    if (/^(left|right)$/.test(pos)) positionTags.push(`${item.anchor} on ${pos}`.toLowerCase())
  }
  const relationDetails = scene.relations.flatMap((relation) => relation.details || []).filter((detail) => !/^(?:pulling|pushing|holding|grabbing|biting|kissing|touching|lifting|carrying|dragging|pressing|pinning|wrapping|hooking|gripping|bracing|straddling)\b/i.test(String(detail || '').trim()))
  const generalTags = animaTagList([
    ...(descriptors.length > 1 ? ['same frame'] : []),
    ...positionTags,
    ...relationDetails,
    ...scene.setting,
    ...scene.camera,
    ...scene.lighting,
    ...scene.style,
  ])
  if (generalTags.length) sections.push(generalTags.join(', '))

  return sections.join('\n')
}

function profileSchemaHints(profiles) {
  const hints = []
  for (const ref of ['character', 'persona']) {
    const profile = profiles[ref]
    if (!profile) continue
    const label = [profile.anchor, profile.subject].filter(Boolean).join(' — ')
    const aliases = (profile.visualAliases || []).map((alias) => `${alias.name} = ${alias.description}`).join('; ')
    hints.push(`- ref "${ref}" means ${label || ref}. Do not output permanent appearance for this ref.${aliases ? ` Named visual aliases: ${aliases}. Use the exact prop name when it is present.` : ''}`)
  }
  return hints.join('\n')
}

function structuredParserSchema(maxImages, profiles) {
  return `\n\nSTRICT OUTPUT CONTRACT — this overrides any conflicting formatting request above.
Return ONLY one compact JSON object, no markdown and no prose:
{"images":[{"anchor":"5-12 exact consecutive words copied from the passage","scene":{"safety":"safe|sensitive|nsfw|explicit","subjects":[{"ref":"character|persona|other_1","label":"required only for other refs","count_tag":"1girl|1boy|1other etc","position":"left|right|center|foreground|background","appearance":["other subjects only"],"outfit":["short visual tags"],"pose":["short visual phrases"],"support":"visible support surface or empty","expression":["short tags"],"action":["short tag-like actions not involving another subject"],"anatomy_visible":false}],"relations":[{"actor":"subject ref","action":"short visible spatial phrase ending before target","target":"subject ref","details":["non-action visual modifiers only"]}],"setting":["short tags"],"camera":["short tags"],"lighting":["short tags"],"style":["short tags"],"aspect":"3:4|4:3|1:1|9:16|16:9"}}]}
Return at most ${maxImages} image object(s). If no image is warranted, return {"images":[]}.
This JSON is a visual skeleton for an Anima hybrid compiler. LumiDraw will preserve a mostly Danbooru/Gelbooru-style tag prompt and create only a few short natural-language anchors for subject ownership and spatial contact. Do not write the final image prompt yourself.
Every array value must be a terse image tag or visual phrase of at most 7 words. Avoid him/her/them pronouns in pose and action fields. Never write a descriptive paragraph. Never include permanent appearance for ref "character" or "persona"; LumiDraw inserts their locked profiles.
For multi-subject scenes, relations are mandatory. The FIRST relation must establish the visible base body arrangement or orientation, such as "straddles the lap of", "stands between the knees of", "leans over", "faces", or "sits beside". Do not use motion or intensity as the base relation. Additional relations should identify the clearest physical contact points, such as "grips the hips of" or "braces both hands on the shoulders of". Avoid vague central verbs such as "pounds", "thrusts", "moves against", or "presses into" unless the base pose has already been established by an earlier relation.
For seated, leaning, lying, or kneeling poses, provide the visible support surface in "support". When lower-body contact or a sexual position is central, choose framing wide enough to show the relevant geometry; do not choose close-up unless the contact remains clearly visible.
For a solo scene, do not invent a relation merely to create prose; keep the visual skeleton tag-oriented. Natural-language anchors are reserved for cross-subject geometry.
Set anatomy_visible true only when the passage explicitly names and visibly depicts that subject's saved anatomy; sexual context, lowered clothing, arousal, nudity, or post-sex context alone are not enough. Set anatomy_visible false for safe or sensitive scenes. Never place genital/anatomy terms in appearance, outfit, pose, support, expression, action, relation action, or details. LumiDraw alone controls saved anatomy.
Known subject refs:\n${profileSchemaHints(profiles)}`
}

function joinPromptParts(parts) {
  let output = ''
  for (const part of parts || []) {
    const value = String(part || '').trim()
    if (!value) continue
    if (!output) output = value
    else output = `${output.replace(/[\s,]+$/g, '')}, ${value.replace(/^[\s,]+/g, '')}`
  }
  return output
}

async function compileSceneWithPreset(sceneInput, preset, settings, userId, chatId, sourcePassage = '') {
  const rawProfiles = await getStoryProfiles(preset, settings, userId, chatId)
  const filterProfile = (profile) => ({
    ...profile,
    appearance: applyBannedToList(profile.appearance, preset.bannedTags),
    defaultOutfit: applyBannedToList(profile.defaultOutfit, preset.bannedTags),
    visualAliases: (profile.visualAliases || []).filter((alias) => {
      const kept = applyBannedToList([alias.name, alias.description], preset.bannedTags)
      return kept.length === 2
    }),
    anatomy: applyBannedToList(profile.anatomy, preset.bannedTags),
  })
  const profiles = { character: filterProfile(rawProfiles.character), persona: filterProfile(rawProfiles.persona) }
  let scene = normalizeScene(sceneInput)
  scene = bindKnownSubjectRefs(scene, profiles)
  scene = applyAnatomyFirewall(scene)
  scene = applyBannedToScene(scene, preset.bannedTags)
  const core = compileStructuredScene(scene, profiles, sourcePassage)
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  // User-authored quality tags and prompt prefix remain verbatim. The Anima
  // compiler owns safety/count → short interaction anchors → character tag blocks → scene tags.
  const customHeader = joinPromptParts([preset.qualityTags, prefix])
  const prompt = joinPromptParts([customHeader, core])
  return { prompt, core, scene, profiles, aspect: scene.aspect, compiler: 'anima-hybrid-v4' }
}

async function compileInlineBody(body, preset, settings, userId, chatId) {
  const resolved = await resolveMacros(body, userId, chatId)
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  const charTags = preset.characterTags || (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
  const lead = [preset.qualityTags, charTags].filter(Boolean).join(', ')
  const core = stripBannedTags(resolved, preset.bannedTags)
  return { prompt: [lead, prefix, core].filter(Boolean).join(', '), core, scene: null, profiles: null, aspect: '', format: 'legacy-inline' }
}


const PARSER_TIMEOUT_MS = 240000

class StoryScanCancelledError extends Error {
  constructor(message = 'Story scan cancelled.') {
    super(message)
    this.name = 'StoryScanCancelledError'
  }
}

function assertStoryScanActive(scan) {
  if (scan && scan.cancelled) throw new StoryScanCancelledError()
}

function setStoryScanStage(scan, stage, note = '') {
  if (!scan) return
  scan.stage = stage
  scan.note = note
  const elapsedMs = Date.now() - scan.startedAt
  spindle.log.info('[lumidraw] story scan stage · ' + stage + ' · ' + elapsedMs + 'ms' + (scan.messageId ? ' · message=' + scan.messageId : '') + (note ? ' · ' + note : ''))
  notifyFrontend(scan.userId, 'scan_status', {
    scan: {
      id: scan.id,
      stage,
      note,
      messageId: scan.messageId || '',
      startedAt: scan.startedAt,
      elapsedMs,
      cancellable: !['done', 'cancelled', 'error'].includes(stage),
    },
  })
}

async function quietLLM(system, user, settings, userId, structured = false, scan = null) {
  const generateApi = spindle.generate || spindle.generation || spindle.llm
  if (!generateApi || (typeof generateApi.quiet !== 'function' && typeof generateApi.raw !== 'function')) {
    throw new Error('Lumiverse generation API unavailable. Expected spindle.generate.quiet(). Surface: ' + Object.keys(spindle).join(', '))
  }

  const finalReminder = structured
    ? '\n----- END PASSAGE -----\n\nReturn only the compact JSON object required by the system instruction. No prose, no markdown fences, no explanations.'
    : '\n----- END PASSAGE -----\n\nRespond only with one line per image in this format:\n<5-12 exact consecutive words copied from the passage> ||| <comma-separated image tags>\nNo prose or explanations.'

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: '----- STORY PASSAGE -----\n' + user + finalReminder },
  ]

  const parserController = new AbortController()
  if (scan) scan.abortController = parserController

  let connection = null
  if (settings.parserConnection && spindle.connections && typeof spindle.connections.get === 'function') {
    for (const args of [[settings.parserConnection, userId], [settings.parserConnection], [{ connectionId: settings.parserConnection, userId }]]) {
      try {
        connection = await spindle.connections.get(...args)
        if (connection) break
      } catch { /* try the next documented/legacy shape */ }
    }
  }

  const connectionId = settings.parserConnection || undefined
  const connectionModel = connection && (connection.model || connection.defaultModel)
  const requestedModel = String(settings.parserModel || '').trim()
  const useRawOverride = !!(requestedModel && connection && connection.provider && requestedModel !== connectionModel && typeof generateApi.raw === 'function')
  const methodName = useRawOverride ? 'generate.raw' : 'generate.quiet'
  const method = useRawOverride ? generateApi.raw.bind(generateApi) : generateApi.quiet.bind(generateApi)

  const opts = {
    // Operator-scoped extensions must pass the active user explicitly in the
    // request object. Keeping the second-argument retry below preserves
    // compatibility with older generation API shapes.
    userId,
    messages,
    parameters: {
      temperature: 0.2,
      max_tokens: structured ? 1800 : 1200,
    },
    reasoning: { source: 'off' },
    signal: parserController.signal,
  }
  if (connectionId) opts.connection_id = connectionId
  if (useRawOverride) {
    opts.provider = connection.provider
    opts.model = requestedModel
  }

  const parserStarted = Date.now()
  const providerLabel = connection && connection.provider ? connection.provider : 'connection default'
  const modelLabel = useRawOverride ? requestedModel : (connectionModel || requestedModel || 'connection default')
  spindle.log.info('[lumidraw] parser request started' +
    ' · api=' + methodName +
    ' · provider=' + providerLabel +
    ' · model=' + modelLabel +
    (connectionId ? ' · connection_id=' + connectionId : '') +
    ' · reasoning=off · max_tokens=' + opts.parameters.max_tokens)

  if (requestedModel && !useRawOverride && connectionModel && requestedModel !== connectionModel) {
    spindle.log.warn('[lumidraw] parser model override could not be applied because the selected connection did not expose a raw provider route; using connection model ' + connectionModel)
  }

  let timer
  try {
    assertStoryScanActive(scan)
    const remaining = Math.max(1, PARSER_TIMEOUT_MS - (Date.now() - parserStarted))
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { parserController.abort() } catch { /* ignore */ }
        const error = new Error(`Parser request timed out after ${Math.round(PARSER_TIMEOUT_MS / 1000)} seconds.`)
        error.name = 'ParserTimeoutError'
        reject(error)
      }, remaining)
    })

    const requestPromise = (async () => {
      try {
        return await method(opts)
      } catch (error) {
        if (/userId/i.test(error && error.message || '')) return await method(opts, userId)
        throw error
      }
    })()

    const res = await Promise.race([requestPromise, timeoutPromise])
    assertStoryScanActive(scan)

    const responseText = (res && (res.content || res.text ||
      (res.choices && res.choices[0] && (res.choices[0].text || (res.choices[0].message && res.choices[0].message.content))))) ||
      (typeof res === 'string' ? res : null)
    if (!responseText) {
      throw new Error('Parser returned an unrecognized response shape: ' + (res ? Object.keys(res).join(',') : String(res)))
    }

    const elapsed = Date.now() - parserStarted
    const usage = res && res.usage
    const usageText = usage
      ? ' · tokens=' + [usage.prompt_tokens ?? '?', usage.completion_tokens ?? '?', usage.total_tokens ?? '?'].join('/')
      : ''
    const finishText = res && res.finish_reason ? ' · finish=' + res.finish_reason : ''
    spindle.log.info('[lumidraw] parser completed in ' + elapsed + 'ms via ' + methodName + usageText + finishText + ' → raw reply: ' + responseText.trim().slice(0, 500))
    return responseText.trim()
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (scan && scan.cancelled) throw new StoryScanCancelledError()
      const timeout = new Error(`Parser request timed out after ${Math.round(PARSER_TIMEOUT_MS / 1000)} seconds.`)
      timeout.name = 'ParserTimeoutError'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (scan) scan.abortController = null
  }
}


async function quietLLMLegacy(system, user, settings, userId, scan = null) {
  // Deliberately preserves the v0.13 request shape. This is a compatibility
  // engine, not an alias for the newer documented structured transport.
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
    throw new Error('No legacy LLM generation API found. spindle surface: ' + Object.keys(spindle).join(', '))
  }

  const combined = system +
    '\n\n----- STORY PASSAGE -----\n' + user +
    '\n----- END PASSAGE -----\n\nNow respond with ONLY the output the instruction above requires, formatted as one line per image:\n<short verbatim anchor quote of 5-12 words copied exactly from the passage> ||| <comma-separated tag prompt>\nThe anchor marks where in the passage the image belongs. No prose, no explanations, nothing else.'

  const controller = new AbortController()
  if (scan) scan.abortController = controller
  const opts = {
    userId,
    prompt: combined,
    system,
    messages: [{ role: 'user', content: combined }],
    signal: controller.signal,
  }
  if (settings.parserConnection) {
    opts.connection = settings.parserConnection
    opts.connectionId = settings.parserConnection
  }
  if (settings.parserModel) opts.model = settings.parserModel

  const started = Date.now()
  spindle.log.info('[lumidraw] legacy parser request started' +
    (settings.parserConnection ? ' · connection=' + settings.parserConnection : '') +
    (settings.parserModel ? ' · model=' + settings.parserModel : '') +
    ' · transport=v0.13')

  let timer
  try {
    assertStoryScanActive(scan)
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { controller.abort() } catch { /* ignore */ }
        const error = new Error(`Legacy parser request timed out after ${Math.round(PARSER_TIMEOUT_MS / 1000)} seconds.`)
        error.name = 'ParserTimeoutError'
        reject(error)
      }, PARSER_TIMEOUT_MS)
    })

    const runCandidates = async () => {
      const errs = []
      for (const [name, fn] of candidates) {
        try {
          let res
          try { res = await fn(opts) }
          catch (e1) {
            if (/userId/i.test(e1 && e1.message || '')) res = await fn(opts, userId)
            else throw e1
          }
          const responseText = (res && (res.text || res.content ||
            (res.choices && res.choices[0] && (res.choices[0].text || (res.choices[0].message && res.choices[0].message.content))))) ||
            (typeof res === 'string' ? res : null)
          if (responseText) return { name, text: responseText.trim() }
          errs.push(`${name}: unrecognized response shape (${res ? Object.keys(res).join(',') : res})`)
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          errs.push(`${name}: ${error && error.message ? error.message : error}`)
        }
      }
      throw new Error('Legacy parser LLM call failed: ' + errs.join(' | '))
    }

    const result = await Promise.race([runCandidates(), timeoutPromise])
    assertStoryScanActive(scan)
    spindle.log.info('[lumidraw] legacy parser completed in ' + (Date.now() - started) + 'ms via ' + result.name + ' → raw reply: ' + result.text.slice(0, 500))
    return result.text
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (scan && scan.cancelled) throw new StoryScanCancelledError()
      const timeout = new Error(`Legacy parser request timed out after ${Math.round(PARSER_TIMEOUT_MS / 1000)} seconds.`)
      timeout.name = 'ParserTimeoutError'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (scan) scan.abortController = null
  }
}

let activeStoryScan = null
let storyScanSequence = 0
const pendingParserTriggerIds = new Set()

async function scanStory(userId, options = {}) {
  const requestedMessageId = options && options.messageId ? String(options.messageId) : ''
  if (activeStoryScan) {
    return {
      mode: 'busy',
      processed: 0,
      skipped: true,
      activeStage: activeStoryScan.stage,
      activeMessageId: activeStoryScan.messageId,
      note: 'A story scan is already running' + (activeStoryScan.stage ? ' (' + activeStoryScan.stage + ')' : '') + '. LumiDraw skipped this duplicate request.',
    }
  }
  const scan = {
    id: 'scan-' + Date.now() + '-' + (++storyScanSequence),
    userId,
    messageId: requestedMessageId,
    startedAt: Date.now(),
    stage: 'starting',
    note: '',
    cancelled: false,
    abortController: null,
  }
  activeStoryScan = scan
  setStoryScanStage(scan, 'starting', 'Preparing story message.')
  try {
    const result = await scanStoryCore(userId, { ...(options || {}), _scan: scan })
    assertStoryScanActive(scan)
    setStoryScanStage(scan, 'done', result && result.note ? result.note : 'Story scan finished.')
    return result
  } catch (error) {
    if (error && error.name === 'StoryScanCancelledError') {
      setStoryScanStage(scan, 'cancelled', 'Cancelled. No later parser result will start Draw Things.')
      return { mode: 'cancelled', processed: 0, cancelled: true, note: 'Story scan cancelled. No image was generated.' }
    }
    setStoryScanStage(scan, 'error', error && error.message ? error.message : String(error))
    throw error
  } finally {
    if (scan.abortController) { try { scan.abortController.abort() } catch { /* ignore */ } }
    if (activeStoryScan === scan) activeStoryScan = null
  }
}

async function scanStoryCore(userId, options = {}) {
  // Keep compatibility with older internal callers that passed a boolean.
  if (typeof options === 'boolean') options = { force: options }
  const force = !!options.force
  const scan = options._scan || null
  assertStoryScanActive(scan)
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
  if (scan) scan.messageId = String(target.id || requestedMessageId || '')
  assertStoryScanActive(scan)

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
          compiler: compiled.compiler || 'anima-hybrid-v4',
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

    if (settings.parserEngine === 'anima') {
      const profiles = await getStoryProfiles(preset, settings, userId, chatId)
      const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
        .replaceAll('{{max_images}}', String(settings.maxImages || 2))
      const resolvedGuidance = await resolveMacros(guidance, userId, chatId)
      const instruction = resolvedGuidance + structuredParserSchema(settings.maxImages || 2, profiles)
      const instrLabel = usingCustom ? `custom guidance + structured compiler (${instruction.length} chars)` : 'structured subject compiler'
      setStoryScanStage(scan, 'parsing', 'Waiting for the selected parser model.')
      const out = await quietLLM(instruction, passage, settings, userId, true, scan)
      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'compiling', 'Parser returned structured JSON; compiling the Anima prompt.')
      let parsed
      try {
        parsed = parseParserScenes(out, settings.maxImages || 2)
      } catch (error) {
        const storyDebug = await saveStoryDebug({
          mode: 'parser',
          parserEngine: 'anima',
          subjectBinding: true,
          rawReply: out,
          error: error.message,
          entries: [],
          lastCompiledPrompt: '',
        })
        if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
        return {
          mode: 'parser',
          note: `Parser returned invalid structured data — nothing generated (no cost). ${error.message} Raw start: ${out.slice(0, 140)}`,
          storyDebug,
        }
      }
      if (!parsed.length) {
        if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
        if (target.id) await markProcessed(target.id)
        const storyDebug = await saveStoryDebug({ mode: 'parser', parserEngine: 'anima', subjectBinding: true, rawReply: out, entries: [], lastCompiledPrompt: '' })
        return { mode: 'parser', note: `Parser (${instrLabel}) judged no visual moment.`, storyDebug }
      }

      const mds = []
      const debugEntries = []
      const limitedParsed = parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2)))
      let parserImageIndex = 0
      for (const item of limitedParsed) {
        parserImageIndex++
        assertStoryScanActive(scan)
        setStoryScanStage(scan, 'generating', `Sending image ${parserImageIndex} of ${limitedParsed.length} to Draw Things.`)
        const compiled = await compileSceneWithPreset(item.scene, preset, settings, userId, chatId, passage)
        const dims = aspectDims(preset.config, compiled.aspect)
        const entry = await generateAndUpload({
          prompt: compiled.prompt,
          negativePrompt: preset.negativePrompt,
          config: preset.config,
          extra: preset.extra,
          dims,
        }, userId, scan)
        mds.push(`![${compiled.core.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`)
        debugEntries.push({
          anchor: item.anchor,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
          compiler: compiled.compiler || 'anima-hybrid-v4',
        })
      }

      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'inserting', 'Adding generated images to the story message.')
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
        parserEngine: 'anima',
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
    setStoryScanStage(scan, 'parsing', 'Running the v0.13 instruction-only parser.')
    const out = await quietLLMLegacy(await resolveMacros(instruction, userId, chatId), passage, settings, userId, scan)
    assertStoryScanActive(scan)
    setStoryScanStage(scan, 'compiling', 'Parser returned tags; preparing the final prompt.')
    if (/^\s*NONE\s*$/i.test(out)) {
      if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
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
      if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
      return { mode: 'parser', note: `Parser (${instrLabel}) returned prose instead of tags — nothing generated (no cost). Raw start: ` + out.slice(0, 160) }
    }
    const lines = parsed.map((item) => stripBannedTags(item.tags, preset.bannedTags)).filter(Boolean)
    const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
    const charTags = preset.characterTags || (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
    const lead = [preset.qualityTags, charTags].filter(Boolean).join(', ')
    const mds = []
    let firstPrompt = ''
    let legacyImageIndex = 0
    for (const line of lines) {
      legacyImageIndex++
      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'generating', `Sending image ${legacyImageIndex} of ${lines.length} to Draw Things.`)
      const prompt = [lead, prefix, line].filter(Boolean).join(', ')
      if (!firstPrompt) firstPrompt = line
      const entry = await generateAndUpload({
        prompt,
        negativePrompt: preset.negativePrompt,
        config: preset.config,
        extra: preset.extra,
      }, userId, scan)
      mds.push(`![${line.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`)
    }
    assertStoryScanActive(scan)
    setStoryScanStage(scan, 'inserting', 'Adding generated images to the story message.')
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
      mode: 'parser', parserEngine: 'legacy', subjectBinding: false, rawReply: out,
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
          version: (spindle.manifest && spindle.manifest.version) || '0.18.4',
          defaults: { protocol: DEFAULT_PROTOCOL, parserInstruction: LEGACY_DEFAULT_PARSER_INSTRUCTION, legacyParserInstruction: LEGACY_DEFAULT_PARSER_INSTRUCTION, animaParserInstruction: DEFAULT_PARSER_INSTRUCTION },
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
        for (const k of ['mode', 'parserEngine', 'parserConnection', 'parserModel', 'parserInstruction', 'protocol', 'dtModelsPath', 'bridgeHost']) {
          if (payload[k] !== undefined) settings[k] = String(payload[k])
        }
        if (payload.bridgePort !== undefined) settings.bridgePort = Number(payload.bridgePort) || DEFAULT_SETTINGS.bridgePort
        if (payload.autoScan !== undefined) settings.autoScan = !!payload.autoScan
        if (payload.autoCharTags !== undefined) settings.autoCharTags = !!payload.autoCharTags
        if (!['legacy', 'anima'].includes(settings.parserEngine)) settings.parserEngine = 'legacy'
        settings.subjectBinding = settings.parserEngine === 'anima'
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


      case 'frontend_status': {
        spindle.log.info('[lumidraw] frontend status: v' + String(payload.version || '?') +
          ' · history-refresh=' + (payload.historyRefresh ? 'ready' : 'missing') +
          ' · inline-tag=' + (payload.inlineInterceptor ? 'ready' : 'missing') +
          ' · parser-tag=' + (payload.parserInterceptor ? 'ready' : 'missing') +
          (payload.note ? ' · ' + String(payload.note) : ''))
        reply = ok(payload, requestId, { received: true })
        break
      }

      case 'cancel_story_scan': {
        if (!activeStoryScan) {
          reply = ok(payload, requestId, { cancelled: false, note: 'No story scan is currently running.' })
          break
        }
        activeStoryScan.cancelled = true
        activeStoryScan.note = 'Cancellation requested.'
        if (activeStoryScan.abortController) {
          try { activeStoryScan.abortController.abort() } catch { /* ignore */ }
        }
        spindle.log.warn('[lumidraw] story scan cancellation requested · stage=' + activeStoryScan.stage + (activeStoryScan.messageId ? ' · message=' + activeStoryScan.messageId : ''))
        notifyFrontend(userId, 'scan_status', {
          scan: {
            id: activeStoryScan.id,
            stage: 'cancelling',
            note: activeStoryScan.stage === 'generating'
              ? 'Cancellation requested. Draw Things may finish its current local render, but LumiDraw will discard it.'
              : 'Cancellation requested. Waiting for the current provider call to release.',
            messageId: activeStoryScan.messageId || '',
            startedAt: activeStoryScan.startedAt,
            elapsedMs: Date.now() - activeStoryScan.startedAt,
            cancellable: false,
          },
        })
        reply = ok(payload, requestId, { cancelled: true, stage: activeStoryScan.stage })
        break
      }

      case 'parser_trigger': {
        const triggerMessageId = payload.messageId ? String(payload.messageId) : ''
        const triggerKey = triggerMessageId || '__latest__'
        if (pendingParserTriggerIds.has(triggerKey) || (activeStoryScan && (!triggerMessageId || !activeStoryScan.messageId || activeStoryScan.messageId === triggerMessageId))) {
          spindle.log.info('[lumidraw] duplicate parser trigger ignored' + (triggerMessageId ? ' for message ' + triggerMessageId : ''))
          reply = ok(payload, requestId, { accepted: false, duplicate: true, messageId: triggerMessageId, stage: activeStoryScan ? activeStoryScan.stage : 'queued' })
          break
        }
        pendingParserTriggerIds.add(triggerKey)
        spindle.log.info('[lumidraw] parser trigger received' + (triggerMessageId ? ' for message ' + triggerMessageId : ' for latest message'))
        reply = ok(payload, requestId, { accepted: true, messageId: triggerMessageId })
        setTimeout(async () => {
          try {
            const settings = await getSettings()
            if (settings.mode !== 'parser' || settings.autoScan === false) {
              spindle.log.info('[lumidraw] parser trigger ignored because Parser auto-scan is disabled')
              return
            }
            setAutoStatus(userId, {
              mode: 'parser', status: 'running', messageId: triggerMessageId,
              note: 'Committed Parser trigger received — scanning story message…',
            })
            const r = await scanStory(userId, { force: false, messageId: triggerMessageId })
            spindle.log.info('[lumidraw] parser trigger result: ' + JSON.stringify(r))
            const status = r && r.processed ? 'generated' :
              (r && /already illustrated|no visual moment|No story message found|No <dt-image>|busy/i.test(r.note || '') ? 'idle' : 'done')
            setAutoStatus(userId, {
              mode: 'parser', status, messageId: triggerMessageId,
              note: (r && r.note) || '',
            })
          } catch (e) {
            spindle.log.warn('[lumidraw] parser trigger failed: ' + e.message)
            setAutoStatus(userId, { mode: 'parser', status: 'error', messageId: triggerMessageId, note: e.message })
          } finally {
            pendingParserTriggerIds.delete(triggerKey)
          }
        }, 500)
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
    assertStoryScanActive(scan)
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
        assertStoryScanActive(scan)
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
          'At the very end of every assistant reply, always append exactly one line containing this XML tag and nothing else on that line:',
          PARSER_TRIGGER_TAG,
          'This tag is only a private completion signal for LumiDraw; LumiDraw decides whether the scene warrants an image.',
          'Do not output Markdown image syntax. Do not describe the tag. Do not output more than one trigger tag.',
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
  spindle.log.info('[lumidraw] story protocol interceptor registered')
} else {
  spindle.log.warn('[lumidraw] registerInterceptor not available — story protocol injection disabled')
}

// Documented render-event fallback. The native parser tag interceptor is the
// primary trigger; CHARACTER_MESSAGE_RENDERED catches models that omit the tag.
let scanInFlight = false
let lastAutoHandledMessageId = ''
;(() => {
  const on = (typeof spindle.on === 'function') ? spindle.on.bind(spindle)
    : (spindle.events && typeof spindle.events.on === 'function') ? spindle.events.on.bind(spindle.events)
    : null
  if (!on) {
    spindle.log.warn('[lumidraw] lifecycle events unavailable — native tag trigger and manual scan remain available')
    return
  }

  const handler = async (evt) => {
    try {
      const settings = await getSettings()
      if (settings.mode === 'off' || settings.autoScan === false) return
      const eventPayload = evt && evt.payload ? evt.payload : evt || {}
      const messageId = String(eventPayload.messageId || (eventPayload.message && (eventPayload.message.id || eventPayload.message.messageId)) || '')
      const uid = eventPayload.userId || lastUserId
      if (!uid || !messageId || scanInFlight || messageId === lastAutoHandledMessageId) return

      const { messages } = await fetchMessages(uid)
      let latest = null
      for (let i = messages.length - 1; i >= 0; i--) {
        const bits = messageBits(messages[i])
        if (bits.isAssistant && bits.contentKey && typeof bits.content === 'string') { latest = bits; break }
      }
      if (!latest || String(latest.id) !== messageId) return

      scanInFlight = true
      spindle.log.info('[lumidraw] CHARACTER_MESSAGE_RENDERED fallback received for latest message ' + messageId)
      setTimeout(async () => {
        try {
          const r = await scanStory(uid, { messageId, force: false })
          spindle.log.info('[lumidraw] render-event auto-scan result: ' + JSON.stringify(r))
          if (!r || !r.skipped) lastAutoHandledMessageId = messageId
          const status = r && r.processed ? 'generated' :
            (r && /nothing generated|no visual moment|already illustrated|No <dt-image>|busy/i.test(r.note || '') ? 'idle' : 'done')
          setAutoStatus(uid, { mode: r && r.mode ? r.mode : settings.mode, status, messageId, note: (r && r.note) || '' })
        } catch (e) {
          spindle.log.warn('[lumidraw] render-event auto-scan failed: ' + e.message)
          setAutoStatus(uid, { mode: settings.mode, status: 'error', messageId, note: e.message })
        } finally {
          scanInFlight = false
        }
      }, 700)
    } catch (e) {
      scanInFlight = false
      spindle.log.warn('[lumidraw] CHARACTER_MESSAGE_RENDERED handler failed: ' + e.message)
    }
  }

  try {
    on('CHARACTER_MESSAGE_RENDERED', handler)
    spindle.log.info('[lumidraw] documented CHARACTER_MESSAGE_RENDERED fallback registered')
  } catch (e) {
    spindle.log.warn('[lumidraw] CHARACTER_MESSAGE_RENDERED registration failed: ' + e.message)
  }
})()

spindle.log.info('[lumidraw] spindle API surface: ' + Object.keys(spindle).join(', '))
spindle.log.info('[lumidraw] backend loaded v' + ((spindle.manifest && spindle.manifest.version) || '0.18.4'))
