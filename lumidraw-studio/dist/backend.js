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

const DEFAULT_SETTINGS = { host: '127.0.0.1', port: 7862 }
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

spindle.onFrontendMessage(async (payload, userId) => {
  const requestId = payload && payload.requestId
  let reply
  try {
    switch (payload && payload.type) {
      case 'init': {
        const [settings, presets, history] = await Promise.all([
          getSettings(), getPresets(), getHistory(),
        ])
        reply = ok(payload, requestId, { settings, presets, history })
        break
      }

      case 'save_settings': {
        const settings = {
          host: String(payload.host || DEFAULT_SETTINGS.host).trim(),
          port: Number(payload.port) || DEFAULT_SETTINGS.port,
        }
        await spindle.storage.setJson(SETTINGS_FILE, settings, { indent: 2 })
        reply = ok(payload, requestId, { settings })
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
        const uploads = []
        for (const b64 of images) {
          const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
          const dto = await spindle.images.upload({
            data: bytes,
            filename: `lumidraw-${Date.now()}.png`,
            mime_type: 'image/png',
          })
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
        // Adds a generated image to the active chat as an assistant image
        // message via Lumiverse's chat-mutation API (same mechanism as
        // LumiSwarm-Studio's "Append to chat"). The exact call shape is
        // feature-detected; on failure we return a diagnostic listing the
        // real API surface so it can be pinned down in one iteration.
        const { imageUrl, alt, chatId } = payload
        if (!imageUrl) throw new Error('No image URL to append.')
        const content = `![${(alt || 'Generated image').replace(/[\[\]]/g, '')}](${imageUrl})`

        const chatApi = spindle.chat || spindle.chats
        if (!chatApi || typeof chatApi.appendMessage !== 'function') {
          const surface = {
            chat: spindle.chat ? Object.keys(spindle.chat) : null,
            chats: spindle.chats ? Object.keys(spindle.chats) : null,
          }
          throw new Error('chat.appendMessage not available. API surface: ' +
            JSON.stringify(surface) +
            ' — check that the chats + chat_mutation permissions were granted.')
        }

        // Resolve a chat id if the frontend didn't supply one.
        let targetChatId = chatId
        if (!targetChatId && spindle.chats) {
          for (const fn of ['getActive', 'getActiveChat', 'active']) {
            if (typeof spindle.chats[fn] === 'function') {
              try {
                const active = await spindle.chats[fn]()
                targetChatId = active && (active.id || active.chatId || active)
                if (targetChatId) break
              } catch { /* try next shape */ }
            }
          }
        }

        const message = { role: 'assistant', content }
        const attempts = []
        let appended = null
        // Shape 1: appendMessage(chatId, message)
        if (targetChatId) {
          try {
            appended = await chatApi.appendMessage(targetChatId, message)
          } catch (e1) { attempts.push(`appendMessage(chatId, msg): ${e1.message}`) }
        }
        // Shape 2: appendMessage({ chatId?, role, content })
        if (!appended) {
          try {
            appended = await chatApi.appendMessage({ chatId: targetChatId, ...message })
          } catch (e2) { attempts.push(`appendMessage({...}): ${e2.message}`) }
        }
        if (!appended && attempts.length) {
          throw new Error('Could not append to chat. Tried: ' + attempts.join(' | ') +
            ' — send me this text and I will pin the exact signature.')
        }
        reply = ok(payload, requestId, { appended: true })
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

spindle.log.info('[lumidraw] backend loaded')
