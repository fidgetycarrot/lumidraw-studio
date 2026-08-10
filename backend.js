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
const PERSONAS_FILE = 'personas.json'
const CHARACTERS_FILE = 'characters.json'
const HISTORY_FILE = 'history.json'
const STORY_DEBUG_FILE = 'story_debug.json'
const SCENE_MEMORY_FILE = 'scene_memory.json'

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 7862,
  mode: 'off',            // 'off' | 'inline' | 'parser'
  autoScan: true,         // auto-process after each story message (when events are available)
  activePreset: '',       // preset used for story-driven generations
  parserConnection: '',   // optional connection name/id for the parser LLM
  parserModel: '',        // optional model override for the parser LLM
  parserRequestOverrides: '', // JSON merged into the parser request — the escape hatch for provider-specific reasoning keys
  parserMaxTokens: 12000, // first-attempt output budget; sized to survive a reasoning model rather than fight it
  parserInstruction: '',  // selected engine instruction (blank = that engine's built-in default)
  parserEngine: 'legacy',  // 'legacy' (v0.13 instruction-only) | 'anima' (structured JSON compiler)
  parserContextMessages: 2, // Anima only: number of immediately preceding chat messages used as reference context
  useLoomLedger: true,     // Anima only: extract the latest <loomledger> block as continuity reference
  maxImages: 2,           // max illustrations per story message
  minImages: 0,           // required illustrations per reply (0 = model's discretion)
  autoCharTags: true,     // use active character image tags as a profile fallback
  subjectBinding: false,  // legacy compatibility mirror of parserEngine === 'anima'
  dtModelsPath: '',       // retained for compatibility with older settings
  bridgeHost: '127.0.0.1', // native LumiDraw Bridge runs on the Lumiverse Mac
  bridgePort: 7863,
  protocol: '',           // tag guidance for Inline mode (blank = pre-0.17 default)
  stripImageDirectives: true, // remove dead ![...](/…/gen) image-request directives from the prompt context
  sizeChatImages: false,  // off by default: a custom Lumiverse stylesheet would fight it
  chatImageWidth: 500,    // px, only consulted when sizeChatImages is on
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

const DEFAULT_PARSER_INSTRUCTION = `Choose the strongest visual moment in the story passage. Prefer one image, but you may choose up to {{max_images}} distinct moments. Extract a compact visual skeleton: subjects, current clothing, expressions, poses, support surfaces, the base body arrangement, direct contact points, setting, camera, and lighting. Every value is a lowercase Danbooru/Gelbooru-style tag, never hedged prose. Do not rewrite permanent character identity or invent anatomy. LumiDraw compiles this into an Anima prompt itself: a tag run in Anima's trained order, followed by a natural-language caption block that names each character and describes their appearance, which is Anima's documented remedy for traits bleeding between characters. Give it clean scene state and let it own the wording.`
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
  settings.parserContextMessages = Math.max(0, Math.min(4, Number(settings.parserContextMessages) || 0))
  settings.useLoomLedger = settings.useLoomLedger !== false
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

async function getPersonas() {
  const value = await spindle.storage.getJson(PERSONAS_FILE, { fallback: [] })
  return Array.isArray(value) ? value : []
}

async function savePersonas(personas) {
  await spindle.storage.setJson(PERSONAS_FILE, personas, { indent: 2 })
}

async function getCharacters() {
  const value = await spindle.storage.getJson(CHARACTERS_FILE, { fallback: [] })
  return Array.isArray(value) ? value : []
}

async function saveCharacters(characters) {
  await spindle.storage.setJson(CHARACTERS_FILE, characters, { indent: 2 })
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


// The location a chat has established, so an uncertain parser cannot relocate
// the story. Keyed by chat AND preset: memory outranks a preset's scene anchor,
// so a chat-only key meant the first preset to run in a chat set the location for
// every other preset used there, and a second preset's anchor was dead on arrival.
// A preset has to be something you can stay inside.
function sceneMemoryKey(chatId, presetName) {
  const chat = String(chatId || '').trim()
  if (!chat) return ''
  const preset = String(presetName || '').trim()
  return preset ? `${chat}::${preset}` : chat
}

async function getSceneMemory() {
  const value = await spindle.storage.getJson(SCENE_MEMORY_FILE, { fallback: {} })
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Entries written before memory was preset-scoped are keyed by chat alone. The
// first preset to ask for one adopts it, and the unscoped entry is removed, so the
// upgrade keeps continuity for whoever is using the chat now without leaving a
// shared entry behind for the next preset to inherit.
async function readSceneMemory(chatId, presetName) {
  const memory = await getSceneMemory()
  const scoped = sceneMemoryKey(chatId, presetName)
  if (scoped && memory[scoped]) return memory[scoped]
  const legacy = String(chatId || '').trim()
  if (!legacy || !memory[legacy] || legacy === scoped) return {}
  const adopted = memory[legacy]
  try {
    memory[scoped] = { ...adopted, at: Date.now() }
    delete memory[legacy]
    await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
    spindle.log.info(`[lumidraw] scene memory for this chat is now scoped to the preset "${presetName}". ` +
      'Other presets start from their own scene anchor.')
  } catch (error) {
    spindle.log.warn('[lumidraw] could not migrate scene memory: ' + error.message)
  }
  return adopted
}

async function rememberSceneState(chatId, presetName, { setting = [], lighting = [], outfits = null } = {}) {
  const key = sceneMemoryKey(chatId, presetName)
  const tags = uniqueStrings(setting || []).slice(0, 6)
  const light = uniqueStrings(lighting || []).slice(0, 4)
  const wardrobe = outfits && typeof outfits === 'object' ? outfits : null
  if (!key || (!tags.length && !light.length && !wardrobe)) return
  try {
    const memory = await getSceneMemory()
    const previous = memory[key] || {}
    // Merged, not replaced: a character absent from this scene keeps whatever
    // they were last seen wearing, which is the whole point of remembering.
    const mergedOutfits = { ...(previous.outfits || {}) }
    for (const [ref, worn] of Object.entries(wardrobe || {})) {
      const items = uniqueStrings(worn || []).slice(0, 6)
      if (items.length) mergedOutfits[ref] = items
    }
    memory[key] = {
      setting: tags.length ? tags : (previous.setting || []),
      lighting: light.length ? light : (previous.lighting || []),
      outfits: mergedOutfits,
      at: Date.now(),
    }
    const keys = Object.keys(memory)
    if (keys.length > 40) {
      keys.sort((a, b) => (memory[a].at || 0) - (memory[b].at || 0))
      for (const stale of keys.slice(0, keys.length - 40)) delete memory[stale]
    }
    await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
  } catch (error) {
    spindle.log.warn('[lumidraw] could not remember the scene state: ' + error.message)
  }
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

// Draw Things answers an unknown payload key with
// {"detail":"Unrecognized keys: [foo, bar]"}. Surfacing those names verbatim,
// with where to remove them, turns a dead generation into a one-step fix.
function describeDtRejection(message) {
  const text = String(message || '')
  const ranged = /Value for\s+([A-Za-z_][A-Za-z0-9_]*)\s+must be([^.]*)/i.exec(text)
  if (ranged) {
    return `Draw Things will not accept the value LumiDraw captured for ${ranged[1]}: it must be${ranged[2]}. ` +
      `This usually means the value is meaningful inside the Draw Things app but not through its generation API — ` +
      `-1 for "off", for instance. ${ranged[1]} has been dropped and will be omitted from now on, so Draw Things ` +
      `uses its own setting. Clear the list in Settings if you change it there.`
  }
  const match = /Unrecognized keys:\s*\[([^\]]*)\]/i.exec(text)
  if (!match) return text
  const keys = match[1].split(',').map((key) => key.trim()).filter(Boolean)
  if (!keys.length) return text
  return `Draw Things does not accept ${keys.length === 1 ? 'this setting' : 'these settings'}: ` +
    keys.join(', ') +
    `. Remove ${keys.length === 1 ? 'it' : 'them'} in Studio → Draw Things settings (or clear the value) and generate again. ` +
    `This usually means the setting exists in Draw Things' interface but not in its generation API, or your Draw Things version is older than the setting.`
}

// Keys LumiDraw sets per request. A config or extras block may not override
// them, or a preset would silently re-prompt or re-seed the generation.
// Matched by canonical spelling, not literally. A preset holding "negativePrompt"
// used to sail past a set containing only "negative_prompt" and land on the payload
// beside the real one — a second negative prompt LumiDraw never composed, and a
// "must only specify one of" rejection from Draw Things when it noticed.
const RESERVED_PAYLOAD_KEYS = new Set(['prompt', 'negative_prompt', 'seed', 'batch_count'])
const RESERVED_CANONICAL = new Set(['prompt', 'negativeprompt', 'seed', 'batchcount'])

function buildPayload({ prompt, negativePrompt, seed, config, extra }) {
  const payload = {}

  // Every Draw Things setting the workspace holds is sent, not a fixed
  // whitelist. The config originates from Draw Things' own GET / response, so
  // its key names are DT's rather than anything guessed here — that is what
  // makes full pass-through safe enough to prefer over a curated subset.
  // Draw Things treats compression_artifacts and compressionArtifacts as one
  // setting and refuses a payload naming it twice:
  //
  //   More than one key for Compression Artifacts specified
  //   (must only specify one of ["compression_artifacts", "compression_artifacts"])
  //
  // The same name printed twice is the tell — one canonical setting reached by
  // two spellings. Sync captures snake_case from GET /; a preset's extras may
  // hold camelCase. Both are distinct JavaScript keys and neither looks wrong.
  const canonicalKey = (key) => String(key).toLowerCase().replace(/[_-]/g, '')
  const seenByCanonical = new Map()

  const assign = (source) => {
    if (!source || typeof source !== 'object') return
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null || value === '') continue
      const canonical = canonicalKey(key)
      if (RESERVED_CANONICAL.has(canonical)) {
        if (!RESERVED_PAYLOAD_KEYS.has(key)) {
          spindle.log.info(`[lumidraw] ignoring "${key}" from the preset — LumiDraw sets that per request. ` +
            `If a negative prompt is appearing that you did not write, this was it.`)
        }
        continue
      }
      const previous = seenByCanonical.get(canonical)
      // Later assignment wins, matching the precedence below — but the earlier
      // spelling has to be removed, not merely overwritten, or both go out.
      if (previous && previous !== key) {
        delete payload[previous]
        spindle.log.info(`[lumidraw] "${key}" and "${previous}" are the same Draw Things setting; sending only "${key}"`)
      }
      seenByCanonical.set(canonical, key)
      payload[key] = value
    }
  }

  // Extras first so the visible workspace/preset always wins on conflict.
  assign(extra)
  assign(config)

  payload.prompt = prompt || ''
  if (negativePrompt) payload.negative_prompt = negativePrompt
  const parsedSeed = Number(seed)
  if (Number.isFinite(parsedSeed) && parsedSeed >= 0) payload.seed = parsedSeed

  // Story and manual actions in LumiDraw are one-image operations. Draw Things
  // otherwise may reuse the batch count currently selected in its own UI.
  payload.batch_count = 1
  return payload
}


// --- rejected-key memory ------------------------------------------------------
// Full pass-through was the right call for exposing every Draw Things setting,
// and the wrong call for reliability: Draw Things refuses the ENTIRE request if
// one key is not in its generation API, so a single unsupported setting breaks
// Studio completely.
//
// Draw Things names the offenders in its error. Remembering them turns "Studio
// is broken until you find the bad key by hand" into one failure per key, ever.
const REJECTED_KEYS_FILE = 'rejected_dt_keys.json'
let rejectedKeyCache = null

async function getRejectedKeys() {
  if (rejectedKeyCache) return rejectedKeyCache
  try {
    // getJson/setJson are what every other store in this file uses; the plain
    // get/set pair used here originally appears nowhere else, and the silent
    // catch below meant a failed write was indistinguishable from a successful
    // one — the list would have been relearned on every restart, forever.
    const parsed = await spindle.storage.getJson(REJECTED_KEYS_FILE)
    rejectedKeyCache = new Set(Array.isArray(parsed) ? parsed : (parsed && parsed.keys) || [])
  } catch (error) {
    rejectedKeyCache = new Set()
    spindle.log.warn('[lumidraw] could not read the rejected-settings list (' + error.message +
      '); Draw Things settings will be relearned this session.')
  }
  return rejectedKeyCache
}

async function rememberRejectedKeys(keys) {
  const set = await getRejectedKeys()
  let added = 0
  for (const key of keys || []) {
    const value = String(key || '').trim()
    if (value && !set.has(value)) { set.add(value); added++ }
  }
  if (!added) return false
  try {
    await spindle.storage.setJson(REJECTED_KEYS_FILE, [...set], { indent: 2 })
    spindle.log.info('[lumidraw] remembered ' + added + ' refused Draw Things setting(s); ' +
      set.size + ' total. This survives restarts and updates — clear it in Settings after a Draw Things update.')
  } catch (error) {
    spindle.log.warn('[lumidraw] COULD NOT SAVE the rejected-settings list (' + error.message +
      '). Draw Things will refuse the same settings again after a restart. This is worth reporting.')
  }
  return true
}

async function forgetRejectedKeys() {
  rejectedKeyCache = new Set()
  try { await spindle.storage.setJson(REJECTED_KEYS_FILE, [], { indent: 2 }) }
  catch (error) { spindle.log.warn('[lumidraw] could not clear the rejected-settings list: ' + error.message) }
}

