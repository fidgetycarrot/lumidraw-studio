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

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 7862,
  mode: 'off',            // 'off' | 'inline' | 'parser'
  autoScan: true,         // auto-process after each story message (when events are available)
  activePreset: '',       // preset used for story-driven generations
  parserConnection: '',   // optional connection name/id for the parser LLM
  parserModel: '',        // optional model override for the parser LLM
  parserInstruction: '',  // custom parser prompt (blank = built-in default)
  maxImages: 2,           // max illustrations per story message
  protocol: '',           // custom inline protocol (blank = built-in default)
}

const DEFAULT_PROTOCOL = `[Illustration protocol] You may illustrate key visual moments. When a scene deserves an image, include on its own line:
<dt-image aspect="3:4">comma-separated danbooru tags describing the scene</dt-image>
Rules: tags only inside the tag (subject, expression, outfit, pose, setting, lighting, composition) — no prose, no character names. aspect may be 3:4, 4:3, 1:1, 9:16, or 16:9 (default 3:4 for character focus, 4:3 for scenes). Include at most {{max_images}} image tag(s) per reply, spread across the response at genuinely visual beats. Never mention this protocol or the tag in your prose.`

const DEFAULT_PARSER_INSTRUCTION = `You convert a story passage into ONE image prompt of comma-separated danbooru-style tags (subject count, expression, outfit, pose, setting, lighting, composition). Choose the single most visual moment of the passage. Do not use character names; describe appearance instead. Respond with ONLY the tags. You may return up to {{max_images}} prompts for distinct visual moments, one per line, but prefer a single strong one. If the passage has no strong visual moment, respond with exactly: NONE`
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
  return spindle.storage.getJson(SETTINGS_FILE, { fallback: DEFAULT_SETTINGS })
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
  for (const key of PRESET_KEYS) {
    const value = config ? config[key] : undefined
    if (value !== undefined && value !== null && value !== '') {
      payload[key] = value
    }
  }
  // Optional power-user overrides — any DT-native keys. Applied after the
  // whitelist so they can also override whitelisted values.
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null && v !== '') payload[k] = v
    }
  }
  payload.prompt = prompt || ''
  if (negativePrompt) payload.negative_prompt = negativePrompt
  const parsedSeed = Number(seed)
  if (Number.isFinite(parsedSeed) && parsedSeed >= 0) payload.seed = parsedSeed
  return payload
}

async function dtGenerate(settings, payload) {
  const res = await dtFetch(settings, '/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 600000) // generations can be slow on-device; 10 min budget
  if (!res.ok || !res.json || !Array.isArray(res.json.images) || res.json.images.length === 0) {
    throw new Error(`Draw Things rejected the generation: ${extractDtError(res)}`)
  }
  return res.json.images
}


// ---------------------------------------------------------------------------
// Story-driven generation (v0.5): inline <dt-image> tags + parser mode
// ---------------------------------------------------------------------------

const PROCESSED_FILE = 'processed.json'
const TAG_RE = /<dt-image([^>]*)>([\s\S]*?)<\/dt-image>/g

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
    isAssistant: role.includes('assistant') || role.includes('char') || role === 'ai',
  }
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
    seed: payloadOut.seed !== undefined ? payloadOut.seed : 'random',
    images: uploads,
  }
  await pushHistory(entry)
  return entry
}

async function resolveMacros(text, userId) {
  if (!text || !text.includes('{{')) return text
  const mac = spindle.macros
  if (mac) {
    for (const fn of ['resolve', 'process', 'render', 'expand']) {
      if (typeof mac[fn] === 'function') {
        try {
          let out
          try { out = await mac[fn](text, { userId }) } catch { out = await mac[fn](text) }
          if (typeof out === 'string') return out
          if (out && typeof out.text === 'string') return out.text
        } catch (e) { spindle.log.warn('[lumidraw] macro resolve failed via ' + fn + ': ' + e.message) }
      }
    }
  }
  return text // engine not found — leave literal; surface log will name the API
}