// Draw Things refuses a payload in two different ways, and only one of them was
// being read.
//
//   Unrecognized keys: [tiled_decoding]
//     — the key does not exist in the generation API at all.
//
//   Value for tea_cache_end must be between 0 and 1000, inclusive (was -1)
//     — the key exists, but the value we captured on Sync is valid as the app's
//       internal state and invalid as API input. -1 means "off" inside Draw
//       Things; the API will not take it.
//
// Both are the same problem from here: a key we cannot send. Dropping it is
// better than guessing a replacement, because an absent key leaves Draw Things
// on its own setting — which is what -1 meant in the first place.
function rejectedKeysIn(message) {
  const text = String(message || '')
  const keys = []

  const unknown = /Unrecognized keys:\s*\[([^\]]*)\]/i.exec(text)
  if (unknown) {
    for (const key of unknown[1].split(',')) {
      const value = key.trim().replace(/^["']|["']$/g, '')
      if (value) keys.push(value)
    }
  }

  // "must only specify one of [\"a\", \"b\"]" — one setting, two spellings.
  const duplicate = /must only specify one of\s*\[([^\]]*)\]/i.exec(text)
  if (duplicate) {
    for (const key of duplicate[1].split(',')) {
      const value = key.trim().replace(/^["']|["']$/g, '')
      if (value && !keys.includes(value)) keys.push(value)
    }
  }

  // "Value for X must be …", "X must be between …", "Invalid value for X"
  const rangePatterns = [
    /Value for\s+([A-Za-z_][A-Za-z0-9_]*)\s+must be/gi,
    /Invalid value for\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+must be (?:between|greater|less|at least|at most|a )/gim,
  ]
  for (const pattern of rangePatterns) {
    pattern.lastIndex = 0
    let hit
    while ((hit = pattern.exec(text))) {
      const value = (hit[1] || '').trim()
      if (value && !keys.includes(value)) keys.push(value)
    }
  }
  return keys
}

async function dtGenerate(settings, payload, attempt = 0) {
  const rejected = await getRejectedKeys()
  const dropped = Object.keys(payload).filter((key) => rejected.has(key) && !RESERVED_PAYLOAD_KEYS.has(key))
  if (dropped.length) {
    for (const key of dropped) delete payload[key]
    spindle.log.info('[lumidraw] omitted setting(s) Draw Things has rejected before: ' + dropped.join(', '))
  }
  spindle.log.info('[lumidraw] Draw Things payload keys: ' + Object.keys(payload).sort().join(', '))
  spindle.log.info('[lumidraw] Draw Things payload: ' + JSON.stringify({
    ...payload,
    prompt: String(payload.prompt || '').slice(0, 160),
    negative_prompt: String(payload.negative_prompt || '').slice(0, 80),
  }))
  const res = await dtFetch(settings, '/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 600000) // generations can be slow on-device; 10 min budget
  if (!res.ok || !res.json || !Array.isArray(res.json.images) || res.json.images.length === 0) {
    const raw = extractDtError(res)
    const offenders = rejectedKeysIn(raw)
    // Learn and retry once. The first generation that meets a new unsupported
    // setting still succeeds, and no later one meets it again.
    // Keep going while each attempt names something new. A freshly synced
    // config can carry several unusable keys, and Draw Things reports only the
    // first one it trips over — so retrying ONCE meant one failed generation
    // per bad key before the config settled. Now it converges within a single
    // generation.
    const stillPresent = offenders.filter((key) => key in payload)
    if (stillPresent.length && attempt < 5) {
      await rememberRejectedKeys(stillPresent)
      spindle.log.warn('[lumidraw] Draw Things refused ' + stillPresent.join(', ') +
        ' — dropping ' + (stillPresent.length === 1 ? 'it' : 'them') + ' and retrying (round ' + (attempt + 1) + ' of 5). ' +
        'These settings will be omitted from now on; clear the list in Settings if Draw Things is updated.')
      const retry = { ...payload }
      for (const key of stillPresent) delete retry[key]
      return dtGenerate(settings, retry, attempt + 1)
    }
    if (offenders.length && !stillPresent.length) {
      spindle.log.warn('[lumidraw] Draw Things named ' + offenders.join(', ') +
        ' but the payload no longer contains ' + (offenders.length === 1 ? 'it' : 'them') +
        ' — the setting is probably active in the Draw Things app itself rather than in this request.')
    }
    throw new Error(`Draw Things rejected the generation: ${describeDtRejection(raw)}`)
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

// --- foreign image-directive scrubbing --------------------------------------
//
// Other image integrations teach the model to REQUEST an image by writing
// markdown whose href is a fixed endpoint rather than a stored file, e.g.
// "![tags](/api/v1/images/gen)". Those never render, and — worse — every one
// left in the history is a few-shot example teaching the model to emit
// another, so they breed. Stripping them from the model's view of the
// conversation breaks that loop.
//
// Deliberately narrow: a real image (LumiDraw's own, an upload, a data URL, an
// external link) carries an identifying segment and is always left alone, so a
// working SwarmUI-style setup in another chat is not sabotaged.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g
const DIRECTIVE_ENDPOINT_RE = /(?:^|\/)(?:gen|generate|generation|create|new|render|txt2img)$/i

// Conservative by design. A missed directive is harmless; a real image wrongly
// classified would be hidden from the model, so anything that could plausibly
// be a stored file is kept. Only a URL whose path ENDS at a bare verb counts —
// a folder named "gen" or "create" further up the path is not enough.
// A generated image is for the reader, not for the story model. Left in the
// context it teaches the model the pattern — and models imitate patterns they
// keep seeing. The result is invented markdown with plausible-looking UUIDs
// pointing at images that were never generated, which is precisely the failure
// that produced four orphaned tags in one message.
//
// This only ever edits the copy sent for a generation; the stored chat keeps
// its images.
const HOSTED_IMAGE_PATH_RE = /\/(?:api\/v\d+\/)?images?\/[0-9a-f-]{8,}/i

function looksLikeImageDirective(url) {
  const href = String(url || '').trim()
  if (!href) return true
  if (/^data:/i.test(href)) return false                  // inline image data
  const path = href.split('?')[0].split('#')[0].replace(/\/+$/, '')
  const last = path.split('/').pop() || ''
  if (DIRECTIVE_ENDPOINT_RE.test(path)) return true       // ends at a bare verb
  if (HOSTED_IMAGE_PATH_RE.test(path)) return true        // an image we inserted
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return false        // a filename
  return false                                            // unknown → leave alone
}

function stripForeignImageDirectives(text) {
  const value = String(text || '')
  if (!value.includes('![')) return { text: value, count: 0 }
  let count = 0
  const next = value.replace(MARKDOWN_IMAGE_RE, (match, href) => {
    if (!looksLikeImageDirective(href)) return match
    count++
    return ''
  })
  if (!count) return { text: value, count: 0 }
  return { text: next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), count }
}
const PARSER_TRIGGER_TAG = '<lumidraw-parse request="generate"></lumidraw-parse>'
const PARSER_TRIGGER_RE = /<lumidraw-parse\b[^>]*><\/lumidraw-parse>|<lumidraw-parse\b[^>]*>[\s\S]*?<\/lumidraw-parse>|<lumidraw-parse\b[^>]*\/>/gi
const LOOM_LEDGER_RE = /<loomledger\b[^>]*>[\s\S]*?<\/loomledger>/gi
const PARSER_UTILITY_CARD_RE = /<(?:scenecard|adventurecard|statuscard|choicecard|summarycard)\b[^>]*>[\s\S]*?<\/(?:scenecard|adventurecard|statuscard|choicecard|summarycard)>/gi

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

function extractLoomLedgers(text) {
  LOOM_LEDGER_RE.lastIndex = 0
  return [...String(text || '').matchAll(LOOM_LEDGER_RE)].map((match) => match[0]).filter(Boolean)
}

function stripLoomLedgers(text) {
  LOOM_LEDGER_RE.lastIndex = 0
  return String(text || '').replace(LOOM_LEDGER_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function stripParserUtilityCards(text) {
  PARSER_UTILITY_CARD_RE.lastIndex = 0
  return String(text || '').replace(PARSER_UTILITY_CARD_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function decodeBasicHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function loomLedgerToText(html) {
  return decodeBasicHtmlEntities(String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(?:li|h[1-6]|p|summary|div)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim())
}

// Out-of-character asides are a conversation with the author, not a moment in the
// story. Illustrating one produces a picture of nothing, and the alternative was
// switching the extension off and on around every "[ooc]:".
//
// A marker at the very start means the whole message is out of character. A marker
// anywhere else marks that span or that line only, so a story message carrying a
// short aside is still illustrated — from the story part.
const OOC_DELIMITED_RE = /(\(\(|\[\[|\{\{|\(|\[|\{)\s*(?:ooc|o\.o\.c\.?)\b[^)\]}]*(\)\)|\]\]|\}\}|\)|\]|\})/gi
const OOC_LINE_RE = /^[ \t>*_~-]*(?:\(\(|\[\[|\{\{|\(|\[|\{)?\s*(?:ooc|o\.o\.c\.?|out[- ]of[- ]character)\b[^\n]*$/gim
const OOC_OPENING_RE = /^[\s>*_~-]*(?:\(\(|\[\[|\{\{|\(|\[|\{)?\s*(?:ooc|o\.o\.c\.?|out[- ]of[- ]character)\b\s*[:\-\]})]/i

// Any story prose left once the asides are removed? A message that is nothing but
// an aside has none, and there is nothing in it to draw.
function stripOutOfCharacter(text) {
  return String(text || '')
    .replace(OOC_DELIMITED_RE, ' ')
    .replace(OOC_LINE_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Reported separately from the strip so a skip can say which it was.
function outOfCharacterVerdict(text) {
  const value = String(text || '').trim()
  if (!value) return { ooc: false, reason: '' }
  if (OOC_OPENING_RE.test(value)) return { ooc: true, reason: 'the message opens with an out-of-character marker' }
  const remaining = stripOutOfCharacter(value)
  // Punctuation and stray brackets are not a scene. Ten characters of actual
  // words is the floor for calling something a passage worth illustrating.
  if (remaining.replace(/[^\p{L}\p{N}]/gu, '').length < 10) {
    return { ooc: true, reason: 'nothing but out-of-character text remains once the asides are removed' }
  }
  return { ooc: false, reason: '' }
}

// An out-of-character question usually gets an out-of-character answer, but the
// answer carries no marker of its own — the assistant simply replies. And "[ooc]:
// continue the scene" produces real narrative that should still be illustrated.
// So the preceding user message decides whether to look, and the reply's own shape
// decides the verdict.
//
// Meta: written to the author. Second person, offers, questions aimed outward.
const META_ADDRESS_RE = /\b(?:would you like|do you want|shall i|let me know|want me to|i can |i (?:will|could|should) |i'?ll |i'?ve |if you(?:'?d| would)|you(?:'?d| would) (?:like|prefer|rather)|happy to|no problem|got it|understood|makes sense|good catch|my mistake|sorry about|to clarify|just to check|which (?:one|scene|version))\b/i
const META_NOUN_RE = /\b(?:scene|chapter|reply|response|message|post|prompt|recap|summary|continuity|retcon|the parser|out[- ]of[- ]character|character sheet|token|context window)\b/i
// Narrative: written about the story. Dialogue, and past-tense prose in sentences.
const NARRATIVE_QUOTE_RE = /[“"][^”"]{12,}[”"]/
const NARRATIVE_PROSE_RE = /\b\w{3,}ed\b[^.!?]{0,120}[.!?]/

function assistantReplyIsMeta(text, knownNames = []) {
  const value = String(text || '').trim()
  if (!value) return { meta: false, reason: '' }
  const words = value.split(/\s+/).filter(Boolean).length

  // Addressing the author settles it first. "Understood — I'll keep Sovi out of the
  // next scene" names a character but is still a reply to you, not a scene, so the
  // cast check cannot be allowed to veto this one.
  if (META_ADDRESS_RE.test(value)) {
    return { meta: true, reason: 'the reply is addressed to you rather than describing a scene' }
  }
  if (NARRATIVE_QUOTE_RE.test(value)) return { meta: false, reason: 'the reply contains dialogue' }

  // Then the strongest narrative signal available: the story's own cast. An aside
  // about pacing does not name Sovi; a scene does.
  const named = knownNames.filter(Boolean).find((name) => {
    const trimmed = String(name).trim()
    if (trimmed.length < 3) return false
    return new RegExp('\\b' + escapeRegExp(trimmed) + '\\b', 'i').test(value)
  })
  if (named) return { meta: false, reason: `the reply names ${named}` }

  const secondPerson = /\byou(?:'?re|'?ve|r)?\b/i.test(value)
  if (META_NOUN_RE.test(value) && secondPerson) {
    return { meta: true, reason: 'the reply talks to you about the writing rather than telling it' }
  }
  // No cast, no dialogue, no past-tense sentence, and short: an aside.
  if (words < 40 && !NARRATIVE_PROSE_RE.test(value)) {
    return { meta: true, reason: 'the reply is a short aside with no scene in it' }
  }
  return { meta: false, reason: 'the reply reads as narrative prose' }
}

function cleanParserMessageText(text, { keepLedger = false } = {}) {
  let value = stripParserUtilityCards(stripParserTrigger(stripThinking(text)))
  if (!keepLedger) value = stripLoomLedgers(value)
  // Before the tag strip, so an aside can never reach the parser as story prose
  // and become scenery.
  value = stripOutOfCharacter(value)
  return value
    .replace(TAG_RE, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildAnimaParserInput(messages, targetIndex, target, settings, sceneState = null) {
  const currentPassage = cleanParserMessageText(target.content).slice(-6000)
  const contextCount = Math.max(0, Math.min(4, Number(settings.parserContextMessages) || 0))
  const previous = []
  if (contextCount > 0 && Number.isInteger(targetIndex) && targetIndex > 0) {
    // Prefer the nearest messages and cap the entire reference window. Large
    // scene/adventure cards are stripped above and cannot crowd out the actual
    // prose or inflate the parser request.
    const collected = []
    let remainingChars = 3000
    const start = Math.max(0, targetIndex - contextCount)
    for (let i = targetIndex - 1; i >= start && remainingChars > 0; i--) {
      const bits = messageBits(messages[i])
      if (!bits.contentKey || typeof bits.content !== 'string') continue
      const cleanAll = cleanParserMessageText(bits.content)
      if (!cleanAll) continue
      const clean = cleanAll.slice(-Math.min(1200, remainingChars))
      if (!clean) continue
      const label = bits.isAssistant ? 'Previous assistant message' : bits.isUser ? 'Previous user message' : 'Previous chat message'
      collected.push(`[${label}]\n${clean}`)
      remainingChars -= clean.length
    }
    previous.push(...collected.reverse())
  }

  let ledgerText = ''
  if (settings.useLoomLedger !== false && Number.isInteger(targetIndex)) {
    for (let i = targetIndex; i >= Math.max(0, targetIndex - 12); i--) {
      const bits = messageBits(messages[i])
      if (!bits.contentKey || typeof bits.content !== 'string') continue
      const ledgers = extractLoomLedgers(bits.content)
      if (!ledgers.length) continue
      ledgerText = loomLedgerToText(ledgers[ledgers.length - 1]).slice(-3200)
      if (ledgerText) break
    }
  }

  const sections = []
  // The established location, stated outright. A recency window is the wrong
  // instrument for stable facts: during a long scene the prose stops naming
  // the place precisely because everyone already knows it, so the window goes
  // blank exactly when the schema still demands a setting tag. This block is
  // small, always present, and independent of how far back the location was
  // last mentioned.
  const stateLines = []
  if (sceneState && (sceneState.setting || []).length) stateLines.push('Location: ' + sceneState.setting.join(', '))
  if (sceneState && (sceneState.lighting || []).length) stateLines.push('Lighting: ' + sceneState.lighting.join(', '))
  if (stateLines.length) {
    sections.push('----- ESTABLISHED SCENE STATE — AUTHORITATIVE -----\n' +
      'This is where the story currently is. Use it for setting and lighting unless the CURRENT PASSAGE states that the characters moved or the light changed. Never invent a different place, and never describe a location that appears nowhere in this request.\n\n' +
      stateLines.join('\n'))
  }
  if (previous.length) {
    sections.push('----- PRIOR CONTEXT — REFERENCE ONLY -----\nUse only to resolve identity, pronouns, carried props, clothing continuity, accessories, location, and circumstances. Do not choose an image moment or anchor from this section. Current passage details override it.\n\n' + previous.join('\n\n'))
  }
  if (ledgerText) {
    sections.push('----- LATEST LOOM LEDGER — CONTINUITY REFERENCE ONLY -----\nTreat this as state/continuity evidence for attire, accessories, location, and status. Do not illustrate the ledger itself. Do not copy an older action from it. Current passage details override it.\n\n' + ledgerText)
  }
  sections.push('----- CURRENT PASSAGE — ILLUSTRATE ONLY THIS SECTION -----\nAll image anchors and depicted actions must come from this section.\n\n' + currentPassage)

  return {
    input: sections.join('\n\n'),
    currentPassage,
    contextPreview: previous.join('\n\n').slice(0, 1800),
    ledgerPreview: ledgerText.slice(0, 1800),
    contextMessageCount: previous.length,
    ledgerFound: !!ledgerText,
  }
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
        try { active = await withTimeout(spindle.chats[fn](userId), 10000, 'chats.' + fn) }
        catch { active = await withTimeout(spindle.chats[fn](), 10000, 'chats.' + fn) }
        const id = active && (active.id || active.chatId || active)
        if (id) return id
      } catch { /* try next */ }
    }
  }
  return null
}

async function fetchMessages(userId, explicitChatId = '') {
  const chatApi = spindle.chat || spindle.chats
  if (!chatApi || typeof chatApi.getMessages !== 'function') {
    throw new Error('Chat read API unavailable (chats permission granted?).')
  }
  const chatId = String(explicitChatId || '').trim() || await resolveActiveChatId(userId)
  const shapes = []
  // Current documented Chat Mutation shape. Explicit event chat IDs matter for
  // automatic scans because the user may switch chats before the parser starts.
  if (chatId) shapes.push([chatId], [chatId, userId], [{ chatId, userId }])
  shapes.push([undefined, userId], [{ userId }], [])
  const errs = []
  for (const args of shapes) {
    if (args.length && args[0] === null) continue
    try {
      const res = await withTimeout(chatApi.getMessages(...args), 15000, 'chats.getMessages')
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
  const isAssistant = role.includes('assistant') || role.includes('char') || role === 'ai'
  const isUser = role.includes('user') || role.includes('persona') || role === 'human'
  return {
    id: m.id || m.messageId,
    contentKey,
    content: contentKey ? m[contentKey] : null,
    createdAt: m.createdAt || m.created_at || m.timestamp || null,
    role,
    isAssistant,
    isUser,
  }
}

function storyPreview(content, maxLength = 260) {
  const clean = stripLoomLedgers(stripThinking(content))
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A hung host RPC (chat read against a dead frontend process, for example)
// otherwise pins a story scan at "starting" forever, holding the single scan
// lane and leaving the panel timer counting for eternity.
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function comparableMessageText(value) {
  return cleanParserMessageText(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

async function locateStoryMessage(userId, options = {}) {
  const requestedMessageId = String(options.messageId || '')
  const requestedChatId = String(options.chatId || '')
  const expected = comparableMessageText(options.expectedContent || '')
  const isAuto = !!options.auto
  const attempts = isAuto ? 10 : 1
  // Each attempt is a full chat fetch; on a slow host 10 of those for a
  // message that will never appear kept the scan pinned at "Preparing story
  // message" for a minute or more. Retries stop once the overall budget is
  // spent, and early once the message list itself has clearly settled.
  const LOOKUP_BUDGET_MS = 20000
  const lookupStarted = Date.now()
  let lastResult = null
  let lastError = null
  let lastFingerprint = ''
  let stableFetches = 0

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      if (Date.now() - lookupStarted > LOOKUP_BUDGET_MS) break
      if (stableFetches >= 2) break
      await wait(Math.min(1500, 250 + (attempt * 175)))
    }
    try {
      const result = await fetchMessages(userId, requestedChatId)
      lastResult = result
      const fingerprint = (result.messages || []).length + ':' + String(messageBits((result.messages || [])[(result.messages || []).length - 1] || {}).id || '')
      if (fingerprint === lastFingerprint && (result.messages || []).length) stableFetches++
      else stableFetches = 0
      lastFingerprint = fingerprint
      const messages = result.messages
      let target = null
      let targetIndex = -1

      if (requestedMessageId) {
        for (let i = 0; i < messages.length; i++) {
          const bits = messageBits(messages[i])
          if (String(bits.id) === requestedMessageId && bits.isAssistant && bits.contentKey && typeof bits.content === 'string') {
            target = bits
            targetIndex = i
            break
          }
        }
      }

      // Some frontend tag callbacks arrive before messageId is available. The
      // saved trigger is a safer candidate than blindly illustrating the prior
      // assistant message. GENERATION_ENDED normally supplies the exact ID.
      if (!target && !requestedMessageId) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const bits = messageBits(messages[i])
          if (!bits.isAssistant || !bits.contentKey || typeof bits.content !== 'string') continue
          if (hasParserTrigger(bits.content)) {
            target = bits
            targetIndex = i
            break
          }
        }
      }

      // Content matching is a final recovery path for host builds whose event
      // message ID is delayed or normalized differently from chat mutation.
      if (!target && expected) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const bits = messageBits(messages[i])
          if (!bits.isAssistant || !bits.contentKey || typeof bits.content !== 'string') continue
          const candidate = comparableMessageText(bits.content)
          if (!candidate) continue
          const sample = expected.slice(0, Math.min(220, expected.length))
          if ((sample && candidate.includes(sample)) || (candidate.length > 80 && expected.includes(candidate.slice(0, 180)))) {
            target = bits
            targetIndex = i
            break
          }
        }
      }

      if (!target && !isAuto && !requestedMessageId) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const bits = messageBits(messages[i])
          if (bits.isAssistant && bits.contentKey && typeof bits.content === 'string') {
            target = bits
            targetIndex = i
            break
          }
        }
      }

      if (target) return { ...result, target, targetIndex, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
    }
  }

  return {
    ...(lastResult || { messages: [], chatId: requestedChatId || null }),
    target: null,
    targetIndex: -1,
    attempts,
    error: lastError,
  }
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

// Swaps one image URL for another inside a markdown image, leaving the alt
// text and every other character of the message untouched.
// Markdown alt text must be a single line. Since 0.28.0 the compiled prompt
// begins with the caption and contains a paragraph break, so slicing the first
// 100 characters could land past that break and put a literal newline inside
// ![...], which never closes — the image silently fails to render and the
// prompt text shows in the story instead. Alt text is now always flattened.
function markdownAltText(value, maxChars = 100) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim()
}

function replaceImageUrlInContent(content, oldUrl, newUrl) {
  const text = String(content || '')
  if (!text || !oldUrl) return { content: text, replaced: false }
  const pattern = new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegExp(oldUrl)}(\\s*(?:"[^"]*")?\\))`, 'g')
  let replaced = false
  let next = text.replace(pattern, (_match, head, tail) => { replaced = true; return `${head}${newUrl}${tail}` })
  if (!replaced && text.includes(oldUrl)) {
    // Bare URL (html <img>, or a link the host rewrote) — still safe to swap.
    next = text.split(oldUrl).join(newUrl)
    replaced = true
  }
  return { content: next, replaced }
}

// Finds the message that currently displays a given image. The history entry's
// origin is a hint; a scan by URL is the ground truth and also covers images
// generated before origins were recorded, and pregenerated ones whose message
// did not exist yet at generation time.
// An image can be referenced in message text by more than its exact URL: the
// host may rewrite markdown, proxy the path, or strip a query string. Matching
// also on the upload id and the filename makes the lookup survive all three.
function imageMatchNeedles(imageUrl, imageId = '') {
  const needles = []
  const url = String(imageUrl || '').trim()
  if (url) {
    needles.push(url)
    const withoutQuery = url.split('?')[0]
    if (withoutQuery !== url) needles.push(withoutQuery)
    const filename = withoutQuery.split('/').filter(Boolean).pop() || ''
    if (filename.length >= 8) needles.push(filename)
  }
  const id = String(imageId || '').trim()
  if (id.length >= 6) needles.push(id)
  return uniqueStrings(needles)
}

async function listCandidateChatIds(userId, preferred = []) {
  const ids = []
  for (const value of preferred) {
    const id = String(value || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  const chatsApi = spindle.chats
  for (const fn of ['list', 'getAll', 'recent', 'all']) {
    if (!chatsApi || typeof chatsApi[fn] !== 'function') continue
    try {
      let result
      try { result = await withTimeout(chatsApi[fn](userId), 8000, 'chats.' + fn) }
      catch { result = await withTimeout(chatsApi[fn](), 8000, 'chats.' + fn) }
      const list = Array.isArray(result) ? result : (result && (result.chats || result.items)) || []
      for (const chat of list.slice(0, 25)) {
        const id = String((chat && (chat.id || chat.chatId)) || chat || '').trim()
        if (id && !ids.includes(id)) ids.push(id)
      }
      if (ids.length) break
    } catch { /* try the next documented/legacy shape */ }
  }
  return ids
}

// Message text may hold the URL in an encoded form: HTML entities from the
// host's renderer (&amp;), or markdown escapes (\_ \( \)). Matching runs
// against a normalized copy; includes() only needs truth, not positions.
function normalizeForImageMatch(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\\([_()[\]*~`-])/g, '$1')
}

// Forensics for the not-found case: which image references actually exist in
// the scanned messages? Logged next to the needles, "not found" becomes a
// diff instead of a mystery.
function collectImageReferences(messages, limit = 8) {
  const refs = []
  const push = (value) => {
    const ref = String(value || '').trim()
    if (ref && !refs.includes(ref)) refs.push(ref)
  }
  for (const message of messages) {
    const bits = messageBits(message)
    if (!bits.contentKey || typeof bits.content !== 'string') continue
    for (const match of bits.content.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) push(match[1])
    for (const match of bits.content.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) push(match[1])
    if (refs.length >= limit) break
  }
  return refs.slice(0, limit)
}

// Tier-2 lookup: match by ALT TEXT. The host's chat rebuild canonicalizes
// image URLs to /api/v1/images/<uuid> with freshly minted uuids, severing
// every identifier LumiDraw recorded. But the alt text — which LumiDraw wrote
// as the first 100 chars of the compiled prompt — survives the rebuild, and
// the full prompt is in History. An alt that appears verbatim inside the
// recorded prompt identifies the image regardless of what its URL became.
function findImageCandidatesByAlt(messages, promptText) {
  const prompt = normalizeIdentityText(promptText)
  if (!prompt || prompt.length < 30) return []
  const candidates = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const bits = messageBits(messages[i])
    if (!bits.contentKey || typeof bits.content !== 'string') continue
    for (const match of bits.content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
      const alt = normalizeIdentityText(match[1])
      if (alt.length < 20) continue
      if (prompt.includes(alt)) candidates.push({ bits, url: match[2], alt })
    }
  }
  return candidates
}

async function locateMessageByImageUrl(userId, imageUrl, hint = {}) {
  // The hinted chat first, then the active chat. '' means "let fetchMessages
  // resolve the active chat", and must survive here — uniqueStrings would drop
  // it, which previously made this return null whenever there was no hint.
  // A URL captured from the rendered chat image is authoritative: it is what
  // the message actually contains right now, so no inference is needed.
  const needles = uniqueStrings([
    ...(hint.chatImageUrl ? imageMatchNeedles(hint.chatImageUrl, '') : []),
    ...imageMatchNeedles(imageUrl, hint.imageId),
  ])
  if (!needles.length) return null
  let ambiguous = false
  const hintedChat = String(hint.chatId || '').trim()
  // Hinted chat, then the active chat, then any other chat the host will list.
  const searchOrder = hintedChat ? [hintedChat, ''] : ['']
  const extraChats = await listCandidateChatIds(userId, [])
  for (const id of extraChats) if (!searchOrder.includes(id)) searchOrder.push(id)

  const scanned = []
  for (const requestedChatId of searchOrder) {
    let messages = []
    let resolvedChatId = requestedChatId
    try {
      const result = await fetchMessages(userId, requestedChatId)
      messages = result.messages
      // fetchMessages resolves '' to the active chat and reports which one it
      // used. Discarding that returned an empty chatId to updateMessage, whose
      // chat-scoped call shapes were then skipped entirely — the host answered
      // "Chat not found" for every remaining shape.
      resolvedChatId = String(result.chatId || requestedChatId || '')
    } catch { continue }
    if (scanned.some((item) => item.chatId === resolvedChatId)) continue
    scanned.push({ chatId: resolvedChatId, messages: messages.length, sample: collectImageReferences(messages) })

    const matches = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const bits = messageBits(messages[i])
      if (!bits.contentKey || typeof bits.content !== 'string') continue
      const haystack = normalizeForImageMatch(bits.content)
      const matchedNeedle = needles.find((needle) => haystack.includes(needle))
      if (matchedNeedle) matches.push({ ...bits, matchedNeedle })
    }
    if (matches.length) {
      // Prefer the recorded message when the same image appears more than once.
      const preferred = hint.messageId
        ? matches.find((bits) => String(bits.id) === String(hint.messageId))
        : null
      const chosen = preferred || matches[0]
      if (chosen.matchedNeedle !== imageUrl) {
        spindle.log.info('[lumidraw] image located by "' + chosen.matchedNeedle + '" rather than its full URL')
      }
      return { ...chosen, chatId: resolvedChatId }
    }

    // Tier 2: the host rewrote the URL entirely — find the image by alt text.
    let altCandidates = findImageCandidatesByAlt(messages, hint.promptText)
    if (altCandidates.length) {
      // The exact alt recorded for THIS image beats any prefix overlap. Images
      // from one preset share their opening tags, so without this a message
      // holding several illustrations would match them all.
      const recordedAlt = normalizeIdentityText(hint.alt)
      if (recordedAlt) {
        const exact = altCandidates.filter((c) => c.alt === recordedAlt)
        if (exact.length) altCandidates = exact
      }
      let pool = altCandidates
      if (hint.messageId) {
        const hinted = altCandidates.filter((c) => String(c.bits.id) === String(hint.messageId))
        if (hinted.length) pool = hinted
      }
      const distinctUrls = new Set(pool.map((c) => c.url))
      // Never guess. Replacing the wrong image destroys a good one and, worse,
      // moves the illustration away from the story beat it was placed at.
      if (distinctUrls.size > 1) {
        spindle.log.warn('[lumidraw] alt-text match is ambiguous across ' + distinctUrls.size +
          ' images (' + [...distinctUrls].slice(0, 4).join(', ') + '); refusing to guess. Click the image in the chat instead — that identifies it exactly.')
        ambiguous = true
      } else {
        const chosen = pool[0]
        spindle.log.info('[lumidraw] image located by alt text; its stored URL is now "' + chosen.url + '"')
        return { ...chosen.bits, chatId: resolvedChatId, matchedNeedle: chosen.url, matchedBy: 'alt' }
      }
    }
  }
  const sampleRefs = uniqueStrings(scanned.flatMap((item) => item.sample || []))
  spindle.log.warn('[lumidraw] image not found in any message · needles=' + needles.join(' | ') +
    ' · scanned=' + (scanned.map((item) => `${item.chatId || '(active)'}:${item.messages}`).join(', ') || 'nothing') +
    ' · image refs actually present in those messages: ' + (sampleRefs.join(' | ') || 'none at all'))
  return { notFound: true, ambiguous, scanned, needles, sampleRefs }
}

// Encoded spellings a needle may wear inside stored message text. The host may
// apply entity encoding AND markdown escaping together, so the set is closed
// under both transforms rather than applying each in isolation.
function needleEncodings(needle) {
  const value = String(needle || '')
  const entity = (text) => text.replace(/&(?!amp;)/g, '&amp;')
  const escapeMd = (text) => text.replace(/(?<!\\)([_()])/g, '\\$1')
  return uniqueStrings([
    value,
    entity(value),
    escapeMd(value),
    entity(escapeMd(value)),
    escapeMd(entity(value)),
    value.replace(/_/g, '\\_'),
  ])
}

async function generateAndUpload({ prompt, negativePrompt, config, extra, dims, seed, origin }, userId, scan = null) {
  assertStoryScanActive(scan)
  const settings = await getSettings()
  const merged = dims ? { ...config, ...dims } : config
  const payloadOut = buildPayload({ prompt, negativePrompt, seed, config: merged, extra })
  // A blank model is deliberate, not an error: with no `model` key in the
  // request, Draw Things uses whatever is selected in its own UI. That is the
  // only configuration that can reach Cloud Compute, which refuses a model
  // named by local filename.
  if (!payloadOut.model) {
    spindle.log.info('[lumidraw] no model in the payload — Draw Things will use the model selected in its own UI')
  }
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
    // Everything needed to regenerate this image later and put the result back
    // where it came from: the owning message, and the exact recipe used.
    ...(origin && typeof origin === 'object' ? { origin } : {}),
    recipe: { config: merged || null, extra: extra || null },
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
// The firewall is only as wide as this pattern. Every synonym missing from it is
// a way for the parser to hand a subject anatomy that LumiDraw never granted —
// "erection" and "bulge" read as pose or clothing and used to sail through.
const EXPLICIT_ANATOMY_RE = /\b(?:penis|penises|cock|cocks|dick|dicks|phallus|phalluses|erection|erections|erect|member|manhood|shaft|girth|balls|vagina|vaginas|vulva|vulvas|pussy|pussies|clitoris|clit|labia|testicle|testicles|testes|scrotum|genital|genitals|genitalia|crotch|groin|bulge|futa|futanari|dickgirl|newhalf)\b/i
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

// --- partial features -------------------------------------------------------
//
// Appearance states are all-or-nothing: exactly one is active and it replaces
// or layers over the whole look. That leaves no way to say "only his eyes went
// wolf" — the parser is forced to choose between the fully human state and the
// full hybrid one, and picks the hybrid, transforming the entire character for
// a change to one feature.
//
// A partial feature is an atomic, named piece of a transformation that can be
// switched on WITHOUT changing state: "wolf eyes = yellow eyes, slit pupils".
// The parser may only select names the profile defines, so it can neither
// invent features nor smuggle in anatomy.
function normalizePartialFeatures(value, label = 'partial feature') {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\r\n;]+/).map((line) => line.trim()).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const entry of raw.slice(0, 16)) {
    let name = ''
    let tags = ''
    if (entry && typeof entry === 'object') {
      name = String(entry.name || entry.key || '').trim()
      tags = Array.isArray(entry.tags) ? entry.tags.join(', ') : String(entry.tags || entry.value || '').trim()
    } else {
      const match = String(entry || '').match(/^\s*([^=]{1,64}?)\s*=\s*(.{1,120})\s*$/)
      if (!match) continue
      name = match[1].trim()
      tags = match[2].trim()
    }
    name = shortPhrase(name, `${label} name`, 6, 64, true)
    const tagList = shortList(tags, `${label} tags`, { maxItems: 8, maxWords: 7, maxChars: 72 })
    if (!name || !tagList.length) continue
    const key = normalizeIdentityText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ name, tags: tagList })
    if (out.length >= 12) break
  }
  return out
}

// Resolves the names the parser selected against the profile's saved list.
// Unknown names are dropped: the profile is the only source of truth.
function resolvePartialFeatures(profile, requested) {
  const defined = (profile && profile.partialFeatures) || []
  if (!defined.length || !Array.isArray(requested) || !requested.length) return []
  const wanted = requested.map((name) => normalizeIdentityText(name)).filter(Boolean)
  const chosen = []
  for (const feature of defined) {
    if (wanted.includes(normalizeIdentityText(feature.name))) chosen.push(feature)
  }
  return chosen
}

function normalizeIdentityText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Nudity has to be stated by something in the scene — an empty outfit list is a
// parser omission as often as it is a naked character, and guessing wrong would put
// genitals in a clothed scene.
const NUDE_STATE_RE = /\b(?:nude|naked|completely nude|fully nude|unclothed|undressed|bottomless|nude in a bath|bathing)\b/i

function statesNude(outfit, appearance, subject) {
  const parts = [...(outfit || []), ...(appearance || []),
    ...((subject && subject.pose) || []), ...((subject && subject.action) || [])]
  return parts.some((tag) => NUDE_STATE_RE.test(String(tag || '')))
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

// Where a long value can honestly be cut down. Commas and subordinating
// conjunctions mark the end of a self-contained clause, so a prefix ending at
// one is still a whole statement rather than a severed fragment.
const CLAUSE_BREAK_RE = /,\s+|\s+(?:as|while|when|before|after|because|since|during|seeking|though|although|so|with|and)\s+/gi

// Counting to sixteen is not what a language model is for, and throwing away a
// correct scene because it produced nineteen words is the worst possible use of
// the tokens already spent. Repair in three escalating steps, each of which
// keeps more meaning than the next: cut at a clause boundary, drop articles,
// and only then truncate.
function trimToLimits(text, maxWords, maxChars) {
  const value = String(text || '').trim()
  const wordsIn = (s) => s.split(/\s+/).filter(Boolean)
  const fits = (s) => wordsIn(s).length <= maxWords && s.length <= maxChars
  if (fits(value)) return value

  // 1. Longest prefix ending on a clause boundary. Longest, not first — the
  //    first comma in "Rook, in partial wolf form, stands…" yields "Rook".
  const cuts = []
  let match
  CLAUSE_BREAK_RE.lastIndex = 0
  while ((match = CLAUSE_BREAK_RE.exec(value))) cuts.push(match.index)
  for (let i = cuts.length - 1; i >= 0; i--) {
    const candidate = value.slice(0, cuts[i]).replace(/[,;:]+$/, '').trim()
    // A four-word floor keeps a subject-and-verb; below that a truncation of
    // the original says more than a tidy fragment.
    if (wordsIn(candidate).length >= 4 && fits(candidate)) return candidate
  }

  // 2. Articles carry no visual information — "grips the fur at the small of
  //    the back of" loses one "the" and fits without losing a single concept.
  let stripped = value
  while (!fits(stripped) && /\b(?:the|a|an)\s+/i.test(stripped)) {
    stripped = stripped.replace(/\b(?:the|a|an)\s+/i, '')
  }
  if (fits(stripped)) return stripped

  // 3. Hard truncation, last resort.
  const words = wordsIn(stripped).slice(0, maxWords)
  let out = words.join(' ')
  while (out.length > maxChars && words.length > 1) { words.pop(); out = words.join(' ') }
  return out.replace(/[,;:]+$/, '').trim()
}

function shortPhrase(value, label, maxWords = 10, maxChars = 96, allowEmpty = true, repair = false) {
  let text = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim()
  // An optional field filled with filler is an empty field. Required fields
  // still reject it loudly rather than silently becoming blank.
  if (allowEmpty && isPlaceholderTag(text)) return ''
  if (!text && allowEmpty) return ''
  if (!text) throw new Error(`${label} is required.`)
  text = text.replace(/[.!?]+$/g, '').trim()

  if (repair) {
    // Shape problems are cleaned rather than fatal; only an empty result on a
    // required field still throws.
    text = text.replace(/[\r\n]+/g, ' ').replace(/[{}<>]/g, '').replace(/\s{2,}/g, ' ').trim()
    const repaired = trimToLimits(text, maxWords, maxChars)
    if (!repaired) {
      if (allowEmpty) return ''
      throw new Error(`${label} is required.`)
    }
    if (repaired !== text) {
      spindle.log.info(`[lumidraw] trimmed ${label} to fit (${text.split(/\s+/).filter(Boolean).length} words → ${repaired.split(/\s+/).filter(Boolean).length}): ${repaired}`)
    }
    return repaired
  }

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
    // One over-long entry used to throw and take the whole image with it. A
    // list is a bag of independent values: repair what can be repaired, skip
    // what cannot, and never let a single tag be fatal.
    let cleaned = ''
    try {
      cleaned = shortPhrase(item, label, maxWords, maxChars, true, true)
    } catch {
      continue
    }
    // Filler is dropped at the boundary so no downstream field has to know
    // about it — a placeholder is the absence of a value, not a value.
    if (cleaned && !isPlaceholderTag(cleaned)) out.push(cleaned)
  }
  return uniqueStrings(out)
}

function normalizeAnatomyMode(value) {
  const mode = String(value || 'relevant').toLowerCase()
  return ['always', 'relevant', 'manual'].includes(mode) ? mode : 'relevant'
}

function normalizeOutfitPolicy(value) {
  const policy = String(value || 'inherit').trim().toLowerCase()
  return ['inherit', 'omit'].includes(policy) ? policy : 'inherit'
}

// A state's appearance tags are added to the profile's permanent appearance by
// default, which is right for a costume change and wrong for a transformation:
// a fully shifted werewolf was still carrying "messy dark brown hair" and
// "amber eyes" alongside "dark brown fur" and "yellow eyes". "replace" lets a
// form stand on its own tags. Default stays "inherit" for existing presets.
function normalizeAppearancePolicy(value) {
  const policy = String(value || 'inherit').trim().toLowerCase()
  return ['inherit', 'replace'].includes(policy) ? policy : 'inherit'
}

function parseAppearanceStateLine(line, label) {
  const source = String(line || '').trim()
  if (!source || source.startsWith('#')) return null
  const arrow = source.indexOf('=>')
  if (arrow < 0) throw new Error(`${label} must use “=>” between the form header and appearance tags.`)
  let header = source.slice(0, arrow).trim()
  const appearanceText = source.slice(arrow + 2).trim()
  if (!header || !appearanceText) throw new Error(`${label} needs a form name and appearance tags.`)
  let directives = ''
  const directiveMatch = /\[([^\]]+)\]\s*$/.exec(header.split('|')[0] || '')
  if (directiveMatch) {
    directives = directiveMatch[1]
    header = header.replace(/\[([^\]]+)\]\s*/, '').trim()
  }
  const parts = header.split('|').map((part) => part.trim())
  const name = shortPhrase(parts[0] || '', `${label} name`, 6, 64, false)
  const recognition = shortList(parts.slice(1).join(', '), `${label} recognition`, { maxItems: 12, maxWords: 8, maxChars: 80 })
  let countTag = ''
  let outfitPolicy = 'inherit'
  let appearancePolicy = 'inherit'
  let subject = ''
  for (const directive of directives.split(';').map((value) => value.trim()).filter(Boolean)) {
    const idx = directive.indexOf('=')
    if (idx < 0) continue
    const key = directive.slice(0, idx).trim().toLowerCase()
    const value = directive.slice(idx + 1).trim()
    if (key === 'count') countTag = shortPhrase(value, `${label} count tag`, 3, 24, true)
    else if (key === 'outfit') outfitPolicy = normalizeOutfitPolicy(value)
    else if (key === 'appearance') appearancePolicy = normalizeAppearancePolicy(value)
    else if (key === 'subject') subject = shortPhrase(value, `${label} subject`, 8, 72, true)
  }
  return {
    name,
    recognition,
    appearance: shortList(appearanceText, `${label} appearance`, { maxItems: 32, maxWords: 8, maxChars: 80 }),
    countTag,
    subject,
    outfitPolicy,
    appearancePolicy,
  }
}

function normalizeAppearanceStates(value, label = 'appearance state') {
  const rawItems = Array.isArray(value) ? value : String(value || '').split(/\r?\n/)
  const out = []
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index]
    let state
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const name = shortPhrase(raw.name || '', `${label} ${index + 1} name`, 6, 64, false)
      state = {
        name,
        recognition: shortList(raw.recognition || raw.aliases || [], `${label} ${name} recognition`, { maxItems: 12, maxWords: 8, maxChars: 80 }),
        appearance: shortList(raw.appearance || raw.appearanceTags || [], `${label} ${name} appearance`, { maxItems: 32, maxWords: 8, maxChars: 80 }),
        countTag: shortPhrase(raw.countTag || raw.count_tag || '', `${label} ${name} count tag`, 3, 24, true),
        subject: shortPhrase(raw.subject || '', `${label} ${name} subject`, 8, 72, true),
        outfitPolicy: normalizeOutfitPolicy(raw.outfitPolicy || raw.outfit_policy),
        appearancePolicy: normalizeAppearancePolicy(raw.appearancePolicy || raw.appearance_policy),
      }
    } else {
      state = parseAppearanceStateLine(raw, `${label} ${index + 1}`)
    }
    if (!state) continue
    if (!state.appearance.length) throw new Error(`${label} “${state.name}” needs at least one appearance tag.`)
    const key = state.name.toLowerCase()
    const existing = out.findIndex((item) => item.name.toLowerCase() === key)
    if (existing >= 0) out[existing] = state
    else out.push(state)
  }
  return out.slice(0, 12)
}

function normalizeDefaultAppearanceState(value, states) {
  const requested = String(value || '').trim()
  if (!requested) return states.length ? states[0].name : ''
  const match = states.find((state) => state.name.toLowerCase() === requested.toLowerCase())
  return match ? match.name : (states.length ? states[0].name : '')
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
  const appearanceStates = normalizeAppearanceStates(source.appearanceStates || source.forms || '', `${fallbackRef} appearance state`)
  return {
    ref: fallbackRef,
    anchor: shortPhrase(source.anchor || '', `${fallbackRef} anchor`, 6, 64, true, true) || fallbackRef,
    // What the image prompt should call this character, when their name reads
    // as something else to a booru-trained model. Blank means use the anchor.
    promptName: shortPhrase(source.promptName || '', `${fallbackRef} prompt name`, 6, 64, true, true),
    countTag,
    subject: shortPhrase(source.subject || '', `${fallbackRef} subject phrase`, 8, 72, true),
    appearance: shortList(appearance, `${fallbackRef} appearance`, { maxItems: 32, maxWords: 7, maxChars: 72 }),
    defaultOutfit: shortList(source.defaultOutfitTags || '', `${fallbackRef} default outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    visualAliases: normalizeVisualAliases(source.visualAliases || source.namedVisualAliases || '', `${fallbackRef} visual alias`),
    partialFeatures: normalizePartialFeatures(source.partialFeatures || source.partialTraits || '', `${fallbackRef} partial feature`),
    anatomy: normalizeConditionalAnatomy(shortList(source.anatomyTags || '', `${fallbackRef} conditional anatomy`, { maxItems: 12, maxWords: 7, maxChars: 72 })),
    anatomyMode: normalizeAnatomyMode(source.anatomyMode),
    appearanceStates,
    defaultAppearanceState: normalizeDefaultAppearanceState(source.defaultAppearanceState || source.defaultForm || '', appearanceStates),
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
    partialFeatures: normalizePartialFeatures(await Promise.all((profile.partialFeatures || []).map(async (feature) => ({
      name: await resolveMacros(feature.name, userId, chatId),
      tags: await resolveMany(feature.tags, `${profile.ref} partial feature`),
    }))), `${profile.ref} partial feature`),
    appearanceStates: await Promise.all((profile.appearanceStates || []).map(async (state) => ({
      ...state,
      name: await resolveOne(state.name),
      recognition: await resolveMany(state.recognition, `${profile.ref} ${state.name} recognition`),
      appearance: await resolveMany(state.appearance, `${profile.ref} ${state.name} appearance`),
      countTag: await resolveOne(state.countTag),
      subject: await resolveOne(state.subject),
      outfitPolicy: normalizeOutfitPolicy(state.outfitPolicy),
      appearancePolicy: normalizeAppearancePolicy(state.appearancePolicy),
    }))),
  }
}

// Cast refs are derived from the character's name so the parser can use them
// naturally ("kira", "old_maren"), never colliding with the reserved refs.
function castRefFor(anchor, index, taken) {
  let ref = String(anchor || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  if (!ref || ref === 'character' || ref === 'persona' || /^other_\d+$/.test(ref)) ref = `cast_${index + 1}`
  let unique = ref
  let n = 2
  while (taken.has(unique)) unique = `${ref}_${n++}`
  taken.add(unique)
  return unique
}

async function getStoryProfiles(preset, settings, userId, chatId) {
  const needsLibrary = !!(preset.characterLibraryId || (Array.isArray(preset.castLibraryIds) && preset.castLibraryIds.length))
  const characterLibrary = needsLibrary ? await getCharacters() : []

  let characterSource = preset.characterProfile
  let characterFallbackTags = preset.characterTags ||
    (settings.autoCharTags !== false ? await getCharacterImageTags(userId, chatId) : '')
  if (preset.characterLibraryId) {
    const linked = characterLibrary.find((item) => item && item.id === preset.characterLibraryId)
    if (linked && linked.profile) {
      characterSource = linked.profile
      characterFallbackTags = linked.profile.appearanceTags || ''
    }
  }
  const character = normalizeProfile(characterSource, characterFallbackTags, 'character')

  let personaSource = preset.personaProfile
  let personaFallbackTags = preset.personaTags || ''
  if (preset.personaLibraryId) {
    const personas = await getPersonas()
    const linked = personas.find((item) => item && item.id === preset.personaLibraryId)
    if (linked && linked.profile) {
      personaSource = linked.profile
      personaFallbackTags = linked.profile.appearanceTags || ''
    }
  }
  const persona = normalizeProfile(personaSource, personaFallbackTags, 'persona')

  // Additional cast: library characters beyond the main character/persona
  // pair, each with its own named ref, locked profile, states, and anatomy
  // rules — first-class citizens of the same pipeline.
  const cast = []
  const takenRefs = new Set(['character', 'persona'])
  const castIds = Array.isArray(preset.castLibraryIds) ? preset.castLibraryIds.slice(0, 4) : []
  for (let index = 0; index < castIds.length; index++) {
    const linked = characterLibrary.find((item) => item && item.id === castIds[index])
    if (!linked || !linked.profile) continue
    if (linked.id === preset.characterLibraryId) continue // already the main character
    const ref = castRefFor(linked.profile.anchor || linked.name, index, takenRefs)
    const profile = normalizeProfile(linked.profile, linked.profile.appearanceTags || '', ref)
    cast.push(await resolveProfile(profile, userId, chatId))
  }

  return {
    character: await resolveProfile(character, userId, chatId),
    persona: await resolveProfile(persona, userId, chatId),
    cast,
  }
}

function allKnownProfiles(profiles) {
  return [profiles && profiles.character, profiles && profiles.persona, ...((profiles && profiles.cast) || [])].filter(Boolean)
}

function sanitizeJsonText(value) {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // A stray duplicate key silently destroys the real one: JSON.parse keeps
    // the LAST occurrence, so `"scene":{…full scene…},"scene":{}` collapses to
    // an empty scene and a perfectly good reply is thrown away. An empty
    // object carries no information in either position, so it is safe to drop
    // wherever it appears as a repeat.
    .replace(/,\s*"(scene|images)"\s*:\s*\{\s*\}/g, '')
    .replace(/,\s*"(scene|images)"\s*:\s*\[\s*\]/g, '')
    .replace(/,\s*([}\]])/g, '$1')
}

function extractCompleteObjectsFromArray(raw, key = 'images') {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`, 'i').exec(raw)
  if (!match) return []
  const start = match.index + match[0].length
  const objects = []
  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) objectStart = i
      depth++
      continue
    }
    if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && objectStart >= 0) {
        const candidate = sanitizeJsonText(raw.slice(objectStart, i + 1))
        try { objects.push(JSON.parse(candidate)) }
        catch { /* Ignore an invalid candidate and continue looking. */ }
        objectStart = -1
      }
    }
  }
  return objects
}

function tryCloseTruncatedJson(raw) {
  let candidate = String(raw || '').trim().replace(/,\s*$/, '')
  const stack = []
  let inString = false
  let escaped = false

  for (const ch of candidate) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (!stack.length || stack[stack.length - 1] !== ch) return null
      stack.pop()
    }
  }

  // A response cut off in the middle of a quoted value cannot be repaired
  // safely. A response that merely omitted closing brackets often can.
  if (inString || !stack.length) return null
  candidate += stack.reverse().join('')
  candidate = sanitizeJsonText(candidate)
  try { return JSON.parse(candidate) }
  catch { return null }
}

function tryRepairTruncatedJsonTail(raw) {
  let candidate = String(raw || '').trim().replace(/,\s*$/, '')
  if (!candidate) return null

  const stack = []
  const commas = []
  let inString = false
  let escaped = false
  let stringStart = -1

  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') { inString = false; stringStart = -1 }
      continue
    }
    if (ch === '"') { inString = true; stringStart = i; continue }
    if (ch === '{') stack.push({ type: 'object', open: i })
    else if (ch === '[') stack.push({ type: 'array', open: i })
    else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? 'object' : 'array'
      if (!stack.length || stack[stack.length - 1].type !== expected) return null
      stack.pop()
    } else if (ch === ',' && stack.length) {
      commas.push({ pos: i, depth: stack.length, type: stack[stack.length - 1].type })
    }
  }

  // If generation stopped inside the final key/value or array item, discard
  // only that unfinished fragment, then close the surrounding containers.
  if (inString && stack.length) {
    const top = stack[stack.length - 1]
    const sameContainerComma = [...commas].reverse().find((item) =>
      item.depth === stack.length && item.type === top.type && item.pos < stringStart)
    const cut = sameContainerComma ? sameContainerComma.pos : top.open + 1
    candidate = candidate.slice(0, cut).replace(/[,:\s]+$/, '')
  }

  // Remove a dangling property separator or unfinished bare token.
  candidate = candidate.replace(/[,\s]+$/, '')
  if (/[:]\s*$/.test(candidate)) {
    const lastComma = candidate.lastIndexOf(',')
    const lastOpen = Math.max(candidate.lastIndexOf('{'), candidate.lastIndexOf('['))
    candidate = candidate.slice(0, Math.max(lastComma, lastOpen + 1)).replace(/[,\s]+$/, '')
  }

  return tryCloseTruncatedJson(candidate)
}

function parseJsonObject(text, label = 'structured scene') {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text
  let raw = String(text || '').trim()
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  // Some providers return the JSON as a JSON-encoded string. Unwrap it once
  // before looking for the actual object.
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const decoded = JSON.parse(raw)
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) return decoded
      if (typeof decoded === 'string') raw = decoded.trim()
    } catch { /* Continue with the original text. */ }
  }

  const first = raw.indexOf('{')
  if (first < 0) throw new Error(`${label} did not contain a JSON object.`)
  const candidateSource = sanitizeJsonText(raw.slice(first))
  const last = candidateSource.lastIndexOf('}')
  if (last > 0) {
    const candidate = candidateSource.slice(0, last + 1)
    try { return JSON.parse(candidate) }
    catch { /* Try truncated-response recovery below. */ }
  }

  // Sonnet occasionally reaches its completion limit after finishing one
  // image object but before closing the images array/root object. Preserve the
  // complete image(s) rather than discarding the whole generation.
  const recoveredImages = extractCompleteObjectsFromArray(candidateSource, 'images')
  if (recoveredImages.length) {
    return { images: recoveredImages, _lumidrawRecovered: 'complete_images_from_truncated_reply' }
  }

  const tailRepaired = tryRepairTruncatedJsonTail(candidateSource)
  if (tailRepaired && typeof tailRepaired === 'object' && !Array.isArray(tailRepaired)) {
    tailRepaired._lumidrawRecovered = 'trimmed_incomplete_tail_and_closed_json'
    return tailRepaired
  }

  const repaired = tryCloseTruncatedJson(candidateSource)
  if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
    repaired._lumidrawRecovered = 'appended_missing_closers'
    return repaired
  }

  throw new Error(`${label} began as JSON but was cut off before a complete object was returned.`)
}

function normalizeSceneSubject(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fallbackRef = `other_${index + 1}`
  let ref = shortPhrase(source.ref || fallbackRef, `subject ${index + 1} ref`, 3, 32, false).toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!ref) ref = fallbackRef
  // A label is mandatory only for anonymous other_N refs. Named refs —
  // character, persona, and cast refs such as "maren" — carry their identity
  // in the ref itself; when no profile binds, the ref doubles as the label.
  const needsLabel = /^other_\d+$/.test(ref)
  return {
    ref,
    label: shortPhrase(source.label || '', `subject ${index + 1} label`, 7, 72, !needsLabel),
    countTag: shortPhrase(source.count_tag || source.countTag || '', `subject ${index + 1} count tag`, 3, 24, true),
    booruCharacter: shortPhrase(source.booru_character || source.booruCharacter || '', `subject ${index + 1} character tag`, 6, 64, true),
    booruSeries: shortPhrase(source.booru_series || source.booruSeries || '', `subject ${index + 1} series tag`, 8, 72, true),
    position: shortPhrase(source.position || '', `subject ${index + 1} position`, 4, 40, true),
    appearance: shortList(source.appearance || [], `subject ${index + 1} appearance`, { maxItems: 24, maxWords: 7, maxChars: 72 }),
    outfit: shortList(source.outfit || [], `subject ${index + 1} outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    pose: shortList(source.pose || [], `subject ${index + 1} pose`, { maxItems: 10, maxWords: 7, maxChars: 72 }),
    expression: shortList(source.expression || [], `subject ${index + 1} expression`, { maxItems: 8, maxWords: 7, maxChars: 72 }),
    action: shortList(source.action || [], `subject ${index + 1} action`, { maxItems: 10, maxWords: 8, maxChars: 80 }),
    support: shortPhrase(source.support || source.support_surface || source.supportSurface || '', `subject ${index + 1} support surface`, 7, 72, true),
    appearanceState: shortPhrase(source.appearance_state || source.appearanceState || source.form || '', `subject ${index + 1} appearance state`, 6, 64, true),
    partialFeatures: shortList(source.partial_features || source.partialFeatures || [], `subject ${index + 1} partial features`, { maxItems: 6, maxWords: 6, maxChars: 64 }),
    anatomyVisible: source.anatomy_visible === true || source.anatomyVisible === true,
  }
}

function normalizeScene(raw, profiles = null) {
  const source = raw && raw.scene && typeof raw.scene === 'object' ? raw.scene : raw
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Scene must be a JSON object.')
  const subjectsRaw = Array.isArray(source.subjects) ? source.subjects : []
  if (!subjectsRaw.length) throw new Error('Structured scene needs at least one subject.')
  if (subjectsRaw.length > 6) throw new Error('Structured scene supports at most six subjects.')
  const subjects = subjectsRaw.map(normalizeSceneSubject)
  const refs = new Set(subjects.map((subject) => subject.ref))
  if (refs.size !== subjects.length) throw new Error('Each structured subject needs a unique ref.')
  const relationsRaw = Array.isArray(source.relations) ? source.relations : []
  // A malformed or half-written relation (typically the tail of a truncated
  // reply) is dropped rather than discarding the whole scene — the subjects
  // and setting above it are intact and worth keeping.
  const relations = relationsRaw.slice(0, 8).flatMap((relation, index) => {
    const item = relation && typeof relation === 'object' ? relation : {}
    let actor = ''
    let action = ''
    let target = ''
    let details = []
    try {
      actor = shortPhrase(item.actor || '', `relation ${index + 1} actor`, 3, 32, false).toLowerCase().replace(/[^a-z0-9_]/g, '_')
      // A well-formed relation reads as a clause — "grips the fur at the small
      // of the back of" is ten words and entirely visual. Trim it rather than
      // lose the only relation the image has.
      action = shortPhrase(item.action || item.verb || '', `relation ${index + 1} action`, 9, 84, false, true)
      target = shortPhrase(item.target || '', `relation ${index + 1} target`, 3, 32, true).toLowerCase().replace(/[^a-z0-9_]/g, '_')
      details = shortList(item.details || [], `relation ${index + 1} details`, { maxItems: 6, maxWords: 7, maxChars: 72 })
    } catch (error) {
      spindle.log.warn(`[lumidraw] dropping incomplete relation ${index + 1}: ${error.message}`)
      return []
    }
    // The parser is asked for refs and sometimes writes labels — "the alpha"
    // rather than "other_1". Dropping those cost the scene its only real
    // relation, which synthesizeRelation then replaced with "stands with".
    const resolveRef = (value) => {
      if (!value) return ''
      if (refs.has(value)) return value
      const needle = normalizeIdentityText(String(value).replace(/_/g, ' '))
      if (!needle) return ''
      const hit = subjects.find((subject) => {
        const label = normalizeIdentityText(subject.label || '')
        const refWords = normalizeIdentityText(String(subject.ref || '').replace(/_/g, ' '))
        if (label && (label.includes(needle) || needle.includes(label))) return true
        return !!refWords && refWords === needle
      })
      if (hit) return hit.ref
      // "Rook" rather than "persona" — the parser reaches for the name it has
      // been using all along. Only the profiles know that mapping.
      const named = allKnownProfiles(profiles).find((profile) => {
        const anchor = normalizeIdentityText(profile && profile.anchor)
        return anchor && (anchor === needle || anchor.split(/\s+/).includes(needle))
      })
      if (named && refs.has(named.ref)) return named.ref
      return ''
    }
    const actorRef = resolveRef(actor)
    if (!actorRef) {
      spindle.log.warn(`[lumidraw] dropping relation ${index + 1}: actor “${actor}” is not one of the scene subjects.`)
      return []
    }
    if (actorRef !== actor) spindle.log.info(`[lumidraw] relation ${index + 1} actor “${actor}” matched subject ref “${actorRef}”`)
    actor = actorRef
    if (target) {
      const targetRef = resolveRef(target)
      if (!targetRef) {
        spindle.log.warn(`[lumidraw] dropping relation ${index + 1}: target “${target}” is not one of the scene subjects.`)
        return []
      }
      if (targetRef !== target) spindle.log.info(`[lumidraw] relation ${index + 1} target “${target}” matched subject ref “${targetRef}”`)
      target = targetRef
    }
    return [{ actor, target, action, details }]
  })
  const aspectRaw = String(source.aspect || '').trim()
  const sceneStatement = shortPhrase(source.scene_statement || source.sceneStatement || '', 'scene statement', 16, 150, true, true)
  const coreAction = shortPhrase(source.core_action || source.coreAction || '', 'core action', 10, 96, true, true)
  // Dropping a relation must never cascade into dropping the image. A
  // multi-subject scene with no surviving relation gets one rebuilt from the
  // positions the parser already gave us — an arrangement derived from its own
  // data, not invented — so the scene stays renderable.
  if (subjects.length > 1 && !relations.length) {
    const rebuilt = synthesizeRelation(subjects)
    if (rebuilt) {
      relations.push(rebuilt)
      spindle.log.warn('[lumidraw] no relation survived validation; rebuilt one from subject positions: ' +
        `${rebuilt.actor} ${rebuilt.action} ${rebuilt.target}`)
    }
  }
  return {
    subjects,
    relations,
    sceneStatement,
    coreAction,
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

// Depth order, nearest first. Used only to decide who is arranged against whom
// when every stated relation has been lost.
const POSITION_DEPTH = { foreground: 0, center: 1, left: 2, right: 2, background: 3 }

function synthesizeRelation(subjects) {
  if (!Array.isArray(subjects) || subjects.length < 2) return null
  const depth = (subject) => {
    const value = POSITION_DEPTH[String(subject && subject.position || '').toLowerCase()]
    return Number.isFinite(value) ? value : 2
  }
  const ordered = subjects
    .map((subject, index) => ({ subject, index }))
    .sort((a, b) => depth(a.subject) - depth(b.subject) || a.index - b.index)
  const actor = ordered[0].subject
  const target = ordered[1].subject
  if (!actor || !target || !actor.ref || !target.ref || actor.ref === target.ref) return null
  const actorPos = String(actor.position || '').toLowerCase()
  const targetPos = String(target.position || '').toLowerCase()
  let action = 'stands with'
  if (targetPos === 'background' && (actorPos === 'foreground' || actorPos === 'center')) action = 'stands in front of'
  else if ((actorPos === 'left' && targetPos === 'right') || (actorPos === 'right' && targetPos === 'left')) action = 'faces'
  else if (actorPos === 'foreground' && targetPos === 'center') action = 'stands in front of'
  return { actor: actor.ref, target: target.ref, action, details: [], synthesized: true }
}

function assessStructuredScene(scene) {
  const source = scene && typeof scene === 'object' ? scene : {}
  const subjects = Array.isArray(source.subjects) ? source.subjects : []
  const relations = Array.isArray(source.relations) ? source.relations : []
  const setting = Array.isArray(source.setting) ? source.setting : []
  const camera = Array.isArray(source.camera) ? source.camera : []
  const lighting = Array.isArray(source.lighting) ? source.lighting : []
  const style = Array.isArray(source.style) ? source.style : []
  const coreAction = String(source.coreAction || source.core_action || '').trim()
  const hasSubjectAction = subjects.some((subject) =>
    (Array.isArray(subject.pose) && subject.pose.length) ||
    (Array.isArray(subject.action) && subject.action.length)
  )
  const hasRelation = relations.some((relation) => String(relation && relation.action || '').trim())
  const missing = []
  const warnings = []

  if (!setting.length) missing.push('setting/context')
  if (subjects.length > 1) {
    if (!hasRelation) missing.push('cross-subject relation/action')
  } else if (!coreAction && !hasSubjectAction) {
    missing.push('visible pose/action')
  }
  if (!camera.length) warnings.push('camera/framing')
  if (!lighting.length && !style.length) warnings.push('lighting/style')

  return {
    valid: missing.length === 0,
    missing,
    warnings,
    summary: missing.length ? `missing ${missing.join(', ')}` : (warnings.length ? `usable; weak ${warnings.join(', ')}` : 'complete'),
  }
}

function parseInlineScene(body) {
  return normalizeScene(parseJsonObject(body, 'inline scene'))
}

function parseParserScenes(text, maxImages, profiles = null) {
  const root = parseJsonObject(text, 'parser reply')
  if (root && root._lumidrawRecovered) {
    spindle.log.warn('[lumidraw] recovered structured parser data from a truncated reply · mode=' + root._lumidrawRecovered + ' · complete_images=' + (Array.isArray(root.images) ? root.images.length : 0))
  }
  if (/^\s*NONE\s*$/i.test(String(root && root.result || ''))) return []
  const items = Array.isArray(root.images) ? root.images : (root.scene ? [root] : [])
  if (!items.length) throw new Error('Parser JSON must contain an images array.')

  // Images are independent. One that fails validation is skipped rather than
  // discarding the whole reply — losing three good illustrations because a
  // fourth had a stray key is the worst possible trade.
  const scenes = []
  const failures = []
  for (const [index, item] of items.slice(0, maxImages).entries()) {
    try {
      scenes.push({
        anchor: shortPhrase(item.anchor || '', `image ${index + 1} anchor`, 14, 120, false, true),
        scene: normalizeScene(item.scene || item, profiles),
      })
    } catch (error) {
      failures.push(`image ${index + 1}: ${error.message}`)
    }
  }
  if (failures.length) {
    spindle.log.warn('[lumidraw] skipped ' + failures.length + ' unusable image object(s) · ' + failures.join(' · '))
  }
  if (!scenes.length) {
    throw new Error(failures.length ? failures[0] : 'Parser JSON contained no usable image.')
  }
  return scenes
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
    coreAction: applyBannedToList([scene.coreAction], bannedCsv)[0] || '',
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
  const known = allKnownProfiles(profiles)
  const knownRefs = new Set(known.map((profile) => profile.ref))
  const remap = new Map()
  const claimed = new Set(scene.subjects
    .filter((subject) => knownRefs.has(subject.ref))
    .map((subject) => subject.ref))
  for (const subject of scene.subjects) {
    if (knownRefs.has(subject.ref)) continue
    const matches = []
    for (const profile of known) {
      if (profileMatchesSubject(profile, subject)) matches.push(profile.ref)
    }
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

function applyAnatomyFirewall(scene, profiles = null) {
  const knownRefs = profiles
    ? new Set(allKnownProfiles(profiles).map((profile) => profile.ref))
    : new Set(['character', 'persona'])
  return {
    ...scene,
    // Unprofiled subjects used to skip the firewall entirely: the ternary scrubbed
    // known refs and returned an `other_1` untouched, so a walk-on could be handed
    // anatomy in her pose or outfit and nothing stopped it. Only the appearance
    // wipe is profile-only — an unprofiled subject has no saved appearance to fall
    // back on, so hers is all there is.
    subjects: scene.subjects.map((subject) => ({
      ...subject,
      appearance: knownRefs.has(subject.ref) ? [] : removeInventedAnatomy(subject.appearance),
      outfit: removeInventedAnatomy(subject.outfit),
      pose: removeInventedAnatomy(subject.pose),
      expression: removeInventedAnatomy(subject.expression),
      action: removeInventedAnatomy(subject.action),
    })),
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
  return ((profiles && profiles.cast) || []).find((profile) => profile.ref === subject.ref) || null
}

function selectAppearanceState(profile, subject, sourcePassage = '', report = null) {
  const note = (state, reason) => {
    if (report) { report.state = state ? state.name : ''; report.reason = reason }
    return state
  }
  const states = profile && Array.isArray(profile.appearanceStates) ? profile.appearanceStates : []
  if (!states.length) return note(null, 'no states defined')
  const requested = String(subject && subject.appearanceState || '').trim().toLowerCase()
  if (requested) {
    const direct = states.find((state) => state.name.toLowerCase() === requested || (state.recognition || []).some((value) => value.toLowerCase() === requested))
    if (direct) return note(direct, `parser asked for "${requested}"`)
    if (report) report.unmatchedRequest = requested
  }
  const passage = String(sourcePassage || '').toLowerCase()
  const candidates = []
  for (const state of states) {
    for (const phrase of [state.name, ...(state.recognition || [])]) {
      const value = String(phrase || '').trim().toLowerCase()
      if (value.length < 3) continue
      // Whole-word matching only. Substring matching flipped a werewolf into
      // full wolf form whenever the prose merely said "werewolf" or "wolfish",
      // because the state named "Wolf" matched inside those words.
      if (!new RegExp(`\\b${escapeRegExp(value)}\\b`).test(passage)) continue
      candidates.push({ state, cue: value, length: value.length, words: value.split(/\s+/).length })
    }
  }
  // A multi-word cue ("wolf form", "fully shifted") is far stronger evidence
  // than a bare one-word state name, so it wins regardless of length.
  candidates.sort((a, b) => (b.words - a.words) || (b.length - a.length))
  if (candidates.length) return note(candidates[0].state, `passage says "${candidates[0].cue}"`)
  const defaultName = String(profile.defaultAppearanceState || '').toLowerCase()
  const fallback = defaultName ? states.find((state) => state.name.toLowerCase() === defaultName) : null
  if (fallback) return note(fallback, `no cue in the passage; using the declared default "${fallback.name}"`)
  // NEVER states[0]. An appearance state is a departure from the character's
  // base form, so "no cue and no declared default" means the base form — not
  // whichever state happens to sit first in the list. Falling through to
  // states[0] put a human character in a transformed state in every passage
  // that failed to mention shifting, and no amount of re-parsing could fix it
  // because the choice was made after the parser had already finished.
  if (defaultName) {
    spindle.log.warn(`[lumidraw] ${profile.anchor || 'a profile'} declares default appearance state "${profile.defaultAppearanceState}" but no state by that name exists; using the base form.`)
  }
  return note(null, 'no cue in the passage and no declared default — base form')
}

// --- form firewall ----------------------------------------------------------
//
// A shapeshifter in human form must not carry a single word from its other
// forms. Two failures made this urgent: a werewolf whose *inactive* wolf
// vocabulary reached the prompt, and the fact that once "wolf ears" or "tail"
// exists anywhere in a multi-character prompt, Anima is free to hang it on the
// wrong character — which is how an elf became a wolf boy. So the vocabulary
// of every inactive form is banned from the ENTIRE scene, not just its owner.

const FORM_WORD_STOPLIST = new Set([
  'form', 'forms', 'state', 'mode', 'shape', 'normal', 'default', 'base', 'true',
  'full', 'fully', 'half', 'partial', 'partially', 'shifted', 'unshifted', 'turned',
  'transformed', 'untransformed', 'adult', 'human', 'humanoid', 'massive', 'large',
  'small', 'with', 'and', 'the', 'his', 'her', 'their', 'four', 'both', 'more',
])

function formWords(phrase) {
  const text = normalizeIdentityText(phrase)
  if (!text) return []
  const words = text.split(/\s+/).filter((word) => word.length >= 4 && !FORM_WORD_STOPLIST.has(word))
  // Two-word phrases ("wolf ears", "dark fur") are banned as phrases too, so a
  // benign single word is not scrubbed out of an unrelated tag.
  const phrases = []
  const parts = text.split(/\s+/)
  for (let i = 0; i < parts.length - 1; i++) {
    const pair = `${parts[i]} ${parts[i + 1]}`
    if (parts[i].length >= 3 && parts[i + 1].length >= 3) phrases.push(pair)
  }
  return uniqueStrings([...words, ...phrases])
}

function inactiveFormTerms(descriptors) {
  const banned = new Set()
  const allowed = new Set()
  // Everything legitimately visible in this scene, across every subject.
  for (const item of descriptors) {
    for (const value of [item.noun, ...(item.appearance || []), ...(item.outfit || [])]) {
      for (const word of formWords(value)) allowed.add(word)
    }
  }
  for (const item of descriptors) {
    const profile = item.profile
    const states = profile && Array.isArray(profile.appearanceStates) ? profile.appearanceStates : []
    if (states.length < 2) continue
    const activeName = item.appearanceState ? normalizeIdentityText(item.appearanceState.name) : ''
    for (const state of states) {
      if (activeName && normalizeIdentityText(state.name) === activeName) continue
      const sources = [state.name, state.subject, ...(state.recognition || []), ...(state.appearance || [])]
      for (const value of sources) {
        for (const word of formWords(value)) banned.add(word)
      }
    }
  }
  for (const word of allowed) banned.delete(word)
  // Longest first so "wolf ears" is removed before the bare word "wolf".
  return [...banned].sort((a, b) => b.length - a.length)
}

function scrubFormTermsFromText(value, terms) {
  let text = String(value || '')
  if (!text || !terms.length) return text
  for (const term of terms) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), ' ')
  }
  return text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*(?=[,.])/g, '')
    .replace(/\b(?:a|an|the)\s+(?=[,.]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim()
}

// Tags are dropped wholesale rather than mangled — a tag missing its head noun
// is worse than no tag.
function scrubFormTermsFromTags(list, terms) {
  if (!terms.length) return list || []
  return (list || []).filter((tag) => {
    const text = normalizeIdentityText(tag)
    return !terms.some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`).test(text))
  })
}


// --- names that read as something else ---------------------------------------
// Anima is trained on booru tags, so a character name that happens to BE a tag
// is read as that tag. "Fanny" is booru-adjacent slang for a body part, and the
// model draws the body part. The same trap waits for Rose, Lily, Amber, Jade,
// Ruby, Iris, Violet, Holly, Ivy, Crystal, Robin, Hunter and plenty more —
// most of which are already in our vocabulary, so the vocabulary can detect it.
const NAME_SLANG_RE = /^(?:fanny|minge|muff|bush|cherry|dick|willy|johnson|todger|knob|beaver|clunge|growler|tush|keister|booty|melons|jugs|rack)$/i

// Given names that are also strong VISUAL nouns. The model does not know these
// are names; it draws the thing. A character called Rose gets roses, Ivy gets
// ivy, Raven gets a bird. Only names that would visibly change the picture are
// listed — a name that merely happens to be a word is harmless.
const NAME_NOUN_RE = /^(?:rose|lily|iris|violet|jade|ruby|pearl|amber|holly|ivy|daisy|poppy|heather|olive|jasmine|crystal|opal|coral|hazel|willow|fern|sage|clover|dahlia|magnolia|robin|wren|jay|raven|dove|hawk|falcon|fox|wolf|bear|kitty|bunny|star|sky|river|brook|rain|storm|summer|autumn|winter|dawn|aurora|ginger|honey|candy|angel|blade|bell|arrow|hunter|archer|forest|meadow|ash|briar|thorn|rowan|linden|juniper|marigold)$/i

// A text encoder matches TOKENS, not words. "Fanny Price" still contains the
// token that caused the problem, and it contributes just as much as it did
// alone — adding a surname does not neutralise it. Every word is checked, not
// just the whole string.
function nameReadsAsTag(name) {
  const text = normalizeIdentityText(name)
  if (!text) return ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length < 3) continue
    if (NAME_SLANG_RE.test(word)) return `"${word}" is booru slang for a body part`
    if (NAME_NOUN_RE.test(word)) return `"${word}" is also an object the model will draw`
    const resolved = resolveBooruTag(word)
    if (resolved.tag) return `"${word}" is also the booru tag "${resolved.tag}"`
  }
  return ''
}

function subjectDescriptor(subject, profiles, sourcePassage = '', requireAnatomyOwner = false) {
  const profile = profileForSubject(subject, profiles)
  if (profile) {
    if (profile.promptName) {
      const stillClashes = nameReadsAsTag(profile.promptName)
      if (stillClashes) {
        trace(`prompt name · ${profile.anchor}`, 'warn',
          `"${profile.promptName}" does not fix it — ${stillClashes}. A text encoder reads tokens, not words, so adding a surname leaves the problem word contributing exactly as before. Use a name that does not contain it at all.`)
        spindle.log.warn(`[lumidraw] prompt name "${profile.promptName}" still contains the problem: ${stillClashes}. Adding words around it does not help; pick a name without it.`)
      } else {
        trace(`prompt name · ${profile.anchor}`, 'applied', `written as "${profile.promptName}" in the image prompt`)
      }
    } else {
      const clash = nameReadsAsTag(profile.anchor)
      if (clash) {
        trace(`prompt name · ${profile.anchor}`, 'warn',
          `${clash}, so the model may draw that instead of the character. Set \"Name in prompts\" on this character to something that does not contain the word at all — adding a surname will not help.`)
        spindle.log.warn(`[lumidraw] ${profile.anchor}: ${clash}. Set "Name in prompts" on the character to something unambiguous.`)
      }
    }
  }
  const stateReport = {}
  const state = profile ? selectAppearanceState(profile, subject, sourcePassage, stateReport) : null
  if (profile && Array.isArray(profile.appearanceStates) && profile.appearanceStates.length) {
    trace(`appearance state · ${profile.anchor || subject.ref}`,
      state ? 'applied' : 'clean',
      `${state ? state.name : 'base form'} — ${stateReport.reason || 'no reason recorded'}` +
      (stateReport.unmatchedRequest ? ` (parser asked for "${stateReport.unmatchedRequest}", which is not a saved state)` : ''))
  }
  const anchor = profile ? (profile.promptName || profile.anchor) : (subject.label || subject.ref.replace(/_/g, ' '))
  // The name the story uses, which is what the parser will have written into
  // pose and action text. Rendering uses `anchor`; recognising parser prose has
  // to use both, or a prompt name quietly defeats every cross-subject check.
  const sourceAnchor = profile ? profile.anchor : anchor
  const noun = state && state.subject ? state.subject : (profile ? profile.subject : subject.label)
  // A transformation state marked appearance=replace stands on its own tags;
  // otherwise the form's tags are layered over the profile's permanent ones.
  const appearance = profile
    ? (state && state.appearancePolicy === 'replace' && (state.appearance || []).length
      ? uniqueStrings(state.appearance)
      : uniqueStrings([...(profile.appearance || []), ...((state && state.appearance) || [])]))
    : subject.appearance
  // Partial features layer on top of whichever state is active, so a character
  // can show wolf eyes while remaining, in every other respect, a human man.
  const activeFeatures = resolvePartialFeatures(profile, subject.partialFeatures)
  const featureTags = activeFeatures.flatMap((feature) => feature.tags || [])
  const inheritedOutfit = profile && (!state || state.outfitPolicy !== 'omit') ? profile.defaultOutfit : []
  const outfit = subject.outfit.length ? subject.outfit : inheritedOutfit
  // A nude body in an nsfw scene shows its anatomy — that is what nude means. The
  // passage does not have to name it, and prose about a shower rarely does. Left
  // unnamed, the model has a nude figure with nothing anchoring the genitals, and
  // Anima fills that gap from the censored end of its training rather than leaving
  // it blank. This is not the parser inventing anatomy: LumiDraw still supplies
  // only what the profile saved, and only when something in the scene said "nude".
  const nudeNow = statesNude(outfit, appearance, subject)
  const anatomyAllowed = profile && (
    profile.anatomyMode === 'always' ||
    (profile.anatomyMode === 'relevant' && subject.anatomyVisible &&
      (anatomyExplicitlyMentioned(profile.anatomy, sourcePassage, profile.anchor, requireAnatomyOwner) || nudeNow))
  )
  if (profile && profile.anatomyMode === 'relevant' && subject.anatomyVisible && nudeNow &&
      !anatomyExplicitlyMentioned(profile.anatomy, sourcePassage, profile.anchor, requireAnatomyOwner)) {
    trace(`anatomy gate · ${profile.anchor || subject.ref}`, 'applied',
      'the passage never names the anatomy, but the subject is nude in an nsfw scene, so it is visible')
  }
  const anatomy = anatomyAllowed ? profile.anatomy : []
  // A profile's count tag is locked identity and outranks whatever the parser
  // guessed — this is what stops a femboy being rendered as 1girl because the
  // prose read feminine. But an EMPTY profile field is no opinion, not a veto:
  // returning '' there silently dropped the subject's count tag altogether, so
  // a two-person scene could compile as "1boy" with the second person having no
  // count at all.
  const countTag = (state && state.countTag) || (profile && profile.countTag) || subject.countTag || ''
  if (profile && profile.countTag && subject.countTag &&
      animaTag(profile.countTag) !== animaTag(subject.countTag)) {
    trace(`count tag · ${profile.anchor || subject.ref}`, 'applied',
      `parser said "${subject.countTag}", profile says "${profile.countTag}" — the profile wins`)
  } else if (profile && !profile.countTag && subject.countTag) {
    trace(`count tag · ${profile.anchor || subject.ref}`, 'warn',
      `no count tag saved on the profile, so the parser's "${subject.countTag}" is being used. Set one on the character to lock it.`)
  }
  // `named` distinguishes "Ilsa" (a proper name that can head a sentence) from
  // "cloaked stranger" (a label that needs an article: "the cloaked stranger").
  return {
    subject, profile, appearanceState: state, anchor, sourceAnchor, noun,
    appearance: featureTags.length ? uniqueStrings([...appearance, ...featureTags]) : appearance,
    outfit, anatomy, countTag, named: !!profile,
    partialFeatures: activeFeatures,
  }
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
    // Anima is a booru-tag model: hedge phrasing such as "the clearly visible X"
    // has no counterpart in its training captions and only dilutes the tag.
    // Support surfaces are emitted as their own tags instead (see supportTags).
    .replace(/\bthe clearly visible\b/gi, 'the')
    .replace(/\bon (cheek|face|forehead|arm|shoulder|back|chest|neck|hand|thigh|hip)\b/gi, 'on the $1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function normalizeVisualList(list) {
  return uniqueStrings((Array.isArray(list) ? list : []).map(normalizeVisualPhrase).filter(Boolean))
}

// Parsers fill gaps with filler rather than omitting a field: "unknown",
// "not specified", "n/a", "default clothing". Every one that reaches Anima is
// a token spent telling the model nothing, and some of them ("unknown") are
// real words it will try to draw.
const PLACEHOLDER_TERM_RE = /^(?:unknown|unspecified|unclear|unstated|not specified|not stated|not mentioned|unmentioned|undetermined|undefined|none|n\/?a|null|nil|tbd|default|default outfit|default clothing|default attire|no change|unchanged|same as before|as before|as described|standard|generic)$/i

function isPlaceholderTag(value) {
  return PLACEHOLDER_TERM_RE.test(String(value || '').trim())
}

function animaTag(value) {
  let tag = normalizeVisualPhrase(value).trim()
  if (!tag) return ''
  if (isPlaceholderTag(tag)) return ''
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


// ---------------------------------------------------------------------------
// Danbooru vocabulary
//
// Anima is trained on Danbooru tags. A language model asked for tags returns
// plausible English instead, because it has never been trained on which strings
// are real tags — "backlit spores" and "pink grove glow" read like tags and are
// not tags. Emitting them buys nothing: the model has no embedding for them, so
// they act as loose text while occupying the slot reserved for booru control.
//
// This is a vocabulary check, not a filter. Anything unrecognised is demoted
// into the caption, where prose belongs and is understood, rather than dropped.
// Membership is drawn from Danbooru's own tag groups (image composition,
// lighting, posture, facial expression) plus the common general tags.
// ---------------------------------------------------------------------------


// --- creature grounding ----------------------------------------------------
// A coined creature name carries no signal. Anima has never seen a "mycewolf";
// it has seen ten thousand wolves. The coinage is almost always a real creature
// noun with something welded to the front, so the real noun is recovered and
// used in its place — which is exactly the edit that fixed the image by hand.
const CREATURE_NOUNS = [
  'wolf', 'dog', 'fox', 'cat', 'bear', 'lion', 'tiger', 'horse', 'deer', 'stag', 'boar',
  'rat', 'mouse', 'bat', 'bird', 'crow', 'raven', 'owl', 'hawk', 'snake', 'serpent',
  'lizard', 'dragon', 'drake', 'wyvern', 'spider', 'beetle', 'moth', 'fish', 'shark',
  'squid', 'octopus', 'crab', 'frog', 'toad', 'goat', 'ram', 'bull', 'ape', 'monkey',
  'rabbit', 'hare', 'elk', 'moose', 'whale', 'worm', 'slug', 'snail', 'insect',
  'monster', 'creature', 'beast', 'demon', 'devil', 'angel', 'ghost', 'skeleton',
  'zombie', 'golem', 'slime', 'elemental', 'fairy', 'goblin', 'orc', 'ogre', 'troll',
  'giant', 'elf', 'dwarf', 'mermaid', 'centaur', 'harpy', 'gargoyle', 'wraith', 'spirit',
]
const CREATURE_SET = new Set(CREATURE_NOUNS)

// Rewrites coined creature words wherever they appear in free text.
// "ends with a creature noun and is longer than it" is a good rule for a coined
// NAME and a terrible one for English. Checked against a 234,000-word dictionary,
// it mangles 1,222 real words: herself and himself become "elf", shape and
// landscape become "ape", growl becomes "owl", combat becomes "bat", program
// becomes "ram". Eric watched three separate images give Fanny pointed ears before
// the cause surfaced, because the corruption is invisible in the log — the caption
// simply reads "wraps a towel around elf" and looks like a parser mistake.
//
// No dictionary ships with the extension, so the fix is to stop applying a
// name-shaped rule to prose. A coinage the story invented is a proper noun: it is
// capitalised wherever it appears, or hyphenated. An English word is capitalised
// only at the start of a sentence. That distinction needs no word list.
const COINAGE_STOPLIST = new Set([
  // Ordinary words that survive the coinage test and could plausibly appear as a
  // tag or open a sentence. Not exhaustive by design — the prose rule below is
  // what makes the general case safe; this only guards the name and tag paths.
  'herself', 'himself', 'myself', 'itself', 'oneself', 'yourself', 'themselves', 'ourselves',
  'shelf', 'bookshelf', 'shape', 'escape', 'landscape', 'seascape', 'drape', 'scrape', 'agape',
  'growl', 'prowl', 'combat', 'acrobat', 'wombat', 'program', 'diagram', 'anagram', 'epigram',
  'forbear', 'forebear', 'democrat', 'autocrat', 'behemoth', 'bulldog', 'catfish', 'bookworm',
  'billion', 'million', 'trillion', 'stallion', 'medallion', 'battalion', 'rebellion', 'scallion',
  'concrete', 'discrete', 'moustache',
])

function groundCoinedWord(word) {
  const clean = String(word || '').toLowerCase()
  if (!clean || CREATURE_SET.has(clean) || COINAGE_STOPLIST.has(clean)) return word
  const inner = CREATURE_NOUNS.find((noun) =>
    noun.length >= 3 && clean.length > noun.length + 1 && clean.endsWith(noun))
  if (!inner) return word
  return /^[A-Z]/.test(word) ? inner.charAt(0).toUpperCase() + inner.slice(1) : inner
}

// Free prose. Capitalisation is not enough of a signal — "the alpha mycewolf" is
// lowercase and must still ground — so prose is rewritten only for words the scene
// itself has established as creature coinages. A word that appears as somebody's
// label, name or appearance tag is a creature this story invented; a word that
// appears only in the sentence is English until proven otherwise. That is a
// dictionary-free test, and it is stricter than any word list could be.
function creatureCoinagesIn(scene) {
  const found = new Set()
  for (const subject of (scene && scene.subjects) || []) {
    const sources = [subject.label, subject.ref, ...(subject.appearance || []), ...(subject.outfit || [])]
    for (const source of sources) {
      for (const word of String(source || '').split(/[^A-Za-z-]+/)) {
        if (word.length < 5) continue
        if (groundCoinedWord(word) !== word) found.add(word.toLowerCase())
      }
    }
  }
  return found
}

function groundCreatureWords(text, coinages = null) {
  const value = String(text || '')
  if (!value) return value
  const known = coinages instanceof Set ? coinages : null
  return value.replace(/[A-Za-z][A-Za-z-]{4,}/g, (word) => {
    // Hyphenated words are coinages by construction ("spore-wolf"), so they need
    // no corroboration. Everything else must be named by the scene.
    if (!word.includes('-') && known && !known.has(word.toLowerCase())) return word
    if (!word.includes('-') && !known) return word
    return groundCoinedWord(word)
  })
}

// Tags and labels are name-shaped by construction and conventionally lowercase, so
// the capitalisation signal is unavailable — the stoplist carries them instead.
function groundCreatureTag(text) {
  return String(text || '').replace(/[A-Za-z][A-Za-z-]{4,}/g, groundCoinedWord)
}

// Grounds a subject label, falling back to a creature noun the subject's own
// appearance already names when the label contains no coinage to unpack.
function groundCreatureName(label, appearance = []) {
  const grounded = groundCreatureTag(String(label || '').trim())
  if (!grounded) return grounded
  const words = grounded.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z-]/g, ''))
  if (words.some((word) => CREATURE_SET.has(word))) return grounded
  for (const tag of appearance || []) {
    const found = String(tag || '').toLowerCase().split(/\s+/)
      .map((w) => w.replace(/[^a-z-]/g, '')).find((w) => CREATURE_SET.has(w))
    if (found) return `${grounded} ${found}`
  }
  return grounded
}

// --- appearance is for the body, not the scene -----------------------------
// "a cracked bark nearby" reached a creature's appearance array and was
// rendered as one of its physical features. Outfit has been validated since
// 0.27.1; appearance never was.
const SCENERY_NOUN_RE = /\b(?:bark|root|roots|trunk|branch|twig|leaf|leaves|foliage|canopy|rock|stone|boulder|pebble|ground|floor|wall|ceiling|sky|cloud|water|puddle|grass|dirt|soil|mud|sand|gravel|path|road|door|window|table|chair|bed|fence|post|pillar|column|debris|rubble|ruins|tree|bush|shrub|vine|log|stump|campfire|torch|lantern)\b/
const POSITIONAL_CUE_RE = /\b(?:nearby|near ?by|in the background|in the distance|behind (?:them|him|her|it)|beside them|on the ground|to (?:one|the) side|around (?:them|him|her)|beyond|underfoot|overhead|in view|visible behind)\b/
const CREATURE_TRAIT_RE = /\b(?:fur|hair|skin|scale|scales|eye|eyes|ear|ears|tail|tails|claw|claws|paw|paws|horn|horns|wing|wings|tooth|teeth|fang|fangs|snout|muzzle|mane|crest|hoof|hooves|antler|antlers|whisker|whiskers|beak|tongue|body|face|head|limb|limbs|build|frame|physique|marking|markings|pattern|spot|spots|stripe|stripes)\b/

function isNotTrait(value) {
  const text = normalizeIdentityText(value)
  if (!text) return true
  // A phrase naming a body feature is a trait even if scenery words appear in
  // it — "moss-covered fur" belongs on the creature.
  if (CREATURE_TRAIT_RE.test(text)) return false
  if (POSITIONAL_CUE_RE.test(text)) return true
  if (PLACE_WORD_RE.test(text)) { PLACE_WORD_RE.lastIndex = 0; return true }
  PLACE_WORD_RE.lastIndex = 0
  if (SCENERY_NOUN_RE.test(text)) return true
  if (isPovStagingCue(text)) return true
  return false
}

// --- one feature, one description ------------------------------------------
// A profile and an active appearance state can each describe the same feature,
// leaving "wolf ears, animal ears" and — worse — "black fur, dark brown fur".
// Two colours for one coat is a coin flip the model re-tosses every generation,
// which is one reason a character drifts between images.
const MERGEABLE_TRAIT_HEADS = new Set([
  'ears', 'tail', 'tails', 'fur', 'eyes', 'hair', 'horns', 'wings', 'claws', 'teeth',
  'fangs', 'skin', 'scales', 'mane', 'snout', 'muzzle', 'paws', 'whiskers', 'antlers',
])
const TRAIT_COLOR_WORDS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'brown', 'blonde', 'blond', 'grey', 'gray',
  'silver', 'gold', 'golden', 'amber', 'purple', 'violet', 'pink', 'orange', 'tan',
  'auburn', 'crimson', 'scarlet', 'ivory', 'cream', 'ash', 'chestnut', 'dark', 'light',
  'pale', 'bright', 'deep',
])
const GENERIC_TRAIT_MODIFIERS = new Set(['animal', 'creature', 'beast', 'monster', 'generic'])
const TRAIT_SIZE_WORDS = new Set([
  'large', 'big', 'huge', 'massive', 'small', 'little', 'tiny', 'long', 'short',
  'thick', 'thin', 'broad', 'narrow',
])

function mergeTraitsByHead(tags) {
  const groups = new Map()
  const order = []
  const passthrough = []
  for (const tag of tags || []) {
    const text = String(tag || '').trim().toLowerCase().replace(/^(?:a|an|the)\s+/, '')
    const words = text.split(/\s+/).filter(Boolean)
    const head = words[words.length - 1]
    // A bare "claws" used to bypass merging entirely, so it could never combine
    // with "sharp claws" and both reached the prompt. A single-word trait whose
    // head is mergeable is just that group with no modifiers.
    if (!MERGEABLE_TRAIT_HEADS.has(head)) { passthrough.push(tag); continue }
    if (!groups.has(head)) { groups.set(head, []); order.push(head) }
    groups.get(head).push(words.slice(0, -1))
  }
  const merged = []
  for (const head of order) {
    const sets = groups.get(head)
    if (sets.length === 1) { merged.push([...sets[0], head].join(' ')); continue }
    const flat = sets.flat()
    // A specific sibling retires the generic one: "wolf ears" beats "animal ears".
    const specific = flat.filter((word) => !GENERIC_TRAIT_MODIFIERS.has(word))
    const pool = specific.length ? specific : flat
    const out = []
    let colorTaken = false
    for (const word of pool) {
      if (out.includes(word)) continue
      if (TRAIT_COLOR_WORDS.has(word)) {
        if (colorTaken) continue
        colorTaken = true
      }
      out.push(word)
    }
    // Size reads first in English: "large wolf tail", not "wolf large tail".
    out.sort((a, b) => (TRAIT_SIZE_WORDS.has(b) ? 1 : 0) - (TRAIT_SIZE_WORDS.has(a) ? 1 : 0))
    merged.push([...out.slice(0, 3), head].join(' '))
  }
  return uniqueStrings([...merged, ...passthrough])
}

const BOORU_VOCAB = new Set([
  // view angle and framing
  'from above', 'from below', 'from side', 'from behind', 'from front', 'dutch angle',
  'straight-on', 'three-quarter view', 'upside-down', 'sideways', 'multiple views', 'pov',
  'close-up', 'portrait', 'upper body', 'cowboy shot', 'full body', 'wide shot',
  'very wide shot', 'lower body', 'head out of frame', 'feet out of frame',
  'foot out of frame', 'knees out of frame', 'eyes out of frame', 'out of frame',
  'cropped legs', 'cropped torso', 'cropped arms', 'cropped shoulders', 'cropped head',
  'profile', 'cut-in', 'depth of field', 'perspective', 'foreshortening', 'fisheye',
  'panorama', 'atmospheric perspective', 'vanishing point', 'symmetry', 'negative space',
  'scenery', 'landscape', 'cityscape', 'nature', 'no humans', 'still life', 'group picture',
  // focus
  'solo focus', 'eye focus', 'hand focus', 'back focus', 'foot focus', 'male focus',
  'animal focus', 'monster focus', 'object focus', 'weapon focus', 'plant focus',
  // gaze
  'looking at viewer', 'looking away', 'looking back', 'looking down', 'looking up',
  'looking to the side', 'looking ahead', 'facing viewer', 'facing away', 'eye contact',
  // lighting
  'backlighting', 'sidelighting', 'underlighting', 'overlighting', 'rim lighting',
  'dim lighting', 'dramatic lighting', 'cinematic lighting', 'sunlight', 'sunbeam',
  'moonlight', 'candlelight', 'firelight', 'lantern', 'neon lights', 'bioluminescence',
  'glowing', 'glowing eyes', 'light rays', 'lens flare', 'bloom', 'chiaroscuro',
  'high contrast', 'silhouette', 'shadow', 'cast shadow', 'drop shadow', 'vignetting',
  'caustics', 'subsurface scattering', 'dappled sunlight', 'light particles', 'sparkle',
  'overexposure', 'spotlight', 'god rays', 'diffraction spikes',
  // time and weather
  'night', 'evening', 'morning', 'day', 'sunset', 'sunrise', 'dusk', 'twilight',
  'starry sky', 'full moon', 'moon', 'sky', 'cloud', 'cloudy sky', 'overcast', 'rain',
  'snow', 'fog', 'mist', 'wind', 'storm', 'lightning',
  // style, medium, technique
  'sketch', 'lineart', 'realistic', 'photorealistic', 'painterly', 'impressionism',
  'minimalism', 'abstract', 'surreal', 'art nouveau', 'art deco', 'ukiyo-e', 'sumi-e',
  'nihonga', 'ligne claire', 'traditional media', 'monochrome', 'greyscale', 'sepia',
  'limited palette', 'film grain', 'chromatic aberration', 'motion blur', 'motion lines',
  'speed lines', 'emphasis lines', 'screentones', 'halftone', 'blurry', 'blurry background',
  'bokeh', 'gradient', 'glitch', 'scanlines', 'pixel art', 'official art', 'colorful',
  'muted color', 'pale color', 'dark', 'bright', 'crosshatching', 'stippling',
  // setting and background
  'outdoors', 'indoors', 'forest', 'tree', 'bamboo forest', 'grass', 'field', 'flower',
  'flower field', 'petals', 'falling petals', 'leaf', 'fallen leaves', 'moss', 'vines',
  'roots', 'mushroom', 'crystal', 'rock', 'cliff', 'mountain', 'valley', 'meadow', 'swamp',
  'desert', 'jungle', 'cave', 'water', 'river', 'lake', 'ocean', 'beach', 'waterfall',
  'pond', 'puddle', 'ruins', 'castle', 'church', 'temple', 'shrine', 'city', 'street',
  'alley', 'rooftop', 'road', 'path', 'bridge', 'fence', 'garden', 'courtyard', 'forest path',
  'room', 'bedroom', 'bathroom', 'kitchen', 'living room', 'classroom', 'library', 'office',
  'hallway', 'stairs', 'window', 'door', 'bed', 'chair', 'table', 'wall', 'floor', 'ceiling',
  'tent', 'campfire', 'fire', 'smoke', 'dust', 'debris', 'spider web', 'simple background',
  'transparent background', 'gradient background', 'white background', 'black background',
  'dark background', 'outdoor', 'clearing',
  // posture
  'standing', 'sitting', 'kneeling', 'lying', 'on back', 'on stomach', 'on side',
  'crouching', 'squatting', 'all fours', 'leaning forward', 'leaning back', 'bent over',
  'arched back', 'arms up', 'arms behind back', 'arms behind head', 'crossed arms',
  'hands up', 'hand on own hip', 'hand on own chest', 'hand on another’s shoulder',
  'head tilt', 'spread legs', 'crossed legs', 'legs up', 'knees together', 'fetal position',
  'straddling', 'sitting on lap', 'carrying', 'princess carry', 'hug', 'hugging',
  'arm around shoulder', 'arm around waist', 'holding hands', 'back-to-back',
  'outstretched arm', 'outstretched hand', 'reaching', 'clenched hand', 'clenched hands',
  'walking', 'running', 'jumping', 'falling', 'floating', 'flying', 'swimming', 'dancing',
  'bowing', 'crawling', 'top-down bottom-up', 'seiza', 'wariza', 'indian style',
  // expression
  'smile', 'grin', 'smirk', 'frown', 'scowl', 'glare', 'blush', 'embarrassed', 'crying',
  'tears', 'teary eyes', 'crying with eyes open', 'surprised', 'shocked', 'angry', 'sad',
  'happy', 'closed eyes', 'half-closed eyes', 'wide-eyed', 'open mouth', 'closed mouth',
  'parted lips', 'clenched teeth', 'gritted teeth', 'tongue out', 'drooling', 'sweat',
  'sweatdrop', 'nervous', 'worried', 'scared', 'fear', 'determined', 'serious',
  'expressionless', 'empty eyes', 'pout', 'sleepy', 'tired', 'confused', 'annoyed',
  'light smile', 'evil smile', 'sad smile', 'forced smile', 'trembling', 'shaking',
  // body and creature features
  'animal ears', 'wolf ears', 'fox ears', 'cat ears', 'animal ear fluff', 'tail',
  'wolf tail', 'fox tail', 'cat tail', 'fangs', 'sharp teeth', 'claws', 'fur', 'body fur',
  'furry', 'horns', 'wings', 'pointy ears', 'elf', 'slit pupils', 'vertical pupils',
  'colored sclera', 'muscular', 'muscular male', 'scar', 'blood', 'wound', 'dirty',
  'sweaty', 'wet', 'veins', 'toned',
  // anatomy and acts, in the clinical register Danbooru uses
  'penis', 'testicles', 'vagina', 'pussy', 'anus', 'nipples', 'breasts',
  'erection', 'flaccid', 'large penis', 'huge penis', 'veiny penis',
  'fellatio', 'cunnilingus', 'handjob', 'masturbation', 'male masturbation',
  'vaginal', 'anal', 'sex', 'straddling', 'cowgirl position', 'doggystyle',
  'missionary', 'deepthroat', 'licking penis', 'penis grab', 'tongue out',
  'saliva', 'cum', 'ejaculation', 'blush', 'sweat',
  // orientation — which way the bodies face each other. Verified on Danbooru:
  // eye contact carries 67,846 posts and implicates looking at another.
  'face-to-face', 'facing another', 'looking at another', 'eye contact',
  'averting eyes', 'front-to-back', 'back-to-back', 'height difference',
  'noses touching', 'forehead-to-forehead', 'looking up', 'looking down',
  'looking at viewer', 'profile', 'from side',
  // conflict — a fight had no booru vocabulary at all, so every tag describing
  // one was demoted to the caption
  'fighting', 'battle', 'fighting stance', 'clenched hand', 'punching', 'kicking',
  'biting', 'grabbing', 'holding another\'s wrist', 'restrained', 'pinned down',
  'straddling', 'wrestling', 'chasing', 'fleeing', 'blood on face', 'injury',
  'bleeding', 'bruise', 'torn clothes', 'weapon', 'sword', 'knife', 'claw pose',
  'aiming', 'guarding', 'shielding', 'protecting', 'baring teeth', 'growling',
  // gender presentation — all verified against Danbooru's own tag pages
  'trap', 'androgynous', 'bishounen', 'girly boy', 'reverse trap', 'crossdressing',
  'crossdressing (mtf)', 'crossdressing (ftm)', 'futanari', 'male futanari',
  'futa without pussy', 'cuntboy', 'male focus', 'female focus', 'bulge',
  'flat chest',
  // clothing and bare states
  'nude', 'completely nude', 'topless', 'bottomless', 'partially undressed', 'undressing',
  'torn clothes', 'tattered clothes', 'wet clothes', 'open shirt', 'open clothes', 'shirt',
  'dress', 'robe', 'cloak', 'cape', 'coat', 'jacket', 'armor', 'boots', 'gloves', 'hat',
  'hood', 'scarf', 'belt', 'pants', 'shorts', 'skirt', 'thighhighs', 'socks', 'barefoot',
  'bare shoulders', 'bare back', 'bare arms', 'bare legs', 'collar', 'jewelry', 'necklace',
  'earrings', 'glasses', 'round eyewear', 'hair ornament', 'ribbon', 'bandages',
])

// Near-misses a language model reliably produces for a tag that does exist.
// Rewriting is strictly better than demoting: the concept survives *and* lands
// in the vocabulary the model was trained on.
const BOORU_ALIASES = {
  'front view': 'from front', 'frontal view': 'from front', 'facing forward': 'from front',
  'side view': 'from side', 'profile view': 'from side',
  'rear view': 'from behind', 'back view': 'from behind', 'view from behind': 'from behind',
  'top-down': 'from above', 'top down': 'from above', 'overhead': 'from above',
  'overhead view': 'from above', 'high angle': 'from above', 'bird’s eye view': 'from above',
  'birds eye view': 'from above', 'aerial view': 'from above', 'looking down at': 'from above',
  'low angle': 'from below', 'worm’s eye view': 'from below', 'upward angle': 'from below',
  'closeup': 'close-up', 'close up': 'close-up', 'extreme close-up': 'close-up',
  'tight shot': 'close-up', 'headshot': 'portrait', 'head shot': 'portrait',
  'full-body': 'full body', 'full body shot': 'full body', 'upper-body': 'upper body',
  'wide angle': 'wide shot', 'long shot': 'wide shot', 'establishing shot': 'wide shot',
  'medium shot': 'cowboy shot', 'three quarter view': 'three-quarter view',
  'backlit': 'backlighting', 'back lighting': 'backlighting', 'back-lit': 'backlighting',
  'rim light': 'rim lighting', 'side lighting': 'sidelighting', 'under lighting': 'underlighting',
  'dim light': 'dim lighting', 'low light': 'dim lighting', 'dim': 'dim lighting',
  'low lighting': 'dim lighting', 'moody lighting': 'dramatic lighting',
  'moon light': 'moonlight', 'sun light': 'sunlight', 'candle light': 'candlelight',
  'fire light': 'firelight', 'firelit': 'firelight', 'glowing eye': 'glowing eyes',
  'bioluminescent': 'bioluminescence', 'luminescence': 'bioluminescence',
  'sun rays': 'light rays', 'sunbeams': 'sunbeam', 'lens flares': 'lens flare',
  'night time': 'night', 'nighttime': 'night', 'day time': 'day', 'daytime': 'day',
  'out doors': 'outdoors', 'outside': 'outdoors', 'in doors': 'indoors', 'inside': 'indoors',
  'trees': 'tree', 'flowers': 'flower', 'clouds': 'cloud', 'rocks': 'rock',
  'mushrooms': 'mushroom', 'crystals': 'crystal', 'roots': 'roots',
  'forest floor': 'grass', 'undergrowth': 'grass', 'woods': 'forest',
  'grove': 'forest', 'thicket': 'forest', 'glade': 'clearing', 'canopy': 'tree',
  'naked': 'nude', 'fully nude': 'completely nude', 'unclothed': 'nude',
  'bare feet': 'barefoot', 'ripped clothes': 'torn clothes', 'torn clothing': 'torn clothes',
  'tattered clothing': 'tattered clothes', 'trousers': 'pants', 'spectacles': 'glasses',
  'round glasses': 'round eyewear', 'jewellery': 'jewelry',
  'low crouch': 'crouching', 'crouched': 'crouching', 'crouched low': 'crouching',
  'crouching low': 'crouching', 'kneeling down': 'kneeling', 'lying down': 'lying',
  'on all fours': 'all fours', 'bent forward': 'bent over', 'leaning over': 'bent over',
  'arms raised': 'arms up', 'hands raised': 'hands up', 'legs spread': 'spread legs',
  'arms crossed': 'crossed arms', 'hand on hip': 'hand on own hip',
  'standing firm': 'standing', 'standing still': 'standing', 'stands': 'standing',
  'tilted head': 'head tilt', 'head tilted': 'head tilt',
  'blushing': 'blush', 'smiling': 'smile', 'grinning': 'grin', 'smirking': 'smirk',
  'frowning': 'frown', 'scowling': 'scowl', 'glaring': 'glare', 'sweating': 'sweat',
  'drool': 'drooling', 'tearful': 'teary eyes', 'teary-eyed': 'teary eyes',
  'tear-streaked': 'teary eyes', 'in tears': 'crying', 'eyes closed': 'closed eyes',
  'eyes shut': 'closed eyes', 'mouth open': 'open mouth', 'mouth opening': 'open mouth',
  'open-mouthed': 'open mouth', 'wide eyed': 'wide-eyed', 'eyes wide': 'wide-eyed',
  'bared teeth': 'clenched teeth', 'baring teeth': 'clenched teeth',
  'snarling': 'clenched teeth', 'snarl': 'clenched teeth', 'growling': 'clenched teeth',
  'focused': 'serious', 'focussed': 'serious', 'resolute': 'determined',
  'frightened': 'scared', 'afraid': 'scared', 'terrified': 'scared',
  'aggressive': 'angry', 'predatory': 'glare', 'furious': 'angry',
  'looking at the viewer': 'looking at viewer', 'looks at viewer': 'looking at viewer',
  'fang': 'fangs', 'claw': 'claws', 'wolf ear': 'wolf ears', 'animal ear': 'animal ears',
  'pointed ears': 'pointy ears', 'wolf-like ears': 'wolf ears', 'sharp claws': 'claws',
  'muscled': 'muscular', 'toned muscles': 'toned', 'scarred': 'scar',
  // Danbooru aliases femboy, otoko_no_ko and otokonoko all TO "trap" — that is
  // the canonical tag with ~73k posts, so it is the one Anima trained on. The
  // others are dead strings that occupy a slot and do nothing.
  'femboy': 'trap', 'otoko no ko': 'trap', 'otokonoko': 'trap', 'otoko-no-ko': 'trap', 'tomgirl': 'trap',
  'feminine male': 'trap', 'feminine boy': 'trap', 'girly male': 'girly boy',
  'futa': 'futanari', 'hermaphrodite': 'futanari', 'dickgirl': 'futanari',
  'crossdresser': 'crossdressing', 'crossdressed': 'crossdressing',
  'mtf crossdressing': 'crossdressing (mtf)', 'ftm crossdressing': 'crossdressing (ftm)',
  'androgyne': 'androgynous', 'androgynous male': 'androgynous',
  // Colloquial anatomy carries a fraction of the signal of the trained tag.
  'cock': 'penis', 'dick': 'penis', 'shaft': 'penis', 'member': 'penis',
  'manhood': 'penis', 'erection': 'erection', 'hard-on': 'erection',
  'balls': 'testicles', 'ballsack': 'testicles', 'sack': 'testicles',
  'blowjob': 'fellatio', 'blow job': 'fellatio', 'oral sex': 'fellatio',
  'sucking cock': 'fellatio', 'sucking penis': 'fellatio', 'giving head': 'fellatio',
  'going down on': 'fellatio', 'eating out': 'cunnilingus',
  'jerking off': 'masturbation', 'stroking himself': 'male masturbation',
  'stroking herself': 'masturbation', 'jacking off': 'masturbation',
  'tits': 'breasts', 'boobs': 'breasts', 'chest': 'breasts',
  'ass': 'ass', 'butt': 'ass', 'arse': 'ass',
  'cum': 'cum', 'jizz': 'cum', 'spunk': 'cum', 'load': 'cum',
  'glow': 'glowing', 'glowed': 'glowing', 'aglow': 'glowing', 'luminous': 'glowing',
  'grayscale': 'greyscale', 'black and white': 'greyscale', 'monochromatic': 'monochrome',
  'oil painting': 'traditional media', 'watercolor': 'traditional media',
  'photo realistic': 'photorealistic', 'photo-realistic': 'photorealistic',
}

// Resolve a parser tag to a real Danbooru tag. Returns the canonical tag and
// how it was reached, so the caller can decide what to do with a miss.
function resolveBooruTag(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s{2,}/g, ' ')
  if (!raw) return { tag: '', match: 'none' }
  if (BOORU_VOCAB.has(raw)) return { tag: raw, match: 'exact' }
  if (BOORU_ALIASES[raw]) return { tag: BOORU_ALIASES[raw], match: 'alias' }
  // Cheap morphology, in place of enumerating every inflection: a trailing
  // plural or a gerund is the same concept to Danbooru.
  const candidates = [
    raw.replace(/ies$/, 'y'), raw.replace(/es$/, ''), raw.replace(/s$/, ''), `${raw}s`,
    raw.replace(/ing$/, ''), raw.replace(/ing$/, 'e'),
  ]
  for (const candidate of candidates) {
    if (candidate === raw || candidate.length < 3) continue
    if (BOORU_VOCAB.has(candidate)) return { tag: candidate, match: 'morphology' }
    if (BOORU_ALIASES[candidate]) return { tag: BOORU_ALIASES[candidate], match: 'alias' }
  }
  return { tag: '', match: 'none' }
}

const SALVAGE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'with', 'from', 'into',
  'over', 'under', 'his', 'her', 'its', 'their', 'this', 'that', 'is', 'are', 'be',
])

// "dim undergrowth" is not a tag, but "dim lighting" and "grass" both are, and
// both are inside it. Rather than lose the whole phrase, mine it for the real
// tags it contains — the phrase still goes to the caption, so nothing is lost
// and a booru anchor is gained.
function salvageBooruWords(phrase, maxTags = 2) {
  const words = String(phrase || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean)
  const found = []
  // Two-word spans first: "crystal tree" beats "crystal" alone where both exist.
  for (let size = 2; size >= 1 && found.length < maxTags; size--) {
    for (let i = 0; i + size <= words.length && found.length < maxTags; i++) {
      const span = words.slice(i, i + size)
      if (span.every((word) => SALVAGE_STOPWORDS.has(word))) continue
      if (size === 1 && SALVAGE_STOPWORDS.has(span[0])) continue
      const { tag } = resolveBooruTag(span.join(' '))
      if (tag && !found.includes(tag)) found.push(tag)
    }
  }
  return found
}

// Split parser tags into real Danbooru tags and prose. A miss is never simply
// deleted: it is mined for any real tag inside it, and the original phrase is
// returned for the caption, where natural language is what Anima expects.
function partitionBooruTags(tags) {
  const kept = []
  const demoted = []
  const orphans = []
  const rewritten = []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const text = String(tag || '').trim()
    if (!text) continue
    const { tag: resolved, match } = resolveBooruTag(text)
    if (resolved) {
      kept.push(resolved)
      if (match !== 'exact') rewritten.push(`${text} → ${resolved}`)
      continue
    }
    const salvaged = salvageBooruWords(text)
    if (salvaged.length) {
      kept.push(...salvaged)
      rewritten.push(`${text} ⊃ ${salvaged.join(' + ')}`)
    } else {
      // Nothing inside this phrase reached the tag run, so the caption is the
      // only place its meaning survives. That makes it the first thing worth
      // keeping when the caption has to be trimmed.
      orphans.push(text)
    }
    demoted.push(text)
  }
  return { kept: uniqueStrings(kept), demoted: uniqueStrings(demoted), orphans: uniqueStrings(orphans), rewritten }
}

const ANIMA_SAFETY_TAGS = ['safe', 'sensitive', 'nsfw', 'explicit']

// Drops tags that are wholly contained in a longer tag already present, in
// this list or in `others`. "desk, study, wooden desk" collapses to
// "study, wooden desk"; "carrying hammer, carrying a hammer" loses the
// shorter duplicate. Cheap way to stop the same concept being paid for twice.
function collapseRedundantTags(tags, others = []) {
  // Booru tags carry no articles, so "carrying hammer" and "carrying a hammer"
  // are the same concept and must compare equal.
  const key = (value) => normalizeIdentityText(value).replace(/\b(?:a|an|the)\s+/g, '').replace(/\s{2,}/g, ' ').trim()
  const pool = uniqueStrings([...(tags || []), ...(others || [])])
  const seen = new Set()
  return (tags || []).filter((tag) => {
    const value = key(tag)
    if (!value || seen.has(value)) return false
    const covered = pool.some((candidate) => {
      const other = key(candidate)
      return other !== value && other.length > value.length && new RegExp(`\\b${escapeRegExp(value)}\\b`).test(other)
    })
    if (covered) return false
    seen.add(value)
    return true
  })
}

// Prompt weighting works on Anima but needs a heavier hand than SDXL — the
// model card's own example is "(chibi:2)". Reserved for the few places the
// compiler has a defensible reason to emphasise something.
function animaWeight(tag, weight) {
  const value = animaTag(tag)
  if (!value) return ''
  const w = Number(weight)
  if (!Number.isFinite(w) || w === 1) return value
  return `(${value}:${w})`
}

// Anima requires artist tags to be prefixed with "@" — the model card is blunt
// that "the effect will be very weak if you don't". Presets written in A1111
// habits spell them "artist:foo" or "by foo", so normalise those forms rather
// than silently rendering a near-no-op tag.
function normalizeArtistTags(headerText) {
  return String(headerText || '')
    .split(',')
    .map((part) => {
      const value = part.trim()
      if (!value || value.startsWith('@')) return value
      const match = /^(?:artist\s*:\s*|by\s+)(.+)$/i.exec(value)
      return match ? `@${match[1].trim().toLowerCase()}` : value
    })
    .filter(Boolean)
    .join(', ')
}

// A preset's quality-tag field is free text and almost always carries a safety
// tag ("masterpiece, best quality, score_7, safe"). When the parser classifies
// a passage as nsfw/explicit the two disagree, and the old compiler emitted
// both — "…, safe, explicit, 1girl" — which is the single worst thing you can
// hand a model trained with mutually exclusive safety tags. The scene wins.
function reconcileSafetyTags(headerText, safety) {
  const text = String(headerText || '').trim()
  if (!text) return ''
  if (!ANIMA_SAFETY_TAGS.includes(String(safety || '').toLowerCase())) return text
  const kept = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !ANIMA_SAFETY_TAGS.includes(part.toLowerCase()))
  return kept.join(', ')
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

const SUPPORTED_POSE_RE = /\b(?:sitting|seated|perched|leaning|lying|lying down|reclining|kneeling|sprawled|slumped|straddling)\b/

function supportForSubject(item, scene) {
  if (item.subject.support) return animaTag(item.subject.support)
  // Only infer a surface from the setting when the pose actually rests on one.
  // Otherwise a standing character inherited the room's furniture and ended up
  // "standing ... against the counter edge".
  const poseText = animaTagList(item.pose || (item.subject && item.subject.pose) || []).join(', ')
  if (!SUPPORTED_POSE_RE.test(poseText)) return ''
  return findSupportSurface(scene.setting)
}

const SUPPORT_SURFACE_RE = /countertop|counter edge|bar stool|stool|chair|bed|couch|sofa|floor|wall|table|desk|counter/

// Danbooru keeps the pose and the furniture as separate tags ("sitting",
// "counter"), so the compiler no longer welds them into one pseudo-tag. The
// pose list stays clean and the surface is emitted alongside the scene tags.
function poseWithSupport(item, scene) {
  return animaTagList(item.pose)
}

// Collects the visible support surfaces across every subject so they can join
// the general tag block exactly once.
function supportTags(descriptors, scene) {
  const surfaces = []
  for (const item of descriptors) {
    const support = supportForSubject(item, scene)
    if (!support) continue
    const poseText = animaTagList(item.pose).join(', ')
    if (SUPPORT_SURFACE_RE.test(poseText)) continue
    surfaces.push(support)
  }
  return uniqueStrings(surfaces)
}

// Natural-language rendering of a pose plus its surface, used only in the
// multi-subject caption block where the binding actually matters.
function poseClause(item, scene) {
  const poses = animaTagList(item.pose)
  if (!poses.length) return ''
  const support = supportForSubject(item, scene)
  const joined = naturalList(poses)
  if (!support || SUPPORT_SURFACE_RE.test(poses.join(', '))) return joined
  if (/(sitting|seated|perched)/.test(joined)) return `${joined} on the ${support}`
  if (/leaning/.test(joined)) return `${joined} against the ${support}`
  if (/lying/.test(joined)) return `${joined} on the ${support}`
  if (/kneeling/.test(joined) && support === 'floor') return `${joined} on the floor`
  return joined
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

// A text encoder matches tokens, not words. "Fanny Price" taught us this the hard
// way — the model found `fanny` inside a name and drew accordingly. The same trap
// exists in ordinary prose: "braces herself" carries `elf` inside it, and `elf` is a
// strong, well-trained Danbooru concept, so pointed ears turn up on a character who
// has none.
//
// Reflexive pronouns are the cheapest possible fix because they carry no visual
// information at all: "braces herself against the table" and "braces against the
// table" describe the same picture. Removing the word removes the token.
//
// Kept as a table because this class of bug recurs — when the next hidden tag turns
// up, it is one line here rather than a new mechanism.
const SUBWORD_TRAPS = [
  {
    // herself, himself, myself, itself, oneself, yourself, themselves, ourselves
    pattern: /\b(?:her|him|my|it|one|your|them|our|your|your)(?:self|selves)\b/gi,
    replacement: '',
    summons: 'elf',
    why: 'a reflexive pronoun contains "elf", which the model draws as pointed ears',
  },
]

function stripSubwordTraps(text) {
  let value = String(text || '')
  const hits = []
  for (const trap of SUBWORD_TRAPS) {
    trap.pattern.lastIndex = 0
    const found = value.match(trap.pattern)
    if (!found || !found.length) continue
    hits.push({ words: uniqueStrings(found.map((w) => w.toLowerCase())), summons: trap.summons, why: trap.why })
    value = value.replace(trap.pattern, trap.replacement)
  }
  // Removing a word leaves the spacing and punctuation it was holding open.
  value = value
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim()
  return { text: value, hits }
}

function visibleAnatomySentence(item, scene) {
  if (!item.anatomy.length) return ''
  // A safe/sensitive scene must never receive an exposed-anatomy sentence.
  // This also prevents a profile override from contradicting the safety tag.
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return ''
  const anchor = displayName(item, true)
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
  if (clothes.length) sentences.push(`${anchor} wears ${naturalList(withArticleList(clothes))}.`)
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

// Hair and eye colour are how a booru-trained model tells two characters apart —
// they are the first thing in almost every character tag set. Scoring hair 99
// sent it to the end of the list, where the caption cap cut it off, and a
// character with no stated hair borrows whatever hair the prompt does mention.
// That is exactly how two characters end up with the same hair.
const IDENTITY_TRAIT_RE = /\b(?:hair|bun|braids?|ponytails?|twintails?|bangs|sidelocks?|ahoge|eyes?|heterochromia|trap|otoko no ko|femboy|futanari|androgynous|bishounen|girly boy|reverse trap|flat chest|crossdressing)\b/

function signaturePriority(tag) {
  const value = animaTag(tag)
  // Presentation first: whether the figure reads male, female or otoko no ko
  // governs everything else about it, and it was scoring 99 and being cut.
  if (/\b(?:trap|otoko no ko|femboy|futanari|androgynous|bishounen|girly boy|reverse trap|flat chest|crossdressing)\b/.test(value)) return 0
  if (/\bhair\b|\b(?:bun|braids?|ponytails?|twintails?|bangs|sidelocks?|ahoge)\b/.test(value)) return 1
  if (/\beyes?\b|\bheterochromia\b/.test(value)) return 2
  if (/\b(?:pointed elf ears|elf ears|animal ears|wolf ears|cat ears|fox ears|horns?|wings?|tails?|fangs?|claws?|snout|muzzle|fur)\b/.test(value)) return 3
  if (/\b(?:round glasses|glasses|eyewear|goggles|monocle|eyepatch)\b/.test(value)) return 4
  if (/\b(?:tattoo|scar|birthmark|body marking)\b/.test(value)) return 5
  if (/\bpiercing\b/.test(value)) return 6
  return 99
}

function subjectSpeciesCue(item) {
  const text = animaTagList([item && item.noun, ...((item && item.appearance) || [])]).join(', ')
  const species = [
    'human', 'half-elf', 'elf', 'dwarf', 'orc', 'goblin', 'halfling', 'gnome', 'tiefling',
    'aasimar', 'dragonborn', 'drow', 'vampire', 'werewolf', 'demon', 'devil', 'angel', 'fairy',
    'mermaid', 'centaur', 'minotaur', 'kobold', 'lizardfolk', 'catboy', 'catgirl', 'android', 'robot',
  ]
  return species.find((value) => new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i').test(text)) || ''
}

// `lead` controls capitalisation: a species cue reads "The half-elf Ilsa" at
// the start of a sentence but must not shout mid-sentence ("worn by The
// half-elf Ilsa").
function signatureOwnerName(item, lead = true) {
  const species = subjectSpeciesCue(item)
  if (!species || !(item && item.named)) return displayName(item, lead)
  return `${lead ? 'The' : 'the'} ${species} ${sentenceName(item.anchor)}`
}

function signatureOwnershipSentence(tag, item, exclusive = false) {
  const value = animaTag(tag)
  if (!value || signaturePriority(value) >= 99) return ''
  if (/\b(?:glasses|eyewear|goggles|monocle|eyepatch)\b/.test(value)) {
    return exclusive
      ? `The only eyewear in the scene is ${value}, worn by ${signatureOwnerName(item, false)}.`
      : `${signatureOwnerName(item, true)} wears ${value}.`
  }
  return exclusive
    ? `${signatureOwnerName(item, true)} is the only character with ${withArticle(value)}.`
    : `${signatureOwnerName(item, true)} has ${withArticle(value)}.`
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
  const description = String(alias && alias.description || '').trim()
  const propName = String(alias && alias.name || '').trim()
  if (/\bsheathed\b/i.test(value) && !aliasIsSheathable(alias.description)) {
    value = value.replace(/\bsheathed\b/gi, 'carried on back')
  }
  if (description && !normalizeIdentityText(value).includes(normalizeIdentityText(description)) && propName) {
    const propPattern = new RegExp(escapeRegExp(propName), 'i')
    value = value.replace(propPattern, `${propName}, ${description}`)
  }
  return value.replace(/\s+,/g, ',').replace(/,\s*,+/g, ', ').replace(/\s{2,}/g, ' ').trim()
}

function aliasDescriptionMatchesScene(text, alias) {
  const haystack = normalizeIdentityText(text)
  const description = normalizeIdentityText(alias && alias.description)
  if (!haystack || !description) return false
  const nouns = [
    'warhammer', 'hammer', 'greatsword', 'longsword', 'shortsword', 'sword', 'rapier', 'dagger', 'knife',
    'battleaxe', 'greataxe', 'axe', 'staff', 'wand', 'spear', 'lance', 'bow', 'crossbow', 'shield',
    'pistol', 'revolver', 'rifle', 'shotgun', 'gun', 'book', 'tome', 'orb', 'lantern', 'necklace', 'amulet',
  ]
  const candidates = nouns.filter((noun) => description.includes(noun))
  if (description.includes('warhammer') && !candidates.includes('hammer')) candidates.push('hammer')
  if (description.includes('greatsword') && !candidates.includes('sword')) candidates.push('sword')
  if (description.includes('battleaxe') && !candidates.includes('axe')) candidates.push('axe')
  return candidates.some((noun) => new RegExp(`\\b${noun}\\b`, 'i').test(haystack))
}

function expandGenericAliasTag(tag, alias) {
  let value = normalizeVisualPhrase(tag)
  if (!value || !alias || aliasMentioned(value, alias) || !aliasDescriptionMatchesScene(value, alias)) return value
  const description = String(alias.description || '').trim()
  const propName = String(alias.name || '').trim()
  if (!description) return value
  if (normalizeIdentityText(value).includes(normalizeIdentityText(description))) return value
  // Tag space gets the *description* only. A proper noun like "dawnbreaker" is
  // an unknown token to Anima and buys nothing here; the name still appears in
  // the natural-language ownership sentence, where it can actually bind.
  const replacementText = description.replace(/^(?:a|an|the)\s+/i, '')
  const replacements = [
    ['warhammer', /\bwarhammer\b/i], ['hammer', /\bhammer\b/i],
    ['greatsword', /\bgreatsword\b/i], ['longsword', /\blongsword\b/i], ['shortsword', /\bshortsword\b/i], ['sword', /\bsword\b/i],
    ['battleaxe', /\bbattleaxe\b/i], ['greataxe', /\bgreataxe\b/i], ['axe', /\baxe\b/i],
    ['rapier', /\brapier\b/i], ['dagger', /\bdagger\b/i], ['knife', /\bknife\b/i],
    ['staff', /\bstaff\b/i], ['wand', /\bwand\b/i], ['spear', /\bspear\b/i], ['lance', /\blance\b/i],
    ['bow', /\bbow\b/i], ['crossbow', /\bcrossbow\b/i], ['shield', /\bshield\b/i],
    ['revolver', /\brevolver\b/i], ['pistol', /\bpistol\b/i], ['rifle', /\brifle\b/i], ['shotgun', /\bshotgun\b/i], ['gun', /\bgun\b/i],
    ['tome', /\btome\b/i], ['book', /\bbook\b/i], ['orb', /\borb\b/i], ['lantern', /\blantern\b/i],
    ['necklace', /\bnecklace\b/i], ['amulet', /\bamulet\b/i],
  ]
  for (const [noun, pattern] of replacements) {
    if (!description.toLowerCase().includes(noun)) continue
    if (pattern.test(value)) return value.replace(pattern, replacementText)
  }
  return value
}

function activeAliasesForSubject(item, scene) {
  const aliases = item.profile && Array.isArray(item.profile.visualAliases) ? item.profile.visualAliases : []
  const text = subjectSceneText(item, scene)
  const exact = aliases.filter((alias) => aliasMentioned(text, alias))
  if (exact.length) return exact.slice(0, 2)
  // A generic object such as "hammer" may recover a single signature alias,
  // but do not guess when the profile defines multiple matching props.
  const generic = aliases.filter((alias) => aliasDescriptionMatchesScene(text, alias))
  return generic.length === 1 ? generic : []
}

function aliasOwnershipSentence(alias, item, scene) {
  const name = displayName(item, true)
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

function subjectOwnershipAnchors(item, scene, exclusive = false, { includeSignature = true, maxAnchors = 2 } = {}) {
  const anchors = []
  // Signature exclusivity sentences are now optional: since v9 the identity
  // sentence is the only place appearance exists in a multi-subject prompt,
  // so repeating "the only eyewear is..." mostly buys length, not binding.
  if (includeSignature) {
    const signature = [...(item.appearance || [])]
      .filter((tag) => appearanceTraitVisible(tag, item.outfit))
      .sort((a, b) => signaturePriority(a) - signaturePriority(b))
      .find((tag) => signaturePriority(tag) < 99)
    if (signature) {
      const sentence = signatureOwnershipSentence(signature, item, exclusive)
      if (sentence) anchors.push(sentence)
    }
  }
  for (const alias of activeAliasesForSubject(item, scene)) {
    const sentence = aliasOwnershipSentence(alias, item, scene)
    if (sentence) anchors.push(sentence)
    if (anchors.length >= maxAnchors) break
  }
  return uniqueStrings(anchors).slice(0, maxAnchors)
}

// Tag-space rendering for a subject. `includeAppearance` is false in
// multi-subject scenes, where permanent appearance is carried by the
// natural-language identity sentences instead — keeping "silver hair" and
// "black hair" out of the same undifferentiated tag run is the whole point.
function subjectTagLine(item, scene, descriptors, { includeAppearance = true } = {}) {
  const poses = poseWithSupport(item, scene).map((part) => resolveCrossSubjectPronouns(part, item, descriptors))
  const held = heldObjectsFor(item)
  const consumed = new Set(held.consumed)
  const actions = item.action
    .filter((part) => !consumed.has(part))
    .filter((part) => !actionDuplicatesRelation(part, item.subject.ref, scene.relations))
    .map((part) => resolveCrossSubjectPronouns(part, item, descriptors))
  const aliases = activeAliasesForSubject(item, scene)
  // A named prop is expanded to its full descriptor at most once per subject.
  // Expanding on every mention produced lines like "dawnbreaker, a chipped
  // bronze warhammer with a leather-wrapped haft over shoulder, ... carrying
  // dawnbreaker, a chipped bronze warhammer with a leather-wrapped haft".
  const expanded = new Set()
  const normalizeWithAliases = (part) => {
    let value = part
    for (const alias of aliases) {
      const key = normalizeIdentityText(alias && alias.name)
      value = normalizeAliasTag(value, alias)
      if (!expanded.has(key)) {
        const grown = expandGenericAliasTag(value, alias)
        if (grown !== value) expanded.add(key)
        value = grown
      }
      if (normalizeIdentityText(value).includes(normalizeIdentityText(alias && alias.description))) expanded.add(key)
    }
    return animaTag(value)
  }
  const visibleAppearance = includeAppearance
    ? filterAppearanceByVisibility(item.appearance, item.outfit)
    : []
  const signatureAppearance = visibleAppearance
    .filter((tag) => signaturePriority(tag) < 99)
    .sort((a, b) => signaturePriority(a) - signaturePriority(b))
  const ordinaryAppearance = visibleAppearance.filter((tag) => signaturePriority(tag) >= 99)
  // The subject's prose noun ("a half-elf woman") and proper name are
  // deliberately absent: neither is a booru tag, and the count tag in the
  // header already carries the subject count.
  const coreTags = uniqueStrings([
    ...signatureAppearance,
    ...ordinaryAppearance,
    ...item.outfit,
    ...poses,
    ...item.expression,
    ...actions,
  ].map(normalizeWithAliases).filter(Boolean))
  // In multi-subject scenes the ownership sentence already carries the proper
  // name, so keep prompts short and avoid repeating prop descriptors. Solo
  // scenes retain a compact prop fallback only when the core tags did not
  // already mention the named prop or its descriptor.
  const aliasTags = aliases.flatMap((alias) => {
    if (descriptors.length > 1) return []
    const aliasName = normalizeIdentityText(alias && alias.name)
    const aliasDesc = normalizeIdentityText(alias && alias.description)
    const alreadyPresent = coreTags.some((tag) => {
      const value = normalizeIdentityText(tag)
      return (aliasName && value.includes(aliasName)) || (aliasDesc && value.includes(aliasDesc))
    })
    // Description only — the proper name is meaningless to the image model.
    return alreadyPresent ? [] : [alias.description]
  })
  return uniqueStrings([
    ...coreTags,
    ...aliasTags.map(normalizeWithAliases).filter(Boolean),
  ]).join(', ')
}

// --- natural-language identity binding -------------------------------------
//
// Anima's own guidance for multi-character prompts is explicit: "Name a
// character, then describe their basic appearance... If you just list off
// character names with no description of appearance, the model can get
// confused." A comma-separated run that merely *starts* with a name
// ("Ilsa, silver hair, round glasses, ...") gives the text encoder nothing to
// bind with — the name is an unknown token and every trait after it is loose
// in the same tag soup as the other subject's traits. These helpers emit real
// sentences instead, which is the documented mechanism for ownership.

const BODY_TRAIT_RE = /\b(?:eyes?|mouth|brows?|teeth|tongue|blush|tears|fangs?|lips?|cheeks?|ears?|hair)\b/

// --- staging cues and non-clothing ------------------------------------------
//
// The schema asks the parser to put POV cues ("viewer hands visible", "face
// out of frame") into the persona's pose or action, because that is where it
// can see them. They are camera directions about the FRAME, not descriptions
// of a body, and rendering them as character traits is how a prompt ends up
// describing a viewer's hand and the character's own hand in the same clause —
// which is a request for an extra limb. They are consumed here: they still
// prove the shot is POV, and they never reach the caption.
// Matching runs on normalised text, where punctuation becomes a space, so
// "viewer's hands" arrives as "viewer s hands".
const POV_CUE_RE = /\b(?:viewer(?:\s+s)?\s+(?:hands?|arms?|body|fingers?|pov)|hands?\s+in\s+(?:the\s+)?foreground|hands?\s+(?:only|visible\s+only)|face\s+turned\s+away|only\s+(?:the\s+)?hands?\s+visible|face\s+out\s+of\s+frame|faceless|first[\s-]person|pov\s+body|body\s+only|forearms?\s+only|lower\s+body\s+only|off[\s-]screen\s+face|head\s+out\s+of\s+frame|cropped\s+head)\b/i

function isPovStagingCue(value) {
  const text = normalizeIdentityText(value)
  if (!text) return false
  return POV_CUE_RE.test(text)
}

// Clothing is a garment. A body part is not clothing, and neither is an
// action. "wearing a bare hand" is a phantom limb waiting to happen.
const GARMENT_RE = /\b(?:shirt|blouse|dress|skirt|trousers|pants|jeans|shorts|coat|jacket|cloak|cape|capelet|robe|gown|tunic|sweater|hoodie|vest|corset|bodice|apron|uniform|armou?r|helmet|hood|hat|cap|scarf|tie|belt|glove|gloves|mitten|sock|socks|stocking|stockings|pantyhose|tights|shoe|shoes|boot|boots|sandal|sandals|heels|lingerie|bra|panties|underwear|briefs|thong|swimsuit|bikini|kimono|yukata|haori|sash|obi|collar|choker|necklace|earring|earrings|bracelet|ring|glasses|goggles|mask|veil|crown|tiara|headband|ribbon|bow|jewelry|clothes|clothing|outfit|garment|leotard|bodysuit|overalls|jumpsuit|nightgown|pyjamas|pajamas|towel|blanket|harness|strap|straps)\b/i

// Bare-state words are legitimate outfit values even though no garment is named.
const BARE_STATE_RE = /^(?:nude|naked|topless|bottomless|shirtless|barefoot|bare feet|bare legs|bare thighs|bare shoulders|undressed|dressed|clothed|fully clothed|partially clothed|disheveled clothes|torn clothes|open shirt|wet clothes|bloody clothes)$/i

const BODY_PART_RE = /\b(?:hand|hands|thumb|finger|fingers|palm|wrist|arm|arms|forearm|forearms|upper arm|elbow|shoulder|shoulders|jaw|chin|face|cheek|cheeks|eye|eyes|mouth|lip|lips|neck|throat|chest|torso|abdomen|stomach|back|waist|hip|hips|thigh|thighs|calf|shin|knee|knees|leg|legs|ankle|foot|feet|toe|toes|head|forehead|hair|skin|tail|ear|ears|muzzle|snout|fur|claw|claws|paw|paws|wound|scar|bite|bruise)\b/i

// True when an outfit entry does not actually describe something worn.
// A condition is not a garment. "blood-covered" describes the wearer, and
// rendering it as "wearing blood-covered" asks the model for a thing.
const WORN_CONDITION_RE = /^(?:blood[- ]?(?:covered|soaked|stained)|bloodied|bloody|soaked|drenched|muddy|dirty|filthy|singed|burnt|scorched|frayed|ragged|tattered|torn|ruined|wet|damp|dusty|ash[- ]?covered)$/i

function isNotClothing(value) {
  const text = normalizeIdentityText(value)
  if (!text) return true
  if (BARE_STATE_RE.test(text)) return false
  if (WORN_CONDITION_RE.test(text)) return true
  if (GARMENT_RE.test(text)) return false
  if (isPovStagingCue(text)) return true
  if (BODY_PART_RE.test(text)) return true
  // A verb phrase is an action, not a garment.
  if (/\w+ing\b/.test(text) && !/^(?:matching|flowing|clinging|form fitting)/.test(text)) return true
  return false
}

// Build traits are adjectives — "a slender half-elf woman", never "…with
// slender". Everything else is treated as a noun phrase for the "with" list.
const BUILD_ADJECTIVE_RE = /^(?:extremely |very |slightly |incredibly )?(?:slender|slim|thin|petite|curvy|voluptuous|muscular|athletic|toned|lean|stocky|chubby|plump|tall|short|large|small|huge|massive|enormous|towering|hulking|burly|brawny|bulky|broad|giant|gigantic|young|old|androgynous|freckled|pale|tanned|dark-skinned|light-skinned)$/

// English orders adjectives size → age → build; "a tall muscular man", not
// "a muscular tall man".
const ADJECTIVE_ORDER = ['tall', 'short', 'large', 'small', 'petite', 'young', 'old']
function orderAdjectives(list) {
  return [...list].sort((a, b) => {
    const rank = (value) => {
      const index = ADJECTIVE_ORDER.findIndex((word) => new RegExp(`\\b${word}\\b`).test(value))
      return index === -1 ? ADJECTIVE_ORDER.length : index
    }
    return rank(a) - rank(b)
  })
}

// Mass and inherently plural nouns take no article.
const NO_ARTICLE_RE = /\b(?:hair|skin|stubble|fur|makeup|armou?r|clothing|lingerie|jewelry|hosiery|underwear|nudity|bark|blood|moss|dust|smoke|mist|sweat|dirt|grime|ash|flesh|foliage|bone|sand|mud|fog)\b/
// Irregular plurals take no article either, and "a bared teeth" is the tell
// that a purely /s$/ test is not enough.
const IRREGULAR_PLURAL_HEADS = new Set(['teeth', 'feet', 'men', 'women', 'children', 'mice', 'geese', 'oxen', 'people'])
const SINGULAR_S_WORDS = new Set(['dress', 'glass', 'harness', 'corset', 'bodice', 'blouse', 'chemise'])

function isPluralPhrase(text) {
  const head = String(text || '').trim().split(/\s+/).pop() || ''
  if (IRREGULAR_PLURAL_HEADS.has(head.toLowerCase())) return true
  if (!/s$/i.test(head)) return false
  return !SINGULAR_S_WORDS.has(head.toLowerCase())
}

// "shoulder tattoo" → "a shoulder tattoo"; "silver hair" → "silver hair";
// "round glasses" → "round glasses"; "open mouth" → "an open mouth".
function withArticle(tag) {
  const value = animaTag(tag)
  if (!value) return ''
  if (/^(?:a|an|the)\s+/.test(value)) return value
  if (NO_ARTICLE_RE.test(value) || isPluralPhrase(value)) return value
  return `${articleFor(value)} ${value}`
}

function withArticleList(tags) {
  return uniqueStrings((tags || []).map(withArticle).filter(Boolean))
}

// Proper names stand alone; descriptive labels take an article.
function displayName(item, lead = true) {
  const anchor = String((item && item.anchor) || '').trim()
  if (!anchor) return lead ? 'The subject' : 'the subject'
  if (item && item.named) return sentenceName(anchor)
  return `${lead ? 'The' : 'the'} ${anchor.toLowerCase()}`
}

// Trait nouns take "a/an" and belong in the "with …" list. A bare one-word
// trait that names no body part ("hooded", "tall") is an adjective and must
// not become "a hooded".
const TRAIT_NOUN_RE = /\b(?:hair|eyes?|ears?|mouth|lips?|teeth|fangs?|tongue|nose|brows?|beard|stubble|skin|freckles?|moles?|scars?|tattoos?|piercings?|glasses|goggles|monocle|eyepatch|horns?|wings?|tails?|claws?|markings?|birthmarks?|build|figure|frame|fur|pelt|snout|muzzle|mane|paws?|hooves|whiskers|scales|feathers|antlers|talons?|paw pads|wrinkles?|dimples?|lashes|bun|braids?|ponytails?|twintails?|bangs)\b/

// Nonhuman-form descriptors that really are adjectives, so a transformation
// state does not compile to "a digitigrade werewolf with a quadruped build".
const FORM_ADJECTIVE_RE = /^(?:digitigrade|quadruped|bipedal|furred|scaled|feathered|winged|horned|clawed|fanged|hulking|towering|monstrous|bestial|shaggy|sleek)$/

function splitTraitWords(tags) {
  const builds = []      // "slender"  → "a slender build"
  const modifiers = []   // "hooded"   → "a hooded cloaked stranger"
  const nouns = []       // "silver hair" → "with silver hair"
  for (const tag of tags) {
    if (BUILD_ADJECTIVE_RE.test(tag)) { builds.push(tag); continue }
    if (FORM_ADJECTIVE_RE.test(tag)) { modifiers.push(tag); continue }
    if (TRAIT_NOUN_RE.test(tag)) { nouns.push(tag); continue }
    if (!/\s/.test(tag)) { modifiers.push(tag); continue }
    nouns.push(tag)
  }
  return { builds, modifiers, nouns }
}

function subjectNounPhrase(item) {
  const noun = normalizeVisualPhrase(item.noun || '').toLowerCase()
  if (noun) return /^(?:a|an|the)\s+/.test(noun) ? noun : `${articleFor(noun)} ${noun}`
  const count = animaTag(item.countTag)
  if (/girl/.test(count)) return 'a girl'
  if (/boy/.test(count)) return 'a boy'
  if (/woman|female/.test(count)) return 'a woman'
  if (/man|male/.test(count)) return 'a man'
  return 'a character'
}

// Sorts expression/action tags into the three sentence frames that read
// naturally: "is laughing", "has an open mouth", "looks serious".
function stateClauses(tags) {
  const doing = []
  const having = []
  const looking = []
  for (const tag of animaTagList(tags)) {
    if (/\w+ing\b/.test(tag)) doing.push(tag)
    else if (BODY_TRAIT_RE.test(tag)) having.push(tag)
    else looking.push(tag)
  }
  return { doing, having, looking }
}

// Anima confuses easily when a two-character prompt runs long (extra limbs,
// clothes migrating between subjects), so the caption budget is deliberately
// tight: two sentences per subject, at most MAX_CAPTION_TRAITS appearance
// traits ordered so the bleed-prone signature ones survive the cut.
const MAX_CAPTION_TRAITS = 7

// A pose that names another subject is a relation in the wrong field. The
// relation sentence already carries that geometry, bound to both names, so
// rendering the pose too states the same contact twice — and the second
// telling never words the contact point quite the same way.

// Every name a subject might be called in text the parser produced.
function subjectNameForms(item) {
  return uniqueStrings([item && item.anchor, item && item.sourceAnchor].filter(Boolean))
}

function textNamesSubject(text, other) {
  const value = normalizeIdentityText(text)
  if (!value) return false
  return subjectNameForms(other).some((name) => {
    const anchor = normalizeIdentityText(name)
    if (anchor.length < 3) return false
    return anchor.split(/\s+/).some((word) =>
      word.length >= 4 && new RegExp(`\\b${escapeRegExp(word)}\\b`).test(value))
  })
}

function poseBelongsToRelation(pose, item, scene, descriptors) {
  const text = normalizeIdentityText(pose)
  if (!text) return false
  const hasRelation = (scene.relations || []).some((relation) => relation.actor === item.subject.ref && relation.target)
  if (!hasRelation) return false
  const namesAnother = (descriptors || []).some((other) =>
    other && other.subject.ref !== item.subject.ref && textNamesSubject(text, other))
  if (!namesAnother) return false
  // Only drop when a relation actually carries THIS pose's action. Dropping on
  // the mere existence of a relation deleted "pinning the alpha's muzzle"
  // because a bland "faces" relation existed elsewhere — and the pose was the
  // only place that hold was described.
  return (scene.relations || []).some((relation) =>
    relation.actor === item.subject.ref && verbStemsMatch(relation.action, text))
}

function subjectIdentitySentences(item, scene, descriptors, profiles = null) {
  const name = displayName(item)

  // One appositive caption phrase per subject, not three narrative sentences.
  // "Sovi is an elf woman with… Sovi wears… Sovi is standing and laughing."
  // spends a third of its length on copulas and connectives that carry no
  // visual information — and on a model that degrades with prompt length that
  // is pure cost. An image caption reads
  // "Sovi, an elf woman with…, wearing…, standing, laughing."
  const nounPhrase = subjectNounPhrase(item)
  const visible = animaTagList(filterAppearanceByVisibility(item.appearance, item.outfit))
    .filter((tag) => !normalizeIdentityText(nounPhrase).includes(normalizeIdentityText(tag)))
  const { builds, modifiers, nouns } = splitTraitWords(visible)
  const orderedNouns = [...nouns].sort((a, b) => signaturePriority(a) - signaturePriority(b))
  // Identity traits are never traded away for incidental ones. Sorting puts
  // them first, but a subject with several could still crowd itself out, so the
  // cap is filled from identity traits before anything else is considered.
  const identity = orderedNouns.filter((tag) => IDENTITY_TRAIT_RE.test(animaTag(tag)))
  const rest = orderedNouns.filter((tag) => !IDENTITY_TRAIT_RE.test(animaTag(tag)))
  const chosen = [...identity.slice(0, MAX_CAPTION_TRAITS), ...rest].slice(0, MAX_CAPTION_TRAITS)
  const cut = orderedNouns.filter((tag) => !chosen.includes(tag))
  if (cut.length) {
    trace(`caption traits · ${item.anchor || item.subject.ref}`, 'applied',
      `kept ${chosen.length} of ${orderedNouns.length}; dropped ${cut.join(', ')}`)
  }
  const traits = withArticleList(chosen)
  // Size leads, because it is read first and because it is the property most
  // often expressed across several tags at once.
  const leadModifiers = uniqueStrings([...builds, ...modifiers]).slice(0, 3)
  if (builds.length) {
    trace(`build · ${item.anchor || item.subject.ref}`, 'applied',
      `${builds.join(', ')} — cumulative size words, previously collected and discarded`)
  }

  // An unprofiled subject's label doubles as its noun ("cloaked stranger"), so
  // the appositive is dropped rather than repeating it.
  const redundantNoun = normalizeIdentityText(nounPhrase).includes(normalizeIdentityText(item.anchor))
  const described = leadModifiers.length
    ? `${articleFor(leadModifiers[0])} ${leadModifiers.join(', ')} ${nounPhrase.replace(/^(?:a|an|the)\s+/, '')}`
    : nounPhrase

  // The prop sits second, right after the name — "Sovi, holding a staff, an elf
  // femboy with…". Two words from its owner rather than forty, with no other
  // character named in between.
  const held = heldObjectsFor(item)
  const holdClause = held.objects.length ? `holding ${naturalList(held.objects.map(withArticle))}` : ''
  if (holdClause) {
    trace(`held object · ${item.anchor || item.subject.ref}`, 'applied',
      `${held.objects.join(', ')} bound to the name; ${held.consumed.length} loose mention(s) consumed`)
  }

  // Clothing binds the same way a held object does — by sitting next to the
  // name. In a solo scene the garment is a tag beside the count tag and holds
  // fine; in a multi-subject caption it was forty words downstream, which on a
  // model whose prior says 1boy wears trousers is not enough to win.
  const wornEarly = []
  for (const value of item.outfit || []) {
    const tag = animaTag(value)
    if (!tag) continue
    if (/^(?:nude|naked|topless|bottomless|shirtless|barefoot|bare feet|bare legs|bare thighs|dressed|clothed|undressed|fully clothed|partially clothed)$/.test(tag)) continue
    wornEarly.push(tag)
  }
  const wearClause = wornEarly.length ? `in ${naturalList(withArticleList(wornEarly.slice(0, 2)))}` : ''
  const leadExtras = [holdClause, wearClause].filter(Boolean)

  const parts = []
  if (redundantNoun) {
    parts.push(leadExtras.length ? `${name}, ${leadExtras.join(', ')}` : name)
    if (leadModifiers.length) parts.push(naturalList(leadModifiers))
    if (traits.length) parts.push(`with ${naturalList(traits)}`)
  } else {
    const lead = leadExtras.length ? `${name}, ${leadExtras.join(', ')}` : name
    parts.push(traits.length ? `${lead}, ${described} with ${naturalList(traits)}` : `${lead}, ${described}`)
  }

  const clothes = []
  const stateWords = []
  for (const value of item.outfit || []) {
    const tag = animaTag(value)
    if (!tag) continue
    if (/^(?:nude|naked|topless|bottomless|shirtless|barefoot|bare feet|bare legs|bare thighs|dressed|clothed|undressed|fully clothed|partially clothed)$/.test(tag)) stateWords.push(tag)
    else clothes.push(tag)
  }
  const consumedHold = new Set(held.consumed)
  const pose = poseClause({
    ...item,
    pose: item.pose.filter((entry) =>
      !consumedHold.has(entry) && !poseBelongsToRelation(entry, item, scene, descriptors)),
  }, scene)
  const actions = item.action
    .filter((part) => !consumedHold.has(part))
    .filter((part) => !actionDuplicatesRelation(part, item.subject.ref, scene.relations))
    .map((part) => resolveCrossSubjectPronouns(part, item, descriptors))
    .map((part) => applyPromptNames(part, profiles))
  const raw = stateClauses([
    ...item.expression.filter((tag) => !/\beye contact\b/i.test(String(tag))),
    ...actions,
  ])
  // stateClauses lowercases through animaTagList, which turns a substituted
  // name back into a common noun — "watching price". Restore it afterwards.
  const doing = raw.doing.map((part) => applyPromptNames(part, profiles))
  const having = raw.having.map((part) => applyPromptNames(part, profiles))
  const looking = raw.looking.map((part) => applyPromptNames(part, profiles))

  // Anything beyond the two garments already bound to the name.
  const remainingClothes = clothes.filter((tag) => !wornEarly.slice(0, 2).includes(animaTag(tag)))
  if (remainingClothes.length) parts.push(`wearing ${naturalList(withArticleList(remainingClothes))}`)
  const bare = uniqueStrings(stateWords)
  if (bare.length) parts.push(naturalList(bare))
  if (pose) parts.push(pose)
  if (doing.length) parts.push(naturalList(doing))
  if (looking.length) parts.push(naturalList(looking))
  if (having.length) parts.push(naturalList(withArticleList(having)))

  const caption = parts.filter(Boolean).join(', ').replace(/\s{2,}/g, ' ').trim()
  return caption ? [caption + '.'] : []
}


// "pinning" stems to "pinn" and "pins" to "pin", so an equality test says they
// are different verbs. Comparing on the shorter stem's length says they are the
// same, which is what a reader would say.
function verbStem(text) {
  const first = String(text || '').trim().split(/\s+/)[0] || ''
  return first.replace(/(?:ing|es|ed|s)$/, '')
}

function verbStemsMatch(a, b) {
  const sa = verbStem(a)
  const sb = verbStem(b)
  const min = Math.min(sa.length, sb.length)
  if (min < 3) return false
  return sa.slice(0, min) === sb.slice(0, min)
}


// --- one geometry per statement ----------------------------------------------
// "Price is performing fellatio on Jason" fixes a geometry: mouth to genitals.
// Appending ", gagging as she takes him deep" adds a SECOND spatial claim about
// the same contact, and its object is a whole person rather than a body part, so
// "deep" has nothing to attach to. The model renders both and averages them —
// observed result: correct anatomy on one subject, mouth at the other's stomach,
// and geometry passing through a torso.
//
// A trailing clause that re-states the contact is removed. One that only adds an
// expression or a head angle is kept: "chin tipped up" cannot compete with a
// geometry, "takes him deep" is nothing but one.
const COMPETING_GEOMETRY_RE = new RegExp([
  '\\b(?:deep|deeper|deeply|balls deep|to the hilt|all the way)\\b',
  '\\b(?:tak(?:es|ing)|swallow(?:s|ing)|engulf(?:s|ing)|impal(?:es|ing)|sheath(?:es|ing))\\s+\\w+',
  '\\b(?:buried|burying|sunk|sinking|driv(?:es|ing)|thrust(?:s|ing)|slid(?:es|ing))\\b',
  '\\b(?:inside|into|down)\\s+(?:him|her|them|his|hers|their)\\b',
].join('|'), 'i')

function stripCompetingGeometry(statement) {
  const text = String(statement || '').trim()
  if (!text) return { statement: text, removed: '' }
  const cut = text.indexOf(',')
  if (cut < 0) return { statement: text, removed: '' }
  const head = text.slice(0, cut).trim()
  const tail = text.slice(cut + 1).trim()
  if (!head || !tail || !COMPETING_GEOMETRY_RE.test(tail)) return { statement: text, removed: '' }
  // Only when the head already names an act; otherwise the tail may BE the act.
  // Three words is the floor — "Price rides Jason" is a complete act statement.
  if (head.split(/\s+/).length < 3) return { statement: text, removed: '' }
  return { statement: head.replace(/[,;:]+$/, ''), removed: tail }
}


// --- which way they face ------------------------------------------------------
// Two characters kept rendering facing the SAME way — one's back to the other —
// when the scene had them facing each other. Nothing in the prompt said which
// way anybody was pointing.
//
// Orientation is a property of the pair, not of one person, so it belongs in the
// shared tag run. Put "eye contact" in a subject's expression list and it lands
// in that subject's prose clause instead, where it also picks up an article:
// "defiant grin, an eye contact".
const FACING_RELATION_RE = new RegExp([
  '\\bfac(?:es|ing)\\b', '\\bkiss(?:es|ing)\\b', '\\blick(?:s|ing)\\b',
  '\\bsuck(?:s|ing)\\b', '\\bfellatio\\b', '\\bblow(?:s|job)\\b',
  '\\blook(?:s|ing) (?:at|up at|down at)\\b', '\\bstar(?:es|ing) at\\b',
  '\\bglar(?:es|ing) at\\b', '\\bstraddl(?:es|ing)\\b', '\\bembrac(?:es|ing)\\b',
  '\\bhugg?(?:s|ing)\\b', '\\bhold(?:s|ing) the (?:face|chin|cheek)\\b',
  '\\bspeak(?:s|ing) to\\b', '\\btalk(?:s|ing) to\\b', '\\bconfront(?:s|ing)\\b',
  '\\bcup(?:s|ping) the (?:face|cheek|chin)\\b',
].join('|'), 'i')

const AWAY_RELATION_RE = /\bfrom behind\b|\bbehind\b|\bturn(?:s|ing) away\b|\bback to\b|\bbent over\b/i
const LOW_POSTURE_RE = /\b(?:kneel\w*|sit\w*|seated|crouch\w*|squat\w*|lying|on (?:all fours|knees)|prone)\b/i
const TALL_POSTURE_RE = /\b(?:stand\w*|upright|towering|looming)\b/i

function orientationTags(scene, descriptors) {
  if (!descriptors || descriptors.length < 2) return { tags: [], note: '' }
  const tags = []
  const why = []

  const relationText = (scene.relations || [])
    .map((relation) => `${relation.action || ''} ${(relation.details || []).join(' ')}`).join(' ')
  const everything = [relationText, scene.sceneStatement || '', scene.coreAction || ''].join(' ')

  // An explicit "from behind" beats an inferred facing — the parser said so.
  const facesAway = AWAY_RELATION_RE.test(everything)
  const facesEach = FACING_RELATION_RE.test(everything)

  if (facesEach && !facesAway) {
    tags.push('face-to-face', 'facing another')
    why.push('a relation puts them front to front')
  }

  // "eye contact" wherever the parser filed it — expression, detail, action.
  const mentionsEyeContact = descriptors.some((item) =>
    [...(item.expression || []), ...(item.action || []), ...(item.pose || [])]
      .some((value) => /\beye contact\b/i.test(String(value)))) ||
    /\beye contact\b/i.test(everything)
  if (mentionsEyeContact && !facesAway) {
    tags.push('eye contact', 'looking at another')
    why.push('eye contact was stated')
  }

  // One low, one tall: the kneeler looks up and the pair has a height gap.
  const postures = descriptors.map((item) => (item.pose || []).join(' '))
  const someLow = postures.some((text) => LOW_POSTURE_RE.test(text))
  const someTall = postures.some((text) => TALL_POSTURE_RE.test(text))
  if (someLow && someTall) {
    tags.push('height difference')
    if (!facesAway) tags.push('looking up')
    why.push('one is low and one is upright')
  }

  return { tags: uniqueStrings(tags), note: why.join('; ') }
}

// A relation action ending in a body part plus "of" collides with the target's
// name: "drags tongue across the head of" + "Jason" becomes "the head of Jason".
// The anatomical reading and the person's-head reading are both available and
// the model picks the wrong one.
// Only the nouns that are genuinely ambiguous between a person's body and the
// anatomy being described. "in front of" and "the side of" are spatial and
// perfectly clear; "the head of" is not.
const AMBIGUOUS_POSSESSIVE_RE = /\b(head|tip|base|shaft|underside|length|crown)\s+of\s*$/i

function relationSentence(relation, byRef) {
  const actor = byRef.get(relation.actor)
  const target = relation.target ? byRef.get(relation.target) : null
  const actorName = actor ? displayName(actor, true) : sentenceName(relation.actor)
  const targetName = target ? displayName(target, false) : ''
  const action = normalizeVisualPhrase(relation.action)
  if (!action) return ''
  // "drags tongue across the head of" + "Jason" renders as "the head of Jason",
  // which reads as HIS head. An anatomical noun before a trailing "of" collides
  // with the person's name and the model draws the wrong thing entirely.
  // We already know what the referent is: the target's own anatomy is on the
  // descriptor. "the head of" + "Jason" becomes "the head of Jason's penis"
  // rather than a sentence about his head.
  const ambiguous = AMBIGUOUS_POSSESSIVE_RE.exec(action)
  let sentence = `${actorName} ${action}`
  if (targetName && !sentence.toLowerCase().includes(targetName.toLowerCase())) {
    const anatomy = ambiguous && target ? (target.anatomy || []).map(animaTag).find(Boolean) : ''
    if (ambiguous && anatomy) {
      sentence += ` ${targetName}'s ${anatomy}`
    } else if (ambiguous) {
      // No anatomy to name, so the sentence would assert the wrong body part.
      // Drop the dangling "of" and let the relation stay unattached rather than
      // attached to the wrong thing.
      sentence = `${actorName} ${action.replace(/\s+of\s*$/i, '')}`
      trace('relation wording', 'warn',
        `"${action}${targetName ? ' ' + targetName : ''}" would read as ${targetName || 'the target'}'s ${ambiguous[1]}; no anatomy is available to name, so the target was left out`)
    } else {
      sentence += ` ${targetName}`
    }
  }

  // Details are the modifiers that make a hold specific. Appended at the END
  // they sit next to the TARGET's name, so "eye contact held tongue out" gave
  // Jason the tongue. They describe the actor, so they belong beside the actor.
  const extras = (relation.details || []).map(normalizeVisualPhrase).filter(Boolean).slice(0, 2)
  if (extras.length) {
    sentence = sentence.replace(actorName, `${actorName}, ${naturalList(extras)},`)
  }
  return sentence.replace(/\s+([,.])/g, '$1').replace(/\s{2,}/g, ' ').trim() + '.'
}

const SEXUAL_ACT_RE = /\b(?:sex|anal|vaginal|oral|blowjob|fellatio|cunnilingus|handjob|fingering|penetrat\w*|orgasm\w*|masturbat\w*|cum|climax\w*|thrust\w*|riding|grinding)\b/i

// The scene statement is the thesis sentence of the caption: "who is doing
// what", stated plainly, first. Field observation: adding exactly this kind
// of sentence in front of the caption block turned a muddled two-character
// image into a nearly perfect one. The parser writes it; this resolves,
// guards, and — for solo scenes with no statement — synthesizes it from
// core_action.
function resolveSceneStatement(scene, descriptors) {
  let statement = normalizeVisualPhrase(scene.sceneStatement || '')
  // A sexual act named in a scene the parser itself rated safe/sensitive is a
  // contradiction; the safety tag wins and the statement is dropped.
  if (statement && !['nsfw', 'explicit'].includes(scene.safety) && SEXUAL_ACT_RE.test(statement)) {
    spindle.log.warn('[lumidraw] scene statement dropped: names a sexual act in a ' + (scene.safety || 'unrated') + ' scene.')
    statement = ''
  }
  // Every scene deserves its thesis sentence. When one is missing — never
  // written, or dropped just above — it is rebuilt from the names present and
  // the core action, so a multi-character scene never silently loses the one
  // line that says what is happening.
  if (!statement) {
    const core = normalizeVisualPhrase(scene.coreAction).toLowerCase()
    const names = descriptors.map((item) => displayName(item, true))
    if (core && names.length === 1) {
      statement = `${names[0]} is ${core}`
    } else if (core && names.length > 1) {
      statement = `${naturalList(names)} — ${core}`
    } else if (names.length > 1) {
      // No action offered either: at minimum say who is in frame together.
      statement = `${naturalList(names)} together in one scene`
    }
    if (statement) spindle.log.info('[lumidraw] scene statement rebuilt from the scene: ' + statement)
  }
  if (!statement) return ''
  statement = statement.charAt(0).toUpperCase() + statement.slice(1)
  if (!/[.!?]$/.test(statement)) statement += '.'
  return statement
}

// A relation sentence that just restates the scene statement's action buys
// length, not information.
function relationCoveredByStatement(relation, statement, byRef) {
  if (!statement) return false
  const action = comparableAction(relation.action)
  if (!action) return false
  const haystack = normalizeIdentityText(statement)
  // A shared verb with both subjects already named is coverage, even when the
  // contact point is worded differently. "pins ... head against the roots" and
  // "pins the muzzle of" are one grapple; described twice, they ask for two.
  const hayWords = haystack.split(/\s+/).filter(Boolean)
  const verbInStatement = hayWords.some((word) => verbStemsMatch(word, action))
  if (verbInStatement && byRef) {
    // One distinctive word from each name is enough. Requiring the whole anchor
    // meant "the alpha wolf" went unrecognised in a statement that had grounded
    // it to "the alpha fantasy wolf".
    const namePresent = (ref) => {
      const anchor = normalizeIdentityText(((byRef.get(ref) || {}).anchor) || '')
      if (!anchor) return false
      return anchor.split(/\s+/).some((word) => word.length >= 4 && hayWords.includes(word))
    }
    if (namePresent(relation.actor) && namePresent(relation.target)) return true
  }
  const words = action.split(/\s+/).filter((word) => word.length > 3)
  if (!words.length) return false
  const hits = words.filter((word) => haystack.includes(word)).length
  return hits / words.length >= 0.6
}

// Splits "@kantoku" style artist tags out of a free-text header so they can be
// placed in Anima's artist slot rather than wherever the user happened to type
// them. Returns { artists, rest }.
function splitArtistTags(headerText) {
  const artists = []
  const rest = []
  for (const part of String(headerText || '').split(',')) {
    const value = part.trim()
    if (!value) continue
    if (value.startsWith('@')) artists.push(value)
    else rest.push(value)
  }
  return { artists, rest: rest.join(', ') }
}

// --- setting continuity -----------------------------------------------------
//
// A location that appears in the prompt but nowhere in the story is the worst
// class of failure: the image is confidently wrong and the reader knows it.
// An uncertain parser will fill a required field with whatever is nearest to
// hand, and one invented "kitchen" ruins an image that was otherwise correct.
//
// So a setting tag is trusted only when the text supports it. When nothing in
// the passage or the recent context backs ANY of the offered tags, the scene
// keeps the location it already had — a story stays where it was unless it
// says otherwise. This mirrors the field-level inheritance Inlay Illustrator
// uses for character attributes, applied to place.

const GENERIC_INDOOR_SETTING_RE = /^(?:kitchen|bedroom|bathroom|living room|office|hallway|corridor|dining room|classroom|bar|cafe|restaurant|apartment|house|room|indoors|interior)$/

// Place words can ride into a scene through ANY field, not just `setting`.
// Observed in the field: the parser never named a kitchen as the location — it
// wrote "kitchen lighting" three times across three images, and the location
// arrived through the lighting field, unchallenged.
const PLACE_WORD_RE = /\b(?:kitchen|bedroom|bathroom|bedchamber|living room|office|study|hallway|corridor|dining room|classroom|library|tavern|inn|bar|pub|cafe|restaurant|shop|store|market|apartment|house|cabin|cottage|castle|dungeon|cave|temple|church|hospital|laboratory|lab|garage|basement|attic|balcony|rooftop|street|alley|forest|grove|woods|beach|desert|mountain|garden|courtyard|stable|barn|ship|deck|train|car|elevator|shower|pool|arena|stage|studio)\b/g

function placeWordsIn(value) {
  PLACE_WORD_RE.lastIndex = 0
  return uniqueStrings(String(normalizeIdentityText(value)).match(PLACE_WORD_RE) || [])
}

// A tag is supported when its distinctive words appear in the source text.
// Any PLACE word it contains must be supported specifically: "kitchen
// lighting" must not pass merely because the passage happens to say
// "mushrooms lighting the moss".
function settingTagSupported(tag, text) {
  const value = normalizeIdentityText(tag)
  if (!value) return false
  const haystack = normalizeIdentityText(text)
  const places = placeWordsIn(value)
  if (places.length && !places.every((place) => haystack.includes(place))) return false
  const words = value.split(/\s+/).filter((word) => word.length >= 4)
  if (!words.length) return haystack.includes(value)
  return words.some((word) => haystack.includes(word))
}

// Drops atmosphere tags that smuggle in an unsupported location. The whole tag
// goes rather than just the place word — "kitchen lighting" minus "kitchen" is
// not a lighting instruction, and the genuine lighting tags survive alongside.
function scrubUnsupportedPlaces(tags, text, field) {
  const haystack = normalizeIdentityText(text)
  const kept = []
  const dropped = []
  for (const tag of tags || []) {
    const places = placeWordsIn(tag)
    if (places.length && !places.every((place) => haystack.includes(place))) dropped.push(tag)
    else kept.push(tag)
  }
  return { tags: kept, dropped, field }
}

function reconcileSetting(settingTags, sourceText, rememberedSetting) {
  const tags = animaTagList(settingTags)
  if (!tags.length) {
    return { setting: animaTagList(rememberedSetting || []), note: rememberedSetting && rememberedSetting.length ? 'no setting offered; kept the established location' : '' }
  }
  const supported = tags.filter((tag) => settingTagSupported(tag, sourceText))
  if (supported.length) {
    // Some of it is grounded. Drop only the generic rooms that nothing backs —
    // those are the invented ones.
    const kept = tags.filter((tag) => supported.includes(tag) || !GENERIC_INDOOR_SETTING_RE.test(tag))
    const dropped = tags.filter((tag) => !kept.includes(tag))
    return {
      setting: kept,
      note: dropped.length ? `dropped unsupported generic setting: ${dropped.join(', ')}` : '',
    }
  }
  // Nothing is grounded at all. Prefer the location the story already had.
  const remembered = animaTagList(rememberedSetting || [])
  if (remembered.length) {
    return { setting: remembered, note: `no offered setting was supported by the text (${tags.join(', ')}); kept the established location (${remembered.join(', ')})` }
  }
  return { setting: tags, note: '' }
}

// --- camera repair ----------------------------------------------------------
//
// A framing tag is a promise about what the viewer can see. When the parser
// picks "close-up" for a scene whose meaning lives at the hips, or "from
// behind" for a moment defined by a facial expression, the prompt contradicts
// itself and the image loses the thing it was drawn for. Instructing the
// parser to "choose framing wide enough" is unreliable; checking it here is
// deterministic.
//
// Framing tags are ordered by how much of the body they reveal. The scene's
// required regions are derived from what it actually depicts, and the framing
// is widened to the narrowest tag that shows all of them.

const FRAMING_LEVELS = [
  { level: 0, canonical: 'portrait', covers: ['face'],
    match: /^(?:portrait|close-up|closeup|extreme close-up|face focus|headshot|head shot)$/ },
  { level: 1, canonical: 'upper body', covers: ['face', 'upper', 'hands'],
    match: /^(?:upper body|bust|bust shot|chest up|chest-up)$/ },
  { level: 2, canonical: 'cowboy shot', covers: ['face', 'upper', 'hands', 'hips'],
    match: /^(?:cowboy shot|waist up|waist-up|medium shot|half body)$/ },
  { level: 3, canonical: 'full body', covers: ['face', 'upper', 'hands', 'hips', 'legs', 'feet'],
    match: /^(?:full body|full shot|wide shot|long shot|establishing shot|full-length)$/ },
]

const REGION_CUES = [
  ['face', /\b(?:smil\w*|laugh\w*|cry\w*|tears?|blush\w*|frown\w*|grin\w*|scowl\w*|snarl\w*|open mouth|closed eyes|half-closed eyes|eyes? \w+|looking at viewer|looking up|looking down|looking back|expression\w*|kiss\w*|bite[s]? the \w*(?:lip|jaw|neck)|gaze|glare|pout\w*|fang\w*|tongue)\b/],
  ['hands', /\b(?:hand|hands|finger|fingers|grip\w*|grab\w*|hold\w*|holding|clutch\w*|point\w*|touch\w*|wrist|palm|claw\w*|braces? (?:both )?hands?|reach\w*)\b/],
  ['hips', /\b(?:hip|hips|lap|waist|straddl\w*|grind\w*|thrust\w*|penetrat\w*|pelvis|groin|crotch|buttocks|ass|anal|vaginal|sex|riding|mounted|bent over|from behind)\b/],
  ['legs', /\b(?:leg|legs|thigh|thighs|knee|knees|kneel\w*|calf|calves|spread legs|crossed legs|sitting|squat\w*|crouch\w*)\b/],
  ['feet', /\b(?:foot|feet|barefoot|toes?|heel|heels|boots?|shoes?|sandals?|socks?|stockings?)\b/],
]

function framingLevelForTag(tag) {
  const value = animaTag(tag)
  return FRAMING_LEVELS.find((entry) => entry.match.test(value)) || null
}

// Everything the scene claims to show, as one searchable blob.
function sceneVisibleText(scene, descriptors) {
  const parts = []
  for (const item of descriptors) {
    parts.push(...(item.pose || []), ...(item.expression || []), ...(item.action || []),
      ...(item.outfit || []), ...(item.anatomy || []), item.subject.support || '')
  }
  for (const relation of scene.relations || []) {
    parts.push(relation.action || '', ...(relation.details || []))
  }
  parts.push(scene.coreAction || '', scene.sceneStatement || '')
  return normalizeIdentityText(parts.filter(Boolean).join(' '))
}

function requiredVisibleRegions(scene, descriptors) {
  const text = sceneVisibleText(scene, descriptors)
  const regions = new Set()
  for (const [region, cue] of REGION_CUES) {
    if (cue.test(text)) regions.add(region)
  }
  // Exposed anatomy is meaningless unless the frame reaches it.
  if (descriptors.some((item) => (item.anatomy || []).length) && ['nsfw', 'explicit'].includes(scene.safety)) {
    regions.add('hips')
  }
  return regions
}

// The camera stands in exactly one place. "from side, from behind, slightly
// above" is three cameras, and asking for three is how a shot ends up with no
// coherent viewpoint at all. Horizontal and vertical are independent, so one of
// each survives; within an axis the first stated wins, because that is the one
// the parser thought of first.
const VIEW_AXES = [
  ['horizontal', /^(?:from front|from side|from behind|from above and behind|straight-on|three-quarter view)$/],
  ['vertical', /^(?:from above|from below)$/],
]

function dropConflictingViewAngles(tags) {
  const seen = new Set()
  const dropped = []
  const kept = []
  for (const tag of tags) {
    // Compare canonical forms: the parser writes "side view", the vocabulary
    // later rewrites it to "from side", and checking before that rewrite let
    // "side view" and "from behind" both survive as one horizontal angle each.
    const raw = animaTag(tag)
    const resolved = resolveBooruTag(raw)
    const value = resolved.tag || raw
    const axis = VIEW_AXES.find(([, match]) => match.test(value))
    if (!axis) { kept.push(tag); continue }
    if (seen.has(axis[0])) { dropped.push(tag); continue }
    seen.add(axis[0])
    kept.push(tag)
  }
  return { kept, dropped }
}

// Camera is the one field where a closed list is honest. Setting and outfit are
// open-ended — a phrase the vocabulary does not know may still be a real thing the
// caption should say. Framing is not like that: there are about fifteen words the
// model was trained on, and anything else is a guess dressed as direction. Demoting
// "dynamic angle" to the caption spends caption space on a phrase that means
// nothing to the model, so it is dropped outright instead.
const CAMERA_VOCAB = new Set([
  'portrait', 'close-up', 'upper body', 'cowboy shot', 'full body', 'wide shot', 'very wide shot',
  'from above', 'from below', 'from side', 'from behind', 'from front', 'straight-on',
  'dutch angle', 'three-quarter view', 'profile', 'pov',
  'depth of field', 'foreshortening', 'perspective', 'fisheye',
])

function keepRealCameraTags(cameraTags) {
  const kept = []
  const dropped = []
  for (const tag of Array.isArray(cameraTags) ? cameraTags : []) {
    const value = animaTag(tag)
    if (!value) continue
    if (CAMERA_VOCAB.has(value)) kept.push(value)
    else dropped.push(value)
  }
  return { kept: uniqueStrings(kept), dropped: uniqueStrings(dropped) }
}

function repairCameraTags(cameraTags, scene, descriptors) {
  const required = requiredVisibleRegions(scene, descriptors)
  const real = keepRealCameraTags(cameraTags)
  const angles = dropConflictingViewAngles(real.kept)
  const preNotes = []
  if (real.dropped.length) {
    preNotes.push(`dropped invented camera tag(s) ${real.dropped.join(', ')} — not words this model was trained on`)
  }
  if (angles.dropped.length) {
    preNotes.push(`dropped conflicting view angle(s) ${angles.dropped.join(', ')} — the camera can only stand in one place`)
  }
  if (!required.size) {
    return { tags: angles.kept, note: preNotes.join('; ') }
  }

  const tags = [...angles.kept]
  const notes = [...preNotes]

  // A POV shot is the viewer's own eyeline. "pov, full body, from above" asks
  // for three incompatible cameras at once, and widening a POV frame is how
  // that happens — so framing is never widened while pov is present.
  const isPov = tags.some((tag) => /^(?:pov|first person view|first-person view)$/.test(animaTag(tag)))
  if (isPov) {
    const conflicting = tags.filter((tag) => {
      const level = framingLevelForTag(tag)
      return level && level.level >= 2
    })
    if (conflicting.length) {
      for (const tag of conflicting) tags.splice(tags.indexOf(tag), 1)
      notes.push(`removed ${conflicting.join(', ')} — incompatible with a pov shot`)
    }
    return { tags, note: notes.join('; ') }
  }

  const framingIndex = tags.findIndex((tag) => framingLevelForTag(tag))
  const current = framingIndex >= 0 ? framingLevelForTag(tags[framingIndex]) : null
  const covered = new Set(current ? current.covers : [])
  const missing = [...required].filter((region) => !covered.has(region))

  if (current && missing.length) {
    const widened = FRAMING_LEVELS.find((entry) => [...required].every((region) => entry.covers.includes(region)))
    if (widened && widened.level > current.level) {
      notes.push(`framing "${animaTag(tags[framingIndex])}" widened to "${widened.canonical}" (needs ${missing.join(', ')})`)
      tags[framingIndex] = widened.canonical
    }
  } else if (!current) {
    // No framing at all: only supply one when the scene needs more than a
    // default headshot would give, so ordinary shots keep their freedom.
    const needsBody = required.has('hips') || required.has('legs') || required.has('feet')
    if (needsBody) {
      const widened = FRAMING_LEVELS.find((entry) => [...required].every((region) => entry.covers.includes(region)))
      if (widened) {
        notes.push(`added framing "${widened.canonical}" (scene needs ${[...required].join(', ')})`)
        tags.push(widened.canonical)
      }
    }
  }

  // A face-defining moment shot from behind: keep the author's angle and add
  // the booru tag that turns the head toward the viewer, rather than
  // overriding the intended composition.
  if (required.has('face') && tags.some((tag) => /^from behind$/.test(animaTag(tag)))) {
    if (!tags.some((tag) => /^(?:looking back|looking at viewer)$/.test(animaTag(tag)))) {
      tags.push('looking back')
      notes.push('added "looking back" so the face is visible in a from-behind shot')
    }
  }

  return { tags, note: notes.join('; ') }
}


// --- compile trace -----------------------------------------------------------
// "Is our rule being followed?" was previously unanswerable without adding
// console.log by hand. A rule that silently does not fire looks exactly like a
// rule that fired and had nothing to do. The trace records both, so the
// question is answered by reading rather than by instrumenting.
let LAST_COMPILE_TRACE = []
let LAST_COMPILE_OUTFITS = {}
let LAST_COMPILE_NEGATIVES = []

function traceReset() { LAST_COMPILE_TRACE = []; LAST_COMPILE_OUTFITS = {}; LAST_COMPILE_NEGATIVES = [] }
function trace(rule, outcome, detail = '') {
  LAST_COMPILE_TRACE.push({ rule, outcome, detail: String(detail || '') })
}
function traceSnapshot() { return LAST_COMPILE_TRACE.slice() }
function outfitSnapshot() { return { ...LAST_COMPILE_OUTFITS } }
function negativeSnapshot() { return LAST_COMPILE_NEGATIVES.slice() }

// Human-readable, for the Spindle log and the debug panel.
function formatCompileTrace(steps) {
  const mark = { applied: '✓', clean: '·', skipped: '–', warn: '!' }
  return (steps || []).map((step) =>
    `  ${mark[step.outcome] || '?'} ${step.rule}${step.detail ? ' — ' + step.detail : ''}`).join('\n')
}




// --- outfit ownership -------------------------------------------------------
// A parser reading a two-hander can attach the wrong person's clothes to the
// wrong body: Rook came out "wearing a ruined dress" and cracked glasses, both
// of which are Sovi's. Anima will render exactly what it is told, so a man in a
// dress is not a subtle error.
//
// Profiles already declare what each character owns. A garment that belongs to
// someone ELSE in the scene, and not to the wearer, is bleed — dropped, and
// traced so the decision is visible rather than mysterious.
// A garment declared on a profile is owned outright. A garment the story
// introduced is owned by whoever has been seen wearing it — "Sovi's ruined
// dress" and "Rook's ruined tunic" are established by the chat, not by any
// profile, and until now nothing in the compiler knew that.
function stripBorrowedOutfit(descriptors, rememberedOutfits = null) {
  const owned = new Map()
  for (const item of descriptors) {
    const profile = item.profile
    if (!profile) continue
    const mine = new Set()
    for (const garment of [...(profile.defaultOutfit || []), ...(profile.appearance || [])]) {
      const key = normalizeIdentityText(garment)
      if (key) mine.add(key)
    }
    for (const garment of (rememberedOutfits && rememberedOutfits[item.subject.ref]) || []) {
      const key = normalizeIdentityText(garment)
      if (key) mine.add(key)
    }
    owned.set(item.subject.ref, mine)
  }
  if (owned.size < 2) return descriptors

  return descriptors.map((item) => {
    if (!item.profile) return item
    const mine = owned.get(item.subject.ref) || new Set()
    const kept = []
    const borrowed = []
    // "ruined tunic" and "travel-worn tunic" are the same garment wearing a
    // different adjective, so comparison is on the head noun. Substring
    // matching saw two unrelated strings and let the swap through.
    const sameGarment = (a, b) => {
      if (a.includes(b) || b.includes(a)) return true
      const headA = a.split(/\s+/).pop()
      const headB = b.split(/\s+/).pop()
      return !!headA && headA.length > 2 && headA === headB
    }
    for (const garment of item.outfit || []) {
      const key = normalizeIdentityText(garment)
      // Owned by this character, or by nobody in particular — keep it. Only a
      // garment demonstrably belonging to another cast member is refused, and
      // only when that member is actually in this scene.
      if ([...mine].some((value) => sameGarment(value, key))) { kept.push(garment); continue }
      let ownerRef = ''
      for (const [ref, theirs] of owned.entries()) {
        if (ref === item.subject.ref) continue
        if ([...theirs].some((value) => sameGarment(value, key))) { ownerRef = ref; break }
      }
      if (ownerRef) borrowed.push({ garment, ownerRef })
      else kept.push(garment)
    }
    if (borrowed.length) {
      const names = borrowed.map((entry) => {
        const owner = descriptors.find((other) => other.subject.ref === entry.ownerRef)
        return `"${entry.garment}" belongs to ${owner && owner.anchor ? owner.anchor : entry.ownerRef}`
      })
      trace(`outfit ownership · ${item.anchor || item.subject.ref}`, 'applied', names.join('; '))
      spindle.log.warn(`[lumidraw] outfit bleed · removed from ${item.anchor || item.subject.ref}: ${names.join('; ')}`)
      return { ...item, outfit: kept }
    }
    return item
  })
}


// Anima weights as "(tag:1.4)". Written "(tag 1.4)" the colon is missing and the
// weight silently does nothing, which looks identical to a weight that is too
// low to notice. Repair rather than ignore.
function repairTagWeight(tag) {
  return String(tag || '').replace(/\(([^():]+?)\s+(\d+(?:\.\d+)?)\)/g, '($1:$2)')
}

// Profile traits never passed through the booru vocabulary, so a saved
// "otoko no ko" stayed a dead alias instead of becoming the canonical "trap".
// Only aliases are rewritten here — nothing is demoted, because these ARE the
// caption.

// Presentation tags are mutually exclusive readings of one body. "trap" is a
// male body read feminine; "futanari" is a female body with both sets; "male
// futanari" is the male-bodied version of that. Two of them on one character is
// the same coin-flip as two coat colours, except it decides the whole figure —
// and since 0.42.3 ranks presentation first, a stray one now survives every cap
// that used to quietly remove it.
const PRESENTATION_TAGS = [
  'trap', 'futanari', 'male futanari', 'futa without pussy', 'cuntboy',
  'androgynous', 'bishounen', 'girly boy', 'reverse trap',
]

function enforceOnePresentation(tags, name = '') {
  const seen = []
  const out = []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const bare = normalizeIdentityText(String(tag).replace(/^\((.+):[\d.]+\)$/, '$1'))
    const hit = PRESENTATION_TAGS.find((value) => bare === value)
    if (!hit) { out.push(tag); continue }
    if (seen.length) {
      trace(`presentation · ${name || 'subject'}`, 'warn',
        `"${hit}" dropped — "${seen[0]}" already sets this character's presentation, and the two describe different bodies`)
      spindle.log.warn(`[lumidraw] ${name || 'a subject'} carries conflicting presentation tags (${seen[0]} + ${hit}); keeping ${seen[0]}`)
      continue
    }
    seen.push(hit)
    out.push(tag)
  }
  return out
}

function rewriteKnownAliases(tags) {
  const out = []
  const seen = new Map()   // bare tag → index in `out`
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = repairTagWeight(tag)
    const weighted = /^\((.+):([\d.]+)\)$/.exec(value)
    const bareIn = weighted ? weighted[1] : value
    const resolved = resolveBooruTag(bareIn)
    const bare = resolved.match === 'alias' ? resolved.tag : bareIn
    const final = weighted ? `(${bare}:${weighted[2]})` : bare
    const key = normalizeIdentityText(bare)
    if (!key) { out.push(final); continue }
    // A profile holding both "otoko no ko" and "(trap 1.4)" collapses to one
    // tag once the alias is resolved — and the weighted form is the one the
    // author meant, so it wins.
    if (seen.has(key)) {
      const at = seen.get(key)
      if (weighted) out[at] = final
      continue
    }
    seen.set(key, out.length)
    out.push(final)
  }
  return out
}


// --- held objects -----------------------------------------------------------
// A prop reaches the prompt as a pose phrase at the far end of a long clause:
//   "Sovi, [7 traits], wearing [2 garments], standing behind rook, staff
//    planted, ... and gripping staff, fire-flat ears."
// Forty words separate "Sovi" from "staff", and the other character is named
// twice in between. A diffusion model binds the object to the nearest salient
// figure, which is whoever was named last — so Rook ends up holding the staff.
//
// The object is hoisted to sit immediately after the name, where proximity does
// the binding, and repeated mentions collapse to one.
const HOLD_VERB_RE = /\b(?:holding|held|holds|gripping|grips|grasping|grasps|clutching|clutches|carrying|carries|wielding|wields|brandishing|brandishes|planted|raised|resting on|leaning on|shouldering|balancing)\b/i
const HOLD_STOPWORDS = new Set([
  'holding', 'held', 'holds', 'gripping', 'grips', 'grasping', 'grasps', 'clutching',
  'clutches', 'carrying', 'carries', 'wielding', 'wields', 'brandishing', 'brandishes',
  'planted', 'raised', 'resting', 'leaning', 'shouldering', 'balancing', 'on', 'in',
  'a', 'an', 'the', 'his', 'her', 'their', 'its', 'both', 'one', 'two', 'hands', 'hand',
  'tightly', 'loosely', 'firmly', 'lightly',
])

function heldObjectsFor(item) {
  const found = []
  const seen = new Set()
  const consumed = []
  for (const phrase of [...(item.pose || []), ...(item.action || [])]) {
    const text = animaTag(phrase)
    if (!text || !HOLD_VERB_RE.test(text)) continue
    // A phrase naming another body part is contact, not a held object.
    if (BODY_PART_RE.test(text) && !/\b(?:staff|sword|blade|knife|dagger|bow|spear|axe|shield|lantern|torch|book|tome|cup|mug|bottle|flask|rope|reins|bag|pack|satchel|weapon|wand|orb|crystal)\b/i.test(text)) continue
    const noun = text.split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9-]/gi, ''))
      .filter((word) => word && !HOLD_STOPWORDS.has(word.toLowerCase()))
      .pop()
    if (!noun) continue
    const key = noun.toLowerCase()
    if (seen.has(key)) { consumed.push(phrase); continue }
    seen.add(key)
    found.push(noun)
    consumed.push(phrase)
  }
  return { objects: found.slice(0, 2), consumed }
}

// --- cross-subject poses ------------------------------------------------------
// "standing behind rook" inside SOVI's clause names Rook where Sovi is being
// described, which is the other half of why the staff drifts. It is also a
// relation written in the wrong field, so promote it rather than delete it: the
// geometry survives, and the foreign name leaves the clause.
function promoteCrossSubjectPoses(descriptors, scene) {
  const promoted = []
  const next = descriptors.map((item) => {
    const kept = []
    for (const phrase of item.pose || []) {
      const text = normalizeIdentityText(phrase)
      const other = descriptors.find((candidate) =>
        candidate && candidate.subject.ref !== item.subject.ref && textNamesSubject(text, candidate))
      if (!other) { kept.push(phrase); continue }
      const covered = (scene.relations || []).some((relation) =>
        relation.actor === item.subject.ref && verbStemsMatch(relation.action, text))
      if (covered) {
        trace(`pose → relation · ${item.anchor || item.subject.ref}`, 'clean',
          `"${phrase}" dropped — a relation already carries it`)
        continue
      }
      // Strip the other name and trailing preposition off the tail, leaving an
      // action the relation renderer can complete with the real target.
      const anchorWords = subjectNameForms(other)
        .flatMap((name) => normalizeIdentityText(name).split(/\s+/))
        .filter(Boolean)
      let action = animaTag(phrase)
      for (const word of anchorWords) {
        action = action.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'), '').trim()
      }
      action = action.replace(/\s{2,}/g, ' ').replace(/\s+'s\b/g, "'s").trim()
      if (!action || action.split(/\s+/).length > 9) { kept.push(phrase); continue }
      promoted.push({ actor: item.subject.ref, target: other.subject.ref, action, details: [], promoted: true })
      trace(`pose → relation · ${item.anchor || item.subject.ref}`, 'applied',
        `"${phrase}" became a relation, so ${other.anchor || 'the other subject'} is no longer named inside this character's own description`)
      continue
    }
    return { ...item, pose: kept }
  })
  return { descriptors: next, promoted }
}


// --- garment defence ---------------------------------------------------------
// Anima's training says 1boy wears trousers. Asking for 1boy in a dress fights
// that prior, and the prior usually wins — which is why Sovi drifts into a tunic
// and Rook never drifts into a dress. Naming the substitute in the negative
// prompt is the direct remedy: it does not argue with the prior, it removes the
// thing the prior reaches for.
const GARMENT_SUBSTITUTES = {
  'dress': ['pants', 'trousers', 'shorts', 'tunic'],
  'gown': ['pants', 'trousers', 'shorts', 'tunic'],
  'robe': ['pants', 'trousers'],
  'robes': ['pants', 'trousers'],
  'skirt': ['pants', 'trousers', 'shorts'],
  'kimono': ['pants', 'trousers'],
  'thighhighs': ['pants', 'trousers'],
  'leotard': ['pants', 'trousers'],
}

function garmentDefence(descriptors) {
  const worn = new Set()
  for (const item of descriptors || []) {
    for (const garment of item.outfit || []) {
      const head = animaTag(garment).split(/\s+/).pop()
      if (head) worn.add(head)
    }
  }
  const negatives = []
  for (const head of worn) {
    for (const rival of GARMENT_SUBSTITUTES[head] || []) {
      // Never negate something somebody in this scene is actually wearing.
      if (worn.has(rival) || negatives.includes(rival)) continue
      negatives.push(rival)
    }
  }
  return negatives.slice(0, 6)
}

// The caption binds anatomy by name — "Sovi's penis is visibly exposed." The model
// binds by proximity, and Anima has seen a great deal of futanari, so a 1girl
// standing in a frame where a penis is named can be given one. Nothing in the
// positive prompt says whose body it is not. The negative can.
const FEMALE_COUNT_RE = /\b(?:\d+girls?|multiple girls)\b/i
const PENIS_ANATOMY_RE = /\b(?:penis|testicles|erection)\b/i
// A character whose own identity blurs this is not protected against it: negating
// futanari on a trap or a futa is negating who she is.
const BLURRED_IDENTITY_RE = /\b(?:futanari|futa|dickgirl|newhalf|trap|otoko no ko|femboy|cuntboy|intersex)\b/i
// Deliberately not "penis". The caption is asking for one on the other subject, and
// negating the tag outright is how the anatomy disappears from the scene entirely —
// the opposite failure. These four name the specific condition of a female-bodied
// character having one, which is the thing that is actually wrong.
const FUTANARI_NEGATIVES = ['futanari', 'dickgirl', 'newhalf', 'futa']

// Danbooru tags censorship explicitly, so the model learned it as a style rather
// than as an absence. `futanari` in particular is dense with Japanese commercial
// art, where mosaic and bar censoring are a legal requirement — so the tag carries
// a censorship prior that nothing in an ordinary prompt argues against. Naming the
// anatomy fights it by accident, which is why adding "penis" cleared the mosaic.
// Saying it directly is better than relying on that side effect.
const CENSOR_NEGATIVES = ['censored', 'mosaic censoring', 'bar censor', 'heart censor',
  'novelty censor', 'steam censor', 'light censor', 'convenient censoring']
const UNCENSORED_TAG = 'uncensored'

function censorshipDefence(descriptors, scene) {
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return { positive: '', negatives: [] }
  const showsAnatomy = (descriptors || []).some((item) => (item.anatomy || []).length)
  if (!showsAnatomy) return { positive: '', negatives: [] }
  return { positive: UNCENSORED_TAG, negatives: CENSOR_NEGATIVES.slice() }
}

function anatomyDefence(descriptors, scene) {
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return []
  const items = descriptors || []
  const anyPenis = items.some((item) => (item.anatomy || []).some((tag) => PENIS_ANATOMY_RE.test(String(tag || ''))))
  if (!anyPenis) return []
  const exposed = items.some((item) => {
    if ((item.anatomy || []).length) return false
    if (!FEMALE_COUNT_RE.test(String(item.countTag || ''))) return false
    const identity = [...(item.appearance || []), item.noun || '', item.anchor || ''].join(' ')
    return !BLURRED_IDENTITY_RE.test(identity)
  })
  if (!exposed) return []
  return FUTANARI_NEGATIVES.slice()
}

function traceAppearance(item, after) {
  const before = cleanAppearanceForNoun(item.appearance, item.noun)
  const scenery = before.filter((tag) => isNotTrait(tag))
  const name = item.anchor || (item.subject && item.subject.ref) || 'subject'
  if (scenery.length) trace(`scenery out of appearance · ${name}`, 'applied', scenery.join(', '))
  if (before.length - scenery.length !== after.length) {
    trace(`trait merge · ${name}`, 'applied', `${before.length - scenery.length} → ${after.length}: ${after.join(', ')}`)
  } else {
    trace(`trait merge · ${name}`, 'clean', 'no duplicate or conflicting traits')
  }
  return after
}

function traceGrounding(before, after) {
  if (String(before || '') !== String(after || '')) {
    trace('creature grounding', 'applied', `"${before}" → "${after}"`)
  }
  return after
}


// The identity clauses are built from the descriptor, so they pick up a prompt
// name automatically. The scene statement is the PARSER's prose and uses the
// real name — leaving the exact token we were trying to avoid at the very front
// of the prompt, which is the strongest position in it.
function applyPromptNames(text, profiles) {
  let value = String(text || '')
  if (!value) return value
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile || !profile.promptName || !profile.anchor) continue
    if (normalizeIdentityText(profile.promptName) === normalizeIdentityText(profile.anchor)) continue
    const targets = [
      ...String(profile.anchor).split(/\s+/).filter((part) => part.length >= 3),
      profile.promptName,   // catches a substitution that was later lowercased
    ]
    for (const word of targets) {
      value = value.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'), profile.promptName)
    }
    // Replacing each word of a multi-word anchor can repeat the substitute.
    value = value.replace(new RegExp(`(?:\\b${escapeRegExp(profile.promptName)}\\b[\\s,]*){2,}`, 'gi'), `${profile.promptName} `)
  }
  return value.replace(/\s{2,}/g, ' ').trim()
}

const SUBJECT_BREAK_MARK = '\u0000SUBJECT_BREAK'

function compileStructuredScene(scene, profiles, sourcePassage = '', { artistTags = [], rememberedSetting = [], contextText = '', rememberedOutfits = null, breakInPreset = false } = {}) {
  traceReset()
  let descriptors = scene.subjects.map((subject) => subjectDescriptor(subject, profiles, sourcePassage, true)).map((item) => ({
    ...item,
    // An unprofiled subject's name comes straight from the story, so a coined
    // creature gets grounded in a noun the model has actually been trained on.
    anchor: item.named ? item.anchor : traceGrounding(item.anchor, groundCreatureName(item.anchor, item.appearance)),
    noun: item.named ? item.noun : groundCreatureName(item.noun, item.appearance),
    // Appearance is the body. Scenery that landed there would otherwise be
    // rendered as a physical feature — "with ... a cracked bark nearby".
    appearance: traceAppearance(item, enforceOnePresentation(rewriteKnownAliases(mergeTraitsByHead(
      cleanAppearanceForNoun(item.appearance, item.noun).filter((tag) => !isNotTrait(tag))
    ).map(groundCreatureTag)), item.anchor)),
    anatomy: animaTagList(item.anatomy),
    // Outfit keeps only things that can be worn; POV staging cues are removed
    // from every descriptive list. Both would otherwise be rendered as if they
    // described the character's body.
    outfit: animaTagList(item.outfit).filter((tag) => !isNotClothing(tag)),
    pose: animaTagList(item.subject.pose).filter((tag) => !isPovStagingCue(tag)),
    expression: animaTagList(item.subject.expression).filter((tag) => !isPovStagingCue(tag)),
    action: animaTagList(item.subject.action).filter((tag) => !isPovStagingCue(tag)),
  }))

  descriptors = stripBorrowedOutfit(descriptors, rememberedOutfits)
  for (const item of descriptors) {
    const worn = (item.outfit || []).filter((tag) => !isNotClothing(tag))
    if (worn.length) LAST_COMPILE_OUTFITS[item.subject.ref] = worn
  }
  LAST_COMPILE_NEGATIVES = garmentDefence(descriptors)
  if (LAST_COMPILE_NEGATIVES.length) {
    trace('garment defence', 'applied',
      `negating ${LAST_COMPILE_NEGATIVES.join(', ')} — nobody in this scene wears them and the model's prior reaches for them`)
  }
  const anatomyNegatives = anatomyDefence(descriptors, scene)
  if (anatomyNegatives.length) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, ...anatomyNegatives])
    trace('anatomy defence', 'applied',
      `negating ${anatomyNegatives.join(', ')} — anatomy is named for one subject and a female subject in the same frame has none`)
  } else if (descriptors.some((item) => (item.anatomy || []).length)) {
    trace('anatomy defence', 'ran', 'anatomy is named but no unequipped female subject shares the frame')
  }
  // Belt and braces for the same trap. Stripping the reflexive removes the usual
  // source, but a character name, a preset phrase or a word I have not thought of
  // can carry `elf` too. Negating it is free unless somebody in the scene is one.
  const elfInCast = descriptors.some((item) =>
    [...(item.appearance || []), item.noun || '', item.anchor || '', item.subject.booruCharacter || '']
      .some((value) => /\b(?:elf|elves|elven|dark elf|high elf|half-elf|pointy ears|elf ears)\b/i.test(String(value || ''))))
  if (!elfInCast) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, 'elf', 'pointy ears'])
    trace('elf defence', 'applied', 'nobody in this scene is an elf, so pointed ears are negated')
  } else {
    trace('elf defence', 'skipped', 'a subject in this scene is an elf')
  }
  const censorship = censorshipDefence(descriptors, scene)
  if (censorship.negatives.length) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, ...censorship.negatives])
    trace('censorship defence', 'applied',
      `"${censorship.positive}" added and the censor tags negated — exposed anatomy carries a censorship prior on this model`)
  }

  // A pose naming another subject is a relation in the wrong field. Promoting
  // it keeps the geometry and takes the foreign name out of the clause where a
  // held object is trying to bind.
  if (descriptors.length > 1) {
    const lifted = promoteCrossSubjectPoses(descriptors, scene)
    descriptors = lifted.descriptors
    if (lifted.promoted.length) {
      scene = { ...scene, relations: [...(scene.relations || []), ...lifted.promoted] }
    }
  }

  // Form firewall: strip every trace of a shapeshifter's inactive forms from
  // the whole scene. Scene-wide, not per-subject — "wolf ears" loose anywhere
  // in a multi-character prompt is exactly how it lands on the wrong person.
  const formTerms = inactiveFormTerms(descriptors)
  if (formTerms.length) {
    descriptors = descriptors.map((item) => ({
      ...item,
      noun: scrubFormTermsFromText(item.noun, formTerms),
      appearance: scrubFormTermsFromTags(item.appearance, formTerms),
      outfit: scrubFormTermsFromTags(item.outfit, formTerms),
      pose: scrubFormTermsFromTags(item.pose, formTerms),
      expression: scrubFormTermsFromTags(item.expression, formTerms),
      action: scrubFormTermsFromTags(item.action, formTerms),
    }))
    scene = {
      ...scene,
      sceneStatement: scrubFormTermsFromText(scene.sceneStatement, formTerms),
      coreAction: scrubFormTermsFromText(scene.coreAction, formTerms),
      setting: scrubFormTermsFromTags(scene.setting, formTerms),
      camera: scrubFormTermsFromTags(scene.camera, formTerms),
      lighting: scrubFormTermsFromTags(scene.lighting, formTerms),
      style: scrubFormTermsFromTags(scene.style, formTerms),
      relations: (scene.relations || []).map((relation) => ({
        ...relation,
        action: scrubFormTermsFromText(relation.action, formTerms),
        details: scrubFormTermsFromTags(relation.details, formTerms),
      })).filter((relation) => relation.action),
    }
    spindle.log.info('[lumidraw] form firewall scrubbed inactive-form vocabulary: ' + formTerms.slice(0, 12).join(', '))
    trace('form firewall', 'applied', `scrubbed ${formTerms.length} inactive-form term(s): ${formTerms.slice(0, 8).join(', ')}`)
  } else {
    trace('form firewall', 'clean', 'no inactive-form vocabulary to remove')
  }

  const multi = descriptors.length > 1

  // Anima's trained tag order is
  //   [quality/meta/year/safety] [1girl/1boy] [character] [series] [artist] [general]
  // The preset's quality tags are prepended upstream, so the compiler owns
  // everything from the safety tag rightward.
  const headerTags = []
  if (scene.safety) headerTags.push(scene.safety)
  // Beside the safety tag, which is the slot Anima saw it in on Danbooru.
  const censorshipTag = censorshipDefence(descriptors, scene).positive
  if (censorshipTag) headerTags.push(censorshipTag)
  headerTags.push(...aggregateCountTags(descriptors))
  if (!multi) headerTags.push('solo')
  // [character] then [series], the slots Anima expects between the count tags
  // and the general tags. Only populated for recognisable published
  // characters; original characters are carried by the caption block instead.
  headerTags.push(...animaTagList(descriptors.map((item) => item.subject.booruCharacter)))
  headerTags.push(...animaTagList(descriptors.map((item) => item.subject.booruSeries)))
  // [artist] sits after character/series and before the general tags.
  headerTags.push(...uniqueStrings(artistTags))

  // --- natural-language block --------------------------------------------
  // Solo scenes stay tag-only: with one subject there is nothing to bind, and
  // tags are what Anima renders best. Multi-subject scenes get real sentences,
  // which is the model card's prescribed remedy for character confusion.
  const byRef = new Map(descriptors.map((item) => [item.subject.ref, item]))
  const prose = []
  // The thesis sentence leads the caption for BOTH solo and multi scenes:
  // "Sovi is casting a spell with great intensity." before any detail.
  const trimmedStatement = stripCompetingGeometry(
    applyPromptNames(groundCreatureWords(resolveSceneStatement(scene, descriptors), creatureCoinagesIn(scene)), profiles))
  if (trimmedStatement.removed) {
    trace('scene statement', 'applied',
      `dropped "${trimmedStatement.removed}" — it describes the same contact a second way, and two geometries for one act render as neither`)
  }
  const statement = trimmedStatement.statement
  if (statement) prose.push(statement)
  let crossRelationCount = 0   // relations carried by prose OR already in the statement
  let renderedRelations = 0    // sentences actually written — this is the budget
  if (multi) {
    // BREAK resets the attention chunk, which is what keeps one character's
    // traits from reaching another. Only emitted when the preset already uses
    // BREAK — that proves this setup understands the token rather than
    // rendering it as a word.
    for (const item of descriptors) {
      const sentences = subjectIdentitySentences(item, scene, descriptors, profiles)
      if (sentences.length) prose.push(SUBJECT_BREAK_MARK, ...sentences)
    }

    for (const relation of scene.relations) {
      if (!relation.target || relation.target === relation.actor) continue
      if (relationCoveredByStatement(relation, statement, byRef)) {
        trace('relation dedup', 'applied', `"${relation.action}" suppressed — the scene statement already says it`)
        crossRelationCount++
        continue
      }
      const sentence = relationSentence(relation, byRef)
      if (sentence) { prose.push(sentence); crossRelationCount++; renderedRelations++ }
      if (renderedRelations >= 2) break
    }

    // Named-prop ownership only. Signature exclusivity sentences are dropped:
    // the identity sentence already binds those traits, and a long prompt is
    // itself a bleed risk on this model.
    for (const item of descriptors) {
      const ownership = subjectOwnershipAnchors(item, scene, true, { includeSignature: false, maxAnchors: 1 })
      if (ownership.length) prose.push(ownership[0])
    }
  }
  for (const item of descriptors) {
    const anatomy = visibleAnatomySentence(item, scene)
    if (anatomy) prose.push(anatomy)
  }

  // --- subject tags -------------------------------------------------------
  // Solo only. In a multi-subject prompt every subject-specific tag would sit
  // unbound in the shared run — a floating "dark linen shirt" or "grabbing a
  // wrist" is precisely how clothes and hands end up where they shouldn't be.
  // The caption block owns all per-subject content in multi scenes.
  const subjectTags = multi ? [] : animaTagList(
    subjectTagLine(descriptors[0], scene, descriptors, { includeAppearance: true }).split(',')
  )

  // Left/right placement used to be emitted as pseudo-tags ("ilsa on right"),
  // which is not a booru tag and reintroduces a bare name into tag space. It
  // is a sentence now, and only in the scenes that actually have two sides.
  const placements = []
  for (const item of descriptors) {
    const pos = animaTag(item.subject.position)
    if (/^(left|right)$/.test(pos)) placements.push(`${displayName(item, placements.length === 0)} is on the ${pos}`)
  }
  if (multi && placements.length) prose.push(`${naturalList(placements)}.`)

  const relationDetails = scene.relations.flatMap((relation) => relation.details || []).filter((detail) => !/^(?:pulling|pushing|holding|grabbing|biting|kissing|touching|lifting|carrying|dragging|pressing|pinning|wrapping|hooking|gripping|bracing|straddling)\b/i.test(String(detail || '').trim()))
  const personaPovVisible = descriptors.some((item) => {
    if (!item.subject || item.subject.ref !== 'persona') return false
    const cueText = [
      item.subject.position,
      ...(item.subject.pose || []),
      ...(item.subject.action || []),
      ...(item.subject.appearance || []),
      ...(item.subject.outfit || []),
    ].join(' ').toLowerCase()
    return /\b(?:viewer|first[- ]person|pov body|body only|face out of frame|faceless|hands? in foreground|visible hands?|visible arms?|forearms? only|lower body only)\b/.test(cueText)
  })
  // POV means the camera IS a participant's eyes. A multi-subject caption
  // describes every subject as a third-person figure with its own appearance,
  // and those two things cannot both be true — the result is one character
  // facing the camera instead of the other, plus the "viewer" rendered as a
  // third body.
  //
  // The gate previously read scene.camera only, so a pov arriving in style or
  // lighting walked straight past it. It is a camera concept wherever it lands.
  const POV_TAG_RE = /^(?:pov|first person view|first-person view|from pov)$/
  const strayPov = ['style', 'lighting', 'setting'].filter((field) =>
    animaTagList(scene[field]).some((tag) => POV_TAG_RE.test(tag)))
  if (strayPov.length) {
    scene = {
      ...scene,
      ...Object.fromEntries(strayPov.map((field) =>
        [field, animaTagList(scene[field]).filter((tag) => !POV_TAG_RE.test(tag))])),
    }
    trace('pov', 'applied', `found in ${strayPov.join(', ')} rather than camera; treated as a camera tag`)
  }

  const povAsked = animaTagList(scene.camera).some((tag) => POV_TAG_RE.test(tag)) || strayPov.length > 0
  const povAllowed = personaPovVisible && !(multi && descriptors.length > 1)
  const povFiltered = animaTagList(scene.camera).filter((tag) => !(POV_TAG_RE.test(tag) && !povAllowed))
  if (povAsked) {
    trace('pov', povAllowed ? 'applied' : 'warn', povAllowed
      ? 'kept — the persona carries a staging cue and is not separately described'
      : (multi && descriptors.length > 1
        ? `dropped — ${descriptors.length} subjects are each described as visible figures, so none of them can also be the camera`
        : 'dropped — no staging cue ("viewer hands visible", "face out of frame") says the persona is the viewer'))
  }
  const repaired = repairCameraTags(povFiltered, scene, descriptors)
  const cameraTags = animaTagList(repaired.tags)
  if (repaired.note) spindle.log.info('[lumidraw] camera repair · ' + repaired.note)
  trace('camera repair', repaired.note ? 'applied' : 'clean', repaired.note || 'framing and view angles already consistent')
  const groundingText = [sourcePassage, contextText].filter(Boolean).join('\n')
  const settingCheck = reconcileSetting(scene.setting, groundingText, rememberedSetting)
  if (settingCheck.note) spindle.log.warn('[lumidraw] setting continuity · ' + settingCheck.note)
  trace('setting continuity', settingCheck.note ? 'applied' : 'clean', settingCheck.note || `kept: ${settingCheck.setting.join(', ') || '(none)'}`)

  // A location can arrive through any atmosphere field, not just `setting`.
  const placeChecks = [
    scrubUnsupportedPlaces(cameraTags, groundingText, 'camera'),
    scrubUnsupportedPlaces(animaTagList(scene.lighting), groundingText, 'lighting'),
    scrubUnsupportedPlaces(animaTagList(scene.style), groundingText, 'style'),
    scrubUnsupportedPlaces(animaTagList(relationDetails), groundingText, 'relation details'),
  ]
  for (const check of placeChecks) {
    if (check.dropped.length) {
      spindle.log.warn(`[lumidraw] setting continuity · dropped ${check.field} tag(s) naming a place the story never mentions: ${check.dropped.join(', ')}`)
    }
  }
  const [safeCamera, safeLighting, safeStyle, safeRelationDetails] = placeChecks.map((check) => check.tags)

  // In multi-subject scenes, action-flavoured tags stay out of the tag run:
  // an unowned "grabbing a wrist" or "leaning in" conjures limbs that belong
  // to nobody. The relation sentences already carry that geometry, bound to
  // names. core_action is kept only when no relation sentence covered it.
  // The atmosphere fields are where invented tags concentrate: a model asked
  // for a lighting tag writes "pink grove glow", which Anima has no embedding
  // for. Everything here is resolved against the real Danbooru vocabulary;
  // what survives is a tag, what does not becomes caption prose.
  const atmosphere = partitionBooruTags(animaTagList([
    ...settingCheck.setting,
    ...safeCamera,
    ...safeLighting,
    ...safeStyle,
  ]))
  if (atmosphere.rewritten.length) {
    spindle.log.info('[lumidraw] booru vocabulary · ' + atmosphere.rewritten.join(' · '))
  }
  if (atmosphere.demoted.length) {
    spindle.log.info('[lumidraw] booru vocabulary · not real tags, moved to the caption: ' + atmosphere.demoted.join(', '))
  }
  trace('booru vocabulary', atmosphere.rewritten.length || atmosphere.demoted.length ? 'applied' : 'clean',
    `${atmosphere.kept.length} real tag(s) kept, ${atmosphere.rewritten.length} rewritten, ${atmosphere.demoted.length} moved to the caption`)

  // A tag-only scene has no caption to demote into, so unrecognised phrases
  // stay in the run rather than being dropped — the weaker of two slots beats
  // no slot at all.
  const tagOnly = !prose.filter(Boolean).length
  const facing = orientationTags(scene, descriptors)
  if (facing.tags.length) {
    trace('orientation', 'applied', `${facing.tags.join(', ')} — ${facing.note}`)
  } else if (multi) {
    trace('orientation', 'clean', 'nothing in the scene said which way they face')
  }

  const generalTags = animaTagList([
    ...facing.tags,
    ...(multi ? [] : safeRelationDetails),
    ...(scene.coreAction && !(multi && crossRelationCount) ? [scene.coreAction] : []),
    ...(multi ? [] : supportTags(descriptors, scene)),
    ...atmosphere.kept,
    ...(tagOnly ? atmosphere.demoted : []),
  ])

  // Anima saw newlines almost exclusively in its dataset-tagged captions
  // (a "ye-pop"/"deviantart" line, then a title, then prose), so a prompt
  // chopped into six labelled lines is off-distribution. Tags flow as one
  // comma-separated run; the caption block is the single paragraph break.
  // One collapse pass over the whole body so a concept paid for in the subject
  // run is not paid for again in the scene run ("carrying hammer" vs the
  // core action "carrying a hammer").
  const tagRun = joinPromptParts([
    headerTags.join(', '),
    collapseRedundantTags([...subjectTags, ...generalTags]).join(', '),
  ])
  const presetUsesBreak = !!breakInPreset
  let caption = prose.filter(Boolean)
    .map((part) => part === SUBJECT_BREAK_MARK ? (presetUsesBreak ? 'BREAK.' : '') : part)
    .filter(Boolean)
    .join(' ').replace(/\s{2,}/g, ' ').trim()
  if (presetUsesBreak && multi) {
    trace('subject separation', 'applied', 'BREAK inserted between each character — the preset already uses it')
  }
  // Demoted atmosphere joins the caption as a closing scene fragment — the same
  // words, in the register Anima can actually read. Anything the sentences
  // above already said is skipped rather than repeated.
  //
  // Only when a caption already exists. A solo scene is deliberately tag-only,
  // and a stray scenery fragment is not reason enough to restructure the whole
  // prompt into two blocks; there the phrase stays where it was.
  const captionSaid = normalizeIdentityText(caption)
  const orphanFirst = uniqueStrings([...(atmosphere.orphans || []), ...atmosphere.demoted])
  const scenery = caption
    ? orphanFirst.filter((phrase) => {
      const value = normalizeIdentityText(phrase)
      return value && !captionSaid.includes(value)
    })
    : []
  if (scenery.length) {
    // A caption is a caption. Four leftover phrases set the scene; nine bury it.
    const fragment = scenery.slice(0, 4).join(', ')
    caption = `${caption} ${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}.`
  }
  // The caption LEADS. A sentence naming what is happening, read first, frames
  // everything the tags then specify — and it matches the model card's own
  // example shape, where quality tags are followed by prose. The tag run that
  // follows keeps full booru control over characters, clothing, and lighting.
  return caption ? `${caption}\n\n${tagRun}` : tagRun
}

function profileSchemaHints(profiles) {
  const hints = []
  for (const profile of allKnownProfiles(profiles)) {
    const ref = profile.ref
    if (!profile) continue
    const label = [profile.anchor, profile.subject].filter(Boolean).join(' — ')
    const aliases = (profile.visualAliases || []).map((alias) => `${alias.name} = ${alias.description}`).join('; ')
    const states = (profile.appearanceStates || []).map((state) => {
      const recognition = (state.recognition || []).join(', ')
      const form = state.appearancePolicy === 'replace' ? ', a distinct physical form' : ''
      return `${state.name}${recognition ? ` (recognize: ${recognition}${form})` : form ? ` (${form.replace(/^, /, '')})` : ''}`
    }).join('; ')
    const features = (profile.partialFeatures || []).map((feature) => feature.name).join('; ')
    hints.push(`- ref "${ref}" means ${label || ref}. Do not output permanent appearance for this ref.${features ? ` Partial features available (use partial_features, NOT a state change, when only some of these are showing): ${features}.` : ''}${states ? ` Appearance states: ${states}. Use appearance_state with the exact state name only when the CURRENT PASSAGE shows that transformation happening or already in effect; otherwise omit it and LumiDraw uses the default “${profile.defaultAppearanceState || (profile.appearanceStates[0] && profile.appearanceStates[0].name) || ''}”. Never mix states. A passage that merely calls this character by their species, mentions a past or future transformation, or uses a figure of speech is NOT a transformation — keep the default state. When a state is not active, never describe this character with that form's vocabulary anywhere in the JSON, including scene_statement.` : ''}${aliases ? ` Named visual aliases: ${aliases}. Use the exact prop name when it is present.` : ''}`)
  }
  return hints.join('\n')
}

function structuredParserSchema(maxImages, profiles, minImages = 0) {
  const knownRefList = allKnownProfiles(profiles).map((profile) => profile.ref).join('|')
  return `

STRICT OUTPUT CONTRACT — this overrides any conflicting formatting request above.
Return ONLY one compact JSON object, no markdown and no prose.
Write every scene in the EXACT field order shown below. The order is a survival order: if your reply is ever cut off, everything already written must still form a usable scene, so the mandatory core (safety, core_action, setting, subjects) comes FIRST and droppable refinements (camera, lighting, style) come LAST:
{"images":[{"anchor":"5-12 exact consecutive words copied from CURRENT PASSAGE only","scene":{"safety":"safe|sensitive|nsfw|explicit","scene_statement":"one plain sentence naming the subjects and the central visible action","core_action":"one short visible action or pose","setting":["essential location/context tags"],"subjects":[{"ref":"${knownRefList}|other_1","label":"required only for other refs","appearance_state":"exact saved state name for known refs or empty","partial_features":["exact saved feature names currently showing, or omit"],"count_tag":"1girl|1boy|1other etc","booru_character":"published character tag or empty","booru_series":"source work or empty","position":"left|right|center|foreground|background","appearance":["other subjects only"],"outfit":["short visual tags"],"pose":["short visual phrases"],"support":"visible support surface or empty","expression":["short tags"],"action":["short tag-like actions not involving another subject"],"anatomy_visible":false}],"relations":[{"actor":"subject ref","action":"short visible spatial phrase ending before target","target":"subject ref","details":["at most two visual modifiers"]}],"camera":["from the CAMERA list below only"],"lighting":["essential light tags"],"style":["essential style/mood tags"],"aspect":"3:4|4:3|1:1|9:16|16:9"}}]}
${minImages > 0
  ? `Return between ${minImages} and ${maxImages} image objects. ${minImages} is a FLOOR: find that many distinct visual moments even when one dominates — a second character's reaction, a change of position, a detail shown close. Each needs its own anchor from a different part of the passage.`
  : `Return at most ${maxImages} image object(s). If no image is warranted, return {"images":[]}.`}
The parser input may contain PRIOR CONTEXT and a LATEST LOOM LEDGER. They are reference-only. Use them to resolve identities, pronouns, current attire/accessories, carried props, location, and continuity. Never choose an image moment, action, pose, or anchor from those sections. CURRENT PASSAGE always overrides older context and is the only section that may be illustrated.
This JSON is a visual skeleton for an Anima hybrid compiler. LumiDraw compiles it into one Danbooru/Gelbooru-style tag run followed by a short natural-language caption block, in the tag order Anima was trained on. Do not write the final image prompt yourself.
TAG STYLE — every string you emit is destined for a booru-tag model, so prefer common Danbooru tags and take every one from what the passage actually describes. Every value must name something an artist could draw: "clinical focus releasing" and "heat radiating" are not visible, and neither is a hedge like "clearly visible" or "prominently shown". Words used in these rules to illustrate TAG FORMAT are examples of shape only and must never appear among your tags as if they were part of the scene. This restriction applies to tags; it does not apply to scene_statement, whose examples below you SHOULD imitate closely.
For a subject that is a recognisable published character, set "booru_character" to that character's booru tag and "booru_series" to the work it comes from. Leave both empty for original characters; a made-up name in those fields is worse than nothing.
"style" is the mood of this one scene only (e.g. "backlit", "soft focus"). A medium, artist, or rendering style belongs to the preset and must stay identical between images, or characters drift between generations.
SCENE STATEMENT — the most important sentence you write. One plain declarative sentence stating what is actually being pictured: name the subjects (use their real names from the known refs below; use the label for unnamed others) and the central action, bluntly and concretely. "[name] is fighting three bandits." "[name] is casting a large spell." "[name] is performing oral sex on [name]." (Write the characters' real names in place of [name].) ONGOING ACT BEATS MOMENTARY GESTURE. A passage is usually one beat inside a continuing act, and the continuing act is what the image is of. Name that act, even when it began in an earlier message and the current passage only shows a small movement within it. A hand, a glance, a shift of weight, or a change of expression during an act is a detail of that act, never a replacement for it — put those in pose, expression, or action, not here. WRONG: "[name] tips [name]'s chin up." RIGHT: "[name] is performing oral sex on [name], chin tipped up." ONE GEOMETRY ONLY: the statement fixes where the bodies are, said once. A trailing clause may add an expression — "gagging" — never a second account of the same contact. "taking him deep" restates it at another depth and the two render as neither; depth and penetration belong in pose or action." If you cannot tell what the continuing act is from the CURRENT PASSAGE alone, read PRIOR CONTEXT and the ESTABLISHED SCENE STATE to find it before falling back to the gesture. Prefer the clinical booru word: fellatio, penis, masturbation — not blowjob, cock, stroking. In an nsfw or explicit scene, name the act plainly and anatomically — a euphemism, or a literary substitute such as "forcing eye contact" in place of the act being performed, costs the image its subject. In a safe or sensitive scene, never mention a sexual act. No mood words, no scenery, no appearance: subjects and action only, under 15 words.
SAFETY is the Danbooru rating of the picture, not the mood of the story around it: safe = nothing suggestive; sensitive = suggestive but not sexual (swimwear, underwear, a suggestive pose); nsfw = nudity or overt sexual context; explicit = a sexual act or visible genitals. A tense, frightening, or violent scene with no suggestive content is safe.
CAMERA — pick only from this closed list, never invent one; these are the only framing words the model was trained on, so "dynamic angle" instructs nothing at all. Frame (at most one): portrait | upper body | cowboy shot | full body | wide shot. Angle (at most one): from above | from below | from side | from behind | from front | straight-on | dutch angle. Lens, rarely: depth of field | foreshortening. Two people in contact take cowboy shot; a lone figure in a large space takes wide shot; a reaction takes portrait.
ESSENTIALS FIRST: safety, scene_statement, core_action, setting, and every subject must be completed before relations, camera, lighting, and style. A scene with no subjects is discarded entirely, so never spend output on framing or mood words before the subjects array is closed. Every image must include at least one setting tag, taken from the CURRENT PASSAGE or the established location in PRIOR CONTEXT. A solo scene must include core_action or a visible pose/action. A multi-subject scene must include at least one relation.
Keep each image object compact: at most 4 setting, 3 camera, 3 lighting, 3 style, 3 outfit, 2 pose, 2 expression, 2 relation details, and 1 action item, each a terse visual tag of at most 7 words. These are choices, not truncation points — pick the strongest few rather than listing everything true. Omit optional keys when their value would be empty or redundant; do not output an empty appearance_state. Never write a descriptive paragraph. Never include permanent appearance for ANY known ref listed below (character, persona, or a named cast member); LumiDraw inserts their locked profiles. Use each cast member's exact listed ref when they appear; reserve other_1/other_2 for subjects with no saved profile. For a known ref with saved appearance states, set appearance_state only when the current passage or reference context clearly establishes one exact saved state. Omit it when uncertain. Never combine traits from multiple states.
PARTIAL CHANGES ARE NOT STATE CHANGES. When a passage shows only SOME of a character's transformation — a single feature slipping, eyes changing, claws extending, "partly", "slightly", "a little", "just his eyes", "beginning to" — keep appearance_state at the form they are otherwise in and list the specific features in "partial_features" using the exact saved feature names listed below. Switching appearance_state transforms the WHOLE character, which is wrong for a partial change and produces a completely different creature than the passage describes. Use partial_features for anything short of a full, completed transformation. Select only names that are listed for that ref; never invent a feature name, and never put transformation words in appearance, outfit, pose, or expression.
RELATIONS ARE THE ONLY CHANNEL FOR CONTACT — anything two subjects do to each other that is not written as a relation will not be drawn, so they are mandatory in a multi-subject scene. The FIRST relation establishes the base body arrangement: "straddles the lap of", "stands between the knees of", "leans over", "faces", "sits beside". Later ones name the clearest contact points, always as a visible hold plus the body part it takes: "pins the shoulders of", "grips the snout of", "bites the neck of", "braces both hands on the shoulders of". Verbs of motion or intensity — "fights", "attacks", "struggles with", "pounds", "thrusts", "presses into" — describe nothing an artist could draw; use the hold instead. Put the specifics in details: "claws hooked into the nose", "knuckles white".
For seated, leaning, lying, or kneeling poses, name the visible support surface in "support". Use the camera tag "pov" only when ref "persona" is seen from the viewer's own eye position, and in that subject's pose include a cue such as "viewer hands visible" or "face out of frame".
Set anatomy_visible true only when the passage explicitly names and visibly depicts that subject's saved anatomy; sexual context, lowered clothing, arousal, nudity, or post-sex context alone are not enough. Set anatomy_visible false for safe or sensitive scenes. LumiDraw alone controls saved anatomy.
Known subject refs:
${profileSchemaHints(profiles)}`
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


// Merge the compile's garment defence into the preset's negative prompt without
// repeating anything the preset already lists.
// Framing tags describe where the camera is, not what is in the picture. Negating
// "lower body" does not mean "do not show the lower body" — it argues with the
// composition, and on a turbo config that argument is loud. Danbooru's framing
// vocabulary in a negative prompt is nearly always a mistake carried over from a
// quality-tag list somebody pasted.
const FRAMING_NEGATIVE_RE = /^(?:lower body|upper body|full body|cowboy shot|close-?up|portrait|wide shot|very wide shot|profile|from (?:above|below|side|behind|front)|straight-on|three-quarter view|depth of field|foreshortening|perspective)$/i

function framingTagsIn(negative) {
  return String(negative || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => FRAMING_NEGATIVE_RE.test(part))
}

function negativeWith(presetNegative, extras) {
  const base = String(presetNegative || '')
  // Said once per generation, where the negative prompt is already logged, so the
  // question "where is this coming from" has an answer without reading source.
  const framing = framingTagsIn(base)
  if (framing.length) {
    spindle.log.info(`[lumidraw] the preset's negative prompt contains framing tag(s): ${framing.join(', ')}. ` +
      `These come from your preset, not from LumiDraw. Negating a framing tag fights the composition ` +
      `rather than removing anything from the picture — worth deleting if images look oddly cropped or posed.`)
  }
  if (!extras || !extras.length) return base
  const have = new Set(base.split(',').map((part) => normalizeIdentityText(part)).filter(Boolean))
  const add = extras.filter((tag) => !have.has(normalizeIdentityText(tag)))
  if (!add.length) return base
  spindle.log.info(`[lumidraw] LumiDraw added to your preset's negative prompt: ${add.join(', ')}`)
  return base ? `${base.replace(/[\s,]+$/, '')}, ${add.join(', ')}` : add.join(', ')
}

async function compileSceneWithPreset(sceneInput, preset, settings, userId, chatId, sourcePassage = '', contextText = '') {
  const memoryEntry = await readSceneMemory(chatId, preset.name)
  // Author intent is the floor; verified memory is the current truth. A story
  // that has moved keeps its new location, but a chat with no history yet
  // still starts in the place the preset declares.
  const anchorTags = tagsFrom(preset.sceneAnchor || '', 8)
  const remembered = (memoryEntry.setting || []).length ? memoryEntry.setting : anchorTags
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
  const profiles = {
    character: filterProfile(rawProfiles.character),
    persona: filterProfile(rawProfiles.persona),
    cast: (rawProfiles.cast || []).map(filterProfile),
  }
  let scene = normalizeScene(sceneInput)
  scene = bindKnownSubjectRefs(scene, profiles)
  scene = applyAnatomyFirewall(scene, profiles)
  scene = applyBannedToScene(scene, preset.bannedTags)
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  // User-authored quality tags and prompt prefix remain verbatim except for one
  // thing: a stale safety tag. Presets almost always end "…, score_7, safe",
  // and on an nsfw passage that used to compile to "safe, …, explicit" — two
  // mutually exclusive tags in the same prompt. The scene's classification wins.
  // Artist tags are pulled out and handed to the compiler so they land in
  // Anima's artist slot instead of wherever the preset happened to put them.
  const { artists, rest } = splitArtistTags(normalizeArtistTags(
    reconcileSafetyTags(joinPromptParts([preset.qualityTags, prefix]), scene.safety)
  ))
  const core = compileStructuredScene(scene, profiles, sourcePassage, {
    artistTags: artists,
    rememberedSetting: remembered,
    contextText,
    rememberedOutfits: memoryEntry.outfits || null,
    breakInPreset: preset.useBreakSeparators === true ||
      (preset.useBreakSeparators === undefined && /\bBREAK\b/.test(String(preset.qualityTags || ''))),
  })
  // Remember whatever survived reconciliation as the story's location.
  const groundingForMemory = [sourcePassage, contextText].filter(Boolean).join('\n')
  const establishedSetting = reconcileSetting(scene.setting, groundingForMemory, remembered).setting
  const establishedLighting = scrubUnsupportedPlaces(animaTagList(scene.lighting), groundingForMemory, 'lighting').tags
  // Record the wardrobe as compiled — after the ownership check, so a rejected
  // garment is never learned as belonging to the wrong character.
  const establishedOutfits = outfitSnapshot()
  await rememberSceneState(chatId, preset.name, {
    setting: establishedSetting,
    lighting: establishedLighting,
    outfits: Object.keys(establishedOutfits).length ? establishedOutfits : null,
  })
  // A sentence follows the quality header with a full stop, not a comma:
  // "masterpiece, best quality, @artist. Sovi is …" is the card's own shape.
  const coreLeadsWithSentence = /^[A-Z][^,\n]*\s/.test(core)
  const assembled = rest && coreLeadsWithSentence
    ? `${rest.replace(/[\s,]+$/g, '')}. ${core}`
    : joinPromptParts([rest, core])
  // Last thing before the prompt leaves: one pass over the finished text, because a
  // trap word can arrive from the parser, a profile, or the preset, and this is the
  // only point all three have met.
  const detrapped = stripSubwordTraps(assembled)
  const prompt = detrapped.text
  for (const hit of detrapped.hits) {
    trace('subword trap', 'applied', `removed ${hit.words.join(', ')} — ${hit.why}`)
    spindle.log.info(`[lumidraw] subword trap · removed ${hit.words.join(', ')} from the prompt · ${hit.why}`)
  }
  if (!detrapped.hits.length) trace('subword trap', 'clean', 'no word in the prompt hides a tag inside it')
  const compileTrace = traceSnapshot()
  spindle.log.info('[lumidraw] compile trace (' + compileTrace.length + ' rules)\n' + formatCompileTrace(compileTrace))
  return {
    prompt, core, scene, profiles, aspect: scene.aspect,
    compiler: 'anima-hybrid-v14', trace: compileTrace,
    garmentNegatives: negativeSnapshot(),
  }
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
  // A scan the watchdog already declared dead must not resurrect the panel
  // widget when its hung promise finally settles minutes later.
  if (scan.terminated) return
  scan.stage = stage
  scan.note = note
  scan.stageChangedAt = Date.now()
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
  if (scan.auto) {
    setAutoStatus(scan.userId, {
      mode: 'parser',
      status: stage,
      messageId: scan.messageId || '',
      chatId: scan.chatId || '',
      source: scan.source || 'auto',
      note,
    })
  }
}

// Providers disagree about where the assistant's text lives. Only a non-empty
// string counts: an empty `content` must fall through to the next candidate
// rather than being treated as the answer.
function extractParserText(res) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value : '')
  if (typeof res === 'string') return res.trim() ? res : ''
  if (!res || typeof res !== 'object') return ''
  const choice = Array.isArray(res.choices) ? res.choices[0] : null
  return pick(res.content) ||
    pick(res.text) ||
    pick(res.message && res.message.content) ||
    pick(choice && choice.text) ||
    pick(choice && choice.message && choice.message.content) ||
    ''
}

// Last resort for reasoning models that never emit final content: the JSON is
// often sitting in the reasoning stream. Only used when it actually looks like
// the contract's payload.
function extractParserReasoning(res) {
  if (!res || typeof res !== 'object') return ''
  const parts = []
  if (typeof res.reasoning === 'string') parts.push(res.reasoning)
  if (Array.isArray(res.reasoning_details)) {
    for (const detail of res.reasoning_details) {
      if (typeof detail === 'string') parts.push(detail)
      else if (detail && typeof detail === 'object') parts.push(detail.text || detail.content || detail.summary || '')
    }
  }
  const text = parts.filter(Boolean).join('\n').trim()
  if (!text) return ''
  return /"images"\s*:|"scene"\s*:/.test(text) ? text : ''
}

// `report`, when supplied, is filled in with what ACTUALLY happened — the model
// the request resolved to, whether a model override could be applied, and the
// token split. "I changed the model and the log still shows the old one" is
// otherwise impossible to tell apart from "the override was silently refused".

// A dropped socket is not an answer, it is the absence of one. Losing a whole
// scan to a connection reset — 44ms after the request opened, in the observed
// case — is the wrong response to a transient failure that would have succeeded
// on the next attempt.
const TRANSIENT_NETWORK_RE = /socket connection was closed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|network error|fetch failed|Failed to fetch|connection closed|premature close|stream closed|terminated/i

function isTransientNetworkError(error) {
  if (!error) return false
  if (error.name === 'ParserTimeoutError' || error.name === 'StoryScanCancelledError') return false
  if (error.name === 'AbortError') return false
  return TRANSIENT_NETWORK_RE.test(String(error.message || ''))
}

async function quietLLM(system, user, settings, userId, structured = false, scan = null, report = null) {
  const generateApi = spindle.generate || spindle.generation || spindle.llm
  if (!generateApi || (typeof generateApi.quiet !== 'function' && typeof generateApi.raw !== 'function')) {
    throw new Error('Lumiverse generation API unavailable. Expected spindle.generate.quiet(). Surface: ' + Object.keys(spindle).join(', '))
  }

  const inputLabel = structured ? 'PARSER INPUT' : 'STORY PASSAGE'
  const finalReminder = structured
    ? '\n----- END PARSER INPUT -----\n\nReturn only the compact JSON object required by the system instruction. No prose, no markdown fences, no explanations.'
    : '\n----- END PASSAGE -----\n\nRespond only with one line per image in this format:\n<5-12 exact consecutive words copied from the passage> ||| <comma-separated image tags>\nNo prose or explanations.'

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `----- ${inputLabel} -----\n` + user + finalReminder },
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

  const structuredImageCount = Math.max(1, Math.min(4, Number(settings.maxImages) || 2))
  // Sized to survive a reasoning model, not to fight one. When the provider
  // ignores every "reasoning off" key, a 4,100-token budget buys 4,100 tokens
  // of thinking and an empty reply — 49 seconds for nothing, and then a retry
  // that pays the input cost a second time. Starting with room for both the
  // thinking and the JSON gets the same answer in one request.
  //
  // Drop this to ~4000 if you ever confirm reasoning is genuinely off; it is
  // roughly 3x the budget the JSON alone needs.
  const configuredBudget = Math.max(1200, Math.min(32000, Number(settings.parserMaxTokens) || 12000))
  const parserTokenLimit = structured
    ? configuredBudget + ((structuredImageCount - 1) * 650)
    : 1200
  const opts = {
    // Operator-scoped extensions must pass the active user explicitly in the
    // request object. Keeping the second-argument retry below preserves
    // compatibility with older generation API shapes.
    userId,
    messages,
    parameters: {
      temperature: 0.2,
      max_tokens: parserTokenLimit,
    },
    // OpenRouter documents `effort: "none"` as "disables reasoning entirely",
    // and derives Anthropic's thinking budget from it, so that is the switch
    // that matters. `enabled: false` and `source: 'off'` ride along for
    // providers that spell it their own way; keys nobody recognises are
    // ignored.
    //
    // Deliberately NOT sent:
    //   exclude: true    hides reasoning but still generates and bills it —
    //                    the exact behaviour that made this hard to diagnose.
    //   max_tokens: 0    OpenRouter clamps Anthropic's budget to a 1024-token
    //                    MINIMUM, so this would switch reasoning on, not off,
    //                    and it conflicts with `effort` ("one of, not both").
    reasoning: { source: 'off', enabled: false, effort: 'none' },
    signal: parserController.signal,
  }
  if (connectionId) opts.connection_id = connectionId
  if (useRawOverride) {
    opts.provider = connection.provider
    opts.model = requestedModel
  } else if (requestedModel) {
    // The legacy path has always set this unconditionally. The Anima path only
    // set it when a raw provider route existed, so a typed model was silently
    // dropped and the request ran on the connection's own model — while the
    // Settings field went on showing what you asked for. Two paths, two
    // behaviours, one of them wrong.
    opts.model = requestedModel
  }

  // User-supplied overrides win over everything above — the escape hatch for a
  // provider key LumiDraw does not know about yet.
  const overrideText = String(settings.parserRequestOverrides || '').trim()
  if (overrideText && overrideText !== '{}') {
    try {
      const extra = JSON.parse(overrideText)
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [key, value] of Object.entries(extra)) {
          if (key === 'parameters' && value && typeof value === 'object') Object.assign(opts.parameters, value)
          else opts[key] = value
        }
        spindle.log.info('[lumidraw] parser request overrides applied: ' + Object.keys(extra).join(', '))
      }
    } catch (error) {
      spindle.log.warn('[lumidraw] parser request overrides ignored — not valid JSON: ' + error.message)
    }
  }

  const parserStarted = Date.now()
  const providerLabel = connection && connection.provider ? connection.provider : 'connection default'
  // Report what was SENT. Reporting the connection's model while overriding it
  // is how an A/B test between models silently compares nothing.
  const modelLabel = opts.model || connectionModel || requestedModel || 'connection default'
  if (report) {
    report.model = modelLabel
    report.requestedModel = requestedModel
    report.provider = providerLabel
    report.connectionModel = connectionModel || ''
    report.overrideApplied = useRawOverride
    if (requestedModel && !useRawOverride && connectionModel && requestedModel !== connectionModel) {
      report.overrideNote = `Sending model "${requestedModel}" on a connection whose own model is "${connectionModel}". If the provider ignores the override, the connection's model is what actually runs — compare this line against the one in the Spindle log after the request completes.`
    }
  }
  spindle.log.info('[lumidraw] parser request started' +
    ' · api=' + methodName +
    ' · provider=' + providerLabel +
    ' · model=' + modelLabel +
    (requestedModel && requestedModel !== modelLabel ? ' (asked for ' + requestedModel + ')' : '') +
    (connectionModel && connectionModel !== modelLabel ? ' · connection model=' + connectionModel : '') +
    ' · source=' + (requestedModel ? 'model override field' : 'connection') +
    (connectionId ? ' · connection_id=' + connectionId : '') +
    ' · reasoning=' + JSON.stringify(opts.reasoning) + ' · max_tokens=' + opts.parameters.max_tokens)

  if (requestedModel && !useRawOverride && connectionModel && requestedModel !== connectionModel) {
    spindle.log.info('[lumidraw] model override "' + requestedModel + '" sent on a connection whose own model is "' + connectionModel +
      '" (no raw provider route). If the reply does not look like the model you asked for, set it on the Lumiverse connection instead.')
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

    const runOnce = async () => {
      const requestPromise = (async () => {
        try {
          return await method(opts)
        } catch (error) {
          const message = (error && error.message) || ''
          if (/userId/i.test(message)) return await method(opts, userId)
          // Two quick retries on a dropped connection. Cheap, because nothing
          // was generated and nothing was billed — the request never landed.
          if (isTransientNetworkError(error)) {
            for (let attempt = 1; attempt <= 2; attempt++) {
              assertStoryScanActive(scan)
              const backoff = attempt * 1200
              spindle.log.warn(`[lumidraw] parser connection dropped (${message}); retrying in ${backoff}ms — attempt ${attempt} of 2`)
              if (scan) setStoryScanStage(scan, 'parsing', `The connection dropped; retrying (${attempt} of 2).`)
              await wait(backoff)
              try {
                return await method(opts)
              } catch (retryError) {
                if (!isTransientNetworkError(retryError)) throw retryError
                if (attempt === 2) {
                  throw new Error(`${retryError.message} — the parser connection dropped three times. This is usually the provider or the network rather than LumiDraw; check the connection in Lumiverse.`)
                }
              }
            }
          }
          // A strict provider may reject the multi-spelling reasoning object.
          // Drop back to the minimal form once rather than failing the scan.
          if (/reasoning|unrecognized key|unknown (?:field|parameter)|invalid.*param|mandatory/i.test(message) &&
              opts.reasoning && Object.keys(opts.reasoning).length > 1) {
            // Some models mark reasoning mandatory and reject effort:"none".
            spindle.log.warn('[lumidraw] provider rejected the reasoning options (' + message + '); retrying with reasoning={source:off}')
            opts.reasoning = { source: 'off' }
            return await method(opts)
          }
          throw error
        }
      })()
      const res = await Promise.race([requestPromise, timeoutPromise])
      assertStoryScanActive(scan)

      const responseText = extractParserText(res)
      const elapsed = Date.now() - parserStarted
      const usage = res && res.usage
      const reasoningTokens = usage && (
        (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ??
        usage.reasoning_tokens ?? null)
      const usageText = usage
        ? ' · tokens=' + [usage.prompt_tokens ?? '?', usage.completion_tokens ?? '?', usage.total_tokens ?? '?'].join('/') +
          (reasoningTokens != null
            ? ' · reasoning_tokens=' + reasoningTokens +
              (usage.completion_tokens ? ' (' + Math.round((reasoningTokens / usage.completion_tokens) * 100) + '% of output)' : '')
            : ' · reasoning_tokens=not reported')
        : ''
      const finishReason = res && (res.finish_reason || (res.choices && res.choices[0] && res.choices[0].finish_reason))
      const finishText = finishReason ? ' · finish=' + finishReason : ''

      if (!responseText) {
        // A reply CAN legitimately arrive with an empty content field: a
        // reasoning model that spends its whole completion budget thinking
        // returns content:"" alongside reasoning/reasoning_details. Calling
        // that an "unrecognized response shape" hid the real cause, so the
        // two cases are now distinguished and the reasoning text is searched
        // for the JSON before giving up.
        const known = res && typeof res === 'object' && ('content' in res || 'text' in res || 'choices' in res)
        const salvaged = extractParserReasoning(res)
        if (salvaged) {
          spindle.log.warn('[lumidraw] parser returned no visible content; recovered the JSON from its reasoning output.')
          return { text: salvaged, finishReason, usage, recoveredFromReasoning: true }
        }
        if (known) {
          const spent = usage && usage.completion_tokens ? usage.completion_tokens : opts.parameters.max_tokens
          return { text: '', finishReason: finishReason || 'empty', usage, empty: true, spent }
        }
        throw new Error('Parser returned an unrecognized response shape: ' + (res ? Object.keys(res).join(',') : String(res)))
      }

      const cleanResponse = responseText.trim()
      if (report) {
        report.elapsedMs = elapsed
        report.usage = usage || null
        report.reasoningTokens = reasoningTokens
        report.finishReason = finishReason || ''
      }
      spindle.log.info('[lumidraw] parser completed in ' + elapsed + 'ms via ' + methodName + usageText + finishText + ' · chars=' + cleanResponse.length + ' → raw reply: ' + cleanResponse.slice(0, 500))
      return { text: cleanResponse, finishReason, usage }
    }

    let result = await runOnce()

    // Reasoning-capable models routed through gateways can burn most of the
    // completion budget on hidden reasoning tokens that `reasoning: off` does
    // not reliably suppress (observed: 3450 completion tokens, ~1000 visible
    // chars). One retry with a much larger allowance costs a second request
    // only in the truncation case and usually returns the full JSON.
    // An empty reply is the same failure as a truncated one, taken to its
    // extreme: the reasoning consumed the entire budget and nothing visible
    // was left. Both retry the same way.
    const needsMoreRoom = (value) => value && (value.empty ||
      value.finishReason === 'length' || value.finishReason === 'max_tokens')

    if (structured && needsMoreRoom(result)) {
      const visibleTokens = Math.ceil(result.text.length / 4)
      const completionTokens = (result.usage && result.usage.completion_tokens) || opts.parameters.max_tokens
      const hiddenTokens = Math.max(0, completionTokens - visibleTokens)
      // An empty reply proves reasoning ate everything, so give it markedly
      // more room than a merely-truncated one.
      const bump = result.empty
        ? Math.max(4800, completionTokens * 2)
        : Math.max(2400, hiddenTokens * 2)
      const retryLimit = Math.min(16000, opts.parameters.max_tokens + bump)
      spindle.log.warn('[lumidraw] parser reply was ' + (result.empty ? 'EMPTY (all output spent on reasoning)' : 'truncated') +
        ' (visible≈' + visibleTokens + ' tokens, hidden≈' + hiddenTokens + '); retrying once with max_tokens=' + retryLimit)
      setStoryScanStage(scan, 'parsing', result.empty
        ? 'The parser model returned only reasoning; retrying with a much larger output allowance.'
        : 'Parser reply was truncated; retrying with a larger output allowance.')
      opts.parameters.max_tokens = retryLimit
      try {
        const retry = await runOnce()
        if (!needsMoreRoom(retry)) result = retry
        else if (retry.text.length > result.text.length) result = retry
      } catch (retryError) {
        if (retryError && (retryError.name === 'ParserTimeoutError' || retryError.name === 'StoryScanCancelledError')) throw retryError
        spindle.log.warn('[lumidraw] parser retry failed (' + retryError.message + '); using the first reply.')
      }
    }

    if (!result.text) {
      const spent = (result.usage && result.usage.completion_tokens) || result.spent || opts.parameters.max_tokens
      throw new Error(
        `The parser model returned no text — it spent its entire ${spent}-token output budget on internal reasoning. ` +
        `LumiDraw already retried with a larger budget. Fix this on the connection: turn reasoning off for ` +
        `"${modelLabel}" in its Lumiverse connection, or pick a non-reasoning model for the parser in LumiDraw's Settings tab.`
      )
    }

    if (result.finishReason === 'length' || result.finishReason === 'max_tokens') {
      spindle.log.warn('[lumidraw] parser response reached its output limit; LumiDraw will attempt to preserve any complete image objects.')
    }
    return result.text
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
const autoScanJobs = new Map()
const recentAutoScans = new Map()

// CHARACTER_MESSAGE_RENDERED fires for every message the host renders,
// including the existing history it paints while a chat is loading. Without a
// grace window, opening the app queued an automatic scan for the last old
// message — a visible "Preparing story message" timer (and potentially a
// generation) that nobody requested. GENERATION_ENDED is the real completion
// signal and is not gated.
const BACKEND_STARTED_AT = Date.now()
const RENDERED_EVENT_GRACE_MS = 12000
function isStartupRenderedEcho(source) {
  return /rendered/i.test(String(source || '')) && (Date.now() - BACKEND_STARTED_AT) < RENDERED_EVENT_GRACE_MS
}

function autoScanKey(userId, chatId, messageId) {
  // message IDs are globally stable enough for deduplication. Ignoring chatId
  // when one is present lets a tag callback with a missing chatId be enriched
  // by the later GENERATION_ENDED event instead of starting a competing job.
  return messageId
    ? [String(userId || ''), 'message', String(messageId)].join(':')
    : [String(userId || ''), 'chat', String(chatId || ''), '__latest__'].join(':')
}

function autoResultStatus(result) {
  if (result && result.processed) return 'generated'
  const note = String(result && result.note || '')
  if (/already illustrated|no visual moment|nothing generated|No story message|could not be found|not visible after|disabled/i.test(note)) return 'idle'
  if (result && result.skipped) return 'skipped'
  return 'done'
}

function pruneRecentAutoScans() {
  const cutoff = Date.now() - (10 * 60 * 1000)
  for (const [key, at] of recentAutoScans) if (at < cutoff) recentAutoScans.delete(key)
}

function scheduleAutoStoryScan(userId, request = {}) {
  const chatId = String(request.chatId || '')
  const messageId = String(request.messageId || '')
  const source = String(request.source || 'auto-event')
  if (!userId) return { accepted: false, note: 'Automatic scan has no userId.' }
  if (!chatId && !messageId) return { accepted: false, note: 'Automatic scan has neither chatId nor messageId.' }
  if (isStartupRenderedEcho(source)) {
    spindle.log.info('[lumidraw] ignored startup render echo · source=' + source + (messageId ? ' · message=' + messageId : ''))
    return { accepted: false, startupEcho: true, messageId, chatId, source }
  }

  pruneRecentAutoScans()
  const key = autoScanKey(userId, chatId, messageId)
  if (autoScanJobs.has(key)) {
    const existing = autoScanJobs.get(key)
    if (existing) {
      if (!existing.chatId && chatId) existing.chatId = chatId
      if (!existing.messageId && messageId) existing.messageId = messageId
      if (!existing.expectedContent && request.content) existing.expectedContent = String(request.content).slice(-7000)
      existing.sources = uniqueStrings([...(existing.sources || [existing.source]), source])
    }
    spindle.log.info('[lumidraw] auto trigger deduplicated/enriched · source=' + source + (messageId ? ' · message=' + messageId : ''))
    return { accepted: false, duplicate: true, enriched: true, messageId, chatId, source }
  }
  if (recentAutoScans.has(key)) {
    spindle.log.info('[lumidraw] recent auto trigger ignored · source=' + source + (messageId ? ' · message=' + messageId : ''))
    return { accepted: false, duplicate: true, recent: true, messageId, chatId, source }
  }

  const job = {
    key, userId, chatId, messageId, source, sources: [source],
    expectedContent: String(request.content || '').slice(-7000),
    queuedAt: Date.now(),
  }
  setAutoStatus(userId, {
    mode: 'parser', status: 'queued', messageId, chatId, source,
    note: 'Automatic illustration queued from ' + source + '.',
  })
  spindle.log.info('[lumidraw] auto trigger queued · source=' + source + (chatId ? ' · chat=' + chatId : '') + (messageId ? ' · message=' + messageId : ''))

  const promise = (async () => {
    try {
      await wait(Math.max(250, Number(request.delayMs) || 650))
      const settings = await getSettings()
      if (settings.mode !== 'parser' || settings.autoScan === false) {
        const result = { mode: settings.mode, processed: 0, skipped: true, note: 'Parser auto-scan is disabled.' }
        setAutoStatus(userId, { mode: settings.mode, status: 'idle', messageId, chatId, source, note: result.note })
        return result
      }

      // An event replay for an already-illustrated message (startup echoes,
      // re-renders, chat switches) is settled here from local storage, before
      // any scan widget, chat fetch, or message lookup is started.
      if (job.messageId && await wasProcessed(job.messageId)) {
        const result = { mode: 'parser', processed: 0, skipped: true, note: 'This message was already illustrated.' }
        recentAutoScans.set(key, Date.now())
        setAutoStatus(userId, { mode: 'parser', status: 'idle', messageId: job.messageId, chatId: job.chatId, source, note: result.note })
        return result
      }

      // Do not lose an automatic message just because another manual/automatic
      // scan owns the single Draw Things/parser lane. Wait for the lane instead.
      const slotStarted = Date.now()
      while (activeStoryScan) {
        if (job.messageId && activeStoryScan.messageId === job.messageId) {
          const result = { mode: 'parser', processed: 0, skipped: true, note: 'This message is already being scanned.' }
          recentAutoScans.set(key, Date.now())
          setAutoStatus(userId, {
            mode: 'parser', status: 'joined', messageId: job.messageId, chatId: job.chatId, source,
            note: result.note,
          })
          return result
        }
        if (Date.now() - slotStarted > PARSER_TIMEOUT_MS + 90000) {
          throw new Error('Automatic scan waited too long for the current story scan to finish.')
        }
        setAutoStatus(userId, {
          mode: 'parser', status: 'waiting', messageId: job.messageId, chatId: job.chatId, source,
          note: 'Waiting for the current story scan to finish.',
        })
        await wait(750)
      }

      const effectiveSource = uniqueStrings(job.sources || [job.source]).join('+') || source
      const result = await scanStory(userId, {
        force: false,
        auto: true,
        source: effectiveSource,
        messageId: job.messageId,
        chatId: job.chatId,
        expectedContent: job.expectedContent,
      })
      const resultNote = String(result && result.note || '')
      // A saved message can become queryable a little later on some host builds.
      // Do not suppress a later lifecycle event for ten minutes when lookup was
      // the only failure; allow the later event to retry the same message.
      if (!/not visible after|No story message found/i.test(resultNote)) {
        recentAutoScans.set(key, Date.now())
      }
      setAutoStatus(userId, {
        mode: result && result.mode ? result.mode : 'parser',
        status: autoResultStatus(result),
        messageId: (result && result.messageId) || job.messageId,
        chatId: job.chatId,
        source: effectiveSource,
        note: resultNote,
      })
      spindle.log.info('[lumidraw] auto scan result · source=' + effectiveSource + ' · ' + JSON.stringify(result))
      return result
    } catch (error) {
      recentAutoScans.set(key, Date.now())
      spindle.log.warn('[lumidraw] auto scan failed · source=' + source + ' · ' + error.message)
      setAutoStatus(userId, { mode: 'parser', status: 'error', messageId: job.messageId, chatId: job.chatId, source, note: error.message })
      return { mode: 'parser', processed: 0, error: error.message, note: error.message }
    } finally {
      autoScanJobs.delete(key)
    }
  })()
  job.promise = promise
  autoScanJobs.set(key, job)
  return { accepted: true, messageId, chatId, source }
}

const SCAN_TOTAL_LIMIT_MS = 30 * 60000

async function scanStory(userId, options = {}) {
  const requestedMessageId = options && options.messageId ? String(options.messageId) : ''
  // Evict a scan that has plainly died with the lane still held — belt and
  // braces alongside the watchdog, and it also frees lanes stuck from before
  // this version was installed.
  if (activeStoryScan && (activeStoryScan.terminated || Date.now() - activeStoryScan.startedAt > SCAN_TOTAL_LIMIT_MS)) {
    spindle.log.warn('[lumidraw] evicting a dead story scan holding the lane · stage=' + activeStoryScan.stage + ' · age=' + Math.round((Date.now() - activeStoryScan.startedAt) / 1000) + 's')
    activeStoryScan.cancelled = true
    if (activeStoryScan.abortController) { try { activeStoryScan.abortController.abort() } catch { /* ignore */ } }
    setStoryScanStage(activeStoryScan, 'error', 'Superseded: this scan was stuck and has been evicted.')
    activeStoryScan.terminated = true
    activeStoryScan = null
  }
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
    chatId: String(options.chatId || ''),
    auto: !!options.auto,
    source: String(options.source || (options.auto ? 'auto' : 'manual')),
    startedAt: Date.now(),
    stage: 'starting',
    note: '',
    cancelled: false,
    abortController: null,
  }
  activeStoryScan = scan
  setStoryScanStage(scan, 'starting', 'Preparing story message.')

  // Watchdog: no stage may run longer than its budget, and no scan may run
  // longer than the absolute cap. Without this, one hung host call left the
  // scan pinned at "starting" with the timer counting forever AND the scan
  // lane held, so every later scan was rejected as "already running". The
  // watchdog emits the terminal stage itself because a truly hung core
  // promise never reaches the catch/finally below. Between checks it
  // re-broadcasts the current stage as a heartbeat so the panel can tell a
  // live scan from a dead backend.
  const stageLimits = {
    starting: 90000,
    parsing: PARSER_TIMEOUT_MS + 30000,
    compiling: 60000,
    generating: 20 * 60000,
    inserting: 2 * 60000,
  }
  const watchdog = setInterval(() => {
    if (scan.terminated || ['done', 'cancelled', 'error'].includes(scan.stage)) { clearInterval(watchdog); return }
    const stageAge = Date.now() - (scan.stageChangedAt || scan.startedAt)
    const totalAge = Date.now() - scan.startedAt
    const limit = stageLimits[scan.stage] || (10 * 60000)
    if (stageAge > limit || totalAge > SCAN_TOTAL_LIMIT_MS) {
      scan.cancelled = true
      if (scan.abortController) { try { scan.abortController.abort() } catch { /* ignore */ } }
      setStoryScanStage(scan, 'error',
        `Stage "${scan.stage}" exceeded its ${Math.round((stageAge > limit ? limit : SCAN_TOTAL_LIMIT_MS) / 1000)}s budget — a host call likely hung. The scan lane has been released; try again.`)
      scan.terminated = true
      if (activeStoryScan === scan) activeStoryScan = null
      clearInterval(watchdog)
      return
    }
    // Heartbeat: same payload shape the panel already understands.
    notifyFrontend(scan.userId, 'scan_status', {
      scan: {
        id: scan.id,
        stage: scan.stage,
        note: scan.note,
        messageId: scan.messageId || '',
        startedAt: scan.startedAt,
        elapsedMs: totalAge,
        cancellable: true,
        heartbeat: true,
      },
    })
  }, 10000)

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
    clearInterval(watchdog)
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

  const located = await locateStoryMessage(userId, {
    messageId: requestedMessageId,
    chatId: options.chatId,
    expectedContent: options.expectedContent,
    auto: !!options.auto,
  })
  const { messages, chatId, target, targetIndex } = located
  if (!target) {
    const note = requestedMessageId
      ? `Story message ${requestedMessageId} was not visible after ${located.attempts || 1} lookup attempt(s).`
      : 'No story message found.'
    spindle.log.warn('[lumidraw] story target lookup failed' + (options.source ? ' · source=' + options.source : '') + (chatId ? ' · chat=' + chatId : '') + ' · ' + note)
    return { mode: settings.mode, processed: 0, skipped: true, note }
  }
  if (scan) {
    scan.messageId = String(target.id || requestedMessageId || '')
    scan.chatId = String(chatId || options.chatId || '')
  }
  assertStoryScanActive(scan)

  // ------------------------- out-of-character messages ---------------------
  // Checked before either engine runs, so an aside costs no parser call and no
  // Draw Things time, and the extension no longer has to be switched off by hand.
  const targetText = stripParserUtilityCards(stripParserTrigger(stripThinking(target.content)))
  let oocVerdict = outOfCharacterVerdict(targetText)
  // The assistant's own reply carries no marker — it just answers. So when the
  // message that prompted it was out of character, the reply's shape decides:
  // "[ooc]: can we back up?" gets an aside and no image, while "[ooc]: continue
  // the scene" gets narrative that should still be illustrated.
  if (!oocVerdict.ooc && Number.isInteger(targetIndex) && targetIndex > 0) {
    let prompting = null
    for (let i = targetIndex - 1; i >= 0 && i >= targetIndex - 4; i--) {
      const bits = messageBits(messages[i])
      if (!bits || typeof bits.content !== 'string' || !bits.content.trim()) continue
      if (bits.isUser) { prompting = bits; break }
      if (bits.isAssistant) break
    }
    if (prompting && outOfCharacterVerdict(cleanParserMessageText(prompting.content, { keepLedger: true }) || prompting.content).ooc) {
      const names = allKnownProfiles(await getStoryProfiles(preset, settings, userId, chatId))
        .flatMap((profile) => [profile.anchor, profile.promptName])
      const shape = assistantReplyIsMeta(targetText, names)
      spindle.log.info('[lumidraw] the message before this one was out of character · ' +
        (shape.meta ? 'skipping — ' : 'illustrating anyway — ') + shape.reason)
      if (shape.meta) oocVerdict = { ooc: true, reason: `the message before it was out of character and ${shape.reason}` }
    }
  }
  if (oocVerdict.ooc) {
    const note = `Skipped: ${oocVerdict.reason}.`
    spindle.log.info('[lumidraw] out-of-character message skipped · ' + oocVerdict.reason +
      (target.id ? ' · message=' + target.id : ''))
    // Reported as a skip rather than left looking like a silent failure.
    setAutoStatus(userId, { status: 'skipped', note, messageId: String(target.id || ''), mode: settings.mode })
    if (scan) setStoryScanStage(scan, 'done', note)
    return { mode: settings.mode, processed: 0, skipped: true, outOfCharacter: true, note }
  }

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
        const inlineAlt = markdownAltText(compiled.core)
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
            origin: { messageId: String(target.id || ''), chatId: String(chatId || ''), contentKey: target.contentKey || '', presetName: preset.name || '', mode: 'inline', alt: inlineAlt },
          }, userId)
        }
        const md = `![${inlineAlt}](${entry.images[0].url})`
        content = content.replace(m[0], md)
        debugEntries.push({
          format: compiled.format,
          raw: body,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
          compiler: compiled.compiler || 'anima-hybrid-v14',
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
    const passage = cleanParserMessageText(target.content).slice(-6000)

    if (settings.parserEngine === 'anima') {
      // Hand the parser the location outright rather than hoping it survives
      // inside the recency window.
      const rememberedState = await readSceneMemory(chatId, preset.name)
      const anchorForParser = tagsFrom(preset.sceneAnchor || '', 8)
      const parserSceneState = {
        setting: (rememberedState.setting || []).length ? rememberedState.setting : anchorForParser,
        lighting: rememberedState.lighting || [],
      }
      const parserInput = buildAnimaParserInput(messages, targetIndex, target, settings, parserSceneState)
      if (parserSceneState.setting.length) {
        spindle.log.info('[lumidraw] established scene state supplied to parser · ' + parserSceneState.setting.join(', '))
      }
      const profiles = await getStoryProfiles(preset, settings, userId, chatId)
      const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
        .replaceAll('{{max_images}}', String(settings.maxImages || 2))
        .replaceAll('{{min_images}}', String(settings.minImages || 0))
      const resolvedGuidance = await resolveMacros(guidance, userId, chatId)
      const instruction = resolvedGuidance + structuredParserSchema(settings.maxImages || 2, profiles, settings.minImages || 0)
      const instrLabel = usingCustom ? `custom guidance + structured compiler (${instruction.length} chars)` : 'structured subject compiler'
      setStoryScanStage(scan, 'parsing', 'Waiting for the selected parser model.')
      spindle.log.info('[lumidraw] Anima parser context · previous_messages=' + parserInput.contextMessageCount + ' · loom_ledger=' + (parserInput.ledgerFound ? 'found' : 'none'))
      const out = await quietLLM(instruction, parserInput.input, settings, userId, true, scan)
      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'compiling', 'Parser returned structured JSON; compiling the Anima prompt.')
      let parsed
      try {
        parsed = parseParserScenes(out, settings.maxImages || 2, profiles)
      } catch (error) {
        const storyDebug = await saveStoryDebug({
          mode: 'parser',
          parserEngine: 'anima',
          subjectBinding: true,
          rawReply: out,
          error: error.message,
          entries: [],
          lastCompiledPrompt: '',
          contextPreview: parserInput.contextPreview,
          ledgerPreview: parserInput.ledgerPreview,
          contextMessageCount: parserInput.contextMessageCount,
          ledgerFound: parserInput.ledgerFound,
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
        const storyDebug = await saveStoryDebug({ mode: 'parser', parserEngine: 'anima', subjectBinding: true, rawReply: out, entries: [], lastCompiledPrompt: '', contextPreview: parserInput.contextPreview, ledgerPreview: parserInput.ledgerPreview, contextMessageCount: parserInput.contextMessageCount, ledgerFound: parserInput.ledgerFound })
        return { mode: 'parser', messageId: String(target.id || ''), note: `Parser (${instrLabel}) judged no visual moment.`, storyDebug }
      }

      const mds = []
      const debugEntries = []
      const limitedParsed = parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2)))
      const acceptedParsed = []
      for (let i = 0; i < limitedParsed.length; i++) {
        const item = limitedParsed[i]
        const assessment = assessStructuredScene(item.scene)
        if (!assessment.valid) {
          const error = `Incomplete structured scene — ${assessment.summary}.`
          spindle.log.warn('[lumidraw] parser scene rejected before Draw Things · image=' + (i + 1) + ' · ' + error)
          debugEntries.push({ anchor: item.anchor, scene: item.scene, rejected: true, error, assessment })
        } else {
          if (assessment.warnings.length) spindle.log.warn('[lumidraw] parser scene accepted with warning · image=' + (i + 1) + ' · ' + assessment.summary)
          acceptedParsed.push(item)
        }
      }
      if (!acceptedParsed.length) {
        const reason = debugEntries.map((entry) => entry.error).filter(Boolean).join(' ') || 'Structured parser returned no complete visual scenes.'
        const storyDebug = await saveStoryDebug({
          mode: 'parser',
          parserEngine: 'anima',
          subjectBinding: true,
          rawReply: out,
          error: reason,
          entries: debugEntries,
          lastCompiledPrompt: '',
          contextPreview: parserInput.contextPreview,
          ledgerPreview: parserInput.ledgerPreview,
          contextMessageCount: parserInput.contextMessageCount,
          ledgerFound: parserInput.ledgerFound,
        })
        if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
        return { mode: 'parser', processed: 0, note: `Parser result was incomplete, so LumiDraw skipped Draw Things rather than generating a character-only image. ${reason}`, storyDebug }
      }
      let parserImageIndex = 0
      for (const item of acceptedParsed) {
        parserImageIndex++
        assertStoryScanActive(scan)
        setStoryScanStage(scan, 'generating', `Sending image ${parserImageIndex} of ${acceptedParsed.length} to Draw Things.`)
        const compiled = await compileSceneWithPreset(item.scene, preset, settings, userId, chatId, passage, parserInput.contextPreview || '')
        const dims = aspectDims(preset.config, compiled.aspect)
        const parserAlt = markdownAltText(compiled.core)
        const entry = await generateAndUpload({
          prompt: compiled.prompt,
          negativePrompt: negativeWith(preset.negativePrompt, compiled.garmentNegatives),
          config: preset.config,
          extra: preset.extra,
          dims,
          // Which of the message's moments this is. A story message can yield
          // several images and, opened later out of context, they are
          // indistinguishable — including to the person deciding which one to
          // re-parse.
          origin: {
            messageId: String(target.id || ''), chatId: String(chatId || ''),
            contentKey: target.contentKey || '', presetName: preset.name || '',
            mode: 'parser', alt: parserAlt,
            sceneIndex: parserImageIndex, sceneCount: acceptedParsed.length,
            sceneStatement: (item.scene && item.scene.sceneStatement) || '',
          },
        }, userId, scan)
        mds.push(`![${parserAlt}](${entry.images[0].url})`)
        debugEntries.push({
          anchor: item.anchor,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
          compiler: compiled.compiler || 'anima-hybrid-v14',
        })
      }

      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'inserting', 'Adding generated images to the story message.')
      let newContent = target.content
      const topMds = []
      const generatedParsed = acceptedParsed.slice(0, mds.length)
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
        lastCompiledPrompt: debugEntries.find((entry) => entry.compiledPrompt)?.compiledPrompt || '',
        contextPreview: parserInput.contextPreview,
        ledgerPreview: parserInput.ledgerPreview,
        contextMessageCount: parserInput.contextMessageCount,
        ledgerFound: parserInput.ledgerFound,
      })
      return {
        mode: 'parser',
        messageId: String(target.id || ''),
        processed: mds.length,
        note: `Illustrated ${mds.length} moment(s) via ${instrLabel}. First compiled prompt: ${(debugEntries.find((entry) => entry.compiledPrompt)?.compiledPrompt || '').slice(0, 120)}`,
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
        origin: { messageId: String(target.id || ''), chatId: String(chatId || ''), contentKey: target.contentKey || '', presetName: preset.name || '', mode: 'legacy-parser' },
      }, userId, scan)
      mds.push(`![${markdownAltText(line)}](${entry.images[0].url})`)
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
    return { mode: 'parser', messageId: String(target.id || ''), processed: mds.length, note: `Illustrated ${mds.length} moment(s) via ${instrLabel}. First prompt: ` + firstPrompt.slice(0, 120), storyDebug }
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


// Shared by "Re-run parser" (one image) and "Replace all" (every image in the
// message). One parse, however many images are being rebuilt — changing a
// character's tags does not need a new reading of the passage, only a new
// compile of the same scenes.
async function reparseSourceMessage(userId, imageUrl, overrides = {}) {
  const history = await getHistory()
  const source = history.find((item) => (item.images || []).some((image) => image && image.url === imageUrl))
  const origin = (source && source.origin) || {}
  const messageId = String(origin.messageId || '').trim()
  if (!messageId) {
    throw new Error('This image has no recorded source message, so there is no passage to re-parse. Only images made by a story scan can be re-parsed.')
  }

  const saved = await getSettings()
  const settings = { ...saved }
  if (overrides.parserModel !== undefined) settings.parserModel = String(overrides.parserModel || '').trim()
  if (overrides.parserConnection) settings.parserConnection = String(overrides.parserConnection).trim()

  const presets = await getPresets()
  // The active preset wins here, unlike a plain regeneration. Re-running the parser
  // exists to apply the settings you have now — a new instruction, an edited
  // character, a different negative prompt. Inheriting the preset the image was
  // originally made under meant a new prompt compiled against an old preset's
  // negative prompt, banned tags and scene anchor, none of which you were using.
  const preset = presets.find((item) => item.name === settings.activePreset)
    || presets.find((item) => item.name === origin.presetName)
  if (!preset) throw new Error('No preset available to compile against.')
  if (origin.presetName && preset.name !== origin.presetName) {
    spindle.log.info(`[lumidraw] re-parsing against the active preset "${preset.name}". ` +
      `This image was originally made under "${origin.presetName}" — its negative prompt and banned tags no longer apply.`)
  }

  const { messages, chatId: resolvedChatId } = await fetchMessages(userId, String(origin.chatId || '').trim())
  const chatId = String(origin.chatId || resolvedChatId || '')
  const targetIndex = messages.findIndex((message) => String((message.id || message.messageId) || '') === messageId)
  if (targetIndex < 0) {
    throw new Error(`The source message (${messageId}) is no longer in this chat, so its passage cannot be re-read.`)
  }
  const target = messageBits(messages[targetIndex])
  if (!target.content) throw new Error('The source message has no readable text.')

  const passage = cleanParserMessageText(target.content).slice(-6000)
  const rememberedState = await readSceneMemory(chatId, preset.name)
  const anchorTags = tagsFrom(preset.sceneAnchor || '', 8)
  const parserInput = buildAnimaParserInput(messages, targetIndex, target, settings, {
    setting: (rememberedState.setting || []).length ? rememberedState.setting : anchorTags,
    lighting: rememberedState.lighting || [],
  })
  const profiles = await getStoryProfiles(preset, settings, userId, chatId)
  const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
    .replaceAll('{{max_images}}', String(settings.maxImages || 2))
    .replaceAll('{{min_images}}', String(settings.minImages || 0))
  const instruction = (await resolveMacros(guidance, userId, chatId)) +
    structuredParserSchema(settings.maxImages || 2, profiles, settings.minImages || 0)

  const startedAt = Date.now()
  const report = {}
  const raw = await quietLLM(instruction, parserInput.input, settings, userId, true, null, report)
  const parserMs = Date.now() - startedAt

  let parsed = []
  let parseError = ''
  try {
    parsed = parseParserScenes(raw, settings.maxImages || 2, profiles)
  } catch (error) {
    parseError = error.message
  }

  const results = []
  if (!parseError) {
    for (const item of parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2)))) {
      const assessment = assessStructuredScene(item.scene)
      if (!assessment.valid) {
        results.push({ ok: false, anchor: item.anchor || '', note: `Incomplete scene — ${assessment.summary}.` })
        continue
      }
      const compiled = await compileSceneWithPreset(
        item.scene, preset, settings, userId, chatId, passage, parserInput.contextPreview || '')
      results.push({
        ok: true,
        anchor: item.anchor || '',
        sceneStatement: (compiled.scene && compiled.scene.sceneStatement) || '',
        prompt: compiled.prompt,
        core: compiled.core,
        aspect: compiled.aspect || '',
        negativePrompt: negativeWith(preset.negativePrompt, compiled.garmentNegatives),
        warnings: assessment.warnings,
        trace: compiled.trace || [],
      })
    }
  }

  return { origin, messageId, chatId, preset, settings, results, report, parserMs, raw, parseError }
}