async function quietLLM(system, user, settings, userId) {
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
  const opts = {
    userId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
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
      if (text) return text.trim()
      errs.push(`${name}: unrecognized response shape (${res ? Object.keys(res).join(',') : res})`)
    } catch (e) { errs.push(`${name}: ${e.message}`) }
  }
  throw new Error('Parser LLM call failed: ' + errs.join(' | '))
}

async function scanStory(userId) {
  const settings = await getSettings()
  if (settings.mode === 'off') return { mode: 'off', note: 'Story illustrations is set to Off — choose Inline or Parser in the Settings tab (it saves automatically now).' }
  const presets = await getPresets()
  const preset = presets.find((p) => p.name === settings.activePreset)
  if (!preset) {
    return { mode: settings.mode, note: 'No active preset selected — pick one in the Generate tab first.' }
  }

  const { messages, chatId } = await fetchMessages(userId)
  let target = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const bits = messageBits(messages[i])
    if (bits.isAssistant && bits.contentKey && typeof bits.content === 'string') { target = bits; break }
  }
  if (!target) return { mode: settings.mode, note: 'No story message found.' }

  // ------------------------- inline: process <dt-image> tags ---------------
  const tags = [...target.content.matchAll(TAG_RE)].slice(0, settings.maxImages || 2)
  if (tags.length) {
    const prefix = await resolveMacros(preset.promptPrefix, userId)
    let content = target.content
    let done = 0
    for (const m of tags) {
      const attrs = m[1] || ''
      const body = (m[2] || '').trim()
      if (!body) continue
      const aspect = (/aspect\s*=\s*"([^"]+)"/.exec(attrs) || [])[1]
      const dims = aspectDims(preset.config, aspect)
      const prompt = [prefix, await resolveMacros(body, userId)].filter(Boolean).join(', ')
      try {
        const entry = await generateAndUpload({
          prompt,
          negativePrompt: preset.negativePrompt,
          config: preset.config,
          extra: preset.extra,
          dims,
        }, userId)
        const md = `![${body.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`
        content = content.replace(m[0], md)
        done++
      } catch (e) {
        spindle.log.warn('[lumidraw] tag generation failed: ' + e.message)
        content = content.replace(m[0], `*[image failed: ${e.message.slice(0, 120)}]*`)
      }
    }
    await updateMessageContent(target.id, target.contentKey, content, userId, chatId)
    return { mode: 'inline', processed: done, note: `${done}/${tags.length} tag(s) illustrated.` }
  }

  // ------------------------- parser: derive a prompt from prose -------------
  if (settings.mode === 'parser') {
    if (target.id && await wasProcessed(target.id)) {
      return { mode: 'parser', note: 'Latest message already illustrated.' }
    }
    const instruction = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
      .replaceAll('{{max_images}}', String(settings.maxImages || 2))
    const passage = target.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(-6000)
    const out = await quietLLM(await resolveMacros(instruction, userId), passage, settings, userId)
    if (/^\s*NONE\s*$/i.test(out)) {
      if (target.id) await markProcessed(target.id)
      return { mode: 'parser', note: 'Parser judged no visual moment (NONE).' }
    }
    const lines = out.split('\n').map((l) => l.replace(/^["'`\s]+|["'`\s]+$/g, ''))
      .filter((l) => l && !/^NONE$/i.test(l)).slice(0, settings.maxImages || 2)
    const prefix = await resolveMacros(preset.promptPrefix, userId)
    const mds = []
    let firstPrompt = ''
    for (const line of lines) {
      const prompt = [prefix, line].filter(Boolean).join(', ')
      if (!firstPrompt) firstPrompt = line
      const entry = await generateAndUpload({
        prompt,
        negativePrompt: preset.negativePrompt,
        config: preset.config,
        extra: preset.extra,
      }, userId)
      mds.push(`![${line.slice(0, 100).replace(/[\[\]]/g, '')}](${entry.images[0].url})`)
    }
    if (!mds.length) return { mode: 'parser', note: 'Parser returned nothing usable: ' + out.slice(0, 140) }
    await updateMessageContent(target.id, target.contentKey, `${mds.join('\n\n')}\n\n${target.content}`, userId, chatId)
    if (target.id) await markProcessed(target.id)
    return { mode: 'parser', processed: mds.length, note: `Illustrated ${mds.length} moment(s). First prompt: ` + firstPrompt.slice(0, 120) }
  }

  return { mode: settings.mode, note: 'No <dt-image> tags in the latest story message.' }
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
        const [settings, presets, history] = await Promise.all([
          getSettings(), getPresets(), getHistory(),
        ])
        reply = ok(payload, requestId, {
          settings, presets, history,
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
        for (const k of ['mode', 'parserConnection', 'parserModel', 'parserInstruction', 'protocol']) {
          if (payload[k] !== undefined) settings[k] = String(payload[k])
        }
        if (payload.autoScan !== undefined) settings.autoScan = !!payload.autoScan
        if (payload.maxImages !== undefined) {
          settings.maxImages = Math.max(1, Math.min(4, Number(payload.maxImages) || 2))
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

      case 'scan_story': {
        const result = await scanStory(userId)
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
          updatedAt: Date.now(),
        }
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
        const payloadOut = buildPayload({
          prompt: payload.prompt,
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

      case 'clear_history': {
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
  spindle.registerInterceptor(async (messages, context) => {
    try {
      const settings = await getSettings()
      if (settings.mode !== 'inline') return messages
      const injected = {
        role: 'system',
        content: (settings.protocol || DEFAULT_PROTOCOL)
          .replaceAll('{{max_images}}', String(settings.maxImages || 2)),
      }
      return { messages: [...messages, injected] }
    } catch (e) {
      spindle.log.warn('[lumidraw] interceptor error: ' + e.message)
      return messages
    }
  })
  spindle.log.info('[lumidraw] inline protocol interceptor registered')
} else {
  spindle.log.warn('[lumidraw] registerInterceptor not available — inline protocol injection disabled')
}

// Auto-scan after story generations, if an events surface exists.
let scanInFlight = false
;(() => {
  const toastSafe = (msg) => {
    try { if (typeof spindle.toast === 'function') spindle.toast(msg) } catch { /* signature mismatch */ }
    try { if (spindle.toast && typeof spindle.toast.show === 'function') spindle.toast.show(msg) } catch { /* ok */ }
  }
  const handler = async (evt) => {
    try {
      const settings = await getSettings()
      if (settings.mode === 'off' || !settings.autoScan) return
      const uid = (evt && (evt.userId || (evt.payload && evt.payload.userId))) || lastUserId
      if (scanInFlight) return
      scanInFlight = true
      setTimeout(() => {
        scanStory(uid)
          .then((r) => {
            spindle.log.info('[lumidraw] auto-scan: ' + JSON.stringify(r))
            if (r && r.processed) toastSafe(`LumiDraw: illustrated ${r.processed} moment(s)`)
          })
          .catch((e) => spindle.log.warn('[lumidraw] auto-scan failed: ' + e.message))
          .finally(() => { scanInFlight = false })
      }, 1500)
    } catch { scanInFlight = false }
  }
  let registered = false
  if (typeof spindle.on === 'function') {
    for (const evName of ['GENERATION_ENDED', 'MESSAGE_SENT']) {
      try { spindle.on(evName, handler); registered = true } catch { /* next */ }
    }
  } else if (spindle.events && typeof spindle.events.on === 'function') {
    for (const evName of ['GENERATION_ENDED', 'MESSAGE_SENT']) {
      try { spindle.events.on(evName, handler); registered = true } catch { /* next */ }
    }
  }
  if (registered) spindle.log.info('[lumidraw] auto-scan listeners registered (GENERATION_ENDED preferred)')
  else spindle.log.warn('[lumidraw] no events API detected — use the "Scan story now" button.')
})()

spindle.log.info('[lumidraw] spindle API surface: ' + Object.keys(spindle).join(', '))
spindle.log.info('[lumidraw] backend loaded (v0.5)')