// Generate one replacement image and swap it into the story message in place.
// Extracted from the regenerate_image case so bulk replacement runs exactly the
// same path, including the URL-matching fallbacks that took three attempts to
// get right in 0.22.x. One implementation, one set of bugs.
async function replaceOneImage(userId, payload) {
      const imageUrl = String(payload.imageUrl || '').trim()
      if (!imageUrl) throw new Error('Regeneration needs the image being replaced.')
      const prompt = String(payload.prompt || '').trim()
      if (!prompt) throw new Error('The prompt cannot be empty.')

      const history = await getHistory()
      const source = history.find((item) => (item.images || []).some((image) => image && image.url === imageUrl))
      const origin = (source && source.origin) || {}

      // Recipe priority: the exact config this image was made with, then the
      // preset it came from, then the active preset. A regeneration must not
      // silently switch models because a preset was edited since.
      let config = source && source.recipe && source.recipe.config ? source.recipe.config : null
      let extra = source && source.recipe ? source.recipe.extra : null
      if (!config) {
        const presets = await getPresets()
        const settings = await getSettings()
        const preset = presets.find((item) => item.name === (origin.presetName || settings.activePreset))
        if (!preset) throw new Error('No saved recipe for this image and no matching preset to fall back on.')
        config = preset.config
        extra = preset.extra
      }

      const reuseSeed = payload.reuseSeed !== false
      const previousSeed = source && source.seed !== undefined && source.seed !== 'random' ? Number(source.seed) : NaN
      const seed = reuseSeed && Number.isFinite(previousSeed) ? previousSeed : undefined

      const entry = await generateAndUpload({
        prompt,
        negativePrompt: String(payload.negativePrompt || ''),
        config,
        extra,
        seed,
        origin: { ...origin, regeneratedFrom: imageUrl },
      }, userId)

      const newUrl = entry.images && entry.images[0] ? entry.images[0].url : ''
      if (!newUrl) throw new Error('Draw Things returned no image.')

      // Put it back where the old one was. A failure here is not fatal: the
      // new image already exists in History and the panel says so.
      let replaced = false
      let note = ''
      try {
        const sourceImage = source && (source.images || []).find((image) => image && image.url === imageUrl)
        const target = await locateMessageByImageUrl(userId, imageUrl, {
          ...origin,
          imageId: sourceImage && sourceImage.id ? sourceImage.id : '',
          promptText: source && source.prompt ? source.prompt : '',
          chatImageUrl: String(payload.chatImageUrl || '').trim(),
        })
        if (!target || target.notFound) {
          if (target && target.ambiguous) {
            note = 'Generated and saved to History, but this message holds several images with the same prompt opening and the exact one could not be identified — nothing was replaced, so no good image was overwritten. Click the image directly in the chat and fix it from there; that identifies it precisely.'
          } else {
            const scanned = target && target.scanned ? target.scanned : []
            const where = scanned.length
              ? scanned.map((item) => `${item.chatId || 'active chat'} (${item.messages} messages)`).join(', ')
              : 'no chat could be read'
            const sample = target && target.sampleRefs && target.sampleRefs.length
              ? ` Image references that ARE present look like: ${target.sampleRefs.slice(0, 3).join(' · ')}`
              : ' Those messages contain no image references at all.'
            note = `Generated and saved to History, but the original image was not found in any message. Searched: ${where}.${sample}`
          }
        } else {
          // Swap on whatever actually matched — the full URL, the id or
          // filename if the host rewrote the markdown — trying each encoded
          // spelling the stored text might use.
          const swapCandidates = uniqueStrings([
            ...needleEncodings(imageUrl),
            ...(target.matchedNeedle ? needleEncodings(target.matchedNeedle) : []),
          ])
          let swap = { content: target.content, replaced: false }
          for (const candidate of swapCandidates) {
            const attempt = replaceImageUrlInContent(target.content, candidate, newUrl)
            if (attempt.replaced) { swap = attempt; break }
          }
          if (!swap.replaced) {
            note = 'Generated, but the original image markdown could not be matched — it is in History.'
          } else {
            // A chat id is required for the chat-scoped updateMessage shapes;
            // without one the host rejects every attempt with "Chat not found".
            let chatId = String(target.chatId || origin.chatId || '').trim()
            if (!chatId) chatId = String((await resolveActiveChatId(userId)) || '')
            if (!chatId) throw new Error('could not determine which chat this message belongs to.')
            await updateMessageContent(target.id, target.contentKey, swap.content, userId, chatId)
            replaced = true
            note = 'Replaced the image in the story message.'
          }
        }
      } catch (error) {
        note = 'Generated, but replacing it in the message failed: ' + error.message
        spindle.log.warn('[lumidraw] regeneration replace failed: ' + error.message)
      }

  return { entry, newUrl, replaced, note }
}

spindle.onFrontendMessage(async (payload, userId) => {
  if (userId) lastUserId = userId
  const requestId = payload && payload.requestId
  let reply
  try {
    switch (payload && payload.type) {
      case 'init': {
        const [settings, presets, personas, characters, history, storyDebug] = await Promise.all([
          getSettings(), getPresets(), getPersonas(), getCharacters(), getHistory(), getStoryDebug(),
        ])
        reply = ok(payload, requestId, {
          settings, presets, personas, characters, history, storyDebug, lastAutoStatus,
          version: (spindle.manifest && spindle.manifest.version) || '',
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
        if (payload.useLoomLedger !== undefined) settings.useLoomLedger = !!payload.useLoomLedger
        if (payload.stripImageDirectives !== undefined) settings.stripImageDirectives = !!payload.stripImageDirectives
        if (payload.sizeChatImages !== undefined) settings.sizeChatImages = !!payload.sizeChatImages
        if (payload.chatImageWidth !== undefined) {
          settings.chatImageWidth = Math.min(1200, Math.max(200, Number(payload.chatImageWidth) || 500))
        }
        if (payload.parserContextMessages !== undefined) settings.parserContextMessages = Math.max(0, Math.min(4, Number(payload.parserContextMessages) || 0))
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
          ' · generation-ended=' + (payload.generationEndedListener ? 'ready' : 'missing') +
          ' · rendered-event=' + (payload.renderedEventListener ? 'ready' : 'missing') +
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
        const scheduled = scheduleAutoStoryScan(userId, {
          messageId: payload.messageId,
          chatId: payload.chatId,
          source: 'parser-tag',
          delayMs: 650,
        })
        reply = ok(payload, requestId, scheduled)
        break
      }

      case 'generation_ended': {
        const scheduled = scheduleAutoStoryScan(userId, {
          messageId: payload.messageId,
          chatId: payload.chatId,
          content: payload.content,
          source: 'frontend-generation-ended',
          delayMs: 350,
        })
        reply = ok(payload, requestId, scheduled)
        break
      }

      case 'character_message_rendered': {
        const scheduled = scheduleAutoStoryScan(userId, {
          messageId: payload.messageId,
          chatId: payload.chatId,
          source: 'frontend-character-rendered',
          delayMs: 500,
        })
        reply = ok(payload, requestId, scheduled)
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
          chatId: payload.chatId,
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
        // Capture every setting Draw Things reports, not a fixed slice. The
        // keys are DT's own, so Studio can offer all of them without guessing
        // names, and a preset saved from Studio pins the complete recipe.
        const captured = {}
        for (const [key, value] of Object.entries(config || {})) {
          if (RESERVED_PAYLOAD_KEYS.has(key)) continue
          if (value === undefined || value === null) continue
          captured[key] = value
        }
        try { await rememberModels(captured) } catch { /* best-effort */ }
        reply = ok(payload, requestId, { captured, fullConfig: config })
        break
      }

      case 'save_preset': {
        const name = String(payload.name || '').trim()
        if (!name) throw new Error('Preset needs a name.')
        if (!payload.config) {
          throw new Error('Preset has no configuration — sync from Draw Things first.')
        }
        if (!payload.config.model) {
          spindle.log.info(`[lumidraw] preset "${name}" saved with no model — Draw Things will use the model selected in its own UI`)
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
          personaLibraryId: String(payload.personaLibraryId || '').trim(),
          characterLibraryId: String(payload.characterLibraryId || '').trim(),
          castLibraryIds: Array.isArray(payload.castLibraryIds)
            ? uniqueStrings(payload.castLibraryIds.map((id) => String(id || '').trim()).filter(Boolean)).slice(0, 4)
            : [],
          bannedTags: payload.bannedTags || '',
          sceneAnchor: String(payload.sceneAnchor || '').trim(),
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

      case 'save_persona': {
        const name = String(payload.name || '').trim()
        if (!name) throw new Error('Persona needs a library name.')
        const profileInput = payload.profile && typeof payload.profile === 'object' ? { ...payload.profile } : {}
        if (!String(profileInput.anchor || '').trim()) profileInput.anchor = name
        normalizeProfile(profileInput, profileInput.appearanceTags || '', 'persona')
        const personas = await getPersonas()
        const id = String(payload.id || '').trim() || `persona_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const entry = { id, name, profile: profileInput, updatedAt: Date.now() }
        const index = personas.findIndex((item) => item && item.id === id)
        if (index >= 0) personas[index] = entry
        else personas.push(entry)
        personas.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        await savePersonas(personas)
        reply = ok(payload, requestId, { personas, entry })
        break
      }

      case 'delete_persona': {
        const id = String(payload.id || '').trim()
        const personas = (await getPersonas()).filter((item) => item && item.id !== id)
        await savePersonas(personas)
        reply = ok(payload, requestId, { personas })
        break
      }

      case 'save_character': {
        const name = String(payload.name || '').trim()
        if (!name) throw new Error('Character needs a library name.')
        const profileInput = payload.profile && typeof payload.profile === 'object' ? { ...payload.profile } : {}
        if (!String(profileInput.anchor || '').trim()) profileInput.anchor = name
        normalizeProfile(profileInput, profileInput.appearanceTags || '', 'character')
        const characters = await getCharacters()
        const id = String(payload.id || '').trim() || `character_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const entry = { id, name, profile: profileInput, updatedAt: Date.now() }
        const index = characters.findIndex((item) => item && item.id === id)
        if (index >= 0) characters[index] = entry
        else characters.push(entry)
        characters.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        await saveCharacters(characters)
        reply = ok(payload, requestId, { characters, entry })
        break
      }

      // Re-runs the parser over the passage that produced an existing image and
      // returns the freshly compiled prompt(s) WITHOUT generating anything.
      // The point is comparison: swap the parser model, press the button, and
      // read the two prompts side by side for the cost of one parser call and
      // no Draw Things time.
      // Lets the user see and reset what Draw Things has refused, so a DT
      // update that adds support for a setting is one button away from being
      // usable again.
      case 'dt_rejected_keys': {
        if (payload.clear) {
          await forgetRejectedKeys()
          spindle.log.info('[lumidraw] cleared the rejected Draw Things settings list')
        }
        const keys = [...(await getRejectedKeys())].sort()
        reply = ok(payload, requestId, { keys })
        break
      }

      // One parse, every image in the message rebuilt in place. The use that
      // motivated it is not a new reading of the passage at all — it is having
      // changed a character's tags and wanting that applied to images already
      // written into the story.
      case 'regenerate_message_images': {
        const imageUrl = String(payload.imageUrl || '').trim()
        if (!imageUrl) throw new Error('Rebuilding needs to know which message to work from.')

        const parse = await reparseSourceMessage(userId, imageUrl, payload)
        if (parse.parseError) throw new Error(`Parser returned invalid structured data: ${parse.parseError}`)
        const usable = parse.results.filter((item) => item.ok)
        if (!usable.length) throw new Error('The parser produced no usable scene, so nothing was changed.')

        // Every image this message produced, in the order they were made.
        const history = await getHistory()
        const siblings = history
          .filter((item) => item && item.origin && String(item.origin.messageId || '') === parse.messageId)
          .filter((item) => (item.images || []).length)
          .sort((a, b) => Number((a.origin || {}).sceneIndex || 0) - Number((b.origin || {}).sceneIndex || 0))
        if (!siblings.length) throw new Error('No images from this message were found in History.')

        const count = Math.min(siblings.length, usable.length)
        const replaced = []
        const notes = []
        if (usable.length < siblings.length) {
          notes.push(`The parser found ${usable.length} moment(s) but this message has ${siblings.length} image(s); the last ${siblings.length - usable.length} were left alone.`)
        }

        for (let index = 0; index < count; index++) {
          const entry = siblings[index]
          const oldUrl = entry.images[0] && entry.images[0].url
          if (!oldUrl) continue
          const scene = usable[index]
          notifyFrontend(userId, 'bulk_regen_progress', { index: index + 1, total: count, statement: scene.sceneStatement || '' })
          try {
            const swap = await replaceOneImage(userId, {
              imageUrl: oldUrl,
              prompt: scene.prompt,
              negativePrompt: scene.negativePrompt,
              reuseSeed: false,
              chatImageUrl: '',
            })
            replaced.push({ index: index + 1, ok: swap.replaced, newUrl: swap.newUrl, note: swap.note })
            if (!swap.replaced) notes.push(`Image ${index + 1}: ${swap.note}`)
          } catch (error) {
            replaced.push({ index: index + 1, ok: false, note: error.message })
            notes.push(`Image ${index + 1} failed: ${error.message}`)
          }
        }

        const good = replaced.filter((item) => item.ok).length
        reply = ok(payload, requestId, {
          history: await getHistory(),
          replaced,
          total: count,
          parserMs: parse.parserMs,
          model: parse.report.model || '',
          note: `${good} of ${count} image(s) replaced.${notes.length ? ' ' + notes.join(' ') : ''}`,
        })
        break
      }

      // Re-parse the passage behind one image and return the compiled prompt(s)
      // WITHOUT generating. Shares its parse with "Replace all images".
      case 'reparse_image': {
        const imageUrl = String(payload.imageUrl || '').trim()
        if (!imageUrl) throw new Error('Re-parsing needs to know which image to work from.')

        const parse = await reparseSourceMessage(userId, imageUrl, payload)
        if (parse.parseError) {
          reply = ok(payload, requestId, {
            reparsed: false,
            note: `Parser returned invalid structured data: ${parse.parseError}`,
            parserMs: parse.parserMs,
            model: parse.report.model || '',
            overrideNote: parse.report.overrideNote || '',
            raw: String(parse.raw || '').slice(0, 600),
          })
          break
        }
        const usable = parse.results.filter((item) => item.ok).length
        if (!parse.results.length) {
          reply = ok(payload, requestId, {
            reparsed: false,
            note: 'The parser judged this passage to have no visual moment.',
            parserMs: parse.parserMs,
            model: parse.report.model || '',
            overrideNote: parse.report.overrideNote || '',
            raw: String(parse.raw || '').slice(0, 600),
          })
          break
        }

        spindle.log.info(`[lumidraw] re-parsed message ${parse.messageId} in ${parse.parserMs}ms · ${usable}/${parse.results.length} scene(s) usable`)
        reply = ok(payload, requestId, {
          reparsed: usable > 0,
          results: parse.results,
          parserMs: parse.parserMs,
          model: parse.report.model || '',
          requestedModel: parse.report.requestedModel || '',
          provider: parse.report.provider || '',
          overrideNote: parse.report.overrideNote || '',
          reasoningTokens: parse.report.reasoningTokens ?? null,
          usage: parse.report.usage || null,
          presetName: parse.preset.name || '',
          messageId: parse.messageId,
          note: usable
            ? `Parsed in ${(parse.parserMs / 1000).toFixed(1)}s — ${usable} of ${parse.results.length} scene(s) usable.`
            : 'The parser ran but produced no usable scene.',
        })
        break
      }

      case 'regenerate_image': {
        const outcome = await replaceOneImage(userId, payload)
        reply = ok(payload, requestId, {
          history: await getHistory(),
          entry: outcome.entry,
          newUrl: outcome.newUrl,
          replaced: outcome.replaced,
          note: outcome.note,
        })
        break
      }

      case 'delete_character': {
        const id = String(payload.id || '').trim()
        const characters = (await getCharacters()).filter((item) => item && item.id !== id)
        await saveCharacters(characters)
        reply = ok(payload, requestId, { characters })
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
        // Studio is fully isolated from Story presets and identity profiles.
        // Send exactly what the user entered in Studio (plus explicit Studio
        // workspace config), with no hidden quality tags, character tags,
        // persona tags, macros, or preset extras injected.
        const manualPrompt = String(payload.prompt || '').trim()
        const payloadOut = buildPayload({
          prompt: manualPrompt,
          negativePrompt: payload.negativePrompt,
          seed: payload.seed,
          config: payload.config,
          extra: null,
        })
        if (!payloadOut.model) {
          spindle.log.info('[lumidraw] Studio generation sent with no model — Draw Things will use the model selected in its own UI')
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
        // Push the completed result independently of the request reply. This
        // keeps remote/mobile clients synchronized if the original response is
        // delayed or dropped after Draw Things has already finished.
        notifyFrontend(userId, 'history_updated', { history, entry, source: 'studio' })
        spindle.log.info('[lumidraw] Studio generation saved · images=' + uploads.length + ' · duration=' + entry.durationMs + 'ms')
        reply = ok(payload, requestId, { entry, history })
        break
      }

      case 'append_to_chat': {
        // Places a generated image INTO the latest story message (prepended
        // at its top) via getMessages + updateMessage. Falls back to
        // appending a new assistant message if in-place editing fails.
        const { imageUrl, alt, chatId } = payload
        if (!imageUrl) throw new Error('No image URL to add.')
        const md = `![${markdownAltText(alt || 'Generated image', 120)}](${imageUrl})`

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
      let messages = Array.isArray(a) ? a : (wrapped ? a.messages : null)
      const settings = await getSettings()
      if (!messages) {
        spindle.log.warn('[lumidraw] interceptor invoked with unrecognized arg shape: ' +
          (a === null ? 'null' : typeof a) + (a && typeof a === 'object' ? ' keys=' + Object.keys(a).join(',') : ''))
        return a
      }
      spindle.log.info(`[lumidraw] interceptor invoked (mode=${settings.mode}, msgs=${messages.length}, wrapped=${wrapped})`)
      if (settings.mode !== 'inline' && settings.mode !== 'parser') return a

      // Scrub dead image-request directives from the model's view of the
      // conversation. This edits only the copy being sent for this generation;
      // the stored chat is untouched.
      let working = messages
      if (settings.stripImageDirectives !== false) {
        let stripped = 0
        working = messages.map((message) => {
          if (!message || typeof message !== 'object') return message
          const key = typeof message.content === 'string' ? 'content'
            : (typeof message.text === 'string' ? 'text' : null)
          if (!key) return message
          const result = stripForeignImageDirectives(message[key])
          if (!result.count) return message
          stripped += result.count
          return { ...message, [key]: result.text }
        })
        if (stripped) {
          spindle.log.info('[lumidraw] removed ' + stripped + ' image reference(s) from the prompt context so the story model does not learn to imitate them (stored messages unchanged)')
        }
      }
      messages = working
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

// Automatic illustration event fan-in. GENERATION_ENDED is authoritative
// because it fires after the assistant message has been saved and carries the
// exact chat/message IDs. CHARACTER_MESSAGE_RENDERED and the frontend XML tag
// listener remain compatibility fallbacks; scheduleAutoStoryScan deduplicates
// all three sources before any parser cost is incurred.
;(() => {
  const on = (typeof spindle.on === 'function') ? spindle.on.bind(spindle)
    : (spindle.events && typeof spindle.events.on === 'function') ? spindle.events.on.bind(spindle.events)
    : null
  if (!on) {
    spindle.log.warn('[lumidraw] lifecycle events unavailable — frontend events, parser tag, and manual scan remain available')
    return
  }

  const normalizedPayload = (evt) => evt && evt.payload ? evt.payload : evt || {}

  try {
    on('GENERATION_ENDED', (evt) => {
      try {
        const payload = normalizedPayload(evt)
        if (payload.error) return
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || lastUserId
        if (!uid || !messageId || !chatId) return
        scheduleAutoStoryScan(uid, {
          messageId,
          chatId,
          content: payload.content || eventMessage.content || eventMessage.text || '',
          source: 'backend-generation-ended',
          delayMs: 300,
        })
      } catch (error) {
        spindle.log.warn('[lumidraw] GENERATION_ENDED handler failed: ' + error.message)
      }
    })
    spindle.log.info('[lumidraw] documented GENERATION_ENDED auto trigger registered')
  } catch (error) {
    spindle.log.warn('[lumidraw] GENERATION_ENDED registration failed: ' + error.message)
  }

  try {
    on('CHARACTER_MESSAGE_RENDERED', (evt) => {
      try {
        const payload = normalizedPayload(evt)
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || lastUserId
        if (!uid || !messageId || !chatId) return
        scheduleAutoStoryScan(uid, {
          messageId,
          chatId,
          source: 'backend-character-rendered',
          delayMs: 500,
        })
      } catch (error) {
        spindle.log.warn('[lumidraw] CHARACTER_MESSAGE_RENDERED handler failed: ' + error.message)
      }
    })
    spindle.log.info('[lumidraw] documented CHARACTER_MESSAGE_RENDERED fallback registered')
  } catch (error) {
    spindle.log.warn('[lumidraw] CHARACTER_MESSAGE_RENDERED registration failed: ' + error.message)
  }
})()

spindle.log.info('[lumidraw] spindle API surface: ' + Object.keys(spindle).join(', '))
spindle.log.info('[lumidraw] backend loaded v' + ((spindle.manifest && spindle.manifest.version) || 'unknown — no manifest'))
