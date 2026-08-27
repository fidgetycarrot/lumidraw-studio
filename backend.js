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
const PLACES_FILE = 'places.json'
const HISTORY_FILE = 'history.json'
// Native chat-image mounts live outside message content. This is the persistent
// source of truth that lets the frontend rehydrate images without rewriting a
// virtualized message every time an image appears.
const IMAGE_PLACEMENTS_FILE = 'image_placements.json'
const STORY_DEBUG_FILE = 'story_debug.json'
const SCENE_MEMORY_FILE = 'scene_memory.json'
// A cast is WHO is in a story. A preset is WHAT the picture looks like. Those
// change on completely different schedules — the visual settings are set once,
// the cast changes per story — and welding them together is why switching
// presets moved the wardrobe and why one chat's characters showed up in another.
const CASTS_FILE = 'casts.json'
const CHAT_CAST_FILE = 'chat_cast.json'
// Written once, before the first migration, and never touched again. If any of
// this is wrong, the original presets are recoverable from here without relying
// on me having been careful.
const PRESET_BACKUP_FILE = 'presets_backup_pre_cast.json'
// WHO YOU ARE PLAYING, per chat. The host's chat DTO has no persona field at all
// — Eric's reads `id, character_id, name, metadata, created_at, updated_at` —
// so there is nothing to read and no amount of key-guessing will produce one.
// The cast's persona then follows you into every new chat, which is how a story
// with Elliot in it kept generating Jason, and later a persona with no sheet at
// all. When the host cannot say, the answer is to ask once and remember.
const CHAT_PERSONA_FILE = 'chat_persona.json'
// Anima's artist vocabulary, supplied by you rather than bundled. A mistyped
// artist tag is the worst kind of bug this project has: it fails SILENTLY. Anima
// does not error on an artist it was never trained on — it ignores the tag, and
// you get a blander image with no way to tell whether the style did nothing or
// the name was wrong by one letter.
//
// Not shipped with the extension on purpose. 59,000 names is about a megabyte of
// dead weight for everyone who never loads it, and a list that lives with the
// model rather than with LumiDraw is one I cannot keep current anyway.
const ARTIST_INDEX_FILE = 'artist_index.json'

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 7862,
  mode: 'off',            // 'off' | 'inline' | 'parser'
  autoScan: true,         // auto-process after each story message (when events are available)
  activePreset: '',       // generation preset used for story-driven generations
  storyPromptMigrated: false, // one-time copy of legacy preset prompt fields into Story settings
  storyQualityTags: '',
  storyPromptPrefix: '',
  storyNegativePrompt: '',
  storyBannedTags: '',
  storySceneAnchor: '',
  storyUseBreakSeparators: false,
  parserConnection: '',   // optional connection name/id for the parser LLM
  parserModel: '',        // optional model override for the parser LLM
  parserTemperature: 0.2, // parser sampling temperature; exposed because models/providers can be picky about this
  parserRequestOverrides: '', // JSON merged into the parser request — the escape hatch for provider-specific reasoning keys
  parserMaxTokens: 12000, // first-attempt output budget; sized to survive a reasoning model rather than fight it
  parserInstruction: '',  // selected engine instruction (blank = that engine's built-in default)
  parserEngine: 'legacy',  // 'legacy' (v0.13 instruction-only) | 'anima' (structured JSON compiler)
  parserContextMessages: 2, // Anima only: number of immediately preceding chat messages used as reference context
  useLoomLedger: true,     // Anima only: extract the latest <loomledger> block as continuity reference
  maxImages: 2,           // max illustrations per story message
  minImages: 0,           // required illustrations per reply (0 = model's discretion)
  maxSubjects: 2,         // Direct mode: maximum separately-described people in one image
  autoCharTags: true,     // use active character image tags as a profile fallback
  directMode: false,      // the parser writes the finished prompt; the compiler does not run
  chatLeads: true,        // the chat's own character and persona outrank the cast's
  subjectBinding: false,  // legacy compatibility mirror of parserEngine === 'anima'
  dtModelsPath: '',       // retained for compatibility with older settings
  bridgeHost: '127.0.0.1', // native LumiDraw Bridge runs on the Lumiverse Mac
  bridgePort: 7863,
  protocol: '',           // tag guidance for Inline mode (blank = pre-0.17 default)
  stripImageDirectives: true, // remove dead ![...](/…/gen) image-request directives from the prompt context
  sizeChatImages: false,  // off by default: a custom Lumiverse stylesheet would fight it
  chatImageWidth: 500,    // px, only consulted when sizeChatImages is on
  optimizedPreviews: true, // use Lumiverse's cached sm/lg image tiers in the UI; originals remain canonical
  deleteImagesWithChats: true, // delete unshared LumiDraw uploads when their owning chat is deleted
  cloudEnabled: false,    // route generations to Draw Things Cloud Compute via the relay
  cloudHost: '127.0.0.1', // the relay runs on the Lumiverse Mac, beside the Bridge
  cloudPort: 7864,
  cloudModel: '',         // cloud CATALOG id or hf:// link — never a local filename
  cloudFallback: true,    // on any cloud failure, generate locally rather than not at all
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
const HISTORY_LIMIT = 80

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
  // Direct used to be a checkbox layered on top of Parser. Promote that old
  // combination to the first-class mode without requiring reconfiguration.
  if (settings.mode === 'parser' && settings.directMode === true) settings.mode = 'direct'
  if (!['off', 'inline', 'parser', 'direct'].includes(settings.mode)) settings.mode = 'off'
  settings.directMode = settings.mode === 'direct'
  settings.subjectBinding = settings.parserEngine === 'anima' // backward-compatible debug/profile flag
  settings.parserContextMessages = Math.max(0, Math.min(4, Number(settings.parserContextMessages) || 0))
  settings.maxSubjects = Math.max(2, Math.min(4, Number(settings.maxSubjects) || 2))
  settings.useLoomLedger = settings.useLoomLedger !== false
  settings.optimizedPreviews = settings.optimizedPreviews !== false
  settings.deleteImagesWithChats = settings.deleteImagesWithChats !== false
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

// LUMIDRAW_PRESET_SEMANTICS_V1_1
// Presets are generation recipes now. Story prompting lives in settings; people
// live in casts/libraries. The legacy fields are copied once and left untouched in
// existing preset files until that preset is explicitly re-saved.
async function migratePresetPromptingToStorySettings() {
  const stored = await spindle.storage.getJson(SETTINGS_FILE, { fallback: {} })
  if (stored && stored.storyPromptMigrated === true) return { migrated: false, preset: '' }

  const presets = await getPresets()
  const active = presets.find((p) => p && p.name === stored.activePreset)
    || presets.find((p) => {
      if (!p) return false
      return [p.qualityTags, p.promptPrefix, p.negativePrompt, p.bannedTags, p.sceneAnchor]
        .some((value) => String(value || '').trim()) || p.useBreakSeparators === true
    })

  const next = { ...DEFAULT_SETTINGS, ...(stored || {}) }
  if (active) {
    if (!String(next.storyQualityTags || '').trim()) next.storyQualityTags = String(active.qualityTags || '')
    if (!String(next.storyPromptPrefix || '').trim()) next.storyPromptPrefix = String(active.promptPrefix || '')
    if (!String(next.storyNegativePrompt || '').trim()) next.storyNegativePrompt = String(active.negativePrompt || '')
    if (!String(next.storyBannedTags || '').trim()) next.storyBannedTags = String(active.bannedTags || '')
    if (!String(next.storySceneAnchor || '').trim()) next.storySceneAnchor = String(active.sceneAnchor || '')
    if (next.storyUseBreakSeparators !== true && active.useBreakSeparators === true) next.storyUseBreakSeparators = true
  }
  next.storyPromptMigrated = true
  await spindle.storage.setJson(SETTINGS_FILE, next, { indent: 2 })
  if (active) spindle.log.info('[lumidraw] copied legacy prompt defaults from preset "' + active.name + '" into Story settings; preset data was left intact')
  return { migrated: !!active, preset: active ? active.name : '' }
}

function storyPresetFor(preset, settings) {
  if (!preset) return preset
  return {
    ...preset,
    qualityTags: String(settings.storyQualityTags || ''),
    promptPrefix: String(settings.storyPromptPrefix || ''),
    negativePrompt: String(settings.storyNegativePrompt || ''),
    bannedTags: String(settings.storyBannedTags || ''),
    sceneAnchor: String(settings.storySceneAnchor || ''),
    useBreakSeparators: settings.storyUseBreakSeparators === true,
  }
}

async function getPersonas() {
  const value = await spindle.storage.getJson(PERSONAS_FILE, { fallback: [] })
  return Array.isArray(value) ? value : []
}

async function savePersonas(personas) {
  await spindle.storage.setJson(PERSONAS_FILE, personas, { indent: 2 })
}

// ---------------------------------------------------------------------------
// Places — visual canon for locations and objects
// ---------------------------------------------------------------------------
//
// The truck cab problem, approached from the other side. Every fix so far has
// been SUPPRESSION: cap the framing because the model cannot draw a wide cabin,
// drop a setting tag because nothing in the passage grounds it. Those stop the
// wrong thing appearing; none of them says what the right thing looks like.
//
// A Place does. "Jason's truck" is a named location with canonical tags, and
// when prose mentions it those tags ARE the setting — not a guess to be
// second-guessed by settingTagSupported, because a Place was matched on its own
// alias rather than inferred from a sentence.
//
// This is Kitty's Visual Lorebook idea without her host dependency. Swarm Studio
// layers visual metadata onto Lumiverse world-book entries via the world_books
// permission; LumiDraw has never touched that API and I cannot verify this
// Lumiverse exposes it, so Places are stored by the extension. That keeps the
// feature working regardless, needs no new permission, and leaves room to read
// host lore later as an additional SOURCE of the same structure.
async function getPlaces() {
  const value = await spindle.storage.getJson(PLACES_FILE, { fallback: [] })
  return Array.isArray(value) ? value : []
}

async function savePlaces(places) {
  await spindle.storage.setJson(PLACES_FILE, Array.isArray(places) ? places : [], { indent: 2 })
}

// Same shape as a Look, deliberately: name, cues that select it, what it looks
// like, and what must not appear in it.
function normalizePlace(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {}
  // Throws rather than skipping. A line with no name is a typo, and dropping it
  // silently means the user's line vanishes from the editor with no explanation
  // — the same reasoning as the empty-tags check below.
  const name = shortPhrase(source.name || '', `place ${index + 1} name`, 8, 64, false)
  const tags = shortList(source.tags || source.settingTags || '', `place ${name} tags`,
    { maxItems: 10, maxWords: 7, maxChars: 72 })
  if (!tags.length) throw new Error(`Place \u201c${name}\u201d needs at least one setting tag.`)
  return {
    name,
    aliases: shortList(source.aliases || source.recognition || '', `place ${name} aliases`,
      { maxItems: 12, maxWords: 8, maxChars: 80 }),
    tags,
    negative: shortList(source.negative || source.negativeTags || '', `place ${name} negative`,
      { maxItems: 10, maxWords: 7, maxChars: 72 }),
  }
}

function normalizePlaces(list) {
  const out = []
  const items = Array.isArray(list) ? list : []
  for (let i = 0; i < items.length; i++) {
    const place = normalizePlace(items[i], i)
    if (!place) continue
    const key = place.name.toLowerCase()
    const existing = out.findIndex((item) => item.name.toLowerCase() === key)
    if (existing >= 0) out[existing] = place
    else out.push(place)
  }
  return out.slice(0, 40)
}

// Selected by its own name or an alias appearing in the passage, or by the
// parser having already produced a setting tag that names it. Whole-word only
// and longest-cue-wins, the same rules Looks and appearance states use — a Place
// called "bar" must not match "barn".
function selectPlace(places, sourcePassage = '', settingTags = [], report = null) {
  const note = (place, reason) => {
    if (report) { report.place = place ? place.name : ''; report.reason = reason }
    return place
  }
  const list = Array.isArray(places) ? places : []
  if (!list.length) return note(null, 'no places defined')

  const haystack = [String(sourcePassage || ''), ...(settingTags || [])].join(' \n ').toLowerCase()
  const candidates = []
  for (const place of list) {
    for (const phrase of [place.name, ...(place.aliases || [])]) {
      const value = String(phrase || '').trim().toLowerCase()
      if (value.length < 3) continue
      if (!new RegExp(`\\b${escapeRegExp(value)}\\b`).test(haystack)) continue
      candidates.push({ place, cue: value, words: value.split(/\s+/).length, length: value.length })
    }
  }
  if (!candidates.length) return note(null, 'nothing in the passage names a saved place')
  candidates.sort((a, b) => (b.words - a.words) || (b.length - a.length))
  return note(candidates[0].place, `the passage says "${candidates[0].cue}"`)
}

// A Place's tags lead, because they are canon and the parser's are inference.
// Reconciliation has already dropped the ungrounded guesses; whatever survived
// is kept behind the canon so a genuinely new detail ("rain on the windshield")
// is not thrown away.
function applyPlaceSetting(reconciledSetting, place) {
  if (!place) return { setting: animaTagList(reconciledSetting || []), added: [] }
  const canon = animaTagList(place.tags)
  const existing = animaTagList(reconciledSetting || [])
  const lower = new Set(canon.map((tag) => tag.toLowerCase()))
  const rest = existing.filter((tag) => !lower.has(tag.toLowerCase()))
  return {
    setting: uniqueStrings([...canon, ...rest]).slice(0, 8),
    added: canon.filter((tag) => !existing.some((value) => value.toLowerCase() === tag.toLowerCase())),
  }
}

async function getCasts() {
  const value = await spindle.storage.getJson(CASTS_FILE, { fallback: [] })
  return Array.isArray(value) ? value : []
}

async function saveCasts(casts) {
  await spindle.storage.setJson(CASTS_FILE, casts, { indent: 2 })
}

async function getChatCastMap() {
  const value = await spindle.storage.getJson(CHAT_CAST_FILE, { fallback: {} })
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function bindChatToCast(chatId, castId) {
  const chat = String(chatId || '').trim()
  if (!chat) return null
  const map = await getChatCastMap()
  if (castId) map[chat] = String(castId)
  else delete map[chat]
  await spindle.storage.setJson(CHAT_CAST_FILE, map, { indent: 2 })
  spindle.log.info(`[lumidraw] chat ${chat} is now using cast ${castId || '(none — chat-local leads only)'}`)
  return map
}

async function getChatPersonaMap() {
  const value = await spindle.storage.getJson(CHAT_PERSONA_FILE, { fallback: {} })
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function bindChatToPersona(chatId, personaId) {
  const chat = String(chatId || '').trim()
  if (!chat) return null
  const map = await getChatPersonaMap()
  if (personaId) map[chat] = String(personaId)
  else delete map[chat]
  await spindle.storage.setJson(CHAT_PERSONA_FILE, map, { indent: 2 })
  spindle.log.info(`[lumidraw] chat ${chat} is now played as persona ${personaId || '(none — falls back to the cast)'}`)
  return map
}

async function personaForChat(chatId) {
  const chat = String(chatId || '').trim()
  if (!chat) return null
  const map = await getChatPersonaMap()
  const id = map[chat]
  if (!id) return null
  const personas = await getPersonas()
  return personas.find((item) => item && String(item.id) === String(id)) || null
}

// WHICH PERSONA'S TAGS, honouring the choice. "I have Elliot selected as the
// persona character but it keeps injecting Jason's image tags."
//
// `preset.personaTags` is the flat legacy field from when characters lived on
// presets — Jason, in Eric's case. TWO places appended it to the parser
// instruction directly, never going through getStoryProfiles, so the Playing-as
// picker could not possibly affect them. The picker worked; these two did not
// ask it anything.
//
// An explicit choice is the answer even when it carries no tags: choosing a
// persona with an empty sheet means "no persona tags", not "fall back to the
// one I just replaced".
async function effectivePersonaTags(preset, chatId) {
  const chosen = await personaForChat(chatId)
  if (chosen) {
    const tags = String((chosen.profile && chosen.profile.appearanceTags) || '').trim()
    return { tags, source: `your choice for this chat — ${chosen.name}` }
  }
  const cast = await castForChat(chatId)
  const from = cast || {}
  const tags = String((from.personaProfile && from.personaProfile.appearanceTags) ||
    from.personaTags || '').trim()
  return { tags, source: cast ? `the cast "${cast.name}"` : 'no saved cast is bound to this chat' }
}

async function castForChat(chatId) {
  const chat = String(chatId || '').trim()
  if (!chat) return null
  const map = await getChatCastMap()
  const castId = map[chat]
  if (!castId) return null
  const casts = await getCasts()
  return casts.find((item) => item && item.id === castId) || null
}

// Does this preset carry anybody?
function presetHasCast(preset) {
  if (!preset) return false
  return !!(preset.characterProfile || preset.personaProfile || preset.characterLibraryId ||
    preset.personaLibraryId || (Array.isArray(preset.castLibraryIds) && preset.castLibraryIds.length))
}

// COPY the people out of a preset into a cast. Deliberately a copy and not a
// move: the preset keeps every field it had, so a migration that turns out to be
// wrong loses nothing. The contract for this whole change is that your character
// work is never deleted, only duplicated somewhere better.
function castFromPreset(preset) {
  return {
    id: `cast_${normalizeIdentityText(preset.name || 'story').replace(/\s+/g, '_') || 'story'}`,
    name: preset.name || 'Story cast',
    characterProfile: preset.characterProfile ? { ...preset.characterProfile } : null,
    personaProfile: preset.personaProfile ? { ...preset.personaProfile } : null,
    characterLibraryId: preset.characterLibraryId || '',
    personaLibraryId: preset.personaLibraryId || '',
    characterTags: preset.characterTags || '',
    personaTags: preset.personaTags || '',
    castLibraryIds: Array.isArray(preset.castLibraryIds) ? [...preset.castLibraryIds] : [],
    // Where this came from, so the UI can say so and so a re-run can recognise
    // its own work rather than making a second copy.
    migratedFromPreset: preset.name || '',
    createdAt: Date.now(),
  }
}

// Build the cast store from the presets that already exist.
//
// Three properties this must have, in order of how badly they would hurt:
//   1. It never modifies a preset.
//   2. It never overwrites a cast that already exists — running twice is a no-op,
//      and a cast you have since EDITED is not reverted to the preset's version.
//   3. It backs the presets up before doing anything at all.
async function migratePresetsToCasts() {
  const presets = await getPresets()
  if (!Array.isArray(presets) || !presets.length) return { created: [], skipped: [] }

  const existingBackup = await spindle.storage.getJson(PRESET_BACKUP_FILE, { fallback: null })
  if (!existingBackup) {
    await spindle.storage.setJson(PRESET_BACKUP_FILE, presets, { indent: 2 })
    spindle.log.info(`[lumidraw] backed up ${presets.length} preset(s) before the cast migration`)
  }

  const casts = await getCasts()
  const created = []
  const skipped = []
  for (const preset of presets) {
    if (!presetHasCast(preset)) { skipped.push(preset.name || '(unnamed)'); continue }
    const built = castFromPreset(preset)
    if (casts.some((item) => item && item.id === built.id)) {
      skipped.push(preset.name || '(unnamed)')
      continue
    }
    casts.push(built)
    created.push(built.name)
  }
  if (created.length) {
    await saveCasts(casts)
    spindle.log.info(`[lumidraw] cast migration created ${created.length}: ${created.join(', ')} — presets untouched`)
  }
  return { created, skipped }
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

async function pushHistory(entry, userId = '') {
  const history = await getHistory()
  history.unshift(entry)
  const trimmed = history.slice(0, HISTORY_LIMIT)
  await spindle.storage.setJson(HISTORY_FILE, trimmed, { indent: 2 })
  const evicted = history.slice(HISTORY_LIMIT)
  if (userId && evicted.length) await deleteEvictedHistoryImages(userId, evicted, trimmed)
  return trimmed
}

// ---------------------------------------------------------------------------
// Native story-image placements
// ---------------------------------------------------------------------------
// Lumiverse now virtualizes chat rows. Rewriting an assistant message to insert
// a large <img> makes React rebuild that row and the virtualizer remeasure it,
// which is exactly the scroll jump Prolix called out. Images generated by 1.3.3+
// are therefore persisted here and rendered by the frontend with ctx.dom.inject().
// The message text remains the story text; image presentation is extension state.
async function getImagePlacementState() {
  const raw = await spindle.storage.getJson(IMAGE_PLACEMENTS_FILE, { fallback: { version: 1, chats: {} } })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, chats: {} }
  const chats = raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats) ? raw.chats : {}
  return { version: 1, chats }
}

async function saveImagePlacementState(state) {
  const chats = state && state.chats && typeof state.chats === 'object' ? state.chats : {}
  await spindle.storage.setJson(IMAGE_PLACEMENTS_FILE, { version: 1, chats }, { indent: 2 })
}

function nativePlacementId() {
  return `ldp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function placementNumber(value) {
  const n = Math.round(Number(value) || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function placementMatches(placement, criteria = {}) {
  if (!placement || typeof placement !== 'object') return false
  if (criteria.placementId && String(placement.placementId || '') !== String(criteria.placementId)) return false
  if (criteria.chatId && String(placement.chatId || '') !== String(criteria.chatId)) return false
  if (criteria.messageId && String(placement.messageId || '') !== String(criteria.messageId)) return false
  if (criteria.imageUrl && normalizeForImageMatch(placement.url || '') !== normalizeForImageMatch(criteria.imageUrl)) return false
  if (criteria.imageId && String(placement.imageId || '') !== String(criteria.imageId)) return false
  return true
}

async function listImagePlacements(chatId) {
  const wantedChat = String(chatId || '').trim()
  if (!wantedChat) return []
  const state = await getImagePlacementState()
  const byMessage = state.chats[wantedChat]
  if (!byMessage || typeof byMessage !== 'object') return []
  const out = []
  for (const [messageId, items] of Object.entries(byMessage)) {
    if (!Array.isArray(items)) continue
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || !raw.url) continue
      out.push({ ...raw, chatId: wantedChat, messageId: String(raw.messageId || messageId) })
    }
  }
  return out.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0))
}

async function findImagePlacement(criteria = {}) {
  const state = await getImagePlacementState()
  const candidates = []
  const chatIds = criteria.chatId && state.chats[String(criteria.chatId)]
    ? [String(criteria.chatId)]
    : Object.keys(state.chats)
  for (const chatId of chatIds) {
    const byMessage = state.chats[chatId]
    if (!byMessage || typeof byMessage !== 'object') continue
    const messageIds = criteria.messageId && byMessage[String(criteria.messageId)]
      ? [String(criteria.messageId)]
      : Object.keys(byMessage)
    for (const messageId of messageIds) {
      const items = Array.isArray(byMessage[messageId]) ? byMessage[messageId] : []
      for (let index = 0; index < items.length; index++) {
        const placement = items[index]
        if (!placementMatches(placement, { ...criteria, chatId, messageId })) continue
        candidates.push({ state, chatId, messageId, index, placement })
      }
    }
  }
  if (!candidates.length) return null
  if (criteria.placementId) return candidates[0]
  if (candidates.length === 1) return candidates[0]
  // History origin is a strong disambiguator when the same source image has
  // deliberately been copied into more than one message.
  if (criteria.messageId) {
    const exact = candidates.find((item) => item.messageId === String(criteria.messageId))
    if (exact) return exact
  }
  return null
}

async function recordImagePlacement(userId, input = {}) {
  const chatId = String(input.chatId || '').trim()
  const messageId = String(input.messageId || '').trim()
  const url = String(input.imageUrl || input.url || '').trim()
  if (!chatId || !messageId || !url) {
    throw new Error('Native image placement needs a chat id, message id, and image URL.')
  }
  const state = await getImagePlacementState()
  if (!state.chats[chatId] || typeof state.chats[chatId] !== 'object') state.chats[chatId] = {}
  const byMessage = state.chats[chatId]
  const items = Array.isArray(byMessage[messageId]) ? byMessage[messageId] : []
  let index = -1
  if (input.placementId) index = items.findIndex((item) => String(item && item.placementId || '') === String(input.placementId))
  if (index < 0 && input.allowDuplicate !== true) {
    const wanted = normalizeForImageMatch(url)
    index = items.findIndex((item) => normalizeForImageMatch(item && item.url || '') === wanted)
  }
  const previous = index >= 0 ? items[index] : null
  const order = previous && Number.isFinite(Number(previous.order))
    ? Number(previous.order)
    : items.reduce((max, item) => Math.max(max, Number(item && item.order) || 0), 0) + 1
  const placement = {
    ...(previous || {}),
    placementId: String(input.placementId || (previous && previous.placementId) || nativePlacementId()),
    chatId,
    messageId,
    imageId: String(input.imageId || (previous && previous.imageId) || ''),
    url,
    alt: markdownAltText(input.alt || (previous && previous.alt) || 'Generated image', 220),
    width: placementNumber(input.width || (previous && previous.width)),
    height: placementNumber(input.height || (previous && previous.height)),
    anchor: String(input.anchor || (previous && previous.anchor) || '').trim().slice(0, 500),
    source: String(input.source || (previous && previous.source) || 'story'),
    order,
    at: previous && previous.at ? previous.at : Date.now(),
    updatedAt: Date.now(),
  }
  if (index >= 0) items[index] = placement
  else items.push(placement)
  byMessage[messageId] = items
  await saveImagePlacementState(state)
  if (userId) notifyFrontend(userId, 'image_placement_upserted', { placement })
  return placement
}

async function removeImagePlacements(userId, criteria = {}) {
  const state = await getImagePlacementState()
  const removed = []
  for (const [chatId, byMessage] of Object.entries(state.chats)) {
    if (criteria.chatId && chatId !== String(criteria.chatId)) continue
    if (!byMessage || typeof byMessage !== 'object') continue
    for (const [messageId, rawItems] of Object.entries(byMessage)) {
      if (criteria.messageId && messageId !== String(criteria.messageId)) continue
      const items = Array.isArray(rawItems) ? rawItems : []
      const keep = []
      for (const placement of items) {
        if (placementMatches(placement, { ...criteria, chatId, messageId })) removed.push(placement)
        else keep.push(placement)
      }
      if (keep.length) byMessage[messageId] = keep
      else delete byMessage[messageId]
    }
    if (!Object.keys(byMessage).length) delete state.chats[chatId]
  }
  if (removed.length) {
    await saveImagePlacementState(state)
    if (userId) notifyFrontend(userId, 'image_placement_removed', { placements: removed })
  }
  return removed
}

function imageRefId(image = {}) {
  const explicit = String(image.id || image.imageId || '').trim()
  if (explicit) return explicit
  const match = String(image.url || image.imageUrl || '').match(/\/api\/v1\/images\/([^/?#]+)/i)
  return match ? match[1] : ''
}

function imageRefUrl(image = {}) {
  return String(image.url || image.imageUrl || '').trim()
}

function imageBaseUrl(value) {
  return normalizeForImageMatch(String(value || '').trim()).split(/[?#]/)[0]
}

function sameImageRef(left = {}, right = {}) {
  const leftId = imageRefId(left)
  const rightId = imageRefId(right)
  if (leftId && rightId && leftId === rightId) return true
  const leftUrl = imageBaseUrl(imageRefUrl(left))
  const rightUrl = imageBaseUrl(imageRefUrl(right))
  return !!(leftUrl && rightUrl && leftUrl === rightUrl)
}

function uniqueImageRefs(images = []) {
  const out = []
  for (const image of images) {
    if (!image || (!imageRefId(image) && !imageRefUrl(image))) continue
    const normalized = { id: imageRefId(image), url: imageRefUrl(image) }
    if (!out.some((item) => sameImageRef(item, normalized))) out.push(normalized)
  }
  return out
}

function imageReferencedInPlacementState(state, image) {
  const chats = state && state.chats && typeof state.chats === 'object' ? state.chats : {}
  for (const byMessage of Object.values(chats)) {
    if (!byMessage || typeof byMessage !== 'object') continue
    for (const items of Object.values(byMessage)) {
      if (Array.isArray(items) && items.some((item) => sameImageRef(item, image))) return true
    }
  }
  return false
}

function imageReferencedInHistory(history, image, { excludeChatId = '' } = {}) {
  const excluded = String(excludeChatId || '')
  for (const entry of Array.isArray(history) ? history : []) {
    const originChat = String(entry && entry.origin && entry.origin.chatId || '')
    if (excluded && originChat === excluded) continue
    if ((entry.images || []).some((item) => sameImageRef(item, image))) return true
  }
  return false
}

async function deleteOwnedImage(userId, image) {
  const id = imageRefId(image)
  if (!id || !spindle.images) return false
  for (const fn of ['delete', 'remove']) {
    if (typeof spindle.images[fn] !== 'function') continue
    for (const args of [[id, userId], [{ id, userId }], [id]]) {
      try {
        await spindle.images[fn](...args)
        return true
      } catch { /* try the next supported signature */ }
    }
  }
  return false
}

async function deleteEvictedHistoryImages(userId, evicted, remainingHistory) {
  const candidates = uniqueImageRefs((evicted || []).flatMap((entry) => entry && entry.images || []))
  if (!candidates.length) return 0
  const state = await getImagePlacementState()
  let deleted = 0
  for (const image of candidates) {
    if (imageReferencedInPlacementState(state, image)) continue
    if (imageReferencedInHistory(remainingHistory, image)) continue
    if (await deleteOwnedImage(userId, image)) deleted++
  }
  if (deleted) spindle.log.info(`[lumidraw] history retention deleted ${deleted} unreferenced image upload(s)`)
  return deleted
}

async function removeChatScopedState(chatId, messageIds = []) {
  const chat = String(chatId || '').trim()
  if (!chat) return

  for (const file of [CHAT_CAST_FILE, CHAT_PERSONA_FILE]) {
    const map = await spindle.storage.getJson(file, { fallback: {} })
    if (!map || typeof map !== 'object' || Array.isArray(map) || !(chat in map)) continue
    delete map[chat]
    await spindle.storage.setJson(file, map, { indent: 2 })
  }

  const memory = await spindle.storage.getJson(SCENE_MEMORY_FILE, { fallback: {} })
  if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
    let changed = false
    for (const key of Object.keys(memory)) {
      if (key === chat || key.startsWith(chat + '::')) {
        delete memory[key]
        changed = true
      }
    }
    if (changed) await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
  }

  const ids = new Set((messageIds || []).map((value) => String(value || '')).filter(Boolean))
  if (ids.size) {
    const processed = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
    if (Array.isArray(processed)) {
      const kept = processed.filter((entry) => {
        const value = String(entry || '')
        for (const id of ids) if (value === id || value.startsWith(id + ':')) return false
        return true
      })
      if (kept.length !== processed.length) {
        await spindle.storage.setJson(PROCESSED_FILE, kept, { indent: 0 })
      }
    }
  }
}

async function cleanupDeletedChat(userId, chatId, options = {}) {
  const chat = String(chatId || '').trim()
  if (!chat) return { chatId: '', removedPlacements: 0, deletedImages: 0, preservedImages: 0 }
  const settings = options.settings || await getSettings()
  const history = await getHistory()
  const state = await getImagePlacementState()
  const byMessage = state.chats[chat] && typeof state.chats[chat] === 'object' ? state.chats[chat] : {}
  const placed = []
  const messageIds = new Set()
  for (const [messageId, items] of Object.entries(byMessage)) {
    messageIds.add(String(messageId))
    if (Array.isArray(items)) placed.push(...items)
  }
  const ownedEntries = history.filter((entry) => String(entry && entry.origin && entry.origin.chatId || '') === chat)
  for (const entry of ownedEntries) {
    const messageId = String(entry && entry.origin && entry.origin.messageId || '')
    if (messageId) messageIds.add(messageId)
  }
  const candidates = uniqueImageRefs([
    ...placed,
    ...ownedEntries.flatMap((entry) => entry && entry.images || []),
  ])

  const removed = await removeImagePlacements(userId, { chatId: chat })
  await removeChatScopedState(chat, [...messageIds])
  if (typeof lastAutoStatus === 'object' && String(lastAutoStatus.chatId || '') === chat) {
    lastAutoStatus = { at: Date.now(), mode: '', status: 'idle', note: '', messageId: '', chatId: '' }
  }

  if (settings.deleteImagesWithChats === false || !candidates.length) {
    return { chatId: chat, removedPlacements: removed.length, deletedImages: 0, preservedImages: candidates.length }
  }

  const remainingState = await getImagePlacementState()
  const deleted = []
  let preserved = 0
  for (const image of candidates) {
    const shared = imageReferencedInPlacementState(remainingState, image) ||
      imageReferencedInHistory(history, image, { excludeChatId: chat })
    if (shared) {
      preserved++
      continue
    }
    if (await deleteOwnedImage(userId, image)) deleted.push(image)
  }

  let cleanedHistory = history
  if (deleted.length) {
    cleanedHistory = history.map((entry) => ({
      ...entry,
      images: (entry.images || []).filter((image) => !deleted.some((item) => sameImageRef(item, image))),
    })).filter((entry) => entry.images && entry.images.length)
    await spindle.storage.setJson(HISTORY_FILE, cleanedHistory, { indent: 2 })
    if (userId) notifyFrontend(userId, 'history_updated', { history: cleanedHistory, source: 'chat-cleanup' })
  }
  spindle.log.info(`[lumidraw] deleted chat ${chat}: removed ${removed.length} placement(s), ` +
    `deleted ${deleted.length} unshared image upload(s), preserved ${preserved} shared image(s)`)
  return {
    chatId: chat,
    removedPlacements: removed.length,
    deletedImages: deleted.length,
    preservedImages: preserved,
    history: cleanedHistory,
  }
}

async function replaceImagePlacement(userId, criteria, entry, alt = '') {
  const found = await findImagePlacement(criteria)
  if (!found) return null
  const image = entry && Array.isArray(entry.images) ? entry.images[0] : null
  if (!image || !image.url) return null
  const cfg = entry && entry.recipe && entry.recipe.config ? entry.recipe.config : {}
  return recordImagePlacement(userId, {
    ...found.placement,
    placementId: found.placement.placementId,
    chatId: found.chatId,
    messageId: found.messageId,
    imageUrl: image.url,
    imageId: image.id || '',
    alt: alt || entry.prompt || found.placement.alt,
    width: cfg.width || found.placement.width,
    height: cfg.height || found.placement.height,
    allowDuplicate: false,
  })
}

async function placeGeneratedStoryImage(userId, { chatId, messageId, entry, alt, dims, anchor, source }) {
  const image = entry && Array.isArray(entry.images) ? entry.images[0] : null
  if (!image || !image.url) throw new Error('Generated image has no URL to mount in the story.')
  const cfg = entry && entry.recipe && entry.recipe.config ? entry.recipe.config : {}
  return recordImagePlacement(userId, {
    chatId,
    messageId,
    imageUrl: image.url,
    imageId: image.id || '',
    alt: alt || entry.prompt || 'Generated image',
    width: (dims && dims.width) || cfg.width,
    height: (dims && dims.height) || cfg.height,
    anchor,
    source,
  })
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
// What the wardrobe is keyed by.
//
// It was the PRESET name, which meant changing your model moved your characters'
// clothes — the visual settings were acting as an identity for what people are
// wearing. With a cast bound, the cast is the identity, which is what it should
// always have been.
//
// The `cast:` prefix keeps the two namespaces apart, so a preset that happens to
// be named like a cast id cannot collide with one.
async function sceneScopeFor(chatId, presetName) {
  const cast = await castForChat(chatId)
  return cast ? `cast:${cast.id}` : String(presetName || '')
}

async function readSceneMemory(chatId, presetName) {
  const memory = await getSceneMemory()
  const scope = await sceneScopeFor(chatId, presetName)
  const scoped = sceneMemoryKey(chatId, scope)
  if (scoped && memory[scoped]) return memory[scoped]

  // Re-keying would otherwise strand every outfit already recorded. The old
  // preset-keyed entry is COPIED across the first time the new key is asked for,
  // and deliberately left where it was — same rule as the preset migration, for
  // the same reason.
  const presetKey = sceneMemoryKey(chatId, presetName)
  if (scoped && presetKey && presetKey !== scoped && memory[presetKey]) {
    const carried = memory[presetKey]
    try {
      memory[scoped] = { ...carried, at: Date.now() }
      await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
      spindle.log.info('[lumidraw] the wardrobe for this chat now belongs to its cast rather than its ' +
        `preset "${presetName}". What was recorded has been carried over; the old entry is left in place.`)
    } catch (error) {
      spindle.log.warn('[lumidraw] could not carry the wardrobe over: ' + error.message)
    }
    return carried
  }
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

async function rememberSceneState(chatId, presetName, {
  setting = [], lighting = [], outfits = null, looks = null, outfitMeta = null,
} = {}) {
  const key = sceneMemoryKey(chatId, await sceneScopeFor(chatId, presetName))
  const tags = uniqueStrings(setting || []).slice(0, 6)
  const light = uniqueStrings(lighting || []).slice(0, 4)
  const wardrobe = outfits && typeof outfits === 'object' ? outfits : null
  const wornLooks = looks && typeof looks === 'object' ? looks : null
  if (!key || (!tags.length && !light.length && !wardrobe && !wornLooks)) return
  try {
    const memory = await getSceneMemory()
    const previous = memory[key] || {}
    // Merged, not replaced: a character absent from this scene keeps whatever
    // they were last seen wearing, which is the whole point of remembering.
    const mergedOutfits = { ...(previous.outfits || {}) }
    const mergedOutfitMeta = { ...(previous.outfitMeta || {}) }
    for (const [ref, worn] of Object.entries(wardrobe || {})) {
      const items = uniqueStrings(worn || []).slice(0, 12)
      if (items.length) {
        const before = uniqueStrings(mergedOutfits[ref] || [])
        const changed = before.join('\u0000') !== items.join('\u0000')
        mergedOutfits[ref] = items
        const detail = outfitMeta && outfitMeta[ref]
        if (detail && typeof detail === 'object' && (changed || !mergedOutfitMeta[ref])) {
          mergedOutfitMeta[ref] = {
            source: String(detail.source || 'story').slice(0, 32),
            at: Number(detail.at) || Date.now(),
            messageId: String(detail.messageId || '').slice(0, 128),
            evidence: String(detail.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 220),
          }
        }
      }
    }
    // Merged for the same reason as outfits: someone offstage this scene is
    // still in whatever Look they were last put into.
    const mergedLooks = { ...(previous.looks || {}) }
    for (const [ref, name] of Object.entries(wornLooks || {})) {
      if (String(name || '').trim()) mergedLooks[ref] = String(name).trim()
    }
    memory[key] = {
      setting: tags.length ? tags : (previous.setting || []),
      lighting: light.length ? light : (previous.lighting || []),
      outfits: mergedOutfits,
      outfitMeta: mergedOutfitMeta,
      looks: mergedLooks,
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
  // A seed Draw Things picks invisibly is a seed you can never reuse. Leaving the
  // field off meant every story image was a one-off: the fix panel's "reuse seed"
  // had nothing to reuse, and a CFG sweep was a reroll rather than a comparison.
  const parsedSeed = Number(seed)
  payload.seed = Number.isFinite(parsedSeed) && parsedSeed >= 0
    ? parsedSeed
    : Math.floor(Math.random() * 4294967296)

  // Negatives do almost nothing at very low guidance. Every defence in this file
  // — the anatomy firewall, the garment substitutes, the censorship guard — is
  // written into the negative prompt, so on a CFG-1 preset they are decoration.
  // Worth saying out loud rather than debugging a defence that cannot fire.
  const cfg = Number(payload.guidance_scale ?? 1)
  if (payload.negative_prompt && cfg <= 1.5) {
    spindle.log.warn('[lumidraw] CFG ' + cfg + ' — negatives are nearly or fully inert ' +
      'at this guidance; defence negatives will not fire on this preset.')
  }

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
// Draw Things Cloud Compute — via the LumiDraw cloud relay
// ---------------------------------------------------------------------------
//
// Why a relay rather than a direct client.
//
// Cloud Compute is not reachable over the HTTP API this extension speaks. That
// was tested: Draw Things answers "Cloud Compute can only access models from
// Official or Community channels. Your local models cannot be used for this
// generation." — and it answers that even for a community model set on both
// sides, while the identical settings run on cloud from inside the app. It is
// the request path, not the configuration.
//
// The documented cloud path is gRPC, published as a Swift package
// (MediaGenerationKit) and its example client, media-generation-kit-cli, which
// takes `generate --cloud-compute --api-key`. LumiDraw is a zero-dependency
// Spindle extension inside Lumiverse's Node process; it can neither speak gRPC
// nor shell out to a Swift binary. So the transport lives in a small local
// relay on the same Mac, and LumiDraw talks to it the way it already talks to
// the Bridge: plain HTTP and JSON.
//
// The API key never enters Lumiverse. It is read from the relay's environment,
// so it stays out of settings storage, out of the frontend, and out of any
// settings dump pasted into a bug report. LumiDraw cannot leak a secret it was
// never given.

const CLOUD_RELAY_TIMEOUT_MS = 300000 // cloud is fast, but the queue is not always short

function cloudRelayBaseUrl(settings) {
  const host = String(settings.cloudHost || DEFAULT_SETTINGS.cloudHost).trim()
  const port = Number(settings.cloudPort) || DEFAULT_SETTINGS.cloudPort
  return `http://${host}:${port}`
}

function cloudEnabled(settings) {
  return !!(settings && settings.cloudEnabled)
}

// The cloud catalog is not the local model folder. A local filename is exactly
// what Cloud Compute refuses, so an unset cloud model is a configuration error
// worth naming rather than a request worth sending.
function cloudModelFor(settings, payload) {
  const explicit = String((settings && settings.cloudModel) || '').trim()
  if (explicit) return explicit
  return ''
}

// Translate a Draw Things HTTP payload into the relay's flat request.
//
// The crossing list is not a guess. It was read off a live cloud pipeline with
// `lumidraw-dt-cli --dump-config`, which printed all 81 configuration fields
// with their types — so `guidanceScale` is a Float, `seed` a UInt32, `clipSkip`
// an Int, and the settings below are the ones that genuinely exist on the far
// side. Everything else is dropped rather than passed through hopefully.
//
// LoRAs and hires fix DO cross. That is not a preference, it is what the
// recipe requires: a saved cloud generation of Eric's showed two LoRAs — a
// style LoRA at 0.8 and the Fanny/Price character LoRA at 0.4 — plus hires fix
// on at 512×704. Drop the character LoRA and the person in the picture is a
// stranger; drop hires fix and it is a different picture at the same size.
//
// Tiled decoding, compression artifacts and the refiner stay dropped: those are
// local-performance settings a cloud GPU does not need.
function cloudRequestFrom(payload, model) {
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  const request = {
    model,
    prompt: String(payload.prompt || ''),
    negative_prompt: String(payload.negative_prompt || ''),
    width: num(payload.width, 512),
    height: num(payload.height, 768),
    steps: num(payload.steps, 30),
    guidance_scale: num(payload.guidance_scale ?? payload.guidanceScale, 5),
    seed: num(payload.seed, -1),
  }
  const sampler = payload.sampler || payload.sampler_name
  if (sampler) request.sampler = String(sampler)
  const optional = {
    shift: payload.shift ?? payload.res_dpt_shift,
    clip_skip: payload.clip_skip ?? payload.clipSkip,
    strength: payload.strength,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null && value !== '') request[key] = num(value, undefined)
  }

  // A LoRA entry is { file, weight } in a synced Draw Things config, but a
  // hand-written preset may spell it name/model, and a bare string is legal
  // too. Weight defaults to 1 rather than 0 — a LoRA at zero is a LoRA that
  // silently did nothing.
  const loras = Array.isArray(payload.loras) ? payload.loras : []
  const cloudLoras = loras
    .map((entry) => {
      if (!entry) return null
      if (typeof entry === 'string') return { file: entry, weight: 1 }
      const file = entry.file || entry.name || entry.model || ''
      if (!file) return null
      const weight = num(entry.weight, 1)
      return { file: String(file), weight }
    })
    .filter(Boolean)
  if (cloudLoras.length) request.loras = cloudLoras

  const hires = payload.hires_fix ?? payload.hiresFix
  if (hires === true || hires === 'true' || hires === 1) {
    request.hires_fix = true
    const hiresOptional = {
      hires_fix_width: payload.hires_fix_width ?? payload.hiresFixWidth,
      hires_fix_height: payload.hires_fix_height ?? payload.hiresFixHeight,
      hires_fix_strength: payload.hires_fix_strength ?? payload.hiresFixStrength,
    }
    for (const [key, value] of Object.entries(hiresOptional)) {
      if (value !== undefined && value !== null && value !== '') request[key] = num(value, undefined)
    }
  }

  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key]
  }
  return request
}

// A relay that is not running is the ordinary case — Eric starts it when he
// wants cloud — so it must read as "fall back", not as a failure.
async function cloudRelayFetch(settings, path, options = {}, timeoutMs = 12000) {
  const url = `${cloudRelayBaseUrl(settings)}${path}`
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
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : (err && err.message) || String(err)
    const error = new Error(`Could not reach the LumiDraw cloud relay at ${url} (${reason}).`)
    error.relayUnreachable = true
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function cloudRelayStatus(settings) {
  try {
    const res = await cloudRelayFetch(settings, '/health', {}, 6000)
    if (!res.ok || !res.json) return { reachable: false, reason: `relay answered HTTP ${res.status}` }
    return {
      reachable: true,
      authenticated: !!res.json.authenticated,
      cli: String(res.json.cli || ''),
      remaining: res.json.remaining === undefined ? null : res.json.remaining,
      reason: '',
    }
  } catch (err) {
    return { reachable: false, reason: (err && err.message) || String(err) }
  }
}

// Quota is the constraint that actually bites: 20 generations a month on the
// free tier, 200 on Draw Things+. Running out is not a bug and must not read
// like one, so it is raised as its own kind of failure.
function cloudQuotaExhausted(raw) {
  return /quota|exceeded|out of (?:credits|generations)|limit reached|insufficient/i.test(String(raw || ''))
}

async function cloudGenerate(settings, payload) {
  const model = cloudModelFor(settings, payload)
  if (!model) {
    const error = new Error('No cloud model is set. Cloud Compute refuses a local filename, ' +
      'so it needs a catalog model id (or an hf:// link) in Settings → Cloud.')
    error.cloudMisconfigured = true
    throw error
  }
  const request = cloudRequestFrom(payload, model)
  spindle.log.info('[lumidraw] cloud generation · model=' + model +
    ' · ' + request.width + '×' + request.height +
    ' · ' + request.steps + ' steps · guidance ' + request.guidance_scale)
  const res = await cloudRelayFetch(settings, '/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }, CLOUD_RELAY_TIMEOUT_MS)
  const raw = (res.json && (res.json.error || res.json.detail)) || res.text || ''
  if (!res.ok || !res.json || !Array.isArray(res.json.images) || res.json.images.length === 0) {
    if (cloudQuotaExhausted(raw)) {
      const error = new Error('Draw Things cloud quota is used up for this period. ' +
        'Free is 20 generations a month, Draw Things+ is 200; beyond that it is pay-as-you-go.')
      error.cloudQuota = true
      throw error
    }
    throw new Error(`Draw Things cloud rejected the generation: ${String(raw).slice(0, 400) || `HTTP ${res.status}`}`)
  }
  if (res.json.images.length > 1) {
    spindle.log.warn(`[lumidraw] cloud returned ${res.json.images.length} images; keeping only the first.`)
  }
  return [res.json.images[0]]
}

// The single entry point both generation paths call. Local stays the default
// and the fallback: an image that arrives slowly beats no image, and a chat
// that stops illustrating because a relay was not running is a worse failure
// than a slow one.
async function generateImages(settings, payload, label = 'generation') {
  if (!cloudEnabled(settings)) return { images: await dtGenerate(settings, payload), backend: 'local' }
  try {
    const images = await cloudGenerate(settings, payload)
    return { images, backend: 'cloud' }
  } catch (err) {
    const message = (err && err.message) || String(err)
    // Quota and misconfiguration are Eric's to fix, and silently spending
    // local time on them would hide the thing he needs to see. Everything
    // else — relay down, network blip, cloud error — falls back.
    if (err && (err.cloudQuota || err.cloudMisconfigured) && !settings.cloudFallback) throw err
    if (!settings.cloudFallback) throw err
    spindle.log.warn(`[lumidraw] cloud ${label} failed, falling back to local Draw Things · ${message}`)
    const images = await dtGenerate(settings, payload)
    return { images, backend: 'local', fellBackFrom: message }
  }
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
  if (!value.includes('![') && !/<img\b/i.test(value)) return { text: value, count: 0 }
  let count = 0
  let next = value.replace(MARKDOWN_IMAGE_RE, (match, href) => {
    if (!looksLikeImageDirective(href)) return match
    count++
    return ''
  })
  next = next.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)
    const ours = /\bdata-lumidraw-image\s*=|\bdata-lumidraw-image\b/i.test(tag)
    if (!ours && (!src || !looksLikeImageDirective(src[1]))) return tag
    count++
    return ''
  })
  if (!count) return { text: value, count: 0 }
  return { text: next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), count }
}
const PARSER_TRIGGER_TAG = '<lumidraw-parse request="generate"></lumidraw-parse>'
const PARSER_TRIGGER_RE = /<lumidraw-parse\b[^>]*><\/lumidraw-parse>|<lumidraw-parse\b[^>]*>[\s\S]*?<\/lumidraw-parse>|<lumidraw-parse\b[^>]*\/>/gi
const LOOM_LEDGER_RE = /<loomledger\b[^>]*>[\s\S]*?<\/loomledger>/gi
// Cards are furniture: a status readout, a dice roll, a helpdesk console. They are
// never a moment in the story, so the parser must not see them. Two conventions are
// in use — a named custom element, and a pair of HTML comments around a block of
// markup, which is how Lumiverse presets embed a rendered card.
//
// The comment form was not covered, so a card like
//   <!-- UI_START --><div style="…">Gabrielle · OPERATOR CONSOLE · TRACKER 34…
// reached the parser as prose, on every message that carried one. "dependency load
// 34 / 100" and "monitored focus" are not scenery, but nothing had told it that.
const PARSER_UTILITY_CARD_RE = /<(?:scenecard|adventurecard|statuscard|choicecard|summarycard)\b[^>]*>[\s\S]*?<\/(?:scenecard|adventurecard|statuscard|choicecard|summarycard)>|<!--\s*[A-Z0-9_]*_?START\s*-->[\s\S]*?<!--\s*[A-Z0-9_]*_?END\s*-->/gi

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
  // Line rule first, and the order is the whole point. "[ooc]: is the card broken?"
  // has its marker closed BEFORE the colon, so the delimited rule matched "[ooc]"
  // on its own, removed it, and left ": is the card broken?" behind — a line that
  // no longer contains the word "ooc" for the line rule to find. The aside then
  // read as ordinary prose, which is exactly how a four-message out-of-character
  // exchange got illustrated end to end.
  //
  // A whole line that opens with a marker is an aside entire. Only when that does
  // not apply is a delimited span removed from within a line.
  return String(text || '')
    .replace(OOC_LINE_RE, ' ')
    .replace(OOC_DELIMITED_RE, ' ')
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


// Used to answer one question: once the cards and markup are taken out, is there
// any prose left in this message at all? A turn that is only a rendered card has
// nothing to draw.
function stripMarkupForClassification(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/`[^`\n]*`/g, ' ')               // inline code
    .replace(/<!--[\s\S]*?-->/g, ' ')         // html comments, incl. the UI wrappers
    .replace(/<[^>]+>/g, ' ')                 // tags and their attribute soup
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function cleanParserMessageText(text, { keepLedger = false } = {}) {
  let value = stripParserUtilityCards(stripParserTrigger(stripThinking(text)))
  if (!keepLedger) value = stripLoomLedgers(value)
  // Before the tag strip, so an aside can never reach the parser as story prose
  // and become scenery.
  value = stripOutOfCharacter(value)
  // AND NEITHER MAY A CAST DECLARATION. This is the same bug as the line above,
  // one line away, and it cost a whole session.
  //
  //   [LUMICAST]{"name":"Fanny Price","count":"1boy","tags":"blue hair+long
  //    hair+hair down+blue eyes+slender+otokonoko","outfit":"sheer harem
  //    silks+gold jewelry+anklet+barefoot"}[/LUMICAST]
  //
  // …arrived in the prompt as `1boy, Fanny Price, blue hair, long hair, hair
  // down, blue eyes, slender, otokonoko, sheer harem silks, gold jewelry,
  // anklet, barefoot` — verbatim, in that order. In direct mode the parser
  // writes the prompt from the passage, and a block of ready-made booru tags
  // sitting in the passage is the easiest thing in it to copy.
  //
  // It looked like a character LumiDraw had saved somewhere and would not show,
  // and it could not be found because it was never saved: absorbCastDeclarations
  // had already matched the name to a character Eric wrote and correctly used
  // HIS. The declaration is machinery for LumiDraw to read, not prose, and it
  // must not survive to the parser — otherwise the story's guess at somebody
  // silently outranks the sheet.
  value = value.replace(CAST_DECLARATION_RE, ' ')
  value = value.replace(WEAR_DECLARATION_RE, ' ')
  return value
    .replace(TAG_RE, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Remembered outfits are keyed by subject ref; the parser needs names. Built here so
// both parser entry points describe the wardrobe the same way.
function wardrobeLinesFor(rememberedState, profiles) {
  const outfits = (rememberedState && rememberedState.outfits) || {}
  const lines = []
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile || !profile.ref) continue
    const tags = uniqueStrings(outfits[profile.ref] || [])
    if (!tags.length) continue
    // The ANCHOR, never the promptName. promptName exists for the image model —
    // the "Fanny reads as slang, write Price" escape hatch — but the parser reads
    // the story, and the story only ever says Fanny. A wardrobe line about "Price"
    // cannot be bound to anyone in the passage, so it read as a stranger's clothes.
    lines.push({ name: profile.anchor || profile.ref, tags })
  }
  return lines
}

// --- clothing digest ----------------------------------------------------------
// A recency window is the wrong instrument for a stable fact: the passage that
// dressed her could be thirty messages back, and widening the window just moves the
// blind spot without removing it — while giving the parser more material to
// rationalise a confident guess from.
//
// So this searches for the thing instead of hoping it is nearby: scan back a long
// way, keep only the sentences that mention clothing, and hand over a short digest
// in order. ~500 characters instead of ~24,000, and it finds the change moment
// wherever it is.
//
// It runs ONLY when the wardrobe has nothing for somebody in the scene. When the
// record is populated it is authoritative and this would be noise.
const CLOTHING_SENTENCE_RE = /\b(?:wearing|wears?|wore|clad|outfit|dressed|undressed|changed into|pulled on|pulled off|shrugged into|slipped (?:on|into|out of)|stripped|took off|threw on|buttoned|unbuttoned|zipped|unzipped|tugged|barefoot|topless|bottomless|naked|nude|shirt|t-shirt|blouse|tank top|sweater|hoodie|jacket|coat|cardigan|corset|dress|gown|robe|nightgown|pajamas|pyjamas|skirt|shorts|jeans|trousers|pants|leggings|boots|sneakers|shoes|sandals|heels|socks|stockings|thighhighs|apron|uniform|swimsuit|bikini|underwear|lingerie|panties|bra|boxers|briefs)\b/i

function clothingDigest(messages, targetIndex, window = 30, maxChars = 900) {
  if (!Array.isArray(messages) || !Number.isInteger(targetIndex)) return []
  const found = []
  const start = Math.max(0, targetIndex - window)
  for (let i = start; i < targetIndex && i < messages.length; i++) {
    const bits = messageBits(messages[i] || {})
    if (!bits || typeof bits.content !== 'string') continue
    // Cards and out-of-character asides are not the story's account of anybody's
    // clothes, and the card stripper already knows how to remove them.
    const text = cleanParserMessageText(bits.content)
    if (!text) continue
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const line = sentence.trim()
      if (line.length < 12 || line.length > 220) continue
      if (!CLOTHING_SENTENCE_RE.test(line)) continue
      found.push(line)
    }
  }
  // Most recent last, and trimmed from the FRONT when over budget: the newest
  // mention is the one most likely to still be true.
  let total = 0
  const kept = []
  for (let i = found.length - 1; i >= 0 && total < maxChars; i--) {
    kept.unshift(found[i])
    total += found[i].length
  }
  return kept
}

// A wardrobe sync is deliberately smaller than an image parse. It reads the
// latest passage, reports only clothing that passage explicitly establishes,
// and never calls Draw Things. The existing wardrobe is supplied so a partial
// action such as "pulled on jeans" can retain garments the passage did not
// remove without asking the model to invent the rest of an outfit.
const WARDROBE_SYNC_RULES = `
You are a DATA FORMATTER. Read the CURRENT PASSAGE and extract only explicit
clothing-state updates. Do not continue the story, describe an image, or invent
an outfit.

OUTPUT — only compact JSON, no markdown or commentary:
{"updates":[{"name":"exact character name from KNOWN CHARACTERS","evidence":"3-14 exact consecutive words from CURRENT PASSAGE","outfit":["complete current clothing tags"]}]}

RULES
- Return {"updates":[]} when the CURRENT PASSAGE does not explicitly show or
  state a character's clothing, dressing, undressing, or garment removal.
- Ordinary actions and context are not clothing evidence. Waking up does not
  imply underwear; leaving home does not imply getting dressed.
- A visible statement such as "wearing a red dress" is an update even without
  a change verb. Copy its clothing meaning into short booru-style tags.
- The evidence must be copied exactly and must come from CURRENT PASSAGE, never
  RECENT CONTEXT. Context resolves names and pronouns only.
- "outfit" is the complete resulting state: retain CURRENT WARDROBE items the
  passage did not remove, include every explicitly added garment, and use
  "nude", "topless", "bottomless", or "barefoot" when directly established.
- Never guess a missing garment, color, shoes, underwear, or accessory.
- Use each character's exact KNOWN CHARACTERS name. One update per character.
`

function wardrobeProfileForName(name, profiles) {
  const wanted = normalizeIdentityText(name)
  if (!wanted) return null
  return allKnownProfiles(profiles).find((profile) => profile && profile.ref &&
    [profile.anchor, profile.promptName, profile.ref].some((value) =>
      normalizeIdentityText(value) === wanted)) || null
}

function effectiveWardrobeForProfiles(state, profiles) {
  const saved = (state && state.outfits) || {}
  const result = {}
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile || !profile.ref) continue
    const recorded = uniqueStrings(saved[profile.ref] || [])
    result[profile.ref] = recorded.length ? recorded : uniqueStrings(profile.defaultOutfit || [])
  }
  return result
}

function buildWardrobeSyncInput(messages, targetIndex, target, profiles, state) {
  const effective = effectiveWardrobeForProfiles(state, profiles)
  const characterLines = []
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile || !profile.ref) continue
    const name = profile.anchor || profile.promptName || profile.ref
    const recorded = uniqueStrings(((state && state.outfits) || {})[profile.ref] || [])
    const current = effective[profile.ref] || []
    const source = recorded.length ? 'recorded current state' : (current.length ? 'saved default fallback' : 'unknown')
    characterLines.push(`- ${name} (${profile.ref}) · ${source}: ${current.join(', ') || '(do not invent clothing)'}`)
  }

  const context = []
  let remaining = 1800
  for (let i = targetIndex - 1; i >= 0 && i >= targetIndex - 5 && remaining > 0; i--) {
    const bits = messageBits(messages[i] || {})
    if (typeof bits.content !== 'string') continue
    const cleaned = cleanParserMessageText(bits.content).replace(/\s+/g, ' ').trim()
    if (!cleaned) continue
    const clipped = cleaned.slice(-Math.min(remaining, 700))
    context.unshift((bits.isAssistant ? 'Assistant' : bits.isUser ? 'User' : 'Chat') + ': ' + clipped)
    remaining -= clipped.length
  }

  return [
    'KNOWN CHARACTERS AND CURRENT WARDROBE',
    characterLines.join('\n') || '(none)',
    '',
    'RECENT CONTEXT — pronoun/name resolution only; never extract an update from here',
    context.join('\n') || '(none)',
    '',
    'CURRENT PASSAGE — all evidence and updates must come from here',
    cleanParserMessageText(target.content).slice(-6000),
  ].join('\n')
}

function parseWardrobeSyncReply(raw, profiles, passage, currentOutfits = {}) {
  let parsed
  try { parsed = parseJsonObject(extractParserText(raw), 'wardrobe sync') }
  catch (error) { return { updates: [], rejected: [error.message] } }
  if (!parsed || !Array.isArray(parsed.updates)) {
    return { updates: [], rejected: ['Wardrobe sync reply did not contain an updates array.'] }
  }

  const passageNorm = normalizeIdentityText(passage)
  const updatesByRef = new Map()
  const rejected = []
  for (const item of parsed.updates.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim().slice(0, 64)
    const profile = wardrobeProfileForName(name, profiles)
    if (!profile) {
      rejected.push(`${name || 'Unnamed update'} did not match a known character.`)
      continue
    }
    const evidence = String(item.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    const evidenceNorm = normalizeIdentityText(evidence)
    const evidenceWords = evidenceNorm ? evidenceNorm.split(/\s+/).filter(Boolean).length : 0
    if (!evidenceNorm || evidenceWords < 3 || evidenceWords > 14 || !passageNorm.includes(evidenceNorm)) {
      rejected.push(`${profile.anchor || profile.ref} had no valid exact evidence quote in the latest passage.`)
      continue
    }
    if (!CLOTHING_SENTENCE_RE.test(evidence) && !OUTFIT_CHANGE_RE.test(evidence) &&
        !UNDRESS_FULL_RE.test(evidence) && !UNDRESS_VERB_RE.test(evidence)) {
      rejected.push(`${profile.anchor || profile.ref}'s evidence did not explicitly establish clothing.`)
      continue
    }

    const offered = animaTagList(Array.isArray(item.outfit)
      ? item.outfit
      : String(item.outfit || '').split(/[,+]/)).slice(0, 12)
    if (!offered.length) {
      rejected.push(`${profile.anchor || profile.ref}'s update had no clothing tags; use "nude" for an explicitly bare state.`)
      continue
    }
    const before = uniqueStrings(currentOutfits[profile.ref] || [])
    const unsupported = offered.filter((tag) => {
      if (BARE_STATE_RE.test(tag)) {
        return !(BARE_STATE_RE.test(evidence) || UNDRESS_FULL_RE.test(evidence) || UNDRESS_VERB_RE.test(evidence))
      }
      if (isNotClothing(tag)) return true
      // Existing garments may be carried forward. Anything new must be named
      // or synonym-grounded in the latest passage itself.
      return !garmentSupported(tag, passage, before, null)
    })
    if (unsupported.length) {
      rejected.push(`${profile.anchor || profile.ref}'s proposed outfit contained unsupported clothing: ${unsupported.join(', ')}.`)
      continue
    }
    if (before.join('\u0000') === offered.join('\u0000')) continue
    updatesByRef.set(profile.ref, {
      ref: profile.ref,
      name: profile.anchor || profile.promptName || profile.ref,
      outfit: offered,
      evidence,
    })
  }
  return { updates: [...updatesByRef.values()], rejected }
}

async function syncWardrobeFromLatestPassage(userId, chatId, preset, settings) {
  if (!preset) throw new Error('Choose an active story preset before syncing the wardrobe.')
  if (activeStoryScan) throw new Error('A story scan is already running. Wait for it to finish, then sync the wardrobe.')
  const located = await locateStoryMessage(userId, { chatId })
  if (!located.target || located.targetIndex < 0) {
    throw new Error('Could not find the latest assistant story passage in this chat.')
  }
  const resolvedChatId = String(chatId || located.chatId || '')
  const target = located.target
  const passage = cleanParserMessageText(target.content).slice(-6000)
  if (!passage) throw new Error('The latest assistant message has no readable story text.')

  // A latest passage may introduce the person whose clothes it establishes.
  // Adopt that declaration before binding an update, or the result would be
  // rejected merely because the wardrobe panel had not been refreshed first.
  await absorbCastDeclarations(located.messages, located.targetIndex, preset, resolvedChatId)
  const profiles = await getStoryProfiles(preset, settings, userId, resolvedChatId)
  const state = await readSceneMemory(resolvedChatId, preset.name)
  const currentOutfits = effectiveWardrobeForProfiles(state, profiles)
  const input = buildWardrobeSyncInput(located.messages, located.targetIndex, target, profiles, state)
  const report = {}
  const raw = await quietLLM(WARDROBE_SYNC_RULES.trim(), input, settings, userId, true, null, report)
  const parsed = parseWardrobeSyncReply(raw, profiles, passage, currentOutfits)

  if (parsed.updates.length) {
    const now = Date.now()
    const outfits = {}
    const outfitMeta = {}
    for (const update of parsed.updates) {
      outfits[update.ref] = update.outfit
      outfitMeta[update.ref] = {
        source: 'latest-passage',
        at: now,
        messageId: String(target.id || ''),
        evidence: update.evidence,
      }
    }
    await rememberSceneState(resolvedChatId, preset.name, { outfits, outfitMeta })
    spindle.log.info('[lumidraw] wardrobe sync · ' + parsed.updates.map((update) =>
      `${update.name}: ${update.outfit.join(', ')} <= "${update.evidence}"`).join(' · '))
  } else {
    spindle.log.info('[lumidraw] wardrobe sync · latest passage established no clothing changes')
  }
  for (const reason of parsed.rejected) spindle.log.info('[lumidraw] wardrobe sync ignored · ' + reason)
  return {
    updates: parsed.updates,
    rejected: parsed.rejected,
    messageId: String(target.id || ''),
    model: report.model || '',
  }
}

function buildAnimaParserInput(messages, targetIndex, target, settings, sceneState = null) {
  const currentPassage = cleanParserMessageText(target.content).slice(-6000)
  const contextCount = Math.max(0, Math.min(4, Number(settings.parserContextMessages) || 0))
  const previous = []
  if (contextCount > 0 && Number.isInteger(targetIndex) && targetIndex > 0) {
    // Prefer the nearest messages and cap the entire reference window. Large
    // scene/adventure cards are stripped above and cannot crowd out the actual
    // prose or inflate the parser request.
    // The setting counts STORY messages, not turns.
    //
    // It used to walk back N messages of any kind, and a roleplay chat alternates.
    // So "2 messages of context" bought one assistant message and one of yours —
    // and yours is "I take her hand", not the paragraph describing the room. Half
    // the window went to the half of the conversation that carries the least scene.
    //
    // A user message is still included when it falls inside the window, because it
    // is the persona acting and matters for pronouns and intent. It just does not
    // consume the budget. The character cap still bounds the whole thing, so a long
    // one cannot crowd out the prose.
    // There IS a message cap — it is the setting. These are a second, defensive
    // layer so one enormous message cannot inflate the request, and they were fixed
    // numbers: 3,000 across the whole window and 1,200 per message, while the
    // current passage gets 6,000. A roleplay message is routinely longer than 1,200,
    // so every message of context arrived pre-truncated and asking for four bought
    // barely more than asking for two.
    //
    // Scaled to the setting instead: ask for four messages and you get four
    // messages' worth. The ceiling stays, because it is protecting the request
    // rather than rationing the story.
    const perMessageChars = 3000
    const collected = []
    let remainingChars = Math.min(12000, Math.max(3000, contextCount * 3000))
    let storyMessages = 0
    const scanFloor = Math.max(0, targetIndex - (contextCount * 3) - 4)
    for (let i = targetIndex - 1; i >= scanFloor && remainingChars > 0; i--) {
      if (storyMessages >= contextCount) break
      const bits = messageBits(messages[i])
      if (!bits.contentKey || typeof bits.content !== 'string') continue
      const cleanAll = cleanParserMessageText(bits.content)
      if (!cleanAll) continue
      const clean = cleanAll.slice(-Math.min(perMessageChars, remainingChars))
      if (!clean) continue
      const label = bits.isAssistant ? 'Previous assistant message' : bits.isUser ? 'Previous user message' : 'Previous chat message'
      collected.push(`[${label}]\n${clean}`)
      remainingChars -= clean.length
      if (bits.isAssistant || !bits.isUser) storyMessages++
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
  // The wardrobe, stated outright, for the same reason the location is.
  //
  // A passage says "white shirt and jean shorts" once. Ten turns later the parser
  // is asked for an outfit again, has no record of the first answer, and writes
  // "baggy blue shirt, loose exercise shorts" — not a change of clothes, a second
  // description of the same clothes. Everything downstream is then correct about
  // the wrong garment, so the fix has to be here, before the answer is given.
  if (sceneState && (sceneState.outfits || []).length) {
    stateLines.push(...sceneState.outfits.map((entry) => `${entry.name} is wearing: ${entry.tags.join(', ')}`))
  }
  // Only when the record cannot answer. A populated wardrobe is authoritative and
  // this would be noise on top of it.
  if (sceneState && (sceneState.clothingDigest || []).length) {
    stateLines.push('Clothing mentioned earlier in this story, oldest first — use it to work out what they are wearing now, and remember a later line undoes an earlier one:\n' +
      sceneState.clothingDigest.map((line) => '- ' + line).join('\n'))
  }
  if (stateLines.length) {
    // The wardrobe sentence is only worth its tokens when there is a wardrobe. A
    // scene with nothing but a location should not pay for advice about clothes.
    const wardrobeRule = (sceneState && (sceneState.outfits || []).length)
      ? (settings.mode === 'direct' || settings.directMode === true
        ? '\nAttire is kept for you. Each clothing line above is what that character is wearing NOW — copy it exactly unless the CURRENT PASSAGE changes, removes, or adds clothing (a time-skip counts). When it changes, report the complete new outfit in "outfits". Never re-word unchanged clothing: a re-wording reads as a costume change.'
        : '\nAttire is kept for you. OMIT a subject\'s outfit array entirely when the CURRENT PASSAGE does not change it — silence means unchanged, and the wardrobe line above is used. Fill it in only when the passage changes, removes, or adds clothing, or when a time-skip ("later", "the next morning", "after dressing") means they would have changed. When you do fill it in, give the WHOLE outfit, not the one garment the passage mentioned. Never re-describe clothing that has not changed: a re-wording reads as a costume change to the image model. If the CURRENT PASSAGE clearly shows different clothes — a change, not a re-wording — report the passage\'s version; your report outranks the wardrobe line.')
      : ''
    sections.push('----- ESTABLISHED SCENE STATE — AUTHORITATIVE -----\n' +
      'This is where the story currently is. Use it for setting and lighting unless the CURRENT PASSAGE states that the characters moved or the light changed. Never invent a different place, and never describe a location that appears nowhere in this request.' +
      wardrobeRule + '\n\n' +
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

// A message id is not enough to identify what was illustrated.
//
// A SWIPE — asking the model to redo a reply — replaces the message's content
// but keeps its id. The old content had images, so the id was in this list, so
// the replacement was skipped as "already illustrated" and no image was ever
// made. The log went silent because that check returns before anything is
// logged, which made it look like the parser had run and then simply stopped.
//
// So an entry records WHICH TEXT was illustrated, not merely which message.
// FNV-1a: stable across runs, no dependency, and this is a cache key rather
// than anything security-bearing.
function contentFingerprint(text) {
  const value = String(text || '')
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function processedKey(messageId, content) {
  return `${messageId}:${contentFingerprint(content)}`
}

// `migrate` is only passed by the authoritative caller — the one holding the
// real message text. The early optimisation checks read with the event's copy
// of the content, which can differ, and must not write a fingerprint from it.
async function wasProcessed(messageId, content, { migrate = false } = {}) {
  const id = String(messageId || '')
  if (!id) return false
  const list = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
  // No content to compare: fall back to id-only, the pre-0.61 behaviour.
  if (content === undefined || content === null) {
    return list.some((entry) => entry === id || String(entry).startsWith(id + ':'))
  }
  if (list.includes(processedKey(id, content))) return true
  // A bare id was written before fingerprinting existed. Treat it as a match —
  // the far likelier reading is a replay of the same message than a swipe — and
  // adopt the text we can see as its content, so the NEXT swipe is detected.
  const legacy = list.indexOf(id)
  if (legacy >= 0) {
    if (migrate) {
      list[legacy] = processedKey(id, content)
      await spindle.storage.setJson(PROCESSED_FILE, list.slice(-50), { indent: 0 })
    }
    return true
  }
  return false
}

async function markProcessed(messageId, content) {
  const id = String(messageId || '')
  if (!id) return
  const list = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
  const keyed = processedKey(id, content)
  // Drop any older record of this id — a swipe supersedes what came before, and
  // keeping both wastes slots in a 50-entry window.
  const pruned = list.filter((entry) => entry !== id && !String(entry).startsWith(id + ':'))
  pruned.push(keyed)
  await spindle.storage.setJson(PROCESSED_FILE, pruned.slice(-50), { indent: 0 })
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

// Which message of yours prompted this reply? Extracted from the scan so it can be
// tested directly: an out-of-character exchange is usually several turns long, and
// the whole gate rests on this walking back to the right message on turn four as
// reliably as it does on turn two.
//
// It stops at the first message of yours, and does NOT stop at an intervening
// assistant message — a preset that posts a card of its own between your question
// and its answer would otherwise hide the question from the gate. Nothing but a
// message of yours ends the search, and only the window bounds it.
function precedingUserMessage(messages, targetIndex, window = 8) {
  if (!Array.isArray(messages) || !Number.isInteger(targetIndex)) return null
  for (let i = targetIndex - 1; i >= 0 && i >= targetIndex - window; i--) {
    const bits = messageBits(messages[i] || {})
    if (!bits || typeof bits.content !== 'string' || !bits.content.trim()) continue
    if (bits.isUser) return bits
  }
  return null
}

// --- cast declared by the story ---------------------------------------------
// When a character walks on undescribed, somebody has to decide what they look
// like. That decision belongs to the story model, not to LumiDraw: if LumiDraw
// invented an appearance, the story would never learn what was decided and the
// next passage could contradict the picture. So the preset emits the decision and
// LumiDraw locks it.
//
// Shape follows the preset's own payload convention — a marker, JSON, a closing
// marker — so it sits alongside [REFRESH] and [Motive Ledger] rather than
// introducing a new idea:
//
//   <payload>
//   [LUMICAST]{"name":"Mira","count":"1girl","tags":"brown hair+freckles"}[/LUMICAST]
//   </payload>
const CAST_DECLARATION_RE = /\[LUMICAST\]\s*(\{[\s\S]*?\})\s*\[\/LUMICAST\]/gi

// --- clothing declared by the story -----------------------------------------
// "Maybe a preset prompt addition for the story model to constantly update
//  clothing? I do not want to be responsible for manually updating the LumiDraw
//  app with clothing tags. That sounds terrible."
//
// It would be, and a wardrobe only you can update is a wardrobe that is wrong
// within two turns. LUMICAST already proved the shape: the story model knows
// what happened, so let it say so, and let LumiDraw keep the record.
//
//   [LUMIWEAR]{"name":"Fanny","outfit":"sheer harem silks+gold jewelry+anklet"}[/LUMIWEAR]
//
// One rule, and it is the whole point: a declaration REPLACES that character's
// outfit rather than merging into it. Merging is what produced "midriff pops up
// if the wardrobe has midriff typed" — old clothes surviving a change of clothes.
const WEAR_DECLARATION_RE = /\[LUMIWEAR\]\s*(\{[\s\S]*?\})\s*\[\/LUMIWEAR\]/gi

function extractWearDeclarations(text) {
  const found = []
  WEAR_DECLARATION_RE.lastIndex = 0
  for (const match of String(text || '').matchAll(WEAR_DECLARATION_RE)) {
    let raw = null
    try { raw = JSON.parse(sanitizeJsonText(match[1])) } catch { continue }
    if (!raw || typeof raw !== 'object') continue
    const name = shortPhrase(raw.name || raw.anchor || '', 'wear name', 6, 64, true, true)
    if (!name) continue
    const outfit = uniqueStrings(String(raw.outfit || raw.clothing || raw.wearing || '')
      .split(/[+,]/).map((part) => animaTag(part)).filter(Boolean)).slice(0, 12)
    // An empty outfit is a real statement — "nude" — but an ABSENT one is a
    // malformed declaration. Only the second is dropped.
    if (!('outfit' in raw || 'clothing' in raw || 'wearing' in raw)) continue
    found.push({ name, outfit })
  }
  return found
}

// LAST declaration wins, the opposite of LUMICAST. A character is described once
// but changes clothes repeatedly, and within a scan window the newest statement
// is the current one.
async function absorbWearDeclarations(messages, targetIndex, profiles, chatId, scope, window = 6) {
  if (!Array.isArray(messages) || !profiles) return []
  const start = Number.isInteger(targetIndex) ? Math.max(0, targetIndex - window) : 0
  const end = Number.isInteger(targetIndex) ? targetIndex : messages.length - 1
  const declared = []
  for (let i = start; i <= end && i < messages.length; i++) {
    const bits = messageBits(messages[i] || {})
    if (typeof bits.content !== 'string') continue
    declared.push(...extractWearDeclarations(bits.content))
  }
  if (!declared.length) return []
  const known = allKnownProfiles(profiles)
  const memory = await getSceneMemory()
  const key = sceneMemoryKey(chatId, scope)
  const previous = memory[key] || {}
  const outfits = { ...(previous.outfits || {}) }
  const outfitMeta = { ...(previous.outfitMeta || {}) }
  const applied = []
  for (const entry of declared) {
    const wanted = normalizeIdentityText(entry.name)
    const match = known.find((profile) => profile &&
      (normalizeIdentityText(profile.anchor) === wanted ||
       normalizeIdentityText(profile.promptName) === wanted ||
       normalizeIdentityText(profile.ref) === wanted))
    // Somebody the story dressed who is not in this cast. Silently writing an
    // outfit against a ref nobody owns is how anonymous wardrobe rows appeared.
    if (!match || !match.ref) continue
    // Re-declaring the same outfit is not a change, and under the 0.97 block it
    // happens EVERY TURN for everyone on screen — that is the point, because the
    // model cannot see its own earlier declarations and so cannot be asked to
    // remember whether anything moved. LumiDraw holds the record, so LumiDraw
    // does the diffing: an identical declaration must cost nothing, write
    // nothing, and say nothing, or the log becomes noise you learn to ignore.
    const before = (outfits[match.ref] || []).join('\u0000')
    if (before === entry.outfit.join('\u0000')) continue
    outfits[match.ref] = entry.outfit
    outfitMeta[match.ref] = {
      source: 'story-declaration',
      at: Date.now(),
      evidence: '[LUMIWEAR] declaration',
    }
    applied.push({ name: match.anchor || match.ref, outfit: entry.outfit })
  }
  if (!applied.length) return []
  memory[key] = { ...previous, outfits, outfitMeta, at: Date.now() }
  await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
  for (const item of applied) {
    spindle.log.info(`[lumidraw] the story dressed ${item.name} · ${item.outfit.join(', ') || '(nothing)'}`)
  }
  return applied
}

function extractCastDeclarations(text) {
  const found = []
  CAST_DECLARATION_RE.lastIndex = 0
  for (const match of String(text || '').matchAll(CAST_DECLARATION_RE)) {
    let raw = null
    try { raw = JSON.parse(sanitizeJsonText(match[1])) } catch (error) { continue }
    if (!raw || typeof raw !== 'object') continue
    const name = shortPhrase(raw.name || raw.anchor || '', 'cast name', 6, 64, true, true)
    if (!name) continue
    // "+" is this preset family's list delimiter; commas are accepted too because
    // a model asked for booru tags will reach for commas by habit.
    const list = (value) => uniqueStrings(String(value || '').split(/[+,]/).map((part) => animaTag(part)).filter(Boolean)).slice(0, 12)
    found.push({
      name,
      countTag: shortPhrase(raw.count || raw.count_tag || raw.countTag || '', 'cast count tag', 3, 24, true),
      appearance: list(raw.tags || raw.appearance),
      outfit: list(raw.outfit || raw.clothing),
    })
  }
  return found
}

// First declaration wins. The preset strips aged <payload> blocks from the model's
// own context, so it cannot remember whom it already described and may declare the
// same character twice with different hair. Durability belongs here, where the
// record is, rather than in an instruction the model may not be able to follow.
// `chatId` is the fix for the leak Eric found: a character the story invents
// belongs to the story that invented it. Before this it went into the preset's
// cast list, the preset is global, and nothing ever took it out again — so every
// character every chat ever declared showed up in every other chat forever.
async function absorbCastDeclarations(messages, targetIndex, preset, chatId = '', window = 6) {
  if (!Array.isArray(messages) || !preset) return { added: [], skipped: [] }
  const start = Number.isInteger(targetIndex) ? Math.max(0, targetIndex - window) : 0
  const end = Number.isInteger(targetIndex) ? targetIndex : messages.length - 1
  const declared = []
  for (let i = start; i <= end && i < messages.length; i++) {
    const bits = messageBits(messages[i] || {})
    if (typeof bits.content !== 'string') continue
    declared.push(...extractCastDeclarations(bits.content))
  }
  if (!declared.length) return { added: [], skipped: [] }

  const characters = await getCharacters()
  const added = []
  const skipped = []
  // Where does a character the story invents belong? In the cast of the story
  // that invented it. Writing into preset.castLibraryIds — which is global and
  // shared by every chat — is what made one story's cast turn up in another, and
  // 0.73.0 could only paper over it by filtering the polluted list at read time.
  // With a cast bound, there is nothing to filter: it never gets in.
  const boundCast = await castForChat(chatId)
  let castIds = Array.isArray((boundCast || {}).castLibraryIds)
    ? boundCast.castLibraryIds.slice() : []
  for (const entry of declared) {
    const key = normalizeIdentityText(entry.name)
    const existing = characters.find((item) => normalizeIdentityText(item && item.name) === key)
    if (existing) {
      // Already known — including anyone you typed in yourself, whose version wins.
      if (!castIds.includes(existing.id)) castIds.push(existing.id)
      skipped.push(entry.name)
      continue
    }
    if (!entry.appearance.length) { skipped.push(entry.name); continue }
    const id = `cast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    characters.push({
      id,
      name: entry.name,
      profile: {
        anchor: entry.name,
        countTag: entry.countTag,
        appearanceTags: entry.appearance.join(', '),
        defaultOutfit: entry.outfit.join(', '),
        // Recorded so a profile you wrote is never mistaken for one the story
        // invented — and so removal can delete the story's inventions while never
        // touching a character you typed in yourself.
        declaredByStory: true,
        // Which story invented them. An entry without this is from before the
        // scoping existed and cannot be attributed, so it stays visible
        // everywhere, marked, until it is removed by hand.
        declaredInChat: String(chatId || ''),
      },
      updatedAt: Date.now(),
    })
    castIds.push(id)
    added.push(entry.name)
  }
  if (!added.length && !skipped.length) return { added, skipped }
  if (added.length) {
    characters.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    await saveCharacters(characters)
  }
  const nextIds = uniqueStrings(castIds)
  if (boundCast) {
    if (nextIds.join('|') !== (boundCast.castLibraryIds || []).join('|')) {
      const casts = await getCasts()
      const index = casts.findIndex((item) => item && item.id === boundCast.id)
      if (index >= 0) {
        casts[index] = { ...casts[index], castLibraryIds: nextIds }
        await saveCasts(casts)
        spindle.log.info(`[lumidraw] ${added.join(', ') || 'cast'} joined the cast "${boundCast.name}" — this chat only`)
      }
    }
    // The preset is not touched at all on this path. That is the point.
    return { added, skipped }
  }
  // An unbound chat gets a chat-local cast only when there is actually someone
  // to store. Never write story people back into the generation preset.
  if (nextIds.length) {
    const written = await writeCastIds(preset, chatId, nextIds)
    spindle.log.info(`[lumidraw] ${added.join(', ') || 'cast'} joined ${written.where} — this chat only`)
  }
  return { added, skipped }
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
  const nativePlacements = await listImagePlacements(chatId)
  const nativeImageMessages = new Set(nativePlacements.map((item) => String(item.messageId || '')))
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
    hasImage: nativeImageMessages.has(String(bits.id)) || /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*\bsrc\s*=/i.test(bits.content),
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

// Current Lumiverse virtualizes messages and lazy-loads images. Markdown images
// have no intrinsic dimensions until their file is decoded, so a row can be measured
// as text-only and then jump by hundreds of pixels when the image loads. Supplying
// HTML width/height lets the browser reserve the final aspect ratio immediately.
function htmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function storyImageMarkup(imageUrl, alt, dimensions = null) {
  const width = Math.max(0, Math.round(Number(dimensions && dimensions.width) || 0))
  const height = Math.max(0, Math.round(Number(dimensions && dimensions.height) || 0))
  const size = width > 0 && height > 0 ? ` width="${width}" height="${height}"` : ''
  return `<img data-lumidraw-image="1" src="${htmlAttr(imageUrl)}" alt="${htmlAttr(markdownAltText(alt, 120))}"${size} loading="lazy" decoding="async">`
}

function removeImageMarkupFromContent(content, imageUrl) {
  const text = String(content || '')
  const url = String(imageUrl || '').trim()
  if (!text || !url) return { content: text, removed: false }
  const wanted = normalizeForImageMatch(url)
  let removed = false
  let next = text.replace(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)\s*/g, (match, href) => {
    if (normalizeForImageMatch(href) !== wanted) return match
    removed = true
    return ''
  })
  next = next.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (!src || normalizeForImageMatch(src[1]) !== wanted) return tag
    removed = true
    return ''
  })
  if (removed) next = next.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n')
  return { content: next, removed }
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
    for (const match of bits.content.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0]
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)
      const altMatch = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)
      if (!src || !altMatch) continue
      const alt = normalizeIdentityText(altMatch[1]
        .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&'))
      if (alt.length < 20) continue
      if (prompt.includes(alt)) candidates.push({ bits, url: src[1], alt })
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

async function generateAndUpload({ prompt, negativePrompt, config, extra, dims, seed, origin, debug }, userId, scan = null) {
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
  const { images, backend, fellBackFrom } = await generateImages(settings, payloadOut, 'story generation')
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
    // Which machine drew it. Worth keeping: a cloud image and a local one from
    // the same preset are not the same picture, and a silent fallback would
    // otherwise be invisible in the history.
    backend,
    ...(fellBackFrom ? { fellBackFrom } : {}),
    // Everything needed to regenerate this image later and put the result back
    // where it came from: the owning message, and the exact recipe used.
    ...(origin && typeof origin === 'object' ? { origin } : {}),
    recipe: { config: merged || null, extra: extra || null },
    // The compile trace and the parsed scene, kept with the image they produced.
    // Every diagnosis this project has got wrong was made by reading the code and
    // guessing what the app did; the trace says what it actually did, and it used
    // to exist only until the next image overwrote LAST_DIAGNOSTIC.
    ...(debug ? { trace: debug.trace || [], scene: debug.scene || null } : {}),
  }
  assertStoryScanActive(scan)
  const history = await pushHistory(entry, userId)
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

// WHO IS IN THIS CHAT, according to the chat itself.
//
// The cast holds a character and a persona, and neither could be filtered or
// edited — so starting a new story with a different persona pinned the old one.
// The cast was the wrong place to answer this: Lumiverse already knows which
// character card and which persona a chat is using, and that answer is always
// current.
//
// Every field name here is a guess at a DTO I cannot see, so each is a LIST of
// candidates and a miss is logged with the real keys rather than failing
// silently. That is the same shape getCharacterImageTags already uses, because
// it had the same problem.
async function chatOccupants(userId, chatId) {
  const out = { characterId: '', personaId: '', chatKeys: [] }
  try {
    const chatsApi = spindle.chats
    if (!chatsApi || typeof chatsApi.get !== 'function' || !chatId) return out
    let chat = null
    for (const args of [[chatId, userId], [{ chatId, userId }], [chatId]]) {
      try { const r = await chatsApi.get(...args); if (r) { chat = r; break } } catch { /* next */ }
    }
    if (!chat || typeof chat !== 'object') return out
    out.chatKeys = Object.keys(chat)
    out.characterId = String(chat.characterId || chat.character_id ||
      (Array.isArray(chat.characterIds) && chat.characterIds[0]) ||
      (Array.isArray(chat.characters) && ((chat.characters[0] || {}).id || chat.characters[0])) || '')
    // Eric's DTO, from the log: id, character_id, name, metadata, created_at,
    // updated_at. No persona field at the top level at all — so if it is anywhere
    // it is inside `metadata`, which is the only opaque one. Rather than guess a
    // key inside it, walk it for anything persona-shaped and log what was there.
    const meta = (chat.metadata && typeof chat.metadata === 'object') ? chat.metadata : {}
    out.metaKeys = Object.keys(meta)
    const fromMeta = () => {
      for (const [key, value] of Object.entries(meta)) {
        if (!/persona/i.test(key)) continue
        if (typeof value === 'string' && value.trim()) return value.trim()
        if (value && typeof value === 'object') {
          const inner = value.id || value.personaId || value.persona_id || value.name
          if (inner) return String(inner)
        }
      }
      return ''
    }
    out.personaId = String(chat.personaId || chat.persona_id ||
      (chat.persona && (chat.persona.id || chat.persona)) ||
      (Array.isArray(chat.personas) && ((chat.personas[0] || {}).id || chat.personas[0])) ||
      fromMeta() || '')
  } catch (error) {
    spindle.log.warn('[lumidraw] could not read the chat occupants: ' + error.message)
  }
  return out
}

// Turn a host card into the profile shape LumiDraw uses. Only the fields it
// actually has — anything missing stays missing rather than being invented.
function profileFromCard(card, ref) {
  if (!card || typeof card !== 'object') return null
  const name = String(card.name || card.title || card.displayName || '').trim()
  if (!name) return null
  let tags = ''
  for (const key of ['base_tags', 'baseTags', 'image_tags', 'imageTags',
    'visual_tags', 'visualTags', 'appearance_tags', 'appearanceTags']) {
    if (typeof card[key] === 'string' && card[key].trim()) { tags = card[key].trim(); break }
  }
  return normalizeProfile({ anchor: name, promptName: name, appearanceTags: tags, named: true }, tags, ref)
}

async function cardProfile(api, id, ref, userId) {
  if (!api || typeof api.get !== 'function' || !id) return null
  for (const args of [[id, userId], [{ id, userId }], [id]]) {
    try {
      const card = await api.get(...args)
      if (card) return profileFromCard(card, ref)
    } catch { /* next shape */ }
  }
  return null
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

// The gate was too strict for the scene it matters most in.
//
// From a real report: an explicit fellatio scene, two subjects. The futanari's
// anatomy resolved (she is nude, so nudeNow carried it). The RECEIVING partner's
// did not — profileAnatomy "penis", anatomyVisible true, rendered anatomy
// "none". He is in jeans with an open fly, so nudeNow is false, and the prose
// says "she took him in her mouth" rather than naming the anatomy possessively,
// so anatomyExplicitlyMentioned with requireOwnership found nothing.
//
// The result is an image of an act with the thing the act is performed ON absent
// from the prompt entirely. The model then has no anchor for what is physically
// happening, which is exactly when the bodies come out arranged wrong.
//
// The act itself is the ownership evidence requireOwnership was looking for. If
// the scene names fellatio and he is the target of it, whose anatomy is involved
// is not ambiguous.
const ANATOMY_ACT_RE = new RegExp([
  '\\bfellatio\\b', '\\birrumatio\\b', '\\bdeepthroat\\w*\\b', '\\bblow ?job\\b',
  '\\boral sex\\b', '\\bcunnilingus\\b', '\\bpaizuri\\b', '\\bhandjob\\b',
  '\\bpenetrat\\w+\\b', '\\bvaginal\\b', '\\banal sex\\b', '\\bintercourse\\b',
  '\\bcowgirl position\\b', '\\bmating press\\b', '\\bsex\\b',
].join('|'), 'i')

// True when the scene names an act that necessarily involves this subject's
// genitals AND this subject is a party to it. Both actor and target count: in
// the acts above, at least one participant's anatomy is the subject of the
// image, and the parser has already had to set anatomy_visible for the gate to
// be consulted at all.
function anatomyRequiredByAct(subject, scene) {
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return false
  const ref = String((subject && subject.ref) || '')
  if (!ref) return false
  // The SCENE STATEMENT is where the act lives, and looking anywhere else was
  // the first version's mistake. The parser is instructed to keep relation
  // actions spatial — "straddles the lap of", "sits beside" — and to put the act
  // in the statement using the clinical word: "[name] is performing fellatio on
  // [name]." So a relation-only check almost never matched, and restricting the
  // statement check to solo scenes excluded the two-person case it exists for.
  const statement = String(scene.sceneStatement || '')
  if (ANATOMY_ACT_RE.test(statement)) {
    // Everyone in the scene is a party to the act the statement names. The gate
    // still requires anatomy_visible from the parser and saved anatomy on the
    // profile, so this is the third of three conditions rather than a bypass.
    if ((scene.subjects || []).some((item) => String((item && item.ref) || '') === ref)) return true
  }
  // A relation carrying the act as well — rarer, but free to honour.
  const relations = (scene.relations || []).filter((relation) =>
    ANATOMY_ACT_RE.test(`${(relation && relation.action) || ''} ${((relation && relation.details) || []).join(' ')}`))
  if (relations.some((relation) => relation.actor === ref || relation.target === ref)) return true
  return false
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

// ---------------------------------------------------------------------------
// Named Looks
// ---------------------------------------------------------------------------
//
// An appearance state changes the BODY — werewolf, human, half-shifted. A Look
// changes the CLOTHES, and nothing else. They are deliberately separate: mixing
// them was what made appearance states dangerous in the first place, because
// switching one transformed the whole character.
//
// A Look is a named configuration ("formal", "swimwear", "armour") with:
//   aliases  — phrases in prose that mean this Look, so it can be inferred
//   outfit   — the garments it puts her in
//   negative — what must not appear while she is wearing it
//
// Looks sit ABOVE the wardrobe of record rather than replacing it. Selecting a
// Look SETS what she is wearing; from that point the ordinary wardrobe tracking
// takes over, so "she kicked off her sneakers" still persists. The precedence is
//
//     this passage > a Look that just became active > the wardrobe > her default
//
// which keeps every bit of the 0.53–0.56 clothing work earning its keep.
function normalizeLooks(value, label = 'look') {
  const rawItems = Array.isArray(value) ? value : String(value || '').split(/\r?\n/)
  const out = []
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index]
    let look
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const name = shortPhrase(raw.name || '', `${label} ${index + 1} name`, 6, 64, false)
      look = {
        name,
        aliases: shortList(raw.aliases || raw.recognition || [], `${label} ${name} aliases`, { maxItems: 12, maxWords: 8, maxChars: 80 }),
        outfit: shortList(raw.outfit || raw.outfitTags || [], `${label} ${name} outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
        negative: shortList(raw.negative || raw.negativeTags || [], `${label} ${name} negative`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
      }
    } else {
      look = parseLookLine(raw, `${label} ${index + 1}`)
    }
    if (!look) continue
    if (!look.name) continue
    // A Look with no clothes is not a Look. Allowing one would silently strip a
    // character when it was selected, which reads as a bug in the compiler
    // rather than as an empty field in an editor.
    if (!look.outfit.length) throw new Error(`Look \u201c${look.name}\u201d needs at least one outfit tag.`)
    const key = look.name.toLowerCase()
    const existing = out.findIndex((item) => item.name.toLowerCase() === key)
    if (existing >= 0) out[existing] = look
    else out.push(look)
  }
  return out.slice(0, 16)
}

// "formal = black evening gown, heels | aliases: gala, the dress | no: jeans"
function parseLookLine(raw, label) {
  const line = String(raw || '').trim()
  if (!line) return null
  const [head, ...rest] = line.split('|')
  const eq = head.indexOf('=')
  if (eq < 0) return null
  const name = shortPhrase(head.slice(0, eq), `${label} name`, 6, 64, false)
  if (!name) return null
  const look = {
    name,
    aliases: [],
    outfit: shortList(head.slice(eq + 1), `${label} outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    negative: [],
  }
  for (const part of rest) {
    const value = String(part || '').trim()
    const alias = /^(?:aliases?|recognize|recognition)\s*:/i.exec(value)
    if (alias) { look.aliases = shortList(value.slice(alias[0].length), `${label} aliases`, { maxItems: 12, maxWords: 8, maxChars: 80 }); continue }
    const negative = /^(?:no|negative|not)\s*:/i.exec(value)
    if (negative) { look.negative = shortList(value.slice(negative[0].length), `${label} negative`, { maxItems: 12, maxWords: 7, maxChars: 72 }) }
  }
  return look
}

function normalizeDefaultLook(value, looks) {
  const requested = String(value || '').trim().toLowerCase()
  if (!requested) return ''
  const found = (looks || []).find((look) => look.name.toLowerCase() === requested)
  return found ? found.name : ''
}

// Explicit beats inferred beats default, and every path reports WHY, because a
// character silently in the wrong clothes is the failure this whole area keeps
// producing and the trace is how it gets diagnosed.
function selectLook(profile, subject, sourcePassage = '', report = null) {
  const note = (look, reason) => {
    if (report) { report.look = look ? look.name : ''; report.reason = reason }
    return look
  }
  const looks = profile && Array.isArray(profile.looks) ? profile.looks : []
  if (!looks.length) return note(null, 'no looks defined')

  const requested = String((subject && (subject.look || subject.lookName)) || '').trim().toLowerCase()
  if (requested) {
    const direct = looks.find((look) => look.name.toLowerCase() === requested ||
      (look.aliases || []).some((alias) => String(alias).toLowerCase() === requested))
    if (direct) return note(direct, `parser asked for "${requested}"`)
    if (report) report.unmatchedRequest = requested
  }

  // Whole-word matching only, and the longest cue wins — the same rules
  // selectAppearanceState learned the hard way, where substring matching turned
  // "werewolf" into full wolf form.
  const passage = String(sourcePassage || '').toLowerCase()
  const candidates = []
  for (const look of looks) {
    for (const phrase of [...(look.aliases || [])]) {
      const value = String(phrase || '').trim().toLowerCase()
      if (value.length < 3) continue
      if (!new RegExp(`\\b${escapeRegExp(value)}\\b`).test(passage)) continue
      candidates.push({ look, cue: value, words: value.split(/\s+/).length, length: value.length })
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => (b.words - a.words) || (b.length - a.length))
    return note(candidates[0].look, `the passage says "${candidates[0].cue}"`)
  }

  const fallback = looks.find((look) => look.name === profile.defaultLook)
  if (fallback) return note(fallback, 'the default look')
  return note(null, 'nothing named or inferred, and no default')
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
  const looks = normalizeLooks(source.looks || source.namedLooks || '', `${fallbackRef} look`)
  return {
    ref: fallbackRef,
    anchor: shortPhrase(source.anchor || '', `${fallbackRef} anchor`, 6, 64, true, true) || fallbackRef,
    // What the image prompt should call this character, when their name reads
    // as something else to a booru-trained model. Blank means use the anchor.
    promptName: shortPhrase(source.promptName || '', `${fallbackRef} prompt name`, 6, 64, true, true),
    countTag,
    subject: shortPhrase(source.subject || '', `${fallbackRef} subject phrase`, 8, 72, true),
    // Direct mode's only rule. normalizeProfile builds a fresh object from named
    // fields, so a field that is not listed here simply does not survive — which
    // is how the lock would have silently locked nothing.
    identityTags: animaTagList(String(source.identityTags || '').split(',')).slice(0, 6).join(', '),
    appearance: shortList(appearance, `${fallbackRef} appearance`, { maxItems: 32, maxWords: 7, maxChars: 72 }),
    defaultOutfit: shortList(source.defaultOutfitTags || '', `${fallbackRef} default outfit`, { maxItems: 12, maxWords: 7, maxChars: 72 }),
    visualAliases: normalizeVisualAliases(source.visualAliases || source.namedVisualAliases || '', `${fallbackRef} visual alias`),
    partialFeatures: normalizePartialFeatures(source.partialFeatures || source.partialTraits || '', `${fallbackRef} partial feature`),
    anatomy: normalizeConditionalAnatomy(shortList(source.anatomyTags || '', `${fallbackRef} conditional anatomy`, { maxItems: 12, maxWords: 7, maxChars: 72 })),
    anatomyMode: normalizeAnatomyMode(source.anatomyMode),
    appearanceStates,
    defaultAppearanceState: normalizeDefaultAppearanceState(source.defaultAppearanceState || source.defaultForm || '', appearanceStates),
    looks,
    defaultLook: normalizeDefaultLook(source.defaultLook || '', looks),
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

// Who is allowed in this chat.
//
// A character you added by hand in the Characters tab is a deliberate choice and
// stays global — you picked them, so they are yours everywhere. A character the
// STORY invented belongs to the story that invented it, or the cast of every
// chat is the union of the cast of all chats, which is what was happening.
//
// An entry declared before this scoping existed carries no chat and cannot be
// attributed after the fact. Guessing would be worse than admitting it, so it
// stays visible everywhere and the panel marks it for removal.
function castMemberBelongsHere(entry, chatId) {
  const profile = (entry && entry.profile) || {}
  if (!profile.declaredByStory) return true
  const declaredIn = String(profile.declaredInChat || '')
  if (!declaredIn) return true
  return declaredIn === String(chatId || '')
}

// A generation preset no longer owns people. Legacy identity fields remain in the
// preset files for rollback/migration, but an UNBOUND chat must not silently read
// them or every new story starts with yesterday's cast.
function unboundStorySource(preset) {
  return {
    ...(preset || {}),
    characterProfile: null,
    personaProfile: null,
    characterLibraryId: '',
    personaLibraryId: '',
    characterTags: '',
    personaTags: '',
    castLibraryIds: [],
    activeCastId: '',
    activeCastName: '',
    fantasySetting: false,
  }
}

async function createChatLocalCast(chatId) {
  const chat = String(chatId || '').trim()
  if (!chat) throw new Error('Could not identify the current chat; no cast was changed.')
  const existing = await castForChat(chat)
  if (existing) return existing
  const casts = await getCasts()
  const cast = {
    id: `cast_chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: `Chat cast ${chat.slice(-6)}`,
    characterProfile: null,
    personaProfile: null,
    characterLibraryId: '',
    personaLibraryId: '',
    characterTags: '',
    personaTags: '',
    castLibraryIds: [],
    migratedFromPreset: '',
    chatLocal: true,
    createdAt: Date.now(),
  }
  casts.push(cast)
  await saveCasts(casts)
  await bindChatToCast(chat, cast.id)
  spindle.log.info(`[lumidraw] created an empty chat-local cast for ${chat}; generation presets no longer supply people`)
  return cast
}

// ONE WRITER for "who is in this chat's cast". An unbound chat gets its own
// empty cast on the first actual cast edit; the preset is never mutated.
async function writeCastIds(preset, chatId, ids) {
  const next = uniqueStrings(ids.map(String).filter(Boolean))
  const boundCast = await createChatLocalCast(chatId)
  const casts = await getCasts()
  const index = casts.findIndex((item) => item && item.id === boundCast.id)
  if (index >= 0) {
    casts[index] = { ...casts[index], castLibraryIds: next }
    await saveCasts(casts)
  }
  return { next, where: `the cast "${boundCast.name}"` }
}

async function castSourceFor(preset, chatId) {
  const cast = await castForChat(chatId)
  if (!cast) return unboundStorySource(preset)
  return {
    ...preset,
    characterProfile: cast.characterProfile,
    personaProfile: cast.personaProfile,
    characterLibraryId: cast.characterLibraryId || '',
    personaLibraryId: cast.personaLibraryId || '',
    characterTags: cast.characterTags || '',
    personaTags: cast.personaTags || '',
    castLibraryIds: Array.isArray(cast.castLibraryIds) ? cast.castLibraryIds : [],
    activeCastId: cast.id,
    activeCastName: cast.name,
    fantasySetting: !!cast.fantasy,
  }
}

// New chats deliberately do not auto-bind to a preset-derived cast.
// Existing explicit chat→cast bindings are still honored by castSourceFor().
async function getStoryProfiles(preset, settings, userId, chatId) {
  // New chats stay unbound until the user/story actually adds or selects a cast.
  // Legacy preset identities remain stored for rollback but are not active story state.
  preset = await castSourceFor(preset, chatId)
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
  // Four was right when you filled these by hand. A story that can introduce its
  // own cast needs headroom, and silently dropping the fifth person is the kind of
  // thing that becomes a mystery three sessions later. Prune in the Characters tab.
  const castIds = Array.isArray(preset.castLibraryIds) ? preset.castLibraryIds.slice(0, 12) : []
  for (let index = 0; index < castIds.length; index++) {
    const linked = characterLibrary.find((item) => item && item.id === castIds[index])
    if (!linked || !linked.profile) continue
    if (linked.id === preset.characterLibraryId) continue // already the main character
    if (!preset.activeCastId && !castMemberBelongsHere(linked, chatId)) continue
    const ref = castRefFor(linked.profile.anchor || linked.name, index, takenRefs)
    const profile = normalizeProfile(linked.profile, linked.profile.appearanceTags || '', ref)
    const resolved = await resolveProfile(profile, userId, chatId)
    // Provenance, additively. The compiler reads named fields and ignores these;
    // the wardrobe panel needs them to know what it may remove and what it must
    // never touch.
    resolved.libraryId = linked.id
    resolved.declaredByStory = !!linked.profile.declaredByStory
    resolved.declaredInChat = String(linked.profile.declaredInChat || '')
    cast.push(resolved)
  }

  // The chat wins for the two lead roles. A cast is who is in a STORY, and the
  // story's leads are whoever this chat is actually being played with — asking
  // the cast meant a new chat inherited the old persona with no way to change it.
  //
  // Only ever a REPLACEMENT, never a merge: a chat that names nobody keeps the
  // cast's answer, so nothing gets worse when the host cannot say.
  let leadCharacter = character
  let leadPersona = persona
  if (settings.chatLeads !== false) {
    const occupants = await chatOccupants(userId, chatId)
    const fromChat = await cardProfile(spindle.characters, occupants.characterId, 'character', userId)
    // The host may not expose a personas API at all — LumiDraw's own probe has a
    // line asking whether spindle.personas exists, which suggests past me was not
    // sure either. So try the host first, then LumiDraw's own persona library,
    // matched by id or by name. One of the two will have it.
    let asPersona = await cardProfile(spindle.personas, occupants.personaId, 'persona', userId)
    if (!asPersona && occupants.personaId) {
      const saved = await getPersonas()
      const wanted = normalizeIdentityText(occupants.personaId)
      const match = saved.find((item) => item &&
        (String(item.id) === occupants.personaId || normalizeIdentityText(item.name) === wanted))
      if (match) {
        asPersona = match.profile
          ? normalizeProfile(match.profile, match.profile.appearanceTags || '', 'persona')
          : profileFromCard({ name: match.name }, 'persona')
        if (asPersona) spindle.log.info(`[lumidraw] persona resolved from your own library: ${match.name}`)
      }
    }
    // A CARD THAT DESCRIBES NOBODY MUST NOT EVICT A PROFILE THAT DOES.
    //
    // "It's still using the lumicast Fanny Price. I don't see how to change it."
    //
    // The chat's card was "The Remote" — a world and a setting, written as a
    // character card because that is where Lumiverse puts narration. It carries
    // no visual tags at all, so profileFromCard returned an anchor and nothing
    // else, and 0.90 handed that to the lead slot in place of a fully written
    // Fanny Price. She then appeared in no sheet the parser was given, so direct
    // mode invented her from the prose on every single generation — which is
    // exactly the "tags I can't find anywhere" being described, because they
    // were never stored.
    //
    // Taking the leads from the chat is still right. Taking a NAME from the chat
    // and calling it a person is not. A card with no tags is not an answer, and
    // keeping the cast's is strictly better than replacing it with nothing.
    const chatCardHasTags = !!(fromChat && (fromChat.appearance || []).length)
    if (fromChat && chatCardHasTags) {
      leadCharacter = fromChat
      spindle.log.info(`[lumidraw] character comes from the chat: ${fromChat.anchor}`)
    } else if (fromChat) {
      spindle.log.info(`[lumidraw] the chat's card "${fromChat.anchor}" carries no visual tags — ` +
        `it reads as a setting rather than a person, so ${leadCharacter.anchor || 'the cast\'s character'} is kept`)
    }
    if (asPersona) {
      leadPersona = asPersona
      spindle.log.info(`[lumidraw] persona comes from the chat: ${asPersona.anchor}`)
    } else if (occupants.personaId) {
      spindle.log.info(`[lumidraw] the chat names persona ${occupants.personaId} but it could not be read; keeping the cast's`)
    } else if (occupants.chatKeys.length) {
      spindle.log.info('[lumidraw] the chat DTO names no persona. Keys: ' + occupants.chatKeys.join(', ') +
        ' · metadata: ' + ((occupants.metaKeys || []).join(', ') || '(empty)'))
    }
  }

  // AN EXPLICIT CHOICE OUTRANKS EVERY GUESS, and is applied last so nothing can
  // overwrite it. The host does not record a persona per chat, so this is the
  // only route by which a new chat can be played as somebody new — without it,
  // the cast's persona follows you forever and the parser is handed either the
  // wrong person or, once the leads stopped defaulting, nobody at all.
  const chosenPersona = await personaForChat(chatId)
  if (chosenPersona && chosenPersona.profile) {
    leadPersona = normalizeProfile(chosenPersona.profile,
      chosenPersona.profile.appearanceTags || '', 'persona')
    spindle.log.info(`[lumidraw] persona: you chose "${chosenPersona.name}" for chat ${chatId || '(none)'}`)
  } else {
    // The binding is per chat, so a choice saved against one chat id and a
    // generation running under another looks EXACTLY like the picker being
    // ignored. Manual parsing in particular reaches this from a different entry
    // point than the automatic scan. Say so rather than leaving it to be
    // guessed at a third time.
    const bound = await getChatPersonaMap()
    const keys = Object.keys(bound)
    if (keys.length) {
      spindle.log.info(`[lumidraw] persona: no choice recorded for chat ${chatId || '(none)'} — ` +
        `but ${keys.length} chat(s) do have one: ${keys.map((key) => String(key).slice(-8)).join(', ')}. ` +
        'If that list should include this chat, the ids did not match and the picker needs setting again here.')
    }
  }

  return {
    character: await resolveProfile(leadCharacter, userId, chatId),
    persona: await resolveProfile(leadPersona, userId, chatId),
    cast,
    // A property of the STORY, not of any one character — which is why it lives
    // on the cast. Some defences are calibrated for a contemporary setting and
    // are simply wrong in a fantasy one; no amount of regex can work out which
    // kind of story this is, so it is asked rather than guessed.
    fantasySetting: !!preset.fantasySetting,
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
    look: shortPhrase(source.look || source.look_name || source.lookName || '', `subject ${index + 1} look`, 6, 64, true),
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

// Images are INSERTED at their anchor's position in the prose, but they were
// NUMBERED by the parser's array order — and nothing made those agree. So the
// moment that appears first on screen could be "image 2" everywhere in the app:
// in the scan status, in the history, and in the picker used to redo one. Asking
// to redo the first moment then redid the second.
//
// The parser is not told to return moments in passage order and there is no
// reason it should — it reads the whole passage before writing anything. Sorting
// here is the fix, not a stricter instruction, because it holds however the
// model chooses to answer.
function orderScenesByPassage(items, passage) {
  const text = String(passage || '')
  const lower = text.toLowerCase()
  const positionOf = (item) => {
    const anchor = String((item && item.anchor) || '').trim()
    if (!anchor) return Number.MAX_SAFE_INTEGER
    let at = text.indexOf(anchor)
    if (at < 0) at = lower.indexOf(anchor.toLowerCase())
    // An anchor that is not in the passage cannot be placed by position. It goes
    // last rather than first, so a hallucinated anchor never renumbers the real
    // moments ahead of it.
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  // Decorated sort: ties keep the parser's own order, which is the only other
  // signal available.
  return (items || [])
    .map((item, index) => ({ item, index, at: positionOf(item) }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index))
    .map((entry) => entry.item)
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

// `scene` is optional and last: every existing caller keeps working, and the
// anatomy gate simply has no act evidence when it is absent.
function subjectDescriptor(subject, profiles, sourcePassage = '', requireAnatomyOwner = false, rememberedOutfits = null, rememberedLooks = null, sceneForAnatomy = null) {
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
  // What she was last seen wearing beats what her profile says she usually wears.
  //
  // A story describes an outfit once and then stops: the next nine passages are
  // about what happens, not about denim shorts. The parser correctly reports no
  // outfit for those, and this fell straight through to the profile default — so
  // she changed clothes without the story saying so. The wardrobe was already being
  // recorded every scene; it was only ever read to take a garment OFF the wrong
  // person, never to put one back on the right one.
  //
  // Precedence: what this passage says > what she was last seen in > her default.
  // A passage that does describe clothing still wins, so changing outfits works.
  const rememberedRaw = (!state || state.outfitPolicy !== 'omit') && !ANONYMOUS_REF_RE.test(subject.ref || '')
    ? uniqueStrings(((rememberedOutfits && rememberedOutfits[subject.ref]) || []))
    : []
  // Removal is applied ONCE, to whichever source ends up selected below — not
  // here as well. Doing both was redundant: a wardrobe cleared here merely fell
  // through to the profile default, which then had to be cleared anyway, so this
  // copy could be deleted with no test failing. A check that cannot fail is
  // decoration, and this file has produced two of those tonight already.
  const undressed = { zones: undressedZones(sourcePassage), removed: [] }
  const rememberedOutfit = rememberedRaw

  // A named Look sits between the passage and the wardrobe. It does not replace
  // the wardrobe — it SETS it, and only at the moment it becomes active.
  //
  // The distinction matters. If a Look overrode the wardrobe every scene, then
  // "she kicked off her sneakers" would be undone by the next image, and the
  // whole clothing-persistence chain would be dead weight. If it never overrode
  // it, selecting a Look would do nothing while a stale record existed. So: a
  // CHANGE of Look wins over the wardrobe; an unchanged Look yields to it.
  const lookReport = {}
  const look = (!state || state.outfitPolicy !== 'omit')
    ? selectLook(profile, subject, sourcePassage, lookReport)
    : null
  const previousLook = String((rememberedLooks && rememberedLooks[subject.ref]) || '')
  const lookChanged = !!look && look.name !== previousLook
  const lookOutfit = look ? uniqueStrings(look.outfit) : []

  const baseSelected = lookChanged && lookOutfit.length
    ? lookOutfit
    : (rememberedOutfit.length ? rememberedOutfit : (lookOutfit.length ? lookOutfit : inheritedOutfit))
  // Applied to whatever was SELECTED, not only to the wardrobe. Clearing the
  // remembered outfit alone left the fallback chain intact, so the profile
  // default walked straight in and dressed her again — the undress was defeated
  // one line further down than it was fixed.
  const baseAfterUndress = undressRemembered(baseSelected, sourcePassage)
  // A fully bare subject with nothing reported gets "nude" stated rather than an
  // empty outfit. Empty says nothing and lets the model choose; the passage said
  // something, so the prompt should too.
  const baseOutfit = undressed.zones.includes('all') && !subject.outfit.length && !baseAfterUndress.outfit.length
    ? ['nude']
    : baseAfterUndress.outfit
  const merged = mergeOutfitByZone(subject.outfit, baseOutfit, sourcePassage)
  const outfit = subject.outfit.length ? merged.outfit : baseOutfit
  const who = (profile && profile.anchor) || subject.ref
  if (!subject.outfit.length && rememberedOutfit.length) {
    // Reports what SURVIVED, not what was restored. It used to name the restored
    // list, so a wardrobe full of things that are not clothing read as "kept:
    // white shirt in hands, hickey on collarbone" while the outfit was in fact
    // empty — the trace described the intent and the prompt did the opposite.
    const survived = (outfit || []).filter((tag) => !isNotClothing(tag))
    trace(`outfit continuity · ${who}`, survived.length ? 'applied' : 'warn',
      survived.length
        ? `the passage did not describe clothing, so what she was last seen in was kept: ${survived.join(', ')}`
        : `nothing in the wardrobe was wearable (${rememberedOutfit.join(', ') || 'empty'}), so she is wearing nothing`)
  } else if (merged.restored.length || merged.corrected.length) {
    const parts = []
    if (merged.corrected.length) parts.push(`re-worded garment(s) put back to what was established: ${merged.corrected.join('; ')}`)
    if (merged.restored.length) parts.push(`${merged.restored.join(', ')} restored for a zone the passage left silent`)
    // A restored one-piece next to a reported single garment composes oddly —
    // "sundress, jeans" — but covered-and-odd beats half-dressed. Said out loud so
    // it is findable when it happens.
    if (merged.restored.some((tag) => garmentZone(tag) === 'full') && subject.outfit.length) {
      parts.push('note: a one-piece was kept alongside the reported garment — odd but covered')
    }
    trace(`outfit continuity · ${who}`, 'applied', parts.join(' · '))
  }
  // A nude body in an nsfw scene shows its anatomy — that is what nude means. The
  // passage does not have to name it, and prose about a shower rarely does. Left
  // unnamed, the model has a nude figure with nothing anchoring the genitals, and
  // Anima fills that gap from the censored end of its training rather than leaving
  // it blank. This is not the parser inventing anatomy: LumiDraw still supplies
  // only what the profile saved, and only when something in the scene said "nude".
  const undressedAll = uniqueStrings([...undressed.removed, ...baseAfterUndress.removed])
  if (undressedAll.length) {
    trace(`undressed \u00b7 ${who}`, 'applied',
      undressed.zones.includes('all')
        ? `the passage says she is bare, so nothing was restored (dropped: ${undressedAll.join(', ')})`
        : `the passage removes ${undressed.zones.join(', ')}, so ${undressedAll.join(', ')} was not restored`)
  }
  if (look) {
    trace(`look \u00b7 ${who}`, lookChanged ? 'applied' : 'ran',
      lookChanged
        ? `“${look.name}” became active (${lookReport.reason}) and set the outfit: ${lookOutfit.join(', ')}`
        : `“${look.name}” is already active (${lookReport.reason}); what she was last seen in stands`)
  } else if (lookReport.unmatchedRequest) {
    trace(`look \u00b7 ${who}`, 'warn',
      `the parser asked for look “${lookReport.unmatchedRequest}”, which is not defined — ignored`)
  }
  // statesNude looks for a STATED bare tag. An empty outfit states nothing, so a
  // character the filters have just stripped down to nothing did not count as
  // nude and the anatomy gate stayed shut — which is exactly what happened once
  // 0.70.0 correctly threw "white shirt in hands" out of the wardrobe: outfit
  // went to zero, and she still rendered without the anatomy the parser had
  // explicitly marked visible.
  //
  // Wearing nothing IS being nude, in an explicit scene, when the parser said so.
  // All three conditions are required: no garments at all, safety already nsfw or
  // explicit, and anatomy_visible set deliberately by the parser.
  const wearingNothing = !(outfit || []).length &&
    ['nsfw', 'explicit'].includes((sceneForAnatomy && sceneForAnatomy.safety) || '') &&
    !!(subject && subject.anatomyVisible)
  const nudeNow = statesNude(outfit, appearance, subject) || wearingNothing
  const anatomyAllowed = profile && (
    profile.anatomyMode === 'always' ||
    (profile.anatomyMode === 'relevant' && subject.anatomyVisible &&
      (anatomyExplicitlyMentioned(profile.anatomy, sourcePassage, profile.anchor, requireAnatomyOwner) ||
        nudeNow || anatomyRequiredByAct(subject, sceneForAnatomy)))
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
    look, lookChanged,
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
  'bulletin board', 'gate', 'poster (object)',
  'outdoors', 'indoors', 'forest', 'tree', 'bamboo forest', 'grass', 'field', 'flower',
  'flower field', 'petals', 'falling petals', 'leaf', 'fallen leaves', 'moss', 'vines',
  'roots', 'mushroom', 'crystal', 'rock', 'cliff', 'mountain', 'valley', 'meadow', 'swamp',
  'desert', 'jungle', 'cave', 'water', 'river', 'lake', 'ocean', 'beach', 'waterfall',
  'pond', 'puddle', 'ruins', 'castle', 'church', 'temple', 'shrine', 'city', 'street',
  'alley', 'rooftop', 'road', 'path', 'bridge', 'fence', 'garden', 'courtyard', 'forest path',
  'room', 'bedroom', 'bathroom', 'kitchen', 'living room', 'classroom', 'library', 'office',
  // Vehicle interiors. Every one of these is a real Danbooru tag, which matters
  // more here than usual: the model has comparatively few car-interior images, so
  // an invented phrase buys nothing and a real one is the only handle available.
  'car interior', 'vehicle interior', 'car', 'motor vehicle', 'ground vehicle',
  'driving', 'steering wheel', 'dashboard', 'windshield', 'car seat', 'seatbelt',
  'rear-view mirror', 'car window', 'truck', 'bus interior', 'train interior',
  'airplane interior', 'boat', 'motorcycle',
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
  'ass',
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

  // Contemporary clothing. The list above grew up around a fantasy story — robe,
  // cloak, cape, armor, hood — and had no jeans, no t-shirt, no bra in it. Every
  // ordinary modern garment was therefore falling through to the caption, where a
  // tag-trained model can barely use it. "Joggers" is where Eric noticed it; the
  // hole was 29 of the 30 commonest garments.
  // tops
  't-shirt', 'shirt tucked in', 'collared shirt', 'dress shirt', 'polo shirt',
  'sleeveless shirt', 'off-shoulder shirt', 'crop top', 'tank top', 'camisole',
  'tube top', 'halterneck', 'blouse', 'sweater', 'sweater vest', 'turtleneck',
  'sweatshirt', 'hoodie', 'cardigan', 'vest', 'blazer', 'suit', 'formal',
  'jersey', 'tracksuit',
  // bottoms
  'jeans', 'denim shorts', 'short shorts', 'sweatpants', 'track pants',
  'yoga pants', 'leggings', 'pantyhose', 'capri pants', 'harem pants',
  'cargo pants', 'baggy pants', 'miniskirt', 'pleated skirt', 'pencil skirt',
  'long skirt', 'overalls',
  // underwear and swim
  'bra', 'sports bra', 'panties', 'thong', 'underwear', 'lingerie', 'boxers',
  'briefs', 'bikini', 'bikini top', 'bikini bottom', 'swimsuit',
  'one-piece swimsuit',
  // footwear
  'sneakers', 'high heels', 'sandals', 'loafers', 'slippers', 'thigh boots',
  'knee boots', 'ankle boots',
  // one-piece and at-home
  'sundress', 'nightgown', 'pajamas', 'bathrobe', 'apron', 'towel',
  'school uniform', 'serafuku',
])

// Near-misses a language model reliably produces for a tag that does exist.
// Rewriting is strictly better than demoting: the concept survives *and* lands
// in the vocabulary the model was trained on.
const BOORU_ALIASES = {
  'notice board': 'bulletin board', 'lantern post': 'lantern',
  // Garments. "Joggers" is the case that prompted these: Anima has no such tag,
  // so the word reached only the caption and the model drew whatever it liked.
  // A jogger IS a sweatpant — the tapered cuff is a cut, not a garment class —
  // so the tag anchors the class and the original phrase still rides along in
  // the caption, where the cut can be described.
  'joggers': 'sweatpants', 'jogger pants': 'sweatpants', 'jogging pants': 'sweatpants',
  'jogging bottoms': 'sweatpants', 'sweat pants': 'sweatpants',
  'track suit': 'tracksuit', 'trackpants': 'track pants', 'athletic pants': 'track pants',
  'trousers': 'pants', 'slacks': 'pants', 'chinos': 'pants', 'khakis': 'pants',
  'tee': 't-shirt', 'tee shirt': 't-shirt', 'tshirt': 't-shirt', 't shirt': 't-shirt',
  'hoody': 'hoodie', 'hooded sweatshirt': 'hoodie', 'jumper': 'sweater',
  'pullover': 'sweater', 'button-up': 'collared shirt', 'button down': 'collared shirt',
  'button-down shirt': 'collared shirt', 'oxford shirt': 'collared shirt',
  'denim pants': 'jeans', 'blue jeans': 'jeans', 'skinny jeans': 'jeans',
  'jean shorts': 'denim shorts', 'cutoffs': 'denim shorts', 'cut-offs': 'denim shorts',
  'cut-off shorts': 'denim shorts', 'daisy dukes': 'denim shorts',
  'yoga leggings': 'leggings', 'tights': 'pantyhose', 'nylons': 'pantyhose',
  'brassiere': 'bra', 'bralette': 'bra', 'underpants': 'panties', 'knickers': 'panties',
  'undies': 'panties', 'boxer shorts': 'boxers', 'boxer briefs': 'boxers',
  'trainers': 'sneakers', 'tennis shoes': 'sneakers', 'running shoes': 'sneakers',
  'athletic shoes': 'sneakers', 'heels': 'high heels', 'stilettos': 'high heels',
  'pumps': 'high heels', 'flip-flops': 'sandals', 'flip flops': 'sandals',
  'pyjamas': 'pajamas', 'pjs': 'pajamas', 'nightie': 'nightgown',
  'dressing gown': 'bathrobe', 'housecoat': 'bathrobe', 'robe': 'robe',
  'summer dress': 'sundress', 'business suit': 'suit', 'waistcoat': 'vest',
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
  'futa': 'futanari', 'futunari': 'futanari', 'hermaphrodite': 'futanari', 'dickgirl': 'futanari',
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
  'butt': 'ass', 'arse': 'ass', 'backside': 'ass', 'rear end': 'ass',
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
const BARE_STATE_RE = /^(?:nude|naked|topless|bottomless|shirtless|barefoot|bare feet|bare legs|bare thighs|bare shoulders|no shoes|no pants|no bottoms|no shirt|no top|no underwear|no panties|no bra|undressed|dressed|clothed|fully clothed|partially clothed|disheveled clothes|torn clothes|open shirt|wet clothes|bloody clothes)$/i

const BODY_PART_RE = /\b(?:hand|hands|thumb|finger|fingers|palm|wrist|arm|arms|forearm|forearms|upper arm|elbow|shoulder|shoulders|jaw|chin|face|cheek|cheeks|eye|eyes|mouth|lip|lips|neck|throat|chest|torso|abdomen|stomach|back|waist|hip|hips|thigh|thighs|calf|shin|knee|knees|leg|legs|ankle|foot|feet|toe|toes|head|forehead|hair|skin|tail|ear|ears|muzzle|snout|fur|claw|claws|paw|paws|wound|scar|bite|bruise)\b/i

// True when an outfit entry does not actually describe something worn.
// A condition is not a garment. "blood-covered" describes the wearer, and
// rendering it as "wearing blood-covered" asks the model for a thing.
const WORN_CONDITION_RE = /^(?:blood[- ]?(?:covered|soaked|stained)|bloodied|bloody|soaked|drenched|muddy|dirty|filthy|singed|burnt|scorched|frayed|ragged|tattered|torn|ruined|wet|damp|dusty|ash[- ]?covered)$/i

// Which part of the body a garment actually covers.
//
// 0.53.0 restored the remembered outfit only when the passage described NO clothing
// at all. That missed the commoner and sillier case: the passage mentions ONE thing
// — "he fisted the back of her shirt" — so the parser reports a t-shirt and sneakers
// and nothing else, and a partial outfit replaced the whole wardrobe. Price walked
// through a diner car park in her underwear.
//
// Restoring by zone fixes it without overriding the passage: whatever the passage
// dressed stays exactly as written, and only the zones it left silent are filled in
// from what she was last seen wearing.
const GARMENT_ZONES = [
  // Checked in order; the first match wins, so full-body garments must come first
  // or "dress" would register as a top.
  { zone: 'full', re: /\b(?:(?:sun|night|mini|maxi|slip)?dress|gown|robe|kimono|yukata|jumpsuit|overalls|bodysuit|leotard|swimsuit|bikini|catsuit|coveralls|nightgown|cassock|habit|romper|onesie)\b/i },
  { zone: 'bottom', re: /\b(?:shorts|pants|trousers|jeans|skirt|leggings|tights|slacks|chaps|breeches|hakama|loincloth|briefs|boxers|panties|thong|underwear bottom|joggers|sweatpants|track pants|cargo pants|capri pants|yoga pants)\b/i },
  { zone: 'top', re: /\b(?:shirt|t-shirt|tank top|blouse|sweater|hoodie|jacket|coat|cardigan|vest|top|tunic|bra|camisole|crop top|pullover|blazer|poncho|cloak|corset|bustier|halter|bandeau|bodice|turtleneck|sweatshirt|jersey|smock|waistcoat|shrug|bolero|kimono jacket|haori)\b/i },
  { zone: 'feet', re: /\b(?:shoes|sneakers|boots|sandals|heels|slippers|socks|loafers|flats)\b/i },
  { zone: 'legs', re: /\b(?:thighhighs|stockings|kneehighs|garter)\b/i },
]

function garmentZone(tag) {
  const text = normalizeIdentityText(tag)
  if (!text) return ''
  for (const entry of GARMENT_ZONES) if (entry.re.test(text)) return entry.zone
  return ''
}

// A stated bare zone is a decision, not an omission — "topless" means no top, and
// restoring one would contradict the passage.
const BARE_ZONE_RE = [
  { zone: 'all', re: /\b(?:nude|naked|completely nude|fully nude|unclothed|undressed)\b/i },
  { zone: 'top', re: /\btopless\b/i },
  { zone: 'bottom', re: /\b(?:bottomless|no panties|no underwear)\b/i },
  { zone: 'feet', re: /\b(?:barefoot|bare feet)\b/i },
]

// Changing clothes is an event the passage narrates. Absent one of these, a garment
// that differs from memory is a re-description, not a new outfit.
const OUTFIT_CHANGE_RE = /\b(?:chang(?:e|es|ed|ing)|shrug(?:s|ged)? (?:on|into)|pull(?:s|ed|ing)? (?:on|off)|put(?:s|ting)? on|slip(?:s|ped|ping)? (?:on|out of|into)|strip(?:s|ped|ping)?|undress|undo(?:es|ne)?|unbutton|unzip|took off|takes? off|threw on|throws? on|dressed in|now wearing|swap(?:s|ped)|borrow(?:s|ed)|change of clothes|got dressed|redress)\b/i

// The unit of "same garment" for drift detection. Head noun, folded across
// spelling variants only — deliberately FINER than GARMENT_SYNONYMS, which exists
// for grounding and lumps blouse/tank top/t-shirt together. For drift purposes
// those are different garments: a parser told to report only changes that says
// "tank top" over a remembered blouse means a change, not a re-wording.
const FAMILY_ALIASES = [
  [/\btee\b|\bt shirt\b/, 'shirt'],
  [/\btrainers\b|\btennis shoes\b|\bkicks\b/, 'sneakers'],
  [/\bcutoffs?\b|\bhot pants\b/, 'shorts'],
  [/\bsundress\b|\bfrock\b|\bgown\b/, 'dress'],
  [/\bdenims\b/, 'jeans'],
]

function garmentFamily(tag) {
  const text = normalizeIdentityText(tag)
  if (!text) return ''
  for (const [re, canonical] of FAMILY_ALIASES) if (re.test(text)) return canonical
  return text.split(/\s+/).pop()
}

function mergeOutfitByZone(reported, remembered, passage = '') {
  const worn = uniqueStrings(reported || [])
  const memory = uniqueStrings(remembered || [])
  if (!worn.length || !memory.length) return { outfit: worn, restored: [], corrected: [] }

  // Memory's veto is limited to ADJECTIVE DRIFT: the same garment re-described.
  // "white shirt" → "baggy blue shirt" is the parser wording the same shirt again,
  // and a re-wording reads as a costume change to the image model — so within a
  // garment family, memory's wording wins.
  //
  // A DIFFERENT family in the same zone — "tank top" where memory says "blouse" —
  // is what a change looks like, and the parser was told to report the outfit only
  // when it changed. Zone-matching erased those reports, which inverted the
  // pipeline's own precedence (passage > memory) and made the record self-sealing:
  // wrong memory → correction forces it onto the descriptor → the snapshot
  // re-learns it → defended forever. A scan structurally could not fix a bad
  // record; only the wardrobe panel could. Family-matching keeps the drift kill
  // and gives the passage its crown back.
  //
  // OUTFIT_CHANGE_RE survives as an escape for the case family-matching cannot
  // see: a same-family REAL change ("she changed into a fresh white blouse" over a
  // remembered silk blouse). Its false positives — "changed the subject" — now
  // merely skip the correction, which is the direction we already prefer.
  const changing = OUTFIT_CHANGE_RE.test(String(passage || ''))
  const corrected = []
  if (!changing) {
    const memoryByFamily = new Map()
    for (const tag of memory) {
      const family = garmentFamily(tag)
      if (family && !memoryByFamily.has(family)) memoryByFamily.set(family, tag)
    }
    for (let i = 0; i < worn.length; i++) {
      const family = garmentFamily(worn[i])
      if (!family || !memoryByFamily.has(family)) continue
      const known = memoryByFamily.get(family)
      if (normalizeIdentityText(known) === normalizeIdentityText(worn[i])) continue
      corrected.push(`${worn[i]} → ${known}`)
      worn[i] = known
    }
  }

  const covered = new Set()
  for (const tag of worn) {
    for (const entry of BARE_ZONE_RE) {
      if (!entry.re.test(normalizeIdentityText(tag))) continue
      if (entry.zone === 'all') return { outfit: worn, restored: [], corrected }
      covered.add(entry.zone)
    }
    const zone = garmentZone(tag)
    if (zone === 'full') { covered.add('full'); covered.add('top'); covered.add('bottom') }
    else if (zone) covered.add(zone)
  }
  // Only the zones the passage never mentioned, and only the two that read as
  // undressed when missing. Restoring socks nobody asked about is noise.
  const restored = []
  for (const tag of memory) {
    const zone = garmentZone(tag)
    if (zone !== 'top' && zone !== 'bottom' && zone !== 'full') continue
    if (zone === 'full') {
      // A one-piece is displaced only when the passage dressed the WHOLE body.
      // Skipping it as soon as any single garment was named is how a remembered
      // red dress evaporated the moment the prose mentioned her jeans, leaving
      // her in jeans and nothing else — topless without anyone saying so.
      if (covered.has('full') || (covered.has('top') && covered.has('bottom'))) continue
    } else if (covered.has(zone)) continue
    restored.push(tag)
    if (zone === 'full') { covered.add('full'); covered.add('top'); covered.add('bottom') } else covered.add(zone)
  }
  return { outfit: uniqueStrings([...worn, ...restored]), restored, corrected }
}

// ---------------------------------------------------------------------------
// Undressing
// ---------------------------------------------------------------------------
//
// The parser is told "silence means unchanged", and the wardrobe restores what
// she was last seen in. That rule is right for "she is still in her jeans" and
// wrong in exactly one direction for "she pulled her shirt off": undressing is
// narrated as an ACTION, the parser has a perfectly good field for actions, so
// it writes the pose and leaves outfit empty. Silence. She gets dressed again.
//
// Nothing in the compiler has ever read the passage for removal, so the failure
// is always the same way round — stuck dressed, never stuck naked — which is why
// it is obvious in the prose and invisible to the app.
const UNDRESS_FULL_RE = /\b(?:naked|nude|stark naked|fully undressed|stripped bare|nothing on|not a stitch|bare skin|in the nude)\b/i
// A removal verb, then up to a few words, then the garment. Deliberately narrow:
// "took off" reads as removal, "took her hand" does not.
const UNDRESS_VERB_RE = /\b(?:pull(?:s|ed|ing)?|peel(?:s|ed|ing)?|strip(?:s|ped|ping)?|shrug(?:s|ged|ging)?|tug(?:s|ged|ging)?|yank(?:s|ed|ing)?|shove(?:s|d)?|push(?:es|ed|ing)?|kick(?:s|ed|ing)?|slip(?:s|ped|ping)?|work(?:s|ed|ing)?|toss(?:es|ed|ing)?|discard(?:s|ed|ing)?|shed(?:s|ding)?|drop(?:s|ped|ping)?|unbutton(?:s|ed|ing)?|unzip(?:s|ped|ping)?|unhook(?:s|ed|ing)?|unclasp(?:s|ed|ing)?|remove(?:s|d)?|take(?:s)?|took|lose(?:s)?|lost)\b[^.!?\n]{0,24}?\b(?:off|out of|down|away|aside)\b/i

// Reads the passage for what came OFF. Returns the zones to clear, or 'all'.
function undressedZones(passage) {
  const text = String(passage || '')
  if (!text.trim()) return []
  if (UNDRESS_FULL_RE.test(text)) return ['all']
  const zones = new Set()
  // Look at each sentence separately, so a removal in one clause cannot claim a
  // garment mentioned in another.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    // Checked BEFORE the verb gate: "she stripped and got in" carries no
    // off/down/away particle, so the gate rejected the sentence and the
    // bare-strip case below could never be reached.
    if (/\b(?:strip(?:s|ped|ping)?|undress(?:es|ed|ing)?|disrobe(?:s|d|ing)?)\b/i.test(sentence) &&
        !/\bstrip(?:s|ped|ping)? (?:of|away) /i.test(sentence)) return ['all']
    if (!UNDRESS_VERB_RE.test(sentence)) continue
    for (const entry of GARMENT_ZONES) {
      if (entry.re.test(normalizeIdentityText(sentence))) zones.add(entry.zone)
    }
  }
  return [...zones]
}

// What she was last seen in, minus what the passage just took off. This is the
// counterpart to mergeOutfitByZone: that one puts garments BACK, this one takes
// them off, and neither is any use without the other.
function undressRemembered(remembered, passage) {
  const zones = undressedZones(passage)
  if (!zones.length) return { outfit: uniqueStrings(remembered || []), removed: [], zones }
  if (zones.includes('all')) {
    return { outfit: [], removed: uniqueStrings(remembered || []), zones }
  }
  const kept = []
  const removed = []
  for (const tag of uniqueStrings(remembered || [])) {
    const zone = garmentZone(tag)
    // A one-piece is removed by ANY zone it covers — a dress cannot survive
    // "she pulled her dress off" merely because the cue named the top half.
    if (zone && (zones.includes(zone) || zone === 'full')) removed.push(tag)
    else kept.push(tag)
  }
  return { outfit: kept, removed, zones }
}

// A garment being CARRIED is not a garment being worn. "white shirt in hands"
// contains the word shirt, so the garment check below said "clothing" and it
// went into the wardrobe of record — where garmentSupported then treated it as
// grounded by definition, so it could never be dislodged. Checked first, because
// the whole problem is that the garment word wins.
const NOT_WORN_RE = /\b(?:in (?:the |her |his |their |one |both )?hands?|in hand|held|holding|carr(?:y|ies|ied|ying)|over (?:one|her|his|their) (?:arm|shoulder)|draped|discarded|balled up|crumpled|on the floor|on the ground|puddled|abandoned|clutched|tucked under)\b/i
// Marks on skin are not clothing either, and BODY_PART_RE does not name them.
const SKIN_MARK_RE = /\b(?:hickey|hickeys|love bite|handprint|fingerprints?|lipstick mark|welt|welts|rash|freckles?|blush|tan line|tan lines)\b/i

function isNotClothing(value) {
  const text = normalizeIdentityText(value)
  if (!text) return true
  if (BARE_STATE_RE.test(text)) return false
  if (WORN_CONDITION_RE.test(text)) return true
  // Before the garment check, never after: these phrases CONTAIN garment words
  // and that is exactly why they got through.
  if (NOT_WORN_RE.test(text)) return true
  if (SKIN_MARK_RE.test(text)) return true
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
  // A capitalized anchor is a NAME. "Corin" became "the corin" because nothing
  // had flagged `named`, and the parser only sets it when it is confident —
  // which it is not for a character the story introduced in passing. The capital
  // letter is the evidence the author already gave us; it costs nothing to read.
  if ((item && item.named) || /^[A-Z]/.test(anchor)) return sentenceName(anchor)
  return `${lead ? 'The' : 'the'} ${anchor.toLowerCase()}`
}

// Trait nouns take "a/an" and belong in the "with …" list. A bare one-word
// trait that names no body part ("hooded", "tall") is an adjective and must
// not become "a hooded".
const TRAIT_NOUN_RE = /\b(?:hair|eyes?|ears?|mouth|lips?|teeth|fangs?|tongue|nose|brows?|beard|stubble|skin|freckles?|moles?|scars?|tattoos?|piercings?|glasses|goggles|monocle|eyepatch|horns?|wings?|tails?|claws?|markings?|birthmarks?|build|figure|frame|fur|pelt|snout|muzzle|mane|paws?|hooves|whiskers|scales|feathers|antlers|talons?|paw pads|wrinkles?|dimples?|lashes|bun|braids?|ponytails?|twintails?|bangs|bulges?)\b/

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

// "faces away from Jason" used to come out as face-to-face. FACING_RELATION_RE
// matches the bare word "faces", and this list caught "turns away" but not
// "faces away" — so the single clearest statement that two people are NOT
// front-to-front was the one that asserted they were. The caption said she
// faced away, the tag run said face-to-face, and the model believed the tags.
//
// 0.60.0 said "over-matching here is the safe direction". That was wrong, and it
// took until Eric's "they're merged together into one person" to see why.
//
// face-to-face and facing another are not only orientation hints. They are two
// of the strongest statements in the whole prompt that there are TWO SEPARATE
// BODIES here — on Danbooru they overwhelmingly tag images of two distinct
// figures. Suppressing them does not cost "a composition hint". It removes the
// clearest thing the prompt says about there being two people.
//
// And bare \bbehind\b matched anything: "the counter behind her", "light behind
// them", "standing behind the table". Bare \baway from\b matched "steps away
// from the door". Neither says a word about which way the PEOPLE face, and in
// ordinary prose full of furniture they fired constantly.
//
// So: a person verb is now required before "behind", and "away from" must be
// followed by a person rather than a piece of scenery.
const AWAY_RELATION_RE = new RegExp([
  '\\bfrom behind\\b',
  '\\b(?:stand|step|move|kneel|sit|crouch|press|lean|position|hover|loom)(?:s|es|ed|ing)?\\s+behind (?!the\\b|a\\b|an\\b|it\\b|its\\b)',
  '\\bback to\\b', '\\bbent over\\b',
  '\\bfac(?:e|es|ing)\\s+away\\b',
  '\\blook(?:s|ed|ing)\\s+away\\b',
  '\\bturn(?:s|ed|ing)\\s+away\\b',
  '\\bglanc(?:es|ed|ing)\\s+away\\b',
  '\\baway from (?!the\\b|a\\b|an\\b|it\\b|its\\b)',
  '\\bavert(?:s|ed|ing)?\\b',
  '\\bover (?:his|her|their) shoulder\\b',
  '\\bback (?:is |was )?turned\\b',
].join('|'), 'i')
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

async function getArtistIndex() {
  const value = await spindle.storage.getJson(ARTIST_INDEX_FILE, { fallback: null })
  if (!value || !Array.isArray(value.names)) return null
  return value
}

// One name per line. Tolerant on purpose: the index files in the wild carry a
// leading "@", a trailing work count, or a comma-separated second column, and
// asking you to clean a 59,000 line file by hand would be absurd.
function parseArtistIndex(text) {
  const names = new Set()
  for (const line of String(text || '').split(/\r?\n/)) {
    let value = line.trim()
    if (!value || value.startsWith('#')) continue
    value = value.split(/[,\t]/)[0].trim()
    value = value.replace(/\s+\d[\d,]*$/, '').trim()
    value = value.replace(/^@+/, '').trim().toLowerCase()
    if (!value || /\s{2,}/.test(value)) continue
    names.add(value)
  }
  return [...names]
}

// Cheap bounded edit distance. Returns a number greater than `limit` the moment
// it cannot possibly come in under it, so scanning 59,000 names stays fast — and
// it only ever runs for a tag that already failed the lookup.
function editDistanceWithin(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < best) best = current[j]
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length]
}

// Which of these artist tags does Anima not know, and what did you probably mean?
function checkArtistTags(artistTags, index) {
  if (!index || !Array.isArray(index.names) || !index.names.length) return []
  const known = new Set(index.names)
  const problems = []
  for (const tag of artistTags || []) {
    const name = String(tag || '').replace(/^@+/, '').trim().toLowerCase()
    if (!name || known.has(name)) continue
    // A single edit for a short name, up to three for a long one. A fixed
    // threshold either misses "kantoku"/"kantoko" or suggests nonsense for a
    // thirty-character handle.
    const limit = Math.min(3, Math.max(1, Math.floor(name.length / 6)))
    let best = ''
    let bestScore = limit + 1
    for (const candidate of index.names) {
      const score = editDistanceWithin(name, candidate, limit)
      if (score < bestScore) { bestScore = score; best = candidate; if (score === 1) break }
    }
    problems.push({ tag: '@' + name, suggestion: bestScore <= limit ? '@' + best : '' })
  }
  return problems
}

// Shared by both pipelines, so direct mode gets the same warning the compiler
// does — the tag comes from your preset either way.
let artistWarningCache = ''
async function warnOnUnknownArtists(artistTags) {
  try {
    const index = await getArtistIndex()
    if (!index) return []
    const problems = checkArtistTags(artistTags, index)
    if (!problems.length) { artistWarningCache = ''; return [] }
    const message = problems.map((item) =>
      item.suggestion ? `${item.tag} is not in the index — did you mean ${item.suggestion}?`
        : `${item.tag} is not in the index`).join(' · ')
    // Once per distinct problem, not once per image. The same typo repeating in
    // the log every generation would train you to ignore it.
    if (message !== artistWarningCache) {
      artistWarningCache = message
      spindle.log.warn('[lumidraw] artist tag · ' + message +
        ' · Anima ignores an artist it does not know, so the style silently does nothing.')
    }
    return problems
  } catch { return [] }
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
// Learning a garment is not the same as rendering one. The passage wins for THIS
// image — that is the precedence everywhere else — but writing an ungrounded guess
// into memory makes it permanent: restored into every later scene until the story
// explicitly contradicts it, and now defended by the re-wording correction too. One
// hallucinated sundress becomes her outfit forever.
//
// Same shape as settingTagSupported, and the same asymmetry as the out-of-character
// gate: not learning a real garment costs one restore, learning a false one poisons
// every later image.
// Canonicals are bare HEAD NOUNS, because normalizeIdentityText turns "t-shirt"
// into "t shirt" and the head is therefore "shirt". Getting this wrong silently
// blocked every tee.
const GARMENT_SYNONYMS = [
  [/\bcutoffs?\b|\bhot pants\b|\bdaisy dukes\b|\bshorts\b/i, 'shorts'],
  [/\btee\b|\bt shirt\b|\bt-shirt\b|\bblouse\b|\btop\b/i, 'shirt'],
  [/\btrainers\b|\btennis shoes\b|\bkicks\b/i, 'sneakers'],
  [/\bfrock\b|\bsundress\b|\bgown\b/i, 'dress'],
  [/\bdenims\b|\bslacks\b/i, 'jeans'],
  [/\bboots?\b/i, 'boots'],
]

function garmentSupported(tag, text, wardrobe, profile) {
  const head = normalizeIdentityText(tag).split(/\s+/).pop()
  if (!head || head.length < 3) return false
  // Anything already established is grounded by definition — this only questions
  // garments the compile has just invented.
  const known = [...(wardrobe || []), ...((profile && profile.defaultOutfit) || [])]
  if (known.some((item) => normalizeIdentityText(item).split(/\s+/).pop() === head)) return true
  const hay = normalizeIdentityText(text)
  if (new RegExp(`\\b${escapeRegExp(head)}\\b`).test(hay)) return true
  return GARMENT_SYNONYMS.some(([re, canonical]) => canonical === head && re.test(hay))
}

// Positional refs are not identities. The tavern keeper in one scene and the bandit
// eight scenes later are both other_1, so remembering a wardrobe against that ref
// dresses the bandit in the keeper's apron. Named refs are stable and keep theirs.
const ANONYMOUS_REF_RE = /^other_\d+$/

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

// A car cabin is the hardest thing you can ask this model for, and not because the
// prompt is too short. Anima has comparatively few car-interior images, and the ones
// it has are overwhelmingly tight — a face through a windscreen, two people in the
// front seats from the waist up. Ask for `full body` in a car and it has to invent
// the geometry of a cabin it never learned: seats face the wrong way, the dashboard
// wraps, the door becomes a wall.
//
// So the fix is not more description. It is asking for the shot the model has
// actually seen. Framing is capped at `cowboy shot` inside a vehicle, which is where
// its training lives, and the cabin tags carry the rest.
const CONFINED_INTERIOR_RE = /\b(?:car interior|vehicle interior|car seat|steering wheel|dashboard|windshield|driving|driver's seat|passenger seat|bus interior|train interior|airplane interior|cockpit|elevator|phone booth|shower stall)\b/i
const CONFINED_FRAMING_CAP = 2   // cowboy shot; see FRAMING_LEVELS

function confinedInterior(scene, descriptors) {
  const parts = [...(scene.setting || []), ...(scene.camera || []), scene.sceneStatement || '', scene.coreAction || '']
  for (const item of descriptors || []) parts.push(...(item.pose || []), ...(item.action || []), item.subject.support || '')
  return CONFINED_INTERIOR_RE.test(normalizeIdentityText(parts.filter(Boolean).join(' ')))
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
  // Applied before the widening logic below, and it also survives it: a confined
  // interior caps the frame no matter what the scene claims it needs to show.
  const confined = confinedInterior(scene, descriptors)
  const capFraming = (list) => {
    if (!confined) return { tags: list, note: '' }
    const tooWide = list.filter((tag) => {
      const level = framingLevelForTag(tag)
      return level && level.level > CONFINED_FRAMING_CAP
    })
    if (!tooWide.length) return { tags: list, note: '' }
    const kept = list.filter((tag) => !tooWide.includes(tag))
    if (!kept.some((tag) => framingLevelForTag(tag))) kept.push('cowboy shot')
    return {
      tags: kept,
      note: `narrowed ${tooWide.join(', ')} to cowboy shot — this model has barely seen a wide shot inside a vehicle and invents the cabin`,
    }
  }

  if (!required.size) {
    const capped = capFraming(angles.kept)
    if (capped.note) preNotes.push(capped.note)
    return { tags: capped.tags, note: preNotes.join('; ') }
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

  // The widening above may have just asked for a full body in a car. Re-cap after
  // it, because "the scene needs legs" loses to "this model cannot draw a cabin".
  {
    const capped = capFraming(tags)
    if (capped.note) {
      tags.length = 0
      tags.push(...capped.tags)
      notes.push(capped.note)
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
let LAST_COMPILE_LOOKS = {}
let LAST_COMPILE_PLACE = ''
let LAST_DIAGNOSTIC = null
let LAST_COMPILE_NEGATIVES = []

function traceReset() { LAST_COMPILE_TRACE = []; LAST_COMPILE_OUTFITS = {}; LAST_COMPILE_LOOKS = {}; LAST_COMPILE_PLACE = ''; LAST_COMPILE_NEGATIVES = [] }
function trace(rule, outcome, detail = '') {
  LAST_COMPILE_TRACE.push({ rule, outcome, detail: String(detail || '') })
}
function traceSnapshot() { return LAST_COMPILE_TRACE.slice() }
function outfitSnapshot() { return { ...LAST_COMPILE_OUTFITS } }
// Which Look each character ended the scene in, so the NEXT scene can tell a
// change of Look from an unchanged one.
function lookSnapshot() { return { ...LAST_COMPILE_LOOKS } }
function placeSnapshot() { return LAST_COMPILE_PLACE }
function negativeSnapshot() { return LAST_COMPILE_NEGATIVES.slice() }

// Human-readable, for the Spindle log and the debug panel.
// A diagnostic you can paste to me without pasting your story.
//
// Every time my reading of the code was wrong tonight, the app's own output is
// what corrected it. That loop breaks when the scene is explicit and cannot be
// shared — and "be more confident about the code" is not the fix, because being
// confident about the code is precisely what kept being wrong.
//
// So: structure, never prose. Counts, tag families, which rules fired and why.
// No passage, no scene statement, no caption, no relation text, no prompt.
const TRACE_DETAIL_ALLOWED = /^(?:setting|place|look|outfit|garment|camera|framing|anatomy|trait merge|scenery|negative|safety|creature|wardrobe)/i

function anatomyFamily(tags) {
  const joined = (tags || []).join(' ')
  if (!joined.trim()) return 'none'
  const penis = PENIS_ANATOMY_RE.test(joined)
  const female = FEMALE_ANATOMY_RE.test(joined)
  if (penis && female) return 'both'
  if (penis) return 'penis'
  if (female) return 'female'
  return 'other'
}

function redactedDiagnostic(scene, descriptors, extras = {}) {
  const steps = traceSnapshot()
  return {
    version: (spindle.manifest && spindle.manifest.version) || '',
    safety: (scene && scene.safety) || '',
    aspect: (scene && scene.aspect) || '',
    subjects: (descriptors || []).map((item) => ({
      ref: (item.subject && item.subject.ref) || '',
      countTag: item.countTag || '',
      // Whether anatomy is present and of what family — never the tags.
      anatomy: anatomyFamily(item.anatomy),
      profileAnatomy: anatomyFamily((item.profile && item.profile.anatomy) || []),
      anatomyMode: (item.profile && item.profile.anatomyMode) || '',
      anatomyVisible: !!(item.subject && item.subject.anatomyVisible),
      look: (item.look && item.look.name) || '',
      lookChanged: !!item.lookChanged,
      appearanceState: (item.appearanceState && item.appearanceState.name) || '',
      outfitCount: (item.outfit || []).length,
      appearanceCount: (item.appearance || []).length,
    })),
    // Counts only. A relation's action is the most likely thing to be explicit.
    relations: ((scene && scene.relations) || []).map((relation) => ({
      hasActor: !!(relation && relation.actor),
      hasTarget: !!(relation && relation.target),
      hasAction: !!(relation && relation.action),
      detailCount: ((relation && relation.details) || []).length,
    })),
    // Whether the scene names a sexual act at all — the single fact that decides
    // whether the anatomy gate can open for a clothed participant. Boolean, so
    // it says nothing about what the act is.
    actNamed: ANATOMY_ACT_RE.test(String((scene && scene.sceneStatement) || '')),
    // Both, because the DIFFERENCE is the diagnosis. Reporting only what the
    // parser asked for made a dropped pov look like a kept one, and sent me
    // looking for a bug the compiler had already fixed.
    cameraRequested: ((scene && scene.camera) || []).slice(0, 6),
    cameraSent: (extras.cameraSent || []).slice(0, 6),
    place: placeSnapshot(),
    // The negative prompt is a tag list, and it is where an anatomy failure shows
    // up — either the guard did not fire, or it fired and the model ignored it.
    negatives: negativeSnapshot(),
    trace: steps.map((step) => ({
      rule: step.rule,
      outcome: step.outcome,
      detail: TRACE_DETAIL_ALLOWED.test(step.rule) ? step.detail : '(omitted)',
    })),
  }
}

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

// Two bodies arranged a particular way. Every one of these is a real Danbooru
// tag with a large post count, which is the whole reason to prefer it: the
// caption says "he carries her" and the model half-listens, the tag says
// `princess carry` and the model has seen a hundred thousand of them.
const GEOMETRY_TAG_RULES = [
  [/\bprincess carr/i, 'princess carry'],
  [/\bcarr(?:y|ies|ied|ying)\b/i, 'carrying'],
  [/\bstraddl/i, 'straddling'],
  [/\bhugg/i, 'hug'],
  [/\bholding hands\b/i, 'holding hands'],
  [/\bkiss(?:es|ing)?\b/i, 'kiss'],
  [/\b(?:sits?|sitting) on (?:his|her|their) lap\b/i, 'sitting on lap'],
]

function garmentDefence(descriptors) {
  const worn = new Set()
  let bottomCovered = false
  for (const item of descriptors || []) {
    for (const garment of item.outfit || []) {
      const head = animaTag(garment).split(/\s+/).pop()
      if (head) worn.add(head)
      // 'bottom' only, NOT 'full'. A dress covers the legs but nobody in the
      // frame is wearing PANTS, so negating the pants family contradicts nothing
      // visible — and that negative is the whole point of the dress defence.
      // props.mjs caught this: including 'full' disarmed a defence that works.
      if (garmentZone(garment) === 'bottom') bottomCovered = true
    }
  }
  const negatives = []
  for (const head of worn) {
    for (const rival of GARMENT_SUBSTITUTES[head] || []) {
      // Joggers are pants even though the word "pants" never appears in the tag,
      // so "worn.has(rival)" could not see the conflict — and `pants, trousers`
      // went into the negative while Jason was wearing joggers. At CFG 1 that is
      // a shrug; at CFG 3 it is a knife. Negating the bottom family while
      // somebody in the frame is wearing bottoms is friendly fire.
      if (bottomCovered && garmentZone(rival) === 'bottom') continue
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
const OUTDOORS_CUE_RE = /\b(?:city|street|alley|gate|forest|beach|field|garden|park|rooftop|courtyard|meadow|plaza)\b/i

const PENIS_ANATOMY_RE = /\b(?:penis|testicles|erection)\b/i

// "Is anything covering the bottom half, and is it more than underwear?" Two
// questions the compiler had no way to ask, which is why underwear-only read as
// fully dressed to every check downstream.
const OUTER_BOTTOM_RE = /\b(?:shorts|pants|trousers|jeans|skirt|leggings|tights|joggers|sweatpants|track pants|overalls|dress|gown|robe|tunic|hakama|slacks)\b/i
const UNDERWEAR_BOTTOM_RE = /\b(?:panties|briefs|boxers|thong)\b/i
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

// The OTHER anatomy failure, and the one that actually breaks immersion: the
// futanari renders with a vagina.
//
// anatomyDefence below solves a different problem — a penis BLEEDING onto a
// second, ordinary female subject — and it deliberately exempts a character
// whose own identity is futanari, because negating "futanari" on a futanari is
// negating who she is. Correct, and it leaves this case completely uncovered.
//
// Nothing in the prompt has ever said "not a vagina". Anima's prior for a
// feminine body in an explicit scene supplies one unless told otherwise, and an
// unusual position gives it more room to fall back on that prior, which is
// exactly when Eric sees it.
//
// Scope is deliberately tight: this fires only when EVERY subject whose anatomy
// is being drawn has penis-family anatomy. A scene with a futanari and an
// ordinary woman must not negate the woman's own body.
const FEMALE_GENITAL_NEGATIVES = ['pussy', 'vagina', 'clitoris', 'labia', 'vulva']
const FEMALE_ANATOMY_RE = /\b(?:pussy|vagina|vulva|clitoris|labia)\b/i

function femaleAnatomyDefence(descriptors, scene) {
  if (!scene || !['nsfw', 'explicit'].includes(scene.safety)) return []
  const rendered = (descriptors || []).filter((item) => (item.anatomy || []).length)
  if (!rendered.length) return []
  const allPenis = rendered.every((item) =>
    (item.anatomy || []).some((tag) => PENIS_ANATOMY_RE.test(String(tag || ''))))
  if (!allPenis) return []
  // Checked against the SAVED profile, not the rendered descriptor. Against the
  // descriptor it would be dead code — allPenis above already covers anyone whose
  // female anatomy is being drawn — and a check that cannot fail is decoration.
  //
  // The profile is the meaningful question: if a character in this scene is
  // DEFINED as having female genitalia, negating the word is wrong even in a
  // frame where her anatomy is not the subject, because the negative applies to
  // the whole image.
  const anyFemaleAnatomy = (descriptors || []).some((item) =>
    [...((item.profile && item.profile.anatomy) || []), ...(item.anatomy || [])]
      .some((tag) => FEMALE_ANATOMY_RE.test(String(tag || ''))))
  if (anyFemaleAnatomy) return []
  return FEMALE_GENITAL_NEGATIVES.slice()
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

// ===========================================================================
// DIRECT MODE
//
// Eric, after an A/B at a fixed seed: "That's an immediately better image."
//
// The compiler below this comment takes clean structured JSON from a capable
// model and runs it through roughly forty transformations — trait merging,
// creature grounding, alias rewriting, garment substitutes, orientation
// inference, four separate defences. Every one was written in response to one
// bad picture. Together they produced prompts no person would write:
//
//     "a tusks orc woman with a large orc woman, sword pulled from ground and
//      chin jerked aside, laughing and throwing, an open mouth"
//
// And they fought each other. Joggers against the pants negative, the facing
// veto against a bookshelf, the elf negative against an isekai. Those were not
// unrelated bugs; that is what a pile of independent rules does once it is big
// enough.
//
// Direct mode gives the writing back to the model that can read. LumiDraw
// supplies context, holds it to the handful of facts the author has actually
// declared, and sends. Nothing rewrites the model's tags.
//
// THE ONE RULE THAT SURVIVES, and why:
//
// When I hand-wrote the prompt that beat the compiler, I left `futanari` off
// Fanny — the single most important fact about her — and the picture was wrong
// in exactly the way the old anatomy firewall existed to prevent. A model
// writing prose-to-tags will make that mistake for the same reason I did:
// identity facts do not feel like part of the sentence. So one check remains,
// and it does not rewrite anything. It asks whether the tags the author marked
// as non-negotiable are present, and puts back the ones that are not.
// ===========================================================================

// Direct generation and image reparsing must evaluate roster/run contradictions
// identically. Keeping this outside runDirectImages prevents the lightbox's
// prompt-only path from silently falling back to the structured compiler.
async function reconcileDirectPresence(initialImages, ctx) {
  let images = Array.isArray(initialImages) ? initialImages : []
  let rawReply = ctx.rawReply
  const { instruction, settings, profiles, parserInput, userId, scan } = ctx
  const passage = (parserInput && parserInput.currentPassage) || ''
  if (!instruction || !settings || !images.length || !parserInput) return { images, rawReply }

  const contradictions = images.map((image) => directPresenceContradictions(image, profiles)).filter(Boolean)
  const contradictionScore = (list) => (list || []).reduce((sum, item) =>
    sum + (item.missing || []).length + (item.extra || []).length, 0)
  const firstScore = contradictionScore(contradictions)
  if (!contradictions.length) return { images, rawReply }

  const names = uniqueStrings(contradictions.flatMap((c) => [
    ...c.missing.map((p) => p.anchor || p.ref),
    ...c.extra.map((p) => p.anchor || p.ref),
  ]))
  const detail = contradictions.map((c) => {
    const missing = c.missing.map((p) => p.anchor || p.ref).join(', ') || 'none'
    const extra = c.extra.map((p) => p.anchor || p.ref).join(', ') || 'none'
    return `missing runs: ${missing}; wrong/extra runs: ${extra}`
  }).join(' | ')
  spindle.log.warn(`[lumidraw] direct · present roster and runs disagree (${names.join(' / ') || detail}); re-parsing once`)
  if (scan) setStoryScanStage(scan, 'parsing', 'The parser paired the scene with the wrong character sheet; re-reading once.')
  const retryInstruction = instruction +
    '\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED. Your validated present roster and the character BREAK runs did not match. ' +
    `The mismatch was: ${detail}. ` +
    'Every validated present person needs exactly one matching run, and no run may copy a different known sheet. ' +
    'Re-read the CURRENT PASSAGE, verify each 3-8 word evidence quote, and rewrite in the SAME JSON format.'
  try {
    const retryRaw = await quietLLM(retryInstruction, parserInput.input, settings, userId, true, scan || null)
    const retry = parseDirectImages(
      retryRaw,
      settings.maxImages || images.length || 1,
      profiles,
      passage,
      settings.maxSubjects || 2)
    const retryBad = retry.images.map((image) => directPresenceContradictions(image, profiles)).filter(Boolean)
    const retryScore = contradictionScore(retryBad)
    if (retry.images.length && retryScore < firstScore) {
      spindle.log.info('[lumidraw] direct · retry resolved the presence/run mismatch' +
        (retryBad.length ? ' partially' : ' completely'))
      images = retry.images
      rawReply = retryRaw
    } else {
      spindle.log.warn('[lumidraw] direct · retry did not improve the mismatch; using the mechanically guarded first attempt')
    }
  } catch (error) {
    spindle.log.warn('[lumidraw] direct · mismatch retry failed (' + error.message + '); using the first attempt')
  }
  return { images, rawReply }
}

// The exact non-generating half of Direct mode. Automatic scans and lightbox
// reparses both pass through here, so a preview is the prompt Draw Things would
// actually receive rather than a compiler-shaped approximation.
function finalizeDirectImagePrompt(image, ctx) {
  const { preset, profiles, prefix, trace } = ctx
  for (const note of image.notes || []) trace('parser cleanup', 'applied', note)
  if ((image.present || []).length) trace('presence roster', 'clean',
    image.present.map((entry) => `${entry.name}: "${entry.evidence}"`).join(' · '))
  // scene_summary is extracted separately so the parser formats the existing
  // passage instead of composing the action inside a free-form prompt. Insert
  // it mechanically after the leading count tags, then run the same name and
  // identity checks over the combined prompt that Draw Things will receive.
  const summarized = injectDirectSceneSummary(
    image.prompt,
    image.scene_summary,
    trace,
    image.sceneSummaryWordLimit || 18)
  let body = sanitizeDirectNames(summarized, profiles, trace)
  const locked = applyIdentityLock(body, profiles, trace)
  body = applyBannedToList(locked.prompt.split(','), preset.bannedTags)
    .join(', ').replace(/\s*,\s*BREAK\s*,\s*/g, ' BREAK ').replace(/\s{2,}/g, ' ').trim()

  const defences = directDefences(body, profiles, image.rating)
  if (defences.notes.length) {
    trace('direct defences', 'applied',
      defences.notes.join(' · ') + (defences.negatives.length ? ` · negatives: ${defences.negatives.join(', ')}` : ''))
    spindle.log.info('[lumidraw] direct defences · ' + defences.notes.join(' · ') +
      (defences.negatives.length ? ` · negatives: ${defences.negatives.join(', ')}` : ''))
  }

  const headerRaw = reconcileSafetyTags(joinPromptParts([preset.qualityTags, prefix]), image.rating)
  const hadHeaderBreak = /\bBREAK\b/.test(headerRaw)
  const headerParts = headerRaw.split(/\bBREAK\b/)
    .map((part) => part.replace(/^[\s,.]+|[\s,.]+$/g, '')).filter(Boolean)
  if (hadHeaderBreak) {
    trace('preset BREAK', 'removed', 'BREAK found in quality/prefix text — content kept, separator dropped')
  }
  const header = headerParts.join(', ')
  const prompt = joinPromptParts([header, image.rating || '', ...defences.positive, body])
  const negativePrompt = negativeWith(preset.negativePrompt || '', defences.negatives)
  const detrapped = stripSubwordTraps(prompt)
  for (const hit of detrapped.hits) {
    trace('subword trap', 'applied', `removed ${hit.words.join(', ')} — ${hit.why}`)
  }
  const finalPrompt = detrapped.text
  trace('direct prompt', 'applied',
    `${String(image.prompt || '').length} chars from the parser, sent as ${finalPrompt.length}` +
    (image.rating ? ` · rating ${image.rating}` : ' · no rating given'))
  return { prompt: finalPrompt, negativePrompt }
}

function directSceneSentence(prompt) {
  const tags = String(prompt || '').split(/\bBREAK\b/)[0].split(',').map((tag) => tag.trim()).filter(Boolean)
  let index = 0
  while (index < tags.length && (DIRECT_COUNT_TAG_RE.test(tags[index]) || DIRECT_COUNT_FULL_RE.test(tags[index]))) index++
  return tags[index] || ''
}

function normalizeDirectSceneSummary(value, maxWords = 18) {
  const limit = Math.max(18, Math.min(30, Number(maxWords) || 18))
  const compact = String(value || '')
    .replace(/\bBREAK\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
  if (!compact) return ''
  return compact.split(/\s+/).slice(0, limit).join(' ')
}

function injectDirectSceneSummary(prompt, summary, trace = null, maxWords = 18) {
  const sentence = normalizeDirectSceneSummary(summary, maxWords)
  const raw = String(prompt || '').trim()
  if (!sentence || !raw) return raw
  const blocks = raw.split(/\bBREAK\b/).map((block) => block.trim())
  const frame = String(blocks[0] || '')
  const normalizedFrame = normalizeIdentityText(frame)
  const normalizedSentence = normalizeIdentityText(sentence)
  if (normalizedSentence && normalizedFrame.includes(normalizedSentence)) {
    if (trace) trace('scene summary', 'clean', 'already present in the shared frame; not inserted twice')
    return raw
  }
  const tags = frame.split(',').map((tag) => tag.trim()).filter(Boolean)
  let at = 0
  while (at < tags.length &&
    (DIRECT_COUNT_TAG_RE.test(tags[at]) || DIRECT_COUNT_FULL_RE.test(normalizeDirectCountTag(tags[at])))) at++
  tags.splice(at, 0, sentence)
  blocks[0] = tags.join(', ')
  const combined = blocks.join(' BREAK ')
  if (trace) trace('scene summary', 'applied', `inserted after ${at} leading count tag${at === 1 ? '' : 's'}`)
  return combined
}

// Turn the prompts the parser wrote into images. Everything the compiler used to
// do between "the model has spoken" and "send it" is gone: no scene graph, no
// defences, no substitutions. Quality tags in front, the author's negative
// behind, the identity lock in the middle, send.
async function runDirectImages(initialImages, ctx) {
  const { preset, profiles, userId, chatId, scan, parserInput, target, instruction, settings } = ctx
  const reconciled = await reconcileDirectPresence(initialImages, ctx)
  let images = reconciled.images
  const rawReply = reconciled.rawReply
  await warnOnUnknownArtists(splitArtistTags(normalizeArtistTags(String(preset.qualityTags || ''))).artists)
  const origin = {
    messageId: String((target && target.id) || ''),
    chatId: String(chatId || ''),
    contentKey: (target && target.contentKey) || '',
    presetName: preset.name || '',
  }
  const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
  const results = []
  const placements = []
  const traceLines = []
  const trace = (label, status, detail) => traceLines.push({ label, status, detail })
  const passage = (parserInput && parserInput.currentPassage) || ''
  const ordered = orderScenesByPassage(images, passage)
  const grounding = [passage, (parserInput && parserInput.contextPreview) || ''].filter(Boolean).join('\n')

  for (let index = 0; index < ordered.length; index++) {
    assertStoryScanActive(scan)
    const image = ordered[index]
    setStoryScanStage(scan, 'generating',
      `Sending image ${index + 1} of ${ordered.length} to Draw Things.`)
    const finalized = finalizeDirectImagePrompt(image, { preset, profiles, prefix, trace })
    const finalPrompt = finalized.prompt
    const negativePrompt = finalized.negativePrompt

    const dims = aspectDims(preset.config, image.aspect)
    const entry = await generateAndUpload({
      prompt: finalPrompt,
      negativePrompt,
      config: preset.config,
      extra: preset.extra,
      dims,
      origin: { ...origin, mode: 'direct', alt: markdownAltText(finalPrompt) },
      debug: { trace: traceLines.slice(), scene: { direct: true, anchor: image.anchor, sceneSummary: image.scene_summary || '', aspect: image.aspect, rating: image.rating, present: image.present || [] } },
    }, userId, scan)
    results.push({
      ok: true,
      entry,
      anchor: image.anchor,
      prompt: finalPrompt,
      sceneStatement: image.scene_summary || directSceneSentence(image.prompt),
    })
    if (entry && entry.images && entry.images[0] && target && target.id) {
      placements.push(await placeGeneratedStoryImage(userId, {
        chatId,
        messageId: String(target.id),
        entry,
        alt: finalPrompt,
        dims,
        anchor: image.anchor,
        source: 'direct',
      }))
    }
  }

  // What the parser explicitly says changed becomes state for the next image.
  try {
    await applyDirectContinuity(ordered, {
      profiles,
      chatId,
      presetName: preset.name,
      grounding,
      messageId: String((target && target.id) || ''),
    })
  } catch (error) {
    spindle.log.warn('[lumidraw] direct · could not record continuity: ' + error.message)
  }

  setStoryScanStage(scan, 'inserting', 'Mounting generated images in the story message.')
  if (target && target.id) {
    await markProcessed(target.id, target.content)
    spindle.log.info(`[lumidraw] direct mode registered ${placements.length} native image mount(s) for the story message`)
  }

  await saveStoryDebug({
    mode: 'direct',
    parserEngine: 'direct',
    rawReply,
    error: '',
    entries: results.map((item, index) => ({
      anchor: item.anchor,
      prompt: item.prompt,
      sceneStatement: item.sceneStatement || '',
      present: (ordered[index] && ordered[index].present) || [],
    })),
    lastCompiledPrompt: results.length ? results[results.length - 1].prompt : '',
    contextPreview: parserInput.contextPreview,
    ledgerPreview: parserInput.ledgerPreview,
    contextMessageCount: parserInput.contextMessageCount,
    ledgerFound: parserInput.ledgerFound,
    trace: traceLines,
  })
  spindle.log.info(`[lumidraw] direct mode produced ${results.length} image(s); parser body stayed direct, continuity/defences were mechanical`)
  return { mode: 'direct', processed: results.length, results, messageId: target && target.id }
}


// Tags that describe a BODY, not a garment. Kept explicit and short rather than
// derived from the garment table: `garmentZone` returns "" both for `midriff` and
// for `harem silks`, so "not a known garment" would file real clothing as anatomy.
const BODY_STATE_TAGS = new Set([
  'bulge', 'midriff', 'navel', 'cleavage', 'collarbone', 'sideboob', 'underboob',
  'cameltoe', 'nipples', 'abs', 'toned', 'thighs', 'thick thighs', 'armpits',
  'bare shoulders', 'bare legs', 'bare arms', 'exposed skin', 'skindentation',
  'sweat', 'blush', 'barefoot', 'bare feet', 'no shoes', 'nude', 'naked',
  'topless', 'bottomless', 'shirtless', 'undressed', 'no pants', 'no bottoms',
  'no shirt', 'no top', 'no underwear', 'no panties', 'no bra',
])

const DIRECT_RULES = `
You are a DATA FORMATTER for an image-generation pipeline. Translate the
already-written CURRENT PASSAGE into a structured data record. Do not continue,
embellish, or rewrite the story. Extract only visible action, geometry, clothing,
identity, and camera tags. Do not add commentary or reasoning.

OUTPUT — only this JSON, compact, no markdown, no commentary:
{"images":[{"anchor":"5-12 exact consecutive words from the CURRENT PASSAGE","present":[{"name":"exact sheet name","evidence":"3-8 exact consecutive words from the CURRENT PASSAGE that show this person acting or being seen"}],"rating":"safe|sensitive|nsfw|explicit","scene_summary":"one plain sentence within the configured SCENE SUMMARY limit, using vetted SENTENCE NAMES but no appearance, clothing, or scenery","prompt":"the formatted prompt without the scene summary","aspect":"3:4|4:3|1:1|16:9|9:16","setting":["location tags"],"outfits":{"Sheet Name":["complete outfit"]}}]}
Omit "setting" and "outfits" entirely when nothing has changed.

CHOOSING THE MOMENT
- Illustrate only the CURRENT PASSAGE. Prior context resolves who and where;
  it never supplies the moment.
- Pick the single clearest drawable beat. One clear action, not three.

PRESENCE — decide this first, before writing the prompt.
- List in "present" everyone physically in the frame, each with an evidence
  quote copied exactly from the CURRENT PASSAGE — 3-8 consecutive words showing
  them acting, being touched, or being looked at. The quote is checked verbatim;
  a paraphrase voids the entry.
- Talked about, remembered, phoned, imagined, expected, or arriving next is NOT
  present. A person who only appears inside dialogue has no action evidence.
- The character sheets are everyone this story knows, not everyone in the
  picture. Many passages involve only one or two known people, but actual
  physical presence and the configured maximum decide the roster.
- Use the exact sheet name in "present". A physically present stranger with no
  sheet uses a two-word visual label instead. Every BREAK run must belong to
  someone in "present". No run for anyone else, ever.

SCENE SUMMARY — the technical statement of what is depicted.
- Write one plain sentence within the configured SCENE SUMMARY word limit.
  State visible action and geometry once; include no appearance, clothing,
  scenery, camera, lighting, or rating.
- Use each known person's vetted SENTENCE NAME from the sheet. The summary is
  the roster: every known character run below must belong to someone named here.
  If a sheet has no SENTENCE NAME, use its supplied pronoun instead.
- In explicit images, use the precise clinical term for any visible sexual act
  or anatomy. In safe or sensitive images, never name a sexual act.
- LumiDraw inserts this field mechanically into the final prompt. Do not copy
  the sentence into the "prompt" string.

PROMPT SHAPE — exactly this order inside the "prompt" field:
1. Count tags for everyone in frame. These are real Danbooru tags — 1girl,
   2girls, 1boy — pluralized, never "2girl". The frame's total must equal the
   character runs that follow.
2. Camera, setting, lighting as short tags. LumiDraw inserts scene_summary
   between the leading count tags and these tags. Use trained framing words only:
   portrait, upper body, cowboy shot, full body, wide shot; from above, from
   below, from side, from behind, from front; dutch angle, pov. Choose a frame
   that includes everything the summary depends on — a hip-level act is not a
   portrait — but inside a vehicle or other tight interior, never wider than
   cowboy shot.
3. " BREAK ", then one run per character listed in "present". Each run starts:
   count tag, that person's SENTENCE NAME (or RUN LABEL), IDENTITY ANCHOR copied
   exactly; then anatomy (per the rule below), clothing, pose, action,
   expression. One character's traits never appear inside another's run.

NAMES
- Use the same vetted SENTENCE NAME in scene_summary and immediately after the
  count tag at the start of that person's BREAK run ("1girl, Jamie Brennan,
  blonde hair, …"). The repeated safe name binds that description to that body.
- Use the SENTENCE NAME from the sheet exactly. Never abbreviate it or invent a
  shorter form. If the sheet has no safe SENTENCE NAME, use a pronoun in the
  summary and the supplied short RUN LABEL as the run heading.
- A real name marked unsafe by the sheet is NEVER written. Use its safe prompt
  name instead. Names may appear only in scene_summary and at run headings.

KEEP EACH RUN TIGHT — at most 18 tags, each thing said once:
- One hair colour. One tag per garment, with its modifiers merged: write
  "open dark hoodie", never "hoodie, open hoodie, dark hoodie".
- The anchor's noun ("adult man") is said once; do not add extra body nouns such
  as "slim male" or "tall female".
- No umbrella tags ("casual clothes", "simple outfit") once the garments are
  named. No filler ("beautiful", "nice").

THE CHARACTER SHEETS ARE PASTE-EXACT TEXT, NOT NOTES.
- Copy each identity anchor and clothing run character-for-character. Do not
  paraphrase, reorder, complete, or improve them, and do not drop a trait because
  the passage failed to repeat it. What the sheet states is true in every image.
- Never invent appearance. A person the sheet does not cover is described from
  the passage alone, briefly.
- Obey the configured MAXIMUM CHARACTERS PER IMAGE below. Include physically
  participating people up to that limit, each with one separate BREAK run.
  Never add a bystander merely to fill the available slots.

ANATOMY
- ALWAYS INCLUDE traits are part of the identity anchor and appear in every
  image of that character, at every rating.
- SAVED ANATOMY (penis, testicles, ...) is included when the rating is nsfw or
  explicit AND the character is nude or the passage depicts it. It stays inside
  its owner's run, immediately after the identity anchor.
- Never give a character anatomy the sheet does not list, and never substitute
  one set for another. A character whose sheet says futanari is drawn futanari —
  with no female-genital tags — in every image where her anatomy appears.

WARDROBE — persistent story state, in this precedence:
1) a change in the CURRENT PASSAGE wins;
2) otherwise the sheet's CURRENT CLOTHING, copied exactly;
3) otherwise EARLIER CLOTHING MENTIONS;
4) otherwise DEFAULT OUTFIT.
Silence means unchanged — never reset to defaults because clothing has not been
mentioned recently.
- A change means writing the COMPLETE new outfit in the run AND in "outfits",
  keyed by the exact sheet name: every garment still worn, not just the one
  thing the passage named. Report "nude" rather than an empty list when
  everything came off.
- Clothing coming off IS a change. If it leaves the body and you stay silent,
  it goes back on next image.
- Never invent garments. Someone in nothing but an oversized shirt is
  "no pants, barefoot" — say so instead of quietly adding jeans or shoes.
- Body states (bulge, midriff, cleavage, navel) are not garments.

SETTING — when the passage moves the characters somewhere new, put the new
location's tags in "setting" so LumiDraw remembers the move. Omit it when they
have not moved.

RATING is the Danbooru rating of the PICTURE, not the mood of the story:
safe = nothing suggestive; sensitive = suggestive, no nudity; nsfw = nudity or
overt sexual context; explicit = a sexual act or visible genitals.

ASPECT — 16:9 for a wide scene or two figures side by side, 4:3 for two close
figures, 3:4 for a single figure, 1:1 for a tight emblematic shot.

NEVER: prose paragraphs beyond scene_summary, reasoning or self-corrections
("no wait"), the same concept twice in different words, invented tags, an
unsafe/alternate character name, or anything from the banned list.
`

// The context the parser needs to write a good prompt, in the plainest form
// that survives a language model reading it. This is what LumiDraw is FOR now:
// knowing who is in this chat, what they were last seen wearing, where they are.
// Build the identity run once from the locked profile. The count tag is NOT
// part of this anchor because the Direct prompt grammar already places a count
// tag immediately before it in each character block. Keeping it out avoids
// accidental `1girl, 1girl, ...` duplication when the parser copies exactly.
function directAnchorFor(profile) {
  const declared = Array.isArray(profile.identityTags)
    ? profile.identityTags
    : String(profile.identityTags || '').split(',')
  return enforceOnePresentation(rewriteKnownAliases(uniqueStrings([
    profile.subject,
    ...declared,
    ...(profile.appearance || []),
  ].map(animaTag).filter(Boolean))), profile.anchor || profile.ref).slice(0, 28)
}

// Direct mode uses one mechanically-vetted binding name in the natural-language
// scene sentence AND as the heading of that character's BREAK run. promptName is
// the author's explicit safe image-prompt name; the real anchor is used only when
// it does not collide with Anima's tag space.
function directSentenceName(profile) {
  const promptName = String((profile && profile.promptName) || '').trim()
  if (promptName && !nameReadsAsTag(promptName)) return promptName
  const anchor = String((profile && profile.anchor) || '').trim()
  if (anchor && !nameReadsAsTag(anchor)) return anchor
  return ''
}

function directFallbackNoun(profile) {
  const count = animaTag((profile && profile.countTag) || '')
  if (/girl/.test(count)) return 'the girl'
  if (/boy/.test(count)) return 'the boy'
  if (/woman|female/.test(count)) return 'the woman'
  if (/man|male/.test(count)) return 'the man'
  const subject = String((profile && profile.subject) || '').trim().toLowerCase()
  return subject ? `the ${subject}` : 'the character'
}

function directContext(profiles, { wardrobe = null, places = [], banned = '', fantasy = false, clothingDigest = [] } = {}) {
  const blocks = []
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile) continue
    const name = profile.anchor || profile.ref
    const anchor = directAnchorFor(profile)
    const hasWardrobe = !!(wardrobe && wardrobe[profile.ref] && wardrobe[profile.ref].length)
    const recorded = hasWardrobe ? wardrobe[profile.ref] : (profile.defaultOutfit || [])
    // Body facts and garments stay separated. Use the explicit body-state list,
    // never "not a known garment", because unusual clothing must remain clothing.
    const worn = recorded.filter((tag) => !BODY_STATE_TAGS.has(String(tag).toLowerCase()))
    const body = recorded.filter((tag) => BODY_STATE_TAGS.has(String(tag).toLowerCase()))
    const lines = [name]
    const sentenceName = directSentenceName(profile)
    if (sentenceName) {
      lines.push('  SENTENCE NAME: ' + sentenceName + ' — use this exact safe name in the scene sentence AND immediately after the count tag in this person\'s BREAK run')
      if (normalizeIdentityText(sentenceName) !== normalizeIdentityText(name)) {
        lines.push('  REAL NAME IS UNSAFE IN IMAGE TEXT: never write "' + name + '"; use the SENTENCE NAME above')
      }
    } else {
      lines.push('  SENTENCE NAME: none — "' + name + '" collides with image-tag vocabulary; use a pronoun in the sentence')
      lines.push('  RUN LABEL: ' + directFallbackNoun(profile) + ' — use this exact label immediately after the count tag')
    }
    if (profile.countTag) lines.push('  COUNT TAG: ' + animaTag(profile.countTag))
    if (anchor.length) lines.push('  IDENTITY ANCHOR (copy exactly): ' + anchor.join(', '))
    if ((profile.anatomy || []).length) {
      lines.push('  SAVED ANATOMY (the anatomy rule decides when): ' + animaTagList(profile.anatomy).join(', '))
    }
    if (hasWardrobe) {
      lines.push('  CURRENT CLOTHING (copy exactly unless the CURRENT PASSAGE changes it): ' +
        (worn.length ? worn.join(', ') : '(nothing recorded as worn)'))
    } else if (worn.length) {
      lines.push('  DEFAULT OUTFIT (only when nothing is recorded and the passage is silent): ' + worn.join(', '))
    }
    if (body.length) lines.push('  body, not clothing: ' + body.join(', '))
    blocks.push(lines.join('\n'))
  }
  const place = (places || []).filter(Boolean).slice(0, 1)
    .map((item) => `Place — ${item.name}: ${(item.tags || item.setting || []).join(', ')}`)
  const clothingHistory = (clothingDigest || []).filter(Boolean).map((line) => '- ' + line)
  return [
    'CHARACTER SHEETS — paste-exact text, not notes. This is everyone the story knows, NOT everyone in the picture — the present list decides who.',
    'WARDROBE PRECEDENCE: CURRENT PASSAGE change > CURRENT CLOTHING > EARLIER CLOTHING MENTIONS > DEFAULT OUTFIT.',
    'Silence means unchanged, not reset.',
    ...blocks,
    clothingHistory.length ? 'EARLIER CLOTHING MENTIONS (fallback only when no CURRENT CLOTHING exists):' : '',
    ...clothingHistory,
    ...place,
    banned ? `NEVER USE THESE: ${banned}` : '',
    fantasy ? 'This is a FANTASY setting. Non-human species are correct here, not errors.' : '',
  ].filter(Boolean).join('\n')
}


// Character sheets are reference, not a declaration that everyone is on camera.
// Leads stay available because POV/current-chat scenes may omit their names. Cast
// members named nowhere in the passage or recent parser context are withheld so a
// salient paste-exact sheet cannot tempt the parser to draw an absent person.
function gateDirectProfiles(profiles, evidenceText) {
  const hay = normalizeIdentityText(evidenceText)
  const cast = []
  const withheld = []
  for (const profile of ((profiles && profiles.cast) || [])) {
    if (!profile) continue
    const forms = uniqueStrings([profile.anchor, profile.promptName, directSentenceName(profile), String(profile.anchor || '').split(/\s+/)[0]].filter(Boolean))
    const inEvidence = forms.some((form) => {
      const needle = normalizeIdentityText(form)
      return needle && new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(hay)
    })
    if (inEvidence) cast.push(profile)
    else withheld.push(profile.anchor || profile.ref)
  }
  if (withheld.length) {
    spindle.log.info('[lumidraw] direct · no sheet sent for ' + withheld.join(', ') +
      ' — named nowhere in the passage or recent context')
  }
  return { ...(profiles || {}), cast }
}

// Presence evidence deliberately excludes wardrobe/state blocks. A saved outfit
// proves continuity, not that its owner is physically in this moment.
function directEvidenceFor(messages, targetIndex, settings) {
  const parts = []
  const target = messageBits(messages[targetIndex] || {})
  if (typeof target.content === 'string') parts.push(cleanParserMessageText(target.content))
  const back = Math.max(2, (Number(settings.parserContextMessages) || 0) * 2 + 2)
  for (let i = Math.max(0, targetIndex - back); i < targetIndex; i++) {
    const bits = messageBits(messages[i] || {})
    if (typeof bits.content !== 'string') continue
    const clean = cleanParserMessageText(bits.content)
    if (clean) parts.push(clean.slice(-1500))
  }
  return parts.join('\n')
}


// How many pictures. The compiler's schema said the minimum "is a FLOOR: find
// that many distinct visual moments EVEN WHEN ONE DOMINATES" — which is an
// instruction to manufacture moments, and it is why the count came out at the
// limit every time regardless of the passage.
//
// Direct mode said nothing at all, which is not better; it just left the model
// guessing. A ceiling is a limit, not a quota, and one good picture of the moment
// that matters beats two of which one is filler.
function countRule(maxImages = 2) {
  const max = Math.max(1, Number(maxImages) || 1)
  if (max === 1) return 'Return exactly ONE image — the single moment that carries this passage.'
  return `HOW MANY: return ONE image. Most passages have one moment worth drawing, and one good picture beats two where the second is filler. Add a second ONLY if the passage genuinely contains another distinct moment — a different place, a different pair of people, a real change of situation — not a second angle on the same beat. Never more than ${max}. The limit is a ceiling, not a target.`
}

function directSubjectLimit(value = 2) {
  return Math.max(2, Math.min(4, Number(value) || 2))
}

function directSceneSummaryWordLimit(maxSubjects = 2) {
  return { 2: 18, 3: 24, 4: 30 }[directSubjectLimit(maxSubjects)]
}

function subjectLimitRule(maxSubjects = 2) {
  const max = directSubjectLimit(maxSubjects)
  const summaryWords = directSceneSummaryWordLimit(max)
  if (max === 2) {
    return `MAXIMUM CHARACTERS PER IMAGE: 2. This is a hard ceiling and the proven reliability setting. If more than two people occupy the moment, choose the two whose participation carries it; a witness is left out. SCENE SUMMARY: at most ${summaryWords} words.`
  }
  return `MAXIMUM CHARACTERS PER IMAGE: ${max}. This is a hard ceiling. When the chosen moment physically includes ${max} participating people, include all ${max}; do not collapse the scene to two merely because two is easier. If more than ${max} are present, keep the ${max} whose participation carries the moment. Every included person needs independent evidence and exactly one separate BREAK run. Group scenes are less reliable, so keep positions and ownership exceptionally explicit. SCENE SUMMARY: at most ${summaryWords} words.`
}

function buildDirectInstruction(profiles, options = {}) {
  return [DIRECT_RULES.trim(), '', countRule(options.maxImages), '',
    subjectLimitRule(options.maxSubjects), '', directContext(profiles, options)].join('\n')
}

// The scene the parser writes, with nothing but structural checks. `prompt` is
// taken verbatim — the entire point of this mode is that nothing downstream
// rewrites it.
// A model thinking out loud is not a tag.
//
//   "…, BREAK, 2boys,  no wait,  1girl,  1boy,  hallway, …"
//
// The parser started writing a two-boy scene, realised it was a girl and a boy,
// and wrote the correction into the prompt instead of over it. Both halves then
// went to Draw Things: a literal "no wait", and a count tag it had just
// abandoned, fighting the one it settled on.
//
// Direct mode's promise is that the prompt is taken VERBATIM, and that stands —
// this removes model artifacts, it does not rewrite content. Two narrow rules,
// and nothing else:
//
//   1. A self-correction marker is never a Danbooru tag. Drop it.
//   2. A COUNT tag before such a marker in the same run is the attempt the model
//      just abandoned. Drop it. Only counts — a scene tag written before the
//      model changed its mind about the count is still a scene tag, and
//      throwing away everything to the left would lose real work.
//
// A prompt with no markers in it comes through untouched, which is the case that
// matters most and the one that is asserted hardest.
const SELF_CORRECTION_RE = /^(?:oh\s+)?(?:no\s+wait|wait|actually|scratch that|correction|i mean|nevermind|never mind|oops|sorry|hold on|let me redo|on second thought)$/i
// Deliberately its own pattern rather than the compiler's COUNT_TAG_RE: this one
// also has to recognise `solo`, `multiple girls` and `2+girls`, which a parser
// writing freehand will reach for and the compiler's never had to.
const DIRECT_COUNT_TAG_RE = /^(?:\d+\+?(?:girls?|boys?|others?|people)|multiple (?:girls|boys)|solo|no humans)$/i

// A COUNT TAG MID-BLOCK IS A MISSING BREAK.
//
// "They all mix up the positioning of the characters. It should be Elliot and
//  Fanny on the bed and Hannah walking in from the door."
//
// The parser wrote:
//
//   2girls, 1boy, living room, couch, dim lighting, camera facing doorway,
//   wide shot, 1boy, Elliot, tall, lean, … BREAK 1girl, Fanny, … BREAK 1girl, …
//
// Three BREAKs, but none between the shared frame and the FIRST character — so
// the frame and Elliot's whole run are one block, which also declares `1boy`
// twice and `2girls` alongside him. Anima binds a BREAK-delimited block as one
// subject group, so Elliot's features sit in a block announcing two girls, and
// the framing tags bind to him instead of the camera. Everything after that is
// the model guessing.
//
// The rule is unambiguous and needs no judgement: a block may open with count
// tags — that is the shared frame — but the first count tag appearing AFTER a
// non-count tag is a new subject, and a new subject needs a BREAK.
function splitFusedSubjectRuns(prompt, depth = 0) {
  const inserted = []
  // This recurses on model output, and a mutation test proved the recursion is
  // unbounded if the "a block may open with count tags" guard is ever weakened —
  // it blew the stack rather than failing an assertion. A depth cap costs
  // nothing and turns a crash into a merely imperfect prompt. Eight is far more
  // subjects than this model can draw anyway.
  if (depth > 8) return { prompt: String(prompt || ''), inserted }
  const runs = String(prompt || '').split(/\bBREAK\b/).map((run) => {
    const tags = run.split(',').map((tag) => tag.trim()).filter(Boolean)
    let seenNonCount = false
    for (let index = 0; index < tags.length; index++) {
      const isCount = DIRECT_COUNT_TAG_RE.test(tags[index])
      if (!isCount) { seenNonCount = true; continue }
      if (!seenNonCount) continue
      inserted.push(tags[index])
      return ' ' + tags.slice(0, index).join(', ') + ' BREAK ' +
        splitFusedSubjectRuns(tags.slice(index).join(', '), depth + 1).prompt + ' '
    }
    return run
  })
  return { prompt: runs.join('BREAK'), inserted }
}

// Anima does not know your characters' names. The direct-mode rules already say
// "NEVER … a character's name as a tag", and the parser writes them anyway — so
// they are removed here rather than hoped for. A name is not a tag: at best it
// is noise competing with the description, at worst it pulls toward whichever
// booru character happens to share it.
function sanitizeDirectNames(prompt, profiles, trace = null) {
  const notes = []
  const entries = allKnownProfiles(profiles).filter((p) => p && p.anchor).map((profile) => {
    const anchor = String(profile.anchor || '').trim()
    const promptName = String(profile.promptName || '').trim()
    const safe = directSentenceName(profile)
    return {
      anchor,
      promptName,
      use: safe || directFallbackNoun(profile),
      collided: !safe,
    }
  })
  if (!entries.length) return String(prompt || '')

  const blocks = String(prompt || '').split(/\bBREAK\b/)
  const next = blocks.map((block, blockIndex) => {
    const isFrame = blockIndex === 0
    const rawParts = String(block || '').split(',').map((part) => String(part || '').trim()).filter(Boolean)
    const out = []
    for (let partIndex = 0; partIndex < rawParts.length; partIndex++) {
      let part = rawParts[partIndex]
      let drop = false
      for (const entry of entries) {
        const forms = uniqueStrings([entry.anchor, entry.promptName, String(entry.anchor || '').split(/\s+/)[0]].filter(Boolean))
        for (const form of forms) {
          const re = new RegExp(`\\b${escapeRegExp(form)}\\b`, 'gi')
          if (!re.test(part)) continue
          const bare = normalizeIdentityText(part) === normalizeIdentityText(form)

          if (isFrame) {
            // The scene sentence may contain the safe binding name. A separate
            // comma-token that is only a name is still a stray tag and is dropped.
            if (bare) {
              notes.push(`removed bare name tag "${part}" — names belong inside the scene sentence`)
              drop = true
              break
            }
            if (normalizeIdentityText(entry.use) !== normalizeIdentityText(form)) {
              part = part.replace(re, entry.use)
              const why = nameReadsAsTag(form)
              notes.push(why
                ? `"${form}" → "${entry.use}" in the scene sentence — ${why}`
                : `"${form}" → "${entry.use}" in the scene sentence — the sheet's prompt name`)
            }
            continue
          }

          // In a subject run, the binding name is allowed only as the run head:
          // immediately after the count tag. Elsewhere it is tag-space noise.
          const runHead = partIndex === 1 && DIRECT_COUNT_FULL_RE.test(normalizeDirectCountTag(rawParts[0] || ''))
          if (bare && runHead) {
            if (normalizeIdentityText(entry.use) !== normalizeIdentityText(form)) {
              part = entry.use
              const why = nameReadsAsTag(form)
              notes.push(why
                ? `"${form}" → "${entry.use}" at the run head — ${why}`
                : `"${form}" → "${entry.use}" at the run head — the sheet's prompt name`)
            }
            // A vetted name already equal to the chosen safe form survives.
            continue
          }

          notes.push(`removed "${form}" from inside a tag run — names are allowed only as the run heading`)
          drop = true
          break
        }
        if (drop) break
      }
      if (!drop && part) out.push(part)
    }
    return ' ' + out.join(', ') + ' '
  }).join('BREAK').replace(/\s{2,}/g, ' ').trim()

  const unique = uniqueStrings(notes)
  if (trace) for (const note of unique) trace('character names', 'applied', note)
  if (unique.length) spindle.log.info('[lumidraw] direct · names · ' + unique.slice(0, 6).join(' · '))
  return next
}

function repairDirectPrompt(prompt) {
  const runs = String(prompt || '').split(/\bBREAK\b/)
  const dropped = []
  const repaired = runs.map((run) => {
    const tags = run.split(',').map((tag) => tag.trim())
    const markers = tags.map((tag) => SELF_CORRECTION_RE.test(tag))
    if (!markers.some(Boolean)) return run
    const lastMarker = markers.lastIndexOf(true)
    const kept = []
    for (let index = 0; index < tags.length; index++) {
      const tag = tags[index]
      if (!tag) continue
      if (markers[index]) { dropped.push(tag); continue }
      if (index < lastMarker && DIRECT_COUNT_TAG_RE.test(tag)) { dropped.push(tag); continue }
      kept.push(tag)
    }
    return ' ' + kept.join(', ') + ' '
  }).join('BREAK')
  return { prompt: dropped.length ? repaired.replace(/\s+/g, ' ').trim() : String(prompt || ''), dropped }
}


// Freehand parsers occasionally emit singular multi-counts such as `2girl`.
// Normalize counts everywhere, and rebuild the shared frame from the subject
// runs that actually survive the hard two-subject ceiling.
const DIRECT_COUNT_FULL_RE = /^(\d+)\s*\+?\s*(girl|girls|boy|boys|other|others|woman|women|man|men|female|females|male|males|people|person|persons)$/i
const DIRECT_COUNT_BASE = {
  girl: 'girl', girls: 'girl', boy: 'boy', boys: 'boy', other: 'other', others: 'other',
  woman: 'woman', women: 'woman', man: 'man', men: 'man', female: 'female', females: 'female',
  male: 'male', males: 'male', people: 'people', person: 'person', persons: 'person',
}
const DIRECT_COUNT_PLURALS = {
  girl: 'girls', boy: 'boys', other: 'others', woman: 'women',
  man: 'men', female: 'females', male: 'males', people: 'people', person: 'people',
}

function directCountBase(value) {
  return DIRECT_COUNT_BASE[String(value || '').toLowerCase()] || String(value || '').toLowerCase()
}

function normalizeDirectCountTag(tag) {
  const match = DIRECT_COUNT_FULL_RE.exec(String(tag || '').trim())
  if (!match) return String(tag || '').trim()
  const n = Number(match[1])
  const kind = directCountBase(match[2])
  return `${n}${n === 1 ? kind : DIRECT_COUNT_PLURALS[kind]}`
}

function firstDirectTag(block) {
  return (String(block || '').split(',')[0] || '').trim()
}

function limitDirectSubjectRuns(prompt, maxSubjects = 2) {
  const maximum = directSubjectLimit(maxSubjects)
  const notes = []
  const blocks = String(prompt || '').split(/\bBREAK\b/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length < 2) return { prompt: String(prompt || ''), notes }
  const isCount = (tag) => DIRECT_COUNT_TAG_RE.test(tag) || DIRECT_COUNT_FULL_RE.test(tag)
  const frame = blocks[0]
  const subjectRuns = []
  const passthrough = []
  for (const block of blocks.slice(1)) {
    if (isCount(firstDirectTag(block))) subjectRuns.push(block)
    else passthrough.push(block)
  }
  if (!subjectRuns.length) return { prompt: String(prompt || ''), notes }

  const kept = subjectRuns.slice(0, maximum)
  for (const run of subjectRuns.slice(maximum)) {
    notes.push(`dropped an extra character run ("${run.split(',').slice(0, 3).join(', ')}…") — the configured maximum is ${maximum} described subjects`)
  }

  const normalizedRuns = kept.map((run) => {
    const tags = run.split(',')
    const norm = normalizeDirectCountTag(tags[0])
    if (tags[0].trim() && norm !== tags[0].trim()) {
      notes.push(`count tag "${tags[0].trim()}" written as "${norm}"`)
      tags[0] = norm
    }
    return tags.join(',').replace(/\s+/g, ' ').trim()
  })

  const sums = new Map()
  let countable = normalizedRuns.length > 0
  for (const run of normalizedRuns) {
    const match = DIRECT_COUNT_FULL_RE.exec(normalizeDirectCountTag(firstDirectTag(run)))
    if (!match) { countable = false; break }
    const kind = directCountBase(match[2])
    sums.set(kind, (sums.get(kind) || 0) + Number(match[1]))
  }
  let frameOut = frame
  if (countable) {
    const aggregate = [...sums.entries()].map(([kind, n]) =>
      `${n}${n === 1 ? kind : DIRECT_COUNT_PLURALS[kind]}`)
    const rest = frame.split(',').map((t) => t.trim()).filter((t) => t && !isCount(t))
    frameOut = [...aggregate, ...rest].join(', ')
  }
  return { prompt: [frameOut, ...normalizedRuns, ...passthrough].join(' BREAK ').replace(/\s+/g, ' ').trim(), notes }
}

// Collapse parser re-description without changing paste-exact identity anchors.
// Exact anchor tags win over later embellished variants; garments use the most
// specific same-head wording when neither candidate is protected identity.
function dedupeDirectRuns(prompt, profiles = null) {
  const notes = []
  const key = (t) => normalizeIdentityText(t)
  const protectedKeys = new Set()
  for (const profile of allKnownProfiles(profiles || {})) {
    for (const tag of directAnchorFor(profile || {})) {
      const k = key(tag)
      if (k) protectedKeys.add(k)
    }
  }
  const blocks = String(prompt || '').split(/\bBREAK\b/).map((block) => {
    const tags = String(block || '').split(',').map((t) => t.trim()).filter(Boolean)
    const kept = []
    for (const tag of tags) {
      const k = key(tag)
      if (!k) continue
      const exact = kept.findIndex((other) => key(other) === k)
      if (exact >= 0) { notes.push(`"${tag}" — already said`); continue }

      let handled = false
      for (let i = 0; i < kept.length; i++) {
        const other = kept[i]
        const ko = key(other)
        const tagProtected = protectedKeys.has(k)
        const otherProtected = protectedKeys.has(ko)
        const otherContains = ko.length > k.length && new RegExp(`\\b${escapeRegExp(k)}\\b`).test(ko)
        const tagContains = k.length > ko.length && new RegExp(`\\b${escapeRegExp(ko)}\\b`).test(k)
        if (!otherContains && !tagContains) continue
        if (otherProtected) {
          notes.push(`"${tag}" dropped — paste-exact identity already says "${other}"`)
          handled = true
          break
        }
        if (tagProtected) {
          notes.push(`"${other}" folded into paste-exact identity "${tag}"`)
          kept[i] = tag
          handled = true
          break
        }
        if (otherContains) {
          notes.push(`"${tag}" — already covered by "${other}"`)
          handled = true
          break
        }
        if (tagContains) {
          notes.push(`"${other}" folded into "${tag}"`)
          kept[i] = tag
          handled = true
          break
        }
      }
      if (!handled) kept.push(tag)
    }

    const bestByHead = new Map()
    for (const tag of kept) {
      const k = key(tag)
      if (protectedKeys.has(k)) continue
      const head = k.split(/\s+/).pop()
      if (!head || !garmentZone(k)) continue
      const words = k.split(/\s+/).length
      const prev = bestByHead.get(head)
      if (!prev || words > prev.words) bestByHead.set(head, { tag, words })
    }
    const finalTags = kept.filter((tag) => {
      const k = key(tag)
      if (protectedKeys.has(k)) return true
      const head = k.split(/\s+/).pop()
      if (!head || !garmentZone(k)) return true
      const best = bestByHead.get(head)
      if (best && best.tag !== tag) {
        notes.push(`"${tag}" dropped — "${best.tag}" is the same garment`)
        return false
      }
      return true
    })
    return ' ' + finalTags.join(', ') + ' '
  })
  return { prompt: blocks.join('BREAK').replace(/\s+/g, ' ').trim(), notes }
}


function directProfileForPresenceName(name, profiles) {
  const wanted = normalizeIdentityText(name)
  if (!wanted) return null
  return allKnownProfiles(profiles).find((profile) => profile && [
    profile.anchor, profile.promptName, profile.ref, directSentenceName(profile),
  ].some((form) => normalizeIdentityText(form) === wanted)) || null
}

// Whose sheet did this run copy? The run-head binding name is the strongest
// signal. Trait overlap remains a conservative fallback and refuses ties.
function matchDirectRunProfile(run, profiles) {
  const text = String(run || '')
  const lower = text.toLowerCase()
  const headTokens = text.split(',').slice(0, 4).map((v) => normalizeIdentityText(v)).filter(Boolean)
  for (const profile of allKnownProfiles(profiles)) {
    if (!profile) continue
    const forms = uniqueStrings([
      directSentenceName(profile), profile.anchor, profile.promptName, String(profile.anchor || '').split(/\s+/)[0],
    ].filter(Boolean).map(normalizeIdentityText))
    if (forms.some((form) => headTokens.includes(form))) return profile
  }
  let best = null
  let bestScore = 0
  let tie = false
  for (const profile of allKnownProfiles(profiles)) {
    const marks = directAnchorFor(profile || {})
    if (!marks.length) continue
    const score = marks.filter((tag) => lower.includes(String(tag).toLowerCase())).length
    if (score > bestScore) { best = profile; bestScore = score; tie = false }
    else if (score === bestScore && best && profile.ref !== best.ref) tie = true
  }
  if (!best || tie || bestScore < Math.min(2, directAnchorFor(best).length || 1)) return null
  return best
}

// A sheet is not presence. When the parser declared a roster, a known-profile
// run that does not belong to that validated roster is mechanically removed.
// Unknown strangers are kept because there is no reliable sheet match to judge.
function dropUndeclaredRuns(prompt, present, profiles) {
  const notes = []
  if (present === null || present === undefined) return { prompt: String(prompt || ''), notes, skipped: true }
  const declaredNames = new Set((present || []).map((entry) =>
    normalizeIdentityText(entry && typeof entry === 'object' ? entry.name : entry)).filter(Boolean))
  const declaredRefs = new Set()
  for (const entry of present || []) {
    const profile = directProfileForPresenceName(entry && typeof entry === 'object' ? entry.name : entry, profiles)
    if (profile && profile.ref) declaredRefs.add(profile.ref)
  }
  const blocks = String(prompt || '').split(/\bBREAK\b/).map((b) => b.trim()).filter(Boolean)
  if (blocks.length < 2) return { prompt: String(prompt || ''), notes }
  const isCount = (tag) => DIRECT_COUNT_TAG_RE.test(tag) || DIRECT_COUNT_FULL_RE.test(tag)
  const frame = blocks[0]
  const runs = []
  const rest = []
  for (const block of blocks.slice(1)) (isCount(firstDirectTag(block)) ? runs : rest).push(block)
  const kept = []
  for (const run of runs) {
    const best = matchDirectRunProfile(run, profiles)
    if (!best) { kept.push(run); continue }
    const nameForms = uniqueStrings([
      best.anchor, best.promptName, best.ref, directSentenceName(best),
    ].filter(Boolean).map(normalizeIdentityText))
    const allowed = (best.ref && declaredRefs.has(best.ref)) || nameForms.some((form) => declaredNames.has(form))
    if (allowed) { kept.push(run); continue }
    notes.push(`dropped the run for ${best.anchor || best.ref} — the validated present list ` +
      `(${(present || []).map((e) => e && typeof e === 'object' ? e.name : e).join(', ') || 'empty'}) does not include them. Talked about is not present.`)
  }
  if (runs.length && !kept.length) {
    return {
      prompt: String(prompt || ''),
      notes: ['every known run failed the presence check — the declaration is being distrusted and the prompt kept intact'],
      skipped: true,
    }
  }
  return { prompt: [frame, ...kept, ...rest].join(' BREAK '), notes }
}

// Compare the validated roster with the runs that survived parsing. Missing
// validated people are enough to retry: an extra wrong run may already have been
// removed by dropUndeclaredRuns, so requiring an extra here would hide the exact
// Jamie/Erin failure after the guard did its first job.
function directPresenceContradictions(image, profiles) {
  const runs = String((image && image.prompt) || '').split(/\bBREAK\b/).slice(1)
    .map((run) => matchDirectRunProfile(run, profiles)).filter(Boolean)
  const runRefs = new Set(runs.map((p) => p.ref))
  const expected = []
  for (const entry of (image && image.present) || []) {
    const profile = directProfileForPresenceName(entry && entry.name, profiles)
    if (profile && !expected.some((p) => p.ref === profile.ref)) expected.push(profile)
  }
  const missing = expected.filter((p) => !runRefs.has(p.ref))
  const expectedRefs = new Set(expected.map((p) => p.ref))
  const extra = expected.length ? runs.filter((p) => !expectedRefs.has(p.ref)) : []

  // Compatibility fallback if the parser omitted/voided presence: use safe names
  // in the frame sentence to catch a right-sentence/wrong-sheet contradiction.
  if (!expected.length) {
    const frame = [String((image && image.scene_summary) || ''),
      String((image && image.prompt) || '').split(/\bBREAK\b/)[0] || ''].join(' ').toLowerCase()
    const named = []
    for (const p of allKnownProfiles(profiles)) {
      const form = directSentenceName(p)
      if (form && new RegExp(`\\b${escapeRegExp(form.toLowerCase())}\\b`).test(frame)) named.push(p)
    }
    const namedRefs = new Set(named.map((p) => p.ref))
    const sentenceMissing = named.filter((p) => !runRefs.has(p.ref))
    const sentenceExtra = named.length ? runs.filter((p) => !namedRefs.has(p.ref)) : []
    if (sentenceMissing.length || sentenceExtra.length) return { missing: sentenceMissing, extra: sentenceExtra, source: 'sentence' }
    return null
  }
  return (missing.length || extra.length) ? { missing, extra, source: 'present' } : null
}

function parseDirectImages(raw, maxImages = 2, profiles = null, passage = '', maxSubjects = 2) {
  const subjectMaximum = directSubjectLimit(maxSubjects)
  const summaryWordLimit = directSceneSummaryWordLimit(subjectMaximum)
  let text = extractParserText(raw)
  const parsed = (() => {
    try { return JSON.parse(sanitizeJsonText(text)) } catch { /* fall through */ }
    const match = /\{[\s\S]*\}/.exec(text)
    if (!match) return null
    try { return JSON.parse(sanitizeJsonText(match[0])) } catch { return null }
  })()
  if (!parsed || !Array.isArray(parsed.images)) {
    const prose = String(text || '').trim()
    const looksLikeProse = prose.length > 40 && !prose.includes('{')
    if (looksLikeProse) {
      const opening = prose.replace(/\s+/g, ' ').slice(0, 220)
      return {
        images: [],
        refused: true,
        error: 'The parser model replied in prose instead of a prompt — it appears to have ' +
          'declined this passage. It said: "' + opening + (prose.length > 220 ? '…' : '') + '"',
      }
    }
    return { images: [], error: 'no images array in the reply' }
  }
  const images = []
  for (const item of parsed.images.slice(0, Math.max(1, maxImages))) {
    if (!item || typeof item !== 'object') continue
    const written = String(item.prompt || '').trim()
    if (!written) continue
    const repaired = repairDirectPrompt(written)
    if (repaired.dropped.length) {
      spindle.log.info(`[lumidraw] direct · the parser corrected itself mid-prompt; dropped ${repaired.dropped.join(', ')}`)
    }
    const split = splitFusedSubjectRuns(repaired.prompt)
    if (split.inserted.length) {
      spindle.log.info('[lumidraw] direct · the frame and a character were in one block; ' +
        `inserted BREAK before ${split.inserted.join(', ')} — Anima binds a block as one subject group`)
    }
    const presenceFieldDeclared = Object.prototype.hasOwnProperty.call(item, 'present')
    const presentRaw = Array.isArray(item.present) ? item.present
      : (item.present ? [{ name: item.present }] : [])
    const present = []
    const passageNorm = normalizeIdentityText(passage)
    for (const entry of presentRaw.slice(0, 6)) {
      const name = String((entry && typeof entry === 'object' && entry.name) || entry || '').trim()
      const evidence = String((entry && typeof entry === 'object' && entry.evidence) || '').trim()
      if (!name) continue
      const evidenceNorm = normalizeIdentityText(evidence)
      const evidenceWords = evidenceNorm ? evidenceNorm.split(/\s+/).filter(Boolean).length : 0
      if (!evidenceNorm || evidenceWords < 3 || evidenceWords > 8 || !passageNorm.includes(evidenceNorm)) {
        const why = !evidenceNorm ? 'none given'
          : (evidenceWords < 3 || evidenceWords > 8 ? `${evidenceWords} words; expected 3-8` : 'not found in the current passage')
        spindle.log.warn(`[lumidraw] direct · "${name}" declared present, but the evidence quote is invalid ` +
          `(${why}${evidence ? ` · "${evidence.slice(0, 60)}"` : ''}) — treated as not present`)
        continue
      }
      present.push({ name, evidence })
    }
    if (present.length) {
      spindle.log.info('[lumidraw] direct · present · ' + present.map((entry) =>
        `${entry.name} <= "${entry.evidence}"`).join(' · '))
    }
    const declared = dropUndeclaredRuns(split.prompt, presenceFieldDeclared ? present : null, profiles)
    for (const note of declared.notes) spindle.log.warn('[lumidraw] direct · ' + note)
    if (declared.skipped && !presenceFieldDeclared) {
      spindle.log.info('[lumidraw] direct · presence check skipped — the parser omitted the present field')
    }
    const limited = limitDirectSubjectRuns(declared.prompt, subjectMaximum)
    const deduped = dedupeDirectRuns(limited.prompt, profiles)
    const prompt = deduped.prompt
    const notes = [...declared.notes, ...limited.notes, ...deduped.notes]
    if (limited.notes.length) {
      spindle.log.warn('[lumidraw] direct · ' + limited.notes.join(' · '))
    }
    if (deduped.notes.length) {
      spindle.log.info('[lumidraw] direct · duplicates collapsed · ' + deduped.notes.slice(0, 8).join(' · '))
    }
    const ratingRaw = String(item.rating || item.safety || '').trim().toLowerCase()
    const outfits = {}
    if (item.outfits && typeof item.outfits === 'object' && !Array.isArray(item.outfits)) {
      for (const [key, value] of Object.entries(item.outfits)) {
        const name = String(key || '').trim().slice(0, 64)
        if (!name) continue
        const list = animaTagList(Array.isArray(value) ? value : String(value || '').split(',')).slice(0, 12)
        if (list.length) outfits[name] = list
      }
    }
    const sceneSummary = normalizeDirectSceneSummary(item.scene_summary, summaryWordLimit)
    images.push({
      anchor: String(item.anchor || '').trim(),
      prompt,
      scene_summary: sceneSummary,
      sceneSummaryWordLimit: summaryWordLimit,
      aspect: VALID_ASPECTS.has(String(item.aspect || '')) ? String(item.aspect) : '3:4',
      notes,
      present,
      presenceFieldDeclared,
      rating: ANIMA_SAFETY_TAGS.includes(ratingRaw) ? ratingRaw : '',
      setting: animaTagList(tagsFrom(item.setting || [], 8)),
      // Accepted for forward compatibility if a parser returns it, though the
      // compact Direct schema does not require a lighting sidecar.
      lighting: animaTagList(tagsFrom(item.lighting || [], 4)),
      outfits,
    })
  }
  return { images, error: images.length ? '' : 'no usable prompt in the reply' }
}


// Which tags must be present whenever this character is in the picture.
//
// Explicit, never inferred. `identityTags` is the author's list; the noun is
// used only when they have not written one, because "a futanari" IS the fact in
// Fanny's case and pretending otherwise would just lose it. An empty list locks
// nothing — a character with no declared non-negotiables is entirely the
// parser's to describe.
function identityLockFor(profile) {
  if (!profile) return []
  const declared = Array.isArray(profile.identityTags) ? profile.identityTags
    : String(profile.identityTags || '').split(',')
  const explicit = animaTagList(declared)

  // Stable futanari identity is special because a parser can correctly describe
  // every other visible trait and still quietly omit this one — especially when
  // the scene is explicit. If the AUTHOR put futanari in Permanent appearance,
  // that is already an explicit declaration, not an inference. Promote it to the
  // same hard Direct-mode lock as Always include so the parser cannot sanitize or
  // forget it. Aliases such as `futa` canonicalize through animaTag().
  const appearance = animaTagList(profile.appearance || [])
  const stableSexIdentity = appearance.filter((tag) =>
    tag === 'futanari' || tag === 'male futanari' || tag === 'futa without pussy' || tag === 'cuntboy')

  return uniqueStrings([...explicit, ...stableSexIdentity]).slice(0, 6)
}

// Is this character in this prompt at all? Their name is not in it — names are
// not tags — so identity is matched on the tags that describe them.
function subjectPresentIn(prompt, profile) {
  const text = String(prompt || '').toLowerCase()
  // Match the stable identity anchor, never clothing. Clothing is allowed to
  // change; the anchor is the paste-exact signal Direct mode was asked to keep.
  const marks = directAnchorFor(profile).filter((tag) => tag && !DIRECT_COUNT_TAG_RE.test(tag))
  if (!marks.length) return false
  const hits = marks.filter((tag) => text.includes(String(tag).toLowerCase())).length
  return hits >= Math.min(2, marks.length)
}


// The only thing that touches what the parser wrote, and it only ever ADDS.
function applyIdentityLock(prompt, profiles, trace = null) {
  let text = String(prompt || '')
  const restored = []
  for (const profile of allKnownProfiles(profiles)) {
    const required = identityLockFor(profile)
    if (!required.length) continue
    if (!subjectPresentIn(text, profile)) continue
    const missing = required.filter((tag) => !new RegExp(`(^|,\\s*)${escapeForRegex(tag)}\\s*(,|$| BREAK)`, 'i').test(text))
    if (!missing.length) continue
    // Placed at the front of that character's run, where proximity binds it to
    // the right body — appending to the end of the whole prompt would let the
    // model attach it to whoever was named last.
    const who = (profile.appearance || []).find((tag) => text.toLowerCase().includes(String(tag).toLowerCase()))
    if (who) {
      const at = text.toLowerCase().indexOf(String(who).toLowerCase())
      text = `${text.slice(0, at)}${missing.join(', ')}, ${text.slice(at)}`
    } else {
      text = `${text}, ${missing.join(', ')}`
    }
    restored.push(`${profile.anchor || profile.ref}: ${missing.join(', ')}`)
  }
  if (restored.length && trace) {
    trace('identity lock', 'applied', `put back what the parser dropped — ${restored.join('; ')}`)
  }
  return { prompt: text, restored }
}

// The compiler's two anatomy defences, rebuilt for a prompt LumiDraw did not
// compile. They touch fixed header/negative slots, never the parser's body.
function directDefences(prompt, profiles, rating) {
  const out = { positive: [], negatives: [], notes: [] }
  const level = String(rating || '').toLowerCase()
  if (!['nsfw', 'explicit'].includes(level)) return out
  const text = String(prompt || '').toLowerCase()
  const hasTag = (tag) => !!tag && text.includes(String(tag).toLowerCase())
  const present = allKnownProfiles(profiles).filter((p) => p && p.ref && subjectPresentIn(prompt, p))
  const shown = present.filter((p) =>
    (p.anatomy || []).some(hasTag) ||
    identityLockFor(p).some((tag) => /futanari|penis|testicles/.test(tag) && hasTag(tag)))
  if (!shown.length) return out
  out.positive.push(UNCENSORED_TAG)
  out.negatives.push(...CENSOR_NEGATIVES)
  out.notes.push('anatomy is in the prompt — the censorship prior is countered')
  const penisFamily = (p) =>
    [...(p.anatomy || []), ...identityLockFor(p)]
      .some((tag) => PENIS_ANATOMY_RE.test(tag) || /futanari|futa without pussy/.test(tag))
  // profile.anatomy only here deliberately. A lock such as "futa without pussy"
  // contains the word "pussy" but is not saved female anatomy.
  const femaleSaved = present.some((p) => (p.anatomy || []).some((tag) => FEMALE_ANATOMY_RE.test(tag)))
  if (shown.every(penisFamily) && !femaleSaved) {
    out.negatives.push(...FEMALE_GENITAL_NEGATIVES)
    out.notes.push('every shown anatomy is penis-family — female genitalia negated')
  }
  out.positive = uniqueStrings(out.positive)
  out.negatives = uniqueStrings(out.negatives)
  return out
}

// Close the continuity loop Direct mode previously only read from. Sidecar
// reports are persisted only when grounded in the current passage/context or in
// the already-established wardrobe, so a parser hallucination is not learned.
async function applyDirectContinuity(images, { profiles, chatId, presetName, grounding, messageId = '' }) {
  const known = allKnownProfiles(profiles).filter((p) => p && p.ref)
  const memory = await readSceneMemory(chatId, presetName)
  const outfits = {}
  const outfitMeta = {}
  for (const image of images || []) {
    for (const [name, raw] of Object.entries(image.outfits || {})) {
      const wanted = normalizeIdentityText(name)
      const match = known.find((p) =>
        [p.anchor, p.promptName, p.ref].some((v) => normalizeIdentityText(v) === wanted))
      if (!match) {
        spindle.log.info(`[lumidraw] direct · wardrobe report for "${name}" matched no one in this cast — ignored`)
        continue
      }
      if (ANONYMOUS_REF_RE.test(match.ref)) continue
      const list = animaTagList(Array.isArray(raw) ? raw : String(raw || '').split(',')).slice(0, 12)
      if (!list.length) continue
      const before = (memory.outfits || {})[match.ref] || []
      if (before.join('\u0000') === list.join('\u0000')) continue
      const keep = list.filter((tag) => {
        if (BARE_STATE_RE.test(tag)) return true
        if (isNotClothing(tag)) return false
        return garmentSupported(tag, grounding, before, match)
      })
      const dropped = list.filter((tag) => !keep.includes(tag))
      if (dropped.length) {
        spindle.log.info(`[lumidraw] direct · ${match.anchor || match.ref} — rendered but NOT remembered, ` +
          `nothing in the passage backs them: ${dropped.join(', ')}`)
      }
      if (!keep.length) continue
      outfits[match.ref] = keep
      outfitMeta[match.ref] = {
        source: 'story-parser',
        at: Date.now(),
        messageId,
      }
      spindle.log.info(`[lumidraw] direct · the parser re-dressed ${match.anchor || match.ref} · ${keep.join(', ')}`)
    }
  }
  let setting = null
  let lighting = null
  const moved = [...(images || [])].reverse().find((im) => (im.setting || []).length || (im.lighting || []).length)
  if (moved) {
    setting = reconcileSetting(moved.setting || [], grounding, memory.setting || []).setting
    lighting = scrubUnsupportedPlaces(animaTagList(moved.lighting || []), grounding, 'lighting').tags
  }
  if (!Object.keys(outfits).length && !(setting && setting.length) && !(lighting && lighting.length)) return
  await rememberSceneState(chatId, presetName, {
    setting: setting && setting.length ? setting : undefined,
    lighting: lighting && lighting.length ? lighting : undefined,
    outfits: Object.keys(outfits).length ? outfits : null,
    outfitMeta: Object.keys(outfitMeta).length ? outfitMeta : null,
  })
}


function escapeForRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileStructuredScene(scene, profiles, sourcePassage = '', { artistTags = [], rememberedSetting = [], contextText = '', rememberedOutfits = null, rememberedLooks = null, places = [], breakInPreset = false } = {}) {
  traceReset()
  // Matched before anything else uses it: the Place contributes to the negatives
  // (assembled with the descriptors) as well as to the setting (reconciled
  // later), and a value read before its own declaration is a crash rather than a
  // subtle bug — which is exactly how this was caught.
  const placeReport = {}
  const matchedPlace = selectPlace(places, [sourcePassage, contextText].filter(Boolean).join('\n'), scene.setting, placeReport)

  let descriptors = scene.subjects.map((subject) => subjectDescriptor(subject, profiles, sourcePassage, true, rememberedOutfits, rememberedLooks, scene)).map((item) => ({
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

  // Underwear as the only bottom layer is not a "safe" image, whatever the
  // parser labelled it. The label drives the safety tag, the censorship defence
  // and half the anatomy gating, so getting it one step too low quietly disables
  // all three. This only ever raises it.
  const exposedUnderwear = descriptors.some((item) => {
    const outfit = item.outfit || []
    return !outfit.some((tag) => OUTER_BOTTOM_RE.test(tag)) &&
      outfit.some((tag) => UNDERWEAR_BOTTOM_RE.test(tag))
  })
  if (scene.safety === 'safe' && exposedUnderwear) {
    scene = { ...scene, safety: 'sensitive' }
    trace('safety floor', 'applied', 'underwear is the only bottom layer; safe → sensitive')
  }

  // Nothing in the prompt said what a body with penis anatomy looks like under a
  // single layer, so the model drew a flat front. The tag exists and Anima knows
  // it. Three conditions, all required: the anatomy, no outer bottom over it, and
  // underwear actually present — a bare subject is handled by the anatomy path.
  for (const item of descriptors) {
    if (!['sensitive', 'nsfw', 'explicit'].includes(scene.safety)) break
    const hasPenisAnatomy =
      (item.anatomy || []).some((tag) => PENIS_ANATOMY_RE.test(tag)) ||
      (((item.profile || {}).anatomy) || []).some((tag) => PENIS_ANATOMY_RE.test(tag))
    if (!hasPenisAnatomy) continue
    if ((item.outfit || []).some((tag) => OUTER_BOTTOM_RE.test(tag))) continue
    if (!(item.outfit || []).some((tag) => UNDERWEAR_BOTTOM_RE.test(tag))) continue
    item.appearance = uniqueStrings([...(item.appearance || []), 'bulge'])
    trace('bulge', 'applied', 'no outer bottom over penis anatomy; bulge stated')
  }

  for (const item of descriptors) {
    const worn = (item.outfit || []).filter((tag) => !isNotClothing(tag))
    if (worn.length) LAST_COMPILE_OUTFITS[item.subject.ref] = worn
    if (item.look && item.look.name) LAST_COMPILE_LOOKS[item.subject.ref] = item.look.name
  }
  // A Look can carry its own negatives — "no jeans while she is in the gown".
  // Scoped to the scene the Look is active in, never persisted.
  const lookNegatives = uniqueStrings(descriptors.flatMap((item) =>
    (item.look && item.look.negative) || []))
  const placeNegatives = matchedPlace ? uniqueStrings(matchedPlace.negative || []) : []
  LAST_COMPILE_NEGATIVES = uniqueStrings([...garmentDefence(descriptors), ...lookNegatives, ...placeNegatives])
  if (placeNegatives.length) {
    trace('place negatives', 'applied',
      `${placeNegatives.join(', ')} — ${matchedPlace.name} says these do not belong here`)
  }
  if (lookNegatives.length) {
    trace('look negatives', 'applied',
      `${lookNegatives.join(', ')} — carried by the active look(s)`)
  }
  if (LAST_COMPILE_NEGATIVES.length) {
    trace('garment defence', 'applied',
      `negating ${LAST_COMPILE_NEGATIVES.join(', ')} — nobody in this scene wears them and the model's prior reaches for them`)
  }
  const anatomyNegatives = anatomyDefence(descriptors, scene)
  const femaleNegatives = femaleAnatomyDefence(descriptors, scene)
  if (femaleNegatives.length) {
    trace('anatomy · female genitalia negated', 'applied',
      `${femaleNegatives.join(', ')} — every subject whose anatomy is drawn here has a penis, and nothing in the prompt otherwise says she has not got one`)
  }
  if (femaleNegatives.length) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, ...femaleNegatives])
  }
  if (LAST_DIAGNOSTIC) {
    // Re-read after the defences have run; the negative list is the point.
    LAST_DIAGNOSTIC.negatives = negativeSnapshot()
  }
  if (anatomyNegatives.length) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, ...anatomyNegatives])
    trace('anatomy defence', 'applied',
      `negating ${anatomyNegatives.join(', ')} — anatomy is named for one subject and a female subject in the same frame has none`)
  } else if (descriptors.some((item) => (item.anatomy || []).length)) {
    trace('anatomy defence', 'ran', 'anatomy is named but no unequipped female subject shares the frame')
  }
  // "Negating it is free unless somebody in the scene is one." That sentence was
  // written when the preset ran at CFG 1, where the negative prompt is
  // decoration. At CFG 3 nothing in the negative is free: `elf, pointy ears` was
  // pulling on every picture of two people in a kitchen, for a concept nothing in
  // the scene had ever mentioned.
  //
  // The trap it guards is real but narrow — an INACTIVE form on a character who
  // has an elf shape somewhere in their profile can bleed the word in. So the
  // test is whether this cast has any such shape to bleed, not whether they
  // happen to be one right now. A cast that has never heard of elves gets
  // nothing added.
  // "Negating it is free unless somebody in the scene is one." That was written
  // when the preset ran at CFG 1, where the negative prompt is decoration. At
  // CFG 3 nothing in the negative is free, and two people in a kitchen were
  // carrying `elf, pointy ears` for a concept nothing in the scene had mentioned.
  //
  // The trap is real and the reason is precise: `elf` hides INSIDE ordinary
  // words. "herself" and "shelf" both contain it, the reflexives are stripped but
  // "shelf" cannot be — it is a real word doing real work — and `elf` is a strong
  // Danbooru concept. So the evidence is whether those three letters actually
  // appear in what is being sent. If they do not, there is nothing to counteract.
  const elfHaystack = [
    ...(scene.setting || []), scene.sceneStatement || '', scene.coreAction || '',
    ...(scene.relations || []).map((r) => `${r.action || ''} ${(r.details || []).join(' ')}`),
    ...descriptors.flatMap((item) => [
      ...(item.appearance || []), ...(item.outfit || []), ...(item.pose || []),
      ...(item.expression || []), ...(item.action || []),
      item.noun || '', item.anchor || '', (item.subject && item.subject.booruCharacter) || '',
    ]),
  ].join(' ')
  // Deliberately NOT \b-anchored. Word boundaries are what would miss "shelf",
  // and missing "shelf" is the entire reason this exists.
  const elfLurking = /elf/i.test(elfHaystack)
  const ELF_RE = /\b(?:elf|elves|elven|dark elf|high elf|half-elf|pointy ears|pointed ears|elf ears)\b/i
  const elfRendered = descriptors.some((item) =>
    [...(item.appearance || []), item.noun || '', item.anchor || '',
      (item.subject && item.subject.booruCharacter) || ''].some((value) => ELF_RE.test(String(value || ''))))
  const fantasySetting = !!(profiles && profiles.fantasySetting)
  if (fantasySetting) {
    trace('elf defence', 'skipped', 'this cast is marked as a fantasy setting, where elves are not an error')
  } else if (elfLurking && !elfRendered) {
    LAST_COMPILE_NEGATIVES = uniqueStrings([...LAST_COMPILE_NEGATIVES, 'elf', 'pointy ears'])
    trace('elf defence', 'applied', 'the letters "elf" appear inside a word being sent, so pointed ears are negated')
  } else if (elfRendered) {
    trace('elf defence', 'skipped', 'a subject in this scene is an elf')
  } else {
    trace('elf defence', 'skipped', 'nothing being sent contains the letters "elf" — nothing to counteract')
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
      // Was 2. The FIRST relation is the body arrangement by design — "straddles
      // the lap of", "stands between the knees of" — so a budget of two left
      // exactly one slot for everything the bodies were actually DOING. The
      // carry got amputated. Three keeps the arrangement and still bounds it.
      if (renderedRelations >= 3) break
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
  LAST_DIAGNOSTIC = redactedDiagnostic(scene, descriptors, { cameraSent: cameraTags })
  if (repaired.note) spindle.log.info('[lumidraw] camera repair · ' + repaired.note)
  trace('camera repair', repaired.note ? 'applied' : 'clean', repaired.note || 'framing and view angles already consistent')
  const groundingText = [sourcePassage, contextText].filter(Boolean).join('\n')
  const settingCheck = reconcileSetting(scene.setting, groundingText, rememberedSetting)
  // Anima's indoor/outdoor prior is strong and `outdoors` is one of the most
  // populated tags on Danbooru. A setting that names a street and never says
  // "outdoors" leaves that prior free to put walls around it.
  if (settingCheck.setting.some((tag) => OUTDOORS_CUE_RE.test(tag)) &&
      !settingCheck.setting.includes('outdoors')) {
    settingCheck.setting.unshift('outdoors')
    trace('outdoors', 'applied', 'setting names an outdoor place but never says so')
  }
  if (settingCheck.note) spindle.log.warn('[lumidraw] setting continuity · ' + settingCheck.note)
  trace('setting continuity', settingCheck.note ? 'applied' : 'clean', settingCheck.note || `kept: ${settingCheck.setting.join(', ') || '(none)'}`)

  // The Place was matched at the top of the compile — it feeds the negatives as
  // well as the setting, and those are assembled earlier. Its tags are canon
  // rather than inference, so they lead, and they are NOT run past
  // settingTagSupported: that check exists to stop the parser inventing a
  // kitchen, and has no business second-guessing a location the user wrote down.
  if (matchedPlace) {
    const placed = applyPlaceSetting(settingCheck.setting, matchedPlace)
    settingCheck.setting = placed.setting
    LAST_COMPILE_PLACE = matchedPlace.name
    trace(`place · ${matchedPlace.name}`, placed.added.length ? 'applied' : 'clean',
      placed.added.length
        ? `${placeReport.reason}, so its saved look leads: ${placed.added.join(', ')}`
        : `${placeReport.reason}; the scene already described it`)
  }

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

  // Suppressing the core action whenever ANY cross-subject relation rendered was
  // too blunt: a relation about where they stand does not describe what they are
  // doing, so the act was being dropped because an unrelated sentence existed.
  // Only a relation whose verb actually matches the core action covers it.
  const coreActionCovered = multi && (scene.relations || []).some((relation) =>
    relation.action && scene.coreAction && verbStemsMatch(relation.action, scene.coreAction))

  // Multi-subject geometry the caption states in prose but the tag run never
  // named. Anima knows these arrangements as tags and has a strong prior for the
  // conventional one, so the tag is worth far more than the sentence.
  const geometryText = [
    scene.sceneStatement || '', scene.coreAction || '',
    ...(scene.relations || []).map((r) => `${r.action || ''} ${(r.details || []).join(' ')}`),
  ].join(' ')
  const geometryTags = multi
    ? GEOMETRY_TAG_RULES.filter(([re]) => re.test(geometryText)).map(([, tag]) => tag)
    : []
  if (geometryTags.length) trace('geometry tags', 'applied', geometryTags.join(', '))

  // The core action was never checked against the vocabulary — it simply went
  // into the run. That was invisible while multi-subject scenes suppressed it
  // entirely; letting it through correctly exposed it, and a core action like
  // "crouches low, claws extended, facing the alpha wolf" is three phrases, none
  // of them a tag. It gets the same treatment as everything else: what resolves
  // is kept, what does not goes to the caption — or stays only when there is no
  // caption to go to.
  const coreActionSplit = scene.coreAction && !coreActionCovered
    ? partitionBooruTags(animaTagList([scene.coreAction]))
    : { kept: [], demoted: [] }
  const coreActionTags = [...coreActionSplit.kept, ...(tagOnly ? coreActionSplit.demoted : [])]
  if (coreActionSplit.demoted.length) {
    trace('core action', 'applied',
      `${coreActionSplit.kept.join(', ') || 'nothing'} kept as tags; ` +
      `not real tags: ${coreActionSplit.demoted.join(', ')}`)
  }

  const generalTags = animaTagList([
    ...facing.tags,
    ...geometryTags,
    ...(multi ? [] : safeRelationDetails),
    ...coreActionTags,
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
    const looks = (profile.looks || []).map((look) => {
      const cues = (look.aliases || []).join(', ')
      return `${look.name}${cues ? ` (cues: ${cues})` : ''}`
    }).join('; ')
    const features = (profile.partialFeatures || []).map((feature) => feature.name).join('; ')
    hints.push(`- ref "${ref}" means ${label || ref}. Do not output permanent appearance for this ref.${features ? ` Partial features available (use partial_features, NOT a state change, when only some of these are showing): ${features}.` : ''}${states ? ` Appearance states: ${states}. Use appearance_state with the exact state name only when the CURRENT PASSAGE shows that transformation happening or already in effect; otherwise omit it and LumiDraw uses the default “${profile.defaultAppearanceState || (profile.appearanceStates[0] && profile.appearanceStates[0].name) || ''}”. Never mix states. A passage that merely calls this character by their species, mentions a past or future transformation, or uses a figure of speech is NOT a transformation — keep the default state. When a state is not active, never describe this character with that form's vocabulary anywhere in the JSON, including scene_statement.` : ''}${looks ? ` Named looks (CLOTHING only, never the body): ${looks}. Set "look" to the exact saved name when the passage puts this character in one — by naming it, or by one of its cues. Omit it otherwise; LumiDraw keeps what they were last seen wearing. A look sets the clothes once, when it changes; it does not re-dress them every image.` : ''}${aliases ? ` Named visual aliases: ${aliases}. Use the exact prop name when it is present.` : ''}`)
  }
  return hints.join('\n')
}

function structuredParserSchema(maxImages, profiles, minImages = 0) {
  const knownRefList = allKnownProfiles(profiles).map((profile) => profile.ref).join('|')
  return `

STRICT OUTPUT CONTRACT — this overrides any conflicting formatting request above.
Return ONLY one compact JSON object — no markdown, no prose.
Write every scene in the EXACT field order shown below. The order is a survival order: if your reply is ever cut off, everything already written must still form a usable scene, so the mandatory core (safety, core_action, setting, subjects) comes FIRST and droppable refinements (camera, lighting, style) come LAST:
{"images":[{"anchor":"5-12 exact consecutive words from CURRENT PASSAGE only","scene":{"safety":"safe|sensitive|nsfw|explicit","scene_statement":"one plain sentence: the subjects and the central visible action","core_action":"one short visible action or pose","setting":["essential location/context tags"],"subjects":[{"ref":"${knownRefList}|other_1","label":"other refs only — the name exactly as written, capitals kept","appearance_state":"exact saved state name, or empty","look":"exact saved look name, or empty","partial_features":["saved feature names showing now, or omit"],"count_tag":"1girl|1boy|1other etc","booru_character":"published character tag or empty","booru_series":"source work or empty","position":"left|right|center|foreground|background","appearance":["other subjects only"],"outfit":["short visual tags"],"pose":["short visual phrases"],"support":"visible support surface or empty","expression":["short tags"],"action":["short tag-like actions, not involving another subject"],"anatomy_visible":false}],"relations":[{"actor":"subject ref","action":"short visible spatial phrase ending before target","target":"subject ref","details":["at most two visual modifiers"]}],"camera":["from the CAMERA list below only"],"lighting":["essential light tags"],"style":["essential style/mood tags"],"aspect":"3:4|4:3|1:1|9:16|16:9"}}]}
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
Keep each image object compact: at most 4 setting, 3 camera, 3 lighting, 3 style, 6 outfit, 2 pose, 2 expression, 2 relation details, and 1 action item, each a terse visual tag of at most 7 words. These are choices, not truncation points — pick the strongest few rather than listing everything true. Omit optional keys when their value would be empty or redundant; do not output an empty appearance_state. Never write a descriptive paragraph. Never include permanent appearance for ANY known ref listed below (character, persona, or a named cast member); LumiDraw inserts their locked profiles. Use each cast member's exact listed ref when they appear; reserve other_1/other_2 for subjects with no saved profile. For a known ref with saved appearance states, set appearance_state only when the current passage or reference context clearly establishes one exact saved state. Omit it when uncertain. Never combine traits from multiple states.
PARTIAL CHANGES ARE NOT STATE CHANGES. When a passage shows only SOME of a character's transformation — a single feature slipping, eyes changing, claws extending, "partly", "slightly", "a little", "just his eyes", "beginning to" — keep appearance_state at the form they are otherwise in and list the specific features in "partial_features" using the exact saved feature names listed below. Switching appearance_state transforms the WHOLE character, which is wrong for a partial change and produces a completely different creature than the passage describes. Use partial_features for anything short of a full, completed transformation. Select only names that are listed for that ref; never invent a feature name, and never put transformation words in appearance, outfit, pose, or expression.
RELATIONS ARE THE ONLY CHANNEL FOR CONTACT — anything two subjects do to each other that is not written as a relation will not be drawn, so they are mandatory in a multi-subject scene. The FIRST relation establishes the base body arrangement: "straddles the lap of", "stands between the knees of", "leans over", "faces", "sits beside". Later ones name the clearest contact points, always as a visible hold plus the body part it takes: "pins the shoulders of", "grips the snout of", "bites the neck of", "braces both hands on the shoulders of". Verbs of motion or intensity — "fights", "attacks", "struggles with", "pounds", "thrusts", "presses into" — describe nothing an artist could draw; use the hold instead. Put the specifics in details: "claws hooked into the nose", "knuckles white".
For seated, leaning, lying, or kneeling poses, name the visible support surface in "support". Use the camera tag "pov" only when ref "persona" is seen from the viewer's own eye position, and in that subject's pose include a cue such as "viewer hands visible" or "face out of frame".
Set anatomy_visible true only when the passage explicitly names and visibly depicts that subject's saved anatomy; sexual context, lowered clothing, arousal, nudity, or post-sex context alone are not enough. Set anatomy_visible false for safe or sensitive scenes. LumiDraw alone controls saved anatomy.
${DYNAMIC_GUIDANCE_MARKER}
Known subject refs:
${profileSchemaHints(profiles)}`
}

// ---------------------------------------------------------------------------
// The dynamic guidance slot
// ---------------------------------------------------------------------------
//
// Borrowed from kittyafterdark/LumiSwarm-Studio, which marks one place in its
// protocol with {{swarm_dynamic_guidance}} and inserts live instructions there.
//
// LumiDraw needed the same thing for a concrete reason. The static rules are
// measured against a 10,100-character ceiling and currently sit at ~10,000. Any
// new per-scene instruction — a named Look, an activated location's visual
// canon — has nowhere to go: appending it to the rules breaks the budget, and
// that budget is not arbitrary. It is what stops the instruction growing one
// clause at a time until a small parser model stops following any of it.
//
// So live guidance is INSERTED at a marked point rather than appended, and the
// ceiling keeps measuring what it was meant to measure: the rules I write, not
// the scene the user happens to be in.
//
// Removing the marker from a custom instruction is supported and opts out of
// every dynamic block — the same contract Swarm Studio documents.
const DYNAMIC_GUIDANCE_MARKER = '{{dynamic_guidance}}'

// The contributors. Deliberately empty in 0.62.0: this release ships the seam
// and proves it, so the diff that adds named Looks is a change to THIS list and
// nothing else. A feature that has to edit the instruction assembly to add one
// sentence is a feature that will eventually edit it badly.
function dynamicGuidanceBlocks(context = {}) {
  return [
    undressGuidance(context.wardrobe),
    looksGuidance(context.profiles),
    placesGuidance(context.places),
    retryGuidance(context.retry),
  ]
}

// Says nothing when no places are saved. The parser does not need to be told
// about a feature this story does not use.
// Re-parse used to send byte-for-byte the same instruction and the same passage
// to the same model, and then act surprised when the same JSON came back. The
// button said "try again"; the request said "do it again".
//
// The parser has no memory between calls, so the only way to ask for something
// DIFFERENT is to show it what it already produced and say that was rejected.
// This is the one piece of information it was missing.
//
// Escalating: the first retry asks for a different reading of the same moment,
// the second asks for a different MOMENT. Pressing the button repeatedly should
// widen the search rather than reroll the same dice.
function retryGuidance(retry) {
  if (!retry || !retry.previousPrompt) return ''
  const attempt = Math.max(1, Number(retry.attempt) || 1)
  const lines = [
    'THIS IS A RETRY. Your previous reading of this passage was REJECTED by the user.',
    'Previous attempt:',
    `"""${String(retry.previousPrompt).slice(0, 700)}"""`,
  ]
  if (attempt >= 2) {
    lines.push('This is retry ' + attempt + '. Earlier retries were also rejected, so a small variation is not enough:',
      'choose a DIFFERENT MOMENT of the passage — a different beat, a different subject in focus, or a different point in the action.')
  } else {
    lines.push('Read the same moment again and produce a DIFFERENT scene: reconsider the body arrangement, who is where, ' +
      'the contact points, and the framing. Do not restate the previous attempt with reworded tags.')
  }
  lines.push('Pay particular attention to the RELATIONS: an unusual arrangement is the most likely thing to have been read wrong.')
  return lines.join('\n')
}

function placesGuidance(places) {
  const list = Array.isArray(places) ? places : []
  if (!list.length) return ''
  const lines = list.slice(0, 20).map((place) => {
    const cues = (place.aliases || []).join(', ')
    return `- ${place.name}${cues ? ` (also called: ${cues})` : ''}`
  })
  return ['SAVED PLACES — these locations have a known appearance.',
    'When the passage happens in one, put its name or its usual words in "setting" and stop there.',
    'Do not describe it yourself: LumiDraw already knows what it looks like and will fill in the details.',
    ...lines].join('\n')
}

// Only says anything when somebody in the cast HAS looks. A rule about a feature
// nobody uses is instruction budget spent on nothing, and the budget is the
// reason this slot exists.
// "Silence means unchanged" is the rule that lets the wardrobe work at all, and
// it has one blind spot: clothing coming OFF is also a change, and it is narrated
// as an action. The parser has a field for actions, so that is where it goes, and
// outfit stays empty — which reads as "no change" and she is dressed again.
//
// Only emitted when there IS a wardrobe to contradict. With nothing remembered
// there is nothing to wrongly restore, and the budget is better spent elsewhere.
function undressGuidance(wardrobe) {
  const hasRecord = wardrobe && Object.values(wardrobe).some((list) => (list || []).length)
  if (!hasRecord) return ''
  return [
    'CLOTHING COMING OFF IS A CHANGE. Silence means unchanged, so an outfit you leave empty means she is still dressed.',
    'If the passage takes clothing off — fully or partly — you MUST report the outfit: "nude", "topless", "bottomless", or the garments that REMAIN.',
    'Putting the removal in pose or action instead will put her clothes back on.',
  ].join('\n')
}

function looksGuidance(profiles) {
  const withLooks = allKnownProfiles(profiles || {}).filter((profile) => (profile.looks || []).length)
  if (!withLooks.length) return ''
  const lines = withLooks.map((profile) => {
    const names = (profile.looks || []).map((look) => {
      const cues = (look.aliases || []).join(', ')
      return `"${look.name}"${cues ? ` — say this one when the passage mentions ${cues}` : ''}`
    }).join('; ')
    return `- ${profile.anchor}: ${names}.`
  })
  return ['NAMED LOOKS — set "look" ONLY when the CURRENT PASSAGE puts a character into one.',
    'A look is a set of clothes, not a body. Never use it for a transformation, a mood, or a place.',
    'Omit it when nothing in the passage changes what they are wearing; the previous outfit is kept for you.',
    ...lines].join('\n')
}

// Each contributor returns a block or an empty string. A block with nothing to
// say contributes nothing, rather than a header with an empty list under it.
function composeDynamicGuidance(blocks) {
  const kept = (blocks || [])
    .map((block) => String(block || '').trim())
    .filter(Boolean)
  return kept.length ? kept.join('\n') : ''
}

// Insert at the marker. When a custom instruction has removed it, honour the
// removal by default: silently appending what someone deliberately deleted is
// worse than losing the guidance.
function applyDynamicGuidance(instruction, guidance, { appendIfMissing = false } = {}) {
  const text = String(instruction || '')
  const block = String(guidance || '').trim()
  if (!text.includes(DYNAMIC_GUIDANCE_MARKER)) {
    return block && appendIfMissing ? `${text}\n${block}` : text
  }
  return text.replaceAll(DYNAMIC_GUIDANCE_MARKER, block)
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

async function compileSceneWithPreset(sceneInput, preset, settings, userId, chatId, sourcePassage = '', contextText = '', digestLines = []) {
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
  // An artist tag Anima does not know is dropped by the model in silence. Say so
  // — the whole point is that this failure has no symptom you could otherwise
  // notice, only a blander image than you expected.
  await warnOnUnknownArtists(artists)
  const savedPlaces = await getPlaces()
  const core = compileStructuredScene(scene, profiles, sourcePassage, {
    artistTags: artists,
    rememberedSetting: remembered,
    contextText,
    rememberedOutfits: memoryEntry.outfits || null,
    rememberedLooks: memoryEntry.looks || null,
    places: savedPlaces,
    breakInPreset: preset.useBreakSeparators === true ||
      (preset.useBreakSeparators === undefined && /\bBREAK\b/.test(String(preset.qualityTags || ''))),
  })
  // Remember whatever survived reconciliation as the story's location.
  // The digest counts as grounding. Its lines come from messages BEFORE the
  // context window, so without this a digest-derived outfit — the cold-start
  // answer, the thing the digest exists to produce — was always "rendered but NOT
  // remembered": the wardrobe stayed empty, the digest fired again next scan, and
  // cold start never self-healed.
  const groundingForMemory = [sourcePassage, contextText, ...(digestLines || [])].filter(Boolean).join('\n')
  const establishedSetting = reconcileSetting(scene.setting, groundingForMemory, remembered).setting
  const establishedLighting = scrubUnsupportedPlaces(animaTagList(scene.lighting), groundingForMemory, 'lighting').tags
  // Record the wardrobe as compiled — after the ownership check, so a rejected
  // garment is never learned as belonging to the wrong character.
  const establishedOutfits = outfitSnapshot()
  const groundedOutfits = {}
  for (const [ref, worn] of Object.entries(establishedOutfits)) {
    if (ANONYMOUS_REF_RE.test(ref)) {
      spindle.log.info(`[lumidraw] outfit memory · ${ref} — not remembered; an anonymous ref is a position, not a person`)
      continue
    }
    const profile = allKnownProfiles(profiles).find((item) => item && item.ref === ref) || null
    const known = (memoryEntry.outfits || {})[ref]
    const keep = worn.filter((tag) => garmentSupported(tag, groundingForMemory, known, profile))
    const dropped = worn.filter((tag) => !keep.includes(tag))
    if (dropped.length) {
      spindle.log.info(`[lumidraw] outfit memory · ${ref} — rendered but NOT remembered, nothing in the passage backs them: ${dropped.join(', ')}`)
    }
    if (keep.length) {
      groundedOutfits[ref] = keep
      const learned = keep.filter((tag) => !(known || []).includes(tag))
      if (learned.length) spindle.log.info(`[lumidraw] outfit memory · ${ref} — learned: ${learned.join(', ')}`)
    }
  }
  const wornLooks = lookSnapshot()
  const groundedOutfitMeta = Object.fromEntries(Object.keys(groundedOutfits).map((ref) => [ref, {
    source: 'story-parser',
    at: Date.now(),
  }]))
  await rememberSceneState(chatId, preset.name, {
    setting: establishedSetting,
    lighting: establishedLighting,
    outfits: Object.keys(groundedOutfits).length ? groundedOutfits : null,
    outfitMeta: Object.keys(groundedOutfitMeta).length ? groundedOutfitMeta : null,
    // Recorded without a grounding check, unlike outfits. An outfit is inferred
    // from prose and can be wrong; a Look was chosen — named by the parser, or
    // matched on an alias, or configured as the default — so there is nothing to
    // corroborate. What it needs is to be REMEMBERED, so the next scene can tell
    // "still in the gown" from "just put the gown on".
    looks: Object.keys(wornLooks).length ? wornLooks : null,
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
  return /"images"\s*:|"scene"\s*:|"updates"\s*:/.test(text) ? text : ''
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
  const configuredTemperatureRaw = Number(settings.parserTemperature)
  const configuredTemperature = Number.isFinite(configuredTemperatureRaw)
    ? Math.max(0, Math.min(2, configuredTemperatureRaw))
    : 0.2
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
      temperature: configuredTemperature,
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
    ' · reasoning=' + JSON.stringify(opts.reasoning) +
    ' · temperature=' + opts.parameters.temperature + ' · max_tokens=' + opts.parameters.max_tokens)

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

// ---------------------------------------------------------------------------
// The scan queue
// ---------------------------------------------------------------------------
//
// There is one lane: one parser call and one Draw Things generation at a time.
// What changed in 0.58.0 is what happens to everything else.
//
// Before, a waiting message polled `while (activeStoryScan)` every 750ms and
// gave up after PARSER_TIMEOUT_MS + 90s — five and a half minutes — by throwing
// "Automatic scan waited too long". At roughly a minute per image plus the
// parser, two messages arriving behind one slow scan meant the second was
// silently never illustrated. Slow generation was not only costing time, it was
// costing pictures.
//
// The polling had a second and worse problem: no order. Several waiters all
// woke on the same tick and whichever happened to test the condition first won.
// Scene memory — the wardrobe of record, the setting, the remembered outfits —
// is written by each scan in sequence, so illustrating message 12 before
// message 11 teaches it the wrong state and the record then defends it. Some of
// the outfit drift chased through 0.53–0.56 could have entered exactly here.
//
// So: a real queue. First in, first out, no stopwatch. A message waits as long
// as the line in front of it takes, and the per-scan watchdog remains the thing
// that bounds a scan that has genuinely hung.

const SCAN_QUEUE_LIMIT = 12
const scanWaiters = []
let scanLaneHeld = false

function scanQueueDepth() {
  return scanWaiters.length + (scanLaneHeld || activeStoryScan ? 1 : 0)
}

function describeQueuePlace(index) {
  if (index <= 0) return 'next in line'
  if (index === 1) return 'second in line'
  if (index === 2) return 'third in line'
  return `${index + 1}th in line`
}

// Everyone still waiting is told where they now are, so a long wait reads as a
// queue moving rather than as the extension having stopped.
function broadcastQueuePositions() {
  scanWaiters.forEach((waiter, index) => {
    setAutoStatus(waiter.userId, {
      mode: 'parser', status: 'waiting',
      messageId: waiter.job.messageId, chatId: waiter.job.chatId, source: waiter.source,
      note: `Waiting to be illustrated — ${describeQueuePlace(index)}.`,
      queuePosition: index + 1,
      queueDepth: scanQueueDepth(),
    })
  })
}

function pumpScanQueue() {
  if (scanLaneHeld || activeStoryScan) return
  const next = scanWaiters.shift()
  if (!next) return
  scanLaneHeld = true
  next.resolve()
  broadcastQueuePositions()
}

// The cap exists so a runaway event storm cannot grow the queue without bound.
// The OLDEST waiter is dropped rather than the newest: if the queue is genuinely
// backed up, the recent messages are the ones still on screen and worth
// illustrating, and the dropped one is named rather than vanishing.
function acquireScanLane(job, userId, source) {
  return new Promise((resolve, reject) => {
    scanWaiters.push({ job, userId, source, resolve, reject, enqueuedAt: Date.now() })
    while (scanWaiters.length > SCAN_QUEUE_LIMIT) {
      const dropped = scanWaiters.shift()
      spindle.log.warn('[lumidraw] scan queue is full (' + SCAN_QUEUE_LIMIT + ') · dropping the oldest waiting message' +
        (dropped.job.messageId ? ' · message=' + dropped.job.messageId : ''))
      dropped.reject(new Error('The illustration queue is full (' + SCAN_QUEUE_LIMIT +
        ' waiting). This message was dropped to keep up with newer ones; press Scan to illustrate it.'))
    }
    const position = scanWaiters.length - 1
    if (position > 0 || scanLaneHeld || activeStoryScan) {
      spindle.log.info('[lumidraw] queued for the scan lane · ' + describeQueuePlace(position) +
        ' · depth=' + scanQueueDepth() + (job.messageId ? ' · message=' + job.messageId : ''))
    }
    pumpScanQueue()
    broadcastQueuePositions()
  })
}

function releaseScanLane() {
  scanLaneHeld = false
  pumpScanQueue()
  broadcastQueuePositions()
}
const recentAutoScans = new Map()

// CHARACTER_MESSAGE_RENDERED fires for every message the host renders,
// including the existing history it paints while a chat is loading. Without a
// grace window, opening the app queued an automatic scan for the last old
// message — a visible "Preparing story message" timer (and potentially a
// generation) that nobody requested. GENERATION_ENDED is the real completion
// signal and is not gated.
const BACKEND_STARTED_AT = Date.now()
const RENDERED_EVENT_GRACE_MS = 12000

// WHEN THE ECHO STORM ACTUALLY ARRIVES.
//
// "Opening the browser page it's generating images. I didn't send any new
//  messages, and I didn't press anything."
//
// The automatic trigger is a BROWSER event: the frontend listens for
// CHARACTER_MESSAGE_RENDERED and forwards it. Open the page after a while and
// the chat renders its whole backlog at once, so every un-illustrated message
// fires the trigger together — a stampede nobody asked for, on his GPU.
//
// A guard for exactly this already existed and could not fire: it measured from
// BACKEND start, and Spindle had been up for hours. The storm does not come from
// the backend booting. It comes from a FRONTEND connecting, which can happen at
// any moment of the backend's life — every reload, every reopened tab, every
// laptop waking up.
//
// The frontend already announces itself on load with `frontend_status`. That is
// the signal, and it was being logged and thrown away.
let lastFrontendConnectAt = 0
function isStartupRenderedEcho(source) {
  if (!/rendered/i.test(String(source || ''))) return false
  // Whichever came last. A backend restart and a page load both produce the same
  // burst, and only the most recent one bounds the window.
  const since = Date.now() - Math.max(BACKEND_STARTED_AT, lastFrontendConnectAt)
  return since < RENDERED_EVENT_GRACE_MS
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
    spindle.log.info('[lumidraw] ignored render echo from a page load · source=' + source +
      (messageId ? ' · message=' + messageId : '') +
      ' — opening or reloading Lumiverse re-renders the backlog, which is not a reason to illustrate it')
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
      if ((settings.mode !== 'parser' && settings.mode !== 'direct') || settings.autoScan === false) {
        const result = { mode: settings.mode, processed: 0, skipped: true, note: 'Parser auto-scan is disabled.' }
        setAutoStatus(userId, { mode: settings.mode, status: 'idle', messageId, chatId, source, note: result.note })
        return result
      }

      // An event replay for an already-illustrated message (startup echoes,
      // re-renders, chat switches) is settled here from local storage, before
      // any scan widget, chat fetch, or message lookup is started.
      //
      // Compared against the event's copy of the content, which may differ from
      // the stored message. That is fine: a false "not illustrated" here costs
      // one message fetch, and the authoritative check inside the scan — the one
      // holding the real text — still stops it. A false "illustrated" is the
      // expensive direction, and that is the one this cannot produce.
      if (job.messageId && await wasProcessed(job.messageId, job.expectedContent || undefined)) {
        const result = { mode: 'parser', processed: 0, skipped: true, note: 'This message was already illustrated.' }
        recentAutoScans.set(key, Date.now())
        // Logged, because this used to be the one path that returned in silence:
        // the log showed the parser protocol injected, the trigger queued, and
        // then nothing at all, which reads like a crash rather than a skip.
        spindle.log.info('[lumidraw] auto scan skipped · this message was already illustrated · message=' + job.messageId)
        setAutoStatus(userId, { mode: 'parser', status: 'idle', messageId: job.messageId, chatId: job.chatId, source, note: result.note })
        return result
      }

      // Do not lose an automatic message just because another manual/automatic
      // scan owns the single Draw Things/parser lane. Take a place in line.
      if (job.messageId && activeStoryScan && activeStoryScan.messageId === job.messageId) {
        const result = { mode: 'parser', processed: 0, skipped: true, note: 'This message is already being scanned.' }
        recentAutoScans.set(key, Date.now())
        setAutoStatus(userId, {
          mode: 'parser', status: 'joined', messageId: job.messageId, chatId: job.chatId, source,
          note: result.note,
        })
        return result
      }
      await acquireScanLane(job, userId, source)

      let result
      try {
        // The wait may have been long. A manual Scan press, or the scan that
        // was holding the lane, may have illustrated this message in the
        // meantime — so ask again rather than illustrating it twice.
        if (job.messageId && await wasProcessed(job.messageId, job.expectedContent || undefined)) {
          const already = { mode: 'parser', processed: 0, skipped: true, note: 'This message was illustrated while it waited in the queue.' }
          recentAutoScans.set(key, Date.now())
          spindle.log.info('[lumidraw] auto scan skipped · illustrated while it waited in the queue · message=' + job.messageId)
          setAutoStatus(userId, { mode: 'parser', status: 'idle', messageId: job.messageId, chatId: job.chatId, source, note: already.note })
          return already
        }
        const effectiveSource = uniqueStrings(job.sources || [job.source]).join('+') || source
        result = await scanStory(userId, {
          force: false,
          auto: true,
          _fromQueue: true,
          source: effectiveSource,
          messageId: job.messageId,
          chatId: job.chatId,
          expectedContent: job.expectedContent,
        })
      } finally {
        releaseScanLane()
      }

      const effectiveSource = uniqueStrings(job.sources || [job.source]).join('+') || source
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
  // The lane token is held from the moment the queue picks a waiter until that
  // scan finishes — a window that opens before `activeStoryScan` is set. Without
  // this check a manual Scan pressed inside that window would take the lane out
  // from under the queued message, which would then be turned away as "busy":
  // exactly the silent loss the queue exists to stop.
  if (scanLaneHeld && !(options && options._fromQueue)) {
    return {
      mode: 'busy',
      processed: 0,
      skipped: true,
      note: 'An illustration from the queue is just starting. Press Scan again in a moment.',
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
  if (settings.mode === 'off') return { mode: 'off', note: 'Story illustrations is set to Off — choose Inline or Parser in the Story tab.' }
  const presets = await getPresets()
  const savedPreset = presets.find((p) => p.name === settings.activePreset)
  const preset = storyPresetFor(savedPreset, settings)
  if (!preset) {
    return { mode: settings.mode, note: 'No generation preset selected — choose one in Story → Setup.' }
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

  // The story may have introduced someone. Read that before compiling, so the new
  // profile is locked for this very image rather than the next one.
  try {
    const absorbed = await absorbCastDeclarations(messages, targetIndex, preset, String(chatId || ''))
    if (absorbed.added.length) {
      spindle.log.info('[lumidraw] the story declared new cast: ' + absorbed.added.join(', ') +
        ' — saved to the Characters tab and linked to "' + preset.name + '"')
    }
  } catch (error) {
    spindle.log.warn('[lumidraw] could not absorb declared cast: ' + error.message)
  }

  // ------------------------- out-of-character messages ---------------------
  // Checked before either engine runs, so an aside costs no parser call and no
  // Draw Things time, and the extension no longer has to be switched off by hand.
  const targetText = stripParserUtilityCards(stripParserTrigger(stripThinking(target.content)))
  let oocVerdict = outOfCharacterVerdict(targetText)
  // A turn that is nothing but a card — a roll, a status readout, the preset's
  // helpdesk voice answering you — has no scene in it at any rating. Checked
  // structurally rather than by name, because Gabrielle, Stella and whoever comes
  // next all arrive the same way: a block between two HTML comments.
  if (!oocVerdict.ooc && String(target.content || '').trim() && !stripMarkupForClassification(targetText).replace(/[^\p{L}\p{N}]/gu, '').length) {
    oocVerdict = { ooc: true, reason: 'the whole message is a card — a roll, a readout or the preset\'s own voice — with no scene in it' }
  }
  // A reply to an out-of-character message is not illustrated automatically. Full
  // stop — no judgement about what the reply contains.
  //
  // The reply carries no marker of its own, so something has to decide, and I tried
  // deciding by reading it. That guessed wrong twice: a patch note full of CSS read
  // as dialogue because `style="max-width:560px…"` is a quoted string. Every fix
  // made the rule longer and the next surprise no less likely.
  //
  // The asymmetry settles it. Guessing wrong towards an image puts a picture of
  // nothing in the chat and costs a generation; guessing wrong towards no image
  // costs one press of Scan. So the automatic path takes the safe side and the
  // decision goes to you, who can see the message.
  //
  // Only automatic scans are blocked. Pressing Scan is you overriding this on
  // purpose, and it must always work.
  if (!oocVerdict.ooc && options.auto && Number.isInteger(targetIndex) && targetIndex > 0) {
    const prompting = precedingUserMessage(messages, targetIndex)
    // Silent-when-it-fails was the previous version's real bug: "the gate never
    // looked" and "the gate looked and allowed it" produced identical logs.
    if (!prompting) {
      const roles = messages.slice(Math.max(0, targetIndex - 4), targetIndex)
        .map((m) => messageBits(m).role || '(no role)')
      spindle.log.info('[lumidraw] out-of-character check · no preceding user message found · ' +
        `roles seen: ${roles.join(', ') || '(none)'} · if one of those IS your message, its role name is not ` +
        'one this check recognises (user, persona, human) — tell me the name and I will add it')
    } else {
      // The RAW message. cleanParserMessageText removes out-of-character markers by
      // design, so asking it whether a marker is present is asking a question of
      // text chosen to have none. Short asides survived only because they stripped
      // to nothing and fell back to the raw content; a longer one kept enough words
      // to look like prose and sailed through.
      const promptingText = String(prompting.content || '')
      if (outOfCharacterVerdict(promptingText).ooc) {
        oocVerdict = {
          ooc: true,
          reason: 'you were talking out of character, so this reply was not illustrated automatically — press Scan if it turned out to have a scene in it',
        }
      } else {
        spindle.log.info('[lumidraw] out-of-character check · the preceding message is in character · ' +
          `opens with: ${JSON.stringify(String(promptingText).slice(0, 60))}`)
      }
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
            debug: { trace: compiled.trace, scene: compiled.scene },
            negativePrompt: preset.negativePrompt,
            config: preset.config,
            extra: preset.extra,
            dims,
            origin: { messageId: String(target.id || ''), chatId: String(chatId || ''), contentKey: target.contentKey || '', presetName: preset.name || '', mode: 'inline', alt: inlineAlt },
          }, userId)
        }
        await placeGeneratedStoryImage(userId, {
          chatId,
          messageId: String(target.id || ''),
          entry,
          alt: inlineAlt,
          dims,
          anchor: body,
          source: 'inline',
        })
        // Remove only the private generation directive. The large image itself
        // is mounted by the frontend, so this small text edit cannot introduce
        // an image-sized virtualizer jump.
        content = content.replace(m[0], '')
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
  if (settings.mode === 'parser' || settings.mode === 'direct') {
    if (!force && target.id && await wasProcessed(target.id, target.content, { migrate: true })) {
      return { mode: 'parser', note: 'This message was already illustrated — choose it again to force another parser run.' }
    }
    const usingCustom = !!(settings.parserInstruction && settings.parserInstruction.trim())
    const passage = cleanParserMessageText(target.content).slice(-6000)

    if (settings.parserEngine === 'anima' || settings.mode === 'direct') {
      // Hand the parser the location outright rather than hoping it survives
      // inside the recency window.
      const anchorForParser = tagsFrom(preset.sceneAnchor || '', 8)
      const profilesForState = await getStoryProfiles(preset, settings, userId, chatId)
      // The story's own clothing declarations, applied BEFORE the record is read
      // — so both engines see the current outfit rather than last week's. Profiles
      // have to exist first, because a declaration is bound to a character by
      // name and an unmatched one is dropped rather than written to a stray ref.
      try {
        await absorbWearDeclarations(messages, targetIndex, profilesForState, chatId,
          await sceneScopeFor(chatId, preset.name))
      } catch (error) {
        spindle.log.warn('[lumidraw] could not absorb declared clothing: ' + error.message)
      }
      const rememberedState = await readSceneMemory(chatId, preset.name)
      const directMode = settings.mode === 'direct' || settings.directMode === true
      const profilesForPrompt = directMode
        ? gateDirectProfiles(profilesForState, directEvidenceFor(messages, targetIndex, settings))
        : profilesForState
      const wardrobeLines = wardrobeLinesFor(rememberedState, profilesForPrompt)
      // Somebody with no record is the only case the digest earns its tokens for —
      // and only somebody in THIS scene. Character and persona always count; a cast
      // member counts only when the passage names them, or a big cast would keep
      // the digest firing forever for someone offstage.
      const knownCast = allKnownProfiles(profilesForPrompt).filter((p) => p && p.ref)
      const inThisScene = (p) => p.ref === 'character' || p.ref === 'persona' ||
        (p.anchor && new RegExp('\\b' + escapeRegExp(String(p.anchor).split(/\s+/)[0]) + '\\b', 'i').test(passage))
      const presentCast = knownCast.filter(inThisScene)
      const anyUnknown = !presentCast.length || presentCast.some((p) => !((rememberedState.outfits || {})[p.ref] || []).length)
      const digest = anyUnknown ? clothingDigest(messages, targetIndex) : []
      if (digest.length) {
        spindle.log.info(`[lumidraw] clothing digest · ${digest.length} earlier mention(s) found in the last 30 messages, ` +
          'because the wardrobe has no record for someone in this scene')
      }
      const parserSceneState = {
        setting: (rememberedState.setting || []).length ? rememberedState.setting : anchorForParser,
        lighting: rememberedState.lighting || [],
        outfits: wardrobeLines,
        clothingDigest: digest,
      }
      const parserInput = buildAnimaParserInput(messages, targetIndex, target, settings, parserSceneState)
      if (parserSceneState.outfits.length) {
        spindle.log.info('[lumidraw] established wardrobe supplied to parser · ' +
          parserSceneState.outfits.map((e) => `${e.name}: ${e.tags.join(', ')}`).join(' · '))
      }
      if (parserSceneState.setting.length) {
        spindle.log.info('[lumidraw] established scene state supplied to parser · ' + parserSceneState.setting.join(', '))
      }
      const profiles = profilesForState
      const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
        .replaceAll('{{max_images}}', String(settings.maxImages || 2))
        .replaceAll('{{min_images}}', String(settings.minImages || 0))
      const resolvedGuidance = await resolveMacros(guidance, userId, chatId)
      // DIRECT MODE. The parser writes the finished prompt instead of a scene
      // graph, and none of the compiler below runs. Off by default; your existing
      // pipeline is untouched until you turn it on.
      const savedPlacesForParser = await getPlaces()
      const instruction = directMode
        ? buildDirectInstruction(profilesForPrompt, {
          maxImages: settings.maxImages || 2,
          maxSubjects: settings.maxSubjects || 2,
          wardrobe: (rememberedState && rememberedState.outfits) || null,
          clothingDigest: digest,
          places: savedPlacesForParser,
          banned: preset.bannedTags || '',
          fantasy: !!profiles.fantasySetting,
        })
        : applyDynamicGuidance(
          resolvedGuidance + structuredParserSchema(settings.maxImages || 2, profiles, settings.minImages || 0),
          composeDynamicGuidance(dynamicGuidanceBlocks({ profiles, settings, places: savedPlacesForParser, wardrobe: (rememberedState && rememberedState.outfits) || null })))
      const instrLabel = directMode
        ? `direct mode — the parser writes the prompt (${instruction.length} chars)`
        : (usingCustom ? `custom guidance + structured compiler (${instruction.length} chars)` : 'structured subject compiler')
      setStoryScanStage(scan, 'parsing', 'Waiting for the selected parser model.')
      spindle.log.info('[lumidraw] Anima parser context · previous_messages=' + parserInput.contextMessageCount + ' · loom_ledger=' + (parserInput.ledgerFound ? 'found' : 'none'))
      const out = await quietLLM(instruction, parserInput.input, settings, userId, true, scan)
      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'compiling', 'Parser returned structured JSON; compiling the Anima prompt.')
      if (directMode) {
        const direct = parseDirectImages(out, settings.maxImages || 2, profiles, passage, settings.maxSubjects || 2)
        if (!direct.images.length) {
          // A refusal is a decision, not a fault. Reported as itself, at info
          // rather than warn, and WITHOUT the "Direct mode:" prefix that made it
          // read as an internal failure.
          if (direct.refused) {
            spindle.log.info('[lumidraw] ' + direct.error)
            throw new Error(direct.error)
          }
          throw new Error(`Direct mode: ${direct.error || 'the parser returned no usable prompt'}`)
        }
        return await runDirectImages(direct.images, {
          target, preset, profiles, userId, chatId, scan, rawReply: out, parserInput,
          instruction, settings,
        })
      }
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
        if (target.id) await markProcessed(target.id, target.content)
        const storyDebug = await saveStoryDebug({ mode: 'parser', parserEngine: 'anima', subjectBinding: true, rawReply: out, entries: [], lastCompiledPrompt: '', contextPreview: parserInput.contextPreview, ledgerPreview: parserInput.ledgerPreview, contextMessageCount: parserInput.contextMessageCount, ledgerFound: parserInput.ledgerFound })
        return { mode: 'parser', messageId: String(target.id || ''), note: `Parser (${instrLabel}) judged no visual moment.`, storyDebug }
      }

      const mds = []
      const debugEntries = []
      // Ordered by where each anchor falls in the passage BEFORE anything is
      // numbered, so "image 1 of 3" means the first moment of the scene.
      const limitedParsed = orderScenesByPassage(
        parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2))), passage)
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
        const compiled = await compileSceneWithPreset(item.scene, preset, settings, userId, chatId, passage, parserInput.contextPreview || '', digest)
        const dims = aspectDims(preset.config, compiled.aspect)
        const parserAlt = markdownAltText(compiled.core)
        const entry = await generateAndUpload({
          prompt: compiled.prompt,
          debug: { trace: compiled.trace, scene: compiled.scene },
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
        mds.push(await placeGeneratedStoryImage(userId, {
          chatId,
          messageId: String(target.id || ''),
          entry,
          alt: parserAlt,
          dims,
          anchor: item.anchor,
          source: 'parser',
        }))
        debugEntries.push({
          anchor: item.anchor,
          scene: compiled.scene,
          compiledPrompt: compiled.prompt,
          compiler: compiled.compiler || 'anima-hybrid-v14',
        })
      }

      assertStoryScanActive(scan)
      setStoryScanStage(scan, 'inserting', 'Mounting generated images in the story message.')
      // The parser trigger is already hidden by the native interceptor. Do not
      // rewrite the message just to add images; native placement records above
      // are rendered through ctx.dom.inject on the frontend.
      if (target.id) await markProcessed(target.id, target.content)
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
    const legacyPersona = await effectivePersonaTags(preset, chatId)
    if (legacyPersona.tags) {
      instruction += '\n\nUser/persona visual tags — use ONLY when the User is visibly present in the chosen moment, and only the visible parts (respect POV): ' + legacyPersona.tags
    }
    const instrLabel = usingCustom ? `custom instruction (${instruction.length} chars)` : 'legacy tag instruction'
    setStoryScanStage(scan, 'parsing', 'Running the v0.13 instruction-only parser.')
    const out = await quietLLMLegacy(await resolveMacros(instruction, userId, chatId), passage, settings, userId, scan)
    assertStoryScanActive(scan)
    setStoryScanStage(scan, 'compiling', 'Parser returned tags; preparing the final prompt.')
    if (/^\s*NONE\s*$/i.test(out)) {
      if (hasParserTrigger(target.content)) { await updateMessageContent(target.id, target.contentKey, stripParserTrigger(target.content), userId, chatId) }
      if (target.id) await markProcessed(target.id, target.content)
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
      mds.push(await placeGeneratedStoryImage(userId, {
        chatId,
        messageId: String(target.id || ''),
        entry,
        alt: line,
        dims: entry.recipe && entry.recipe.config,
        anchor: parsed[legacyImageIndex - 1] ? parsed[legacyImageIndex - 1].anchor : '',
        source: 'legacy-parser',
      }))
    }
    assertStoryScanActive(scan)
    setStoryScanStage(scan, 'inserting', 'Mounting generated images in the story message.')
    // Native placement records were written during generation; avoid a
    // message-content rewrite so Lumiverse's virtualized row stays stable.

    if (target.id) await markProcessed(target.id, target.content)
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

// WHOSE CHAT IS THIS. "I don't want to keep Lumiverse open at home to get images
// at work."
//
// The backend registers its OWN GENERATION_ENDED trigger, which is the whole
// point of a server-side fallback — it should not need a browser at all. It has
// never once fired, because of this variable.
//
// It was set in exactly one place: inside onFrontendMessage. So the backend
// could not identify the user until a FRONTEND connected, which is precisely the
// dependency the fallback exists to remove. And after every extension restart it
// went back to null, so even a previously-working install lost it.
//
// Worse, the handler then `return`ed with no log at all. A trigger that gives up
// without a word cannot be diagnosed, and this one has been giving up silently
// since it was written.
//
// Remembered on disk now. One frontend connection, ever, and the backend can
// illustrate on its own from then on — across restarts, with nothing open.
const LAST_USER_FILE = 'last_user.json'
let lastUserId = null

async function rememberUserId(userId) {
  if (!userId || userId === lastUserId) return
  lastUserId = userId
  try { await spindle.storage.setJson(LAST_USER_FILE, { userId, at: Date.now() }, { indent: 2 }) }
  catch (error) { spindle.log.warn('[lumidraw] could not remember the user id: ' + error.message) }
}

async function recallUserId() {
  if (lastUserId) return lastUserId
  try {
    const saved = await spindle.storage.getJson(LAST_USER_FILE, { fallback: null })
    if (saved && saved.userId) {
      lastUserId = String(saved.userId)
      spindle.log.info('[lumidraw] remembered user id restored — automatic illustration can run without a browser open')
    }
  } catch { /* first run */ }
  return lastUserId
}


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
  if (['parser', 'direct'].includes(String(overrides.mode || ''))) {
    settings.mode = String(overrides.mode)
    settings.directMode = settings.mode === 'direct'
  }

  const presets = await getPresets()
  // The active preset wins here, unlike a plain regeneration. Re-running the parser
  // exists to apply the settings you have now — a new instruction, an edited
  // character, a different negative prompt. Inheriting the preset the image was
  // originally made under meant a new prompt compiled against an old preset's
  // negative prompt, banned tags and scene anchor, none of which you were using.
  const rawPreset = presets.find((item) => item.name === settings.activePreset)
    || presets.find((item) => item.name === origin.presetName)
  const preset = storyPresetFor(rawPreset, settings)
  if (!preset) throw new Error('No generation preset available to compile against.')
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
  const profiles = await getStoryProfiles(preset, settings, userId, chatId)
  const directMode = settings.mode === 'direct' || settings.directMode === true
  const profilesForPrompt = directMode
    ? gateDirectProfiles(profiles, directEvidenceFor(messages, targetIndex, settings))
    : profiles
  const reparseCast = allKnownProfiles(profilesForPrompt).filter((p) => p && p.ref)
  const inThisScene = (p) => p.ref === 'character' || p.ref === 'persona' ||
    (p.anchor && new RegExp('\\b' + escapeRegExp(String(p.anchor).split(/\s+/)[0]) + '\\b', 'i').test(passage))
  const presentCast = reparseCast.filter(inThisScene)
  const reparseUnknown = !presentCast.length || presentCast.some((p) => !((rememberedState.outfits || {})[p.ref] || []).length)
  const reparseDigest = reparseUnknown ? clothingDigest(messages, targetIndex) : []
  const parserInput = buildAnimaParserInput(messages, targetIndex, target, settings, {
    setting: (rememberedState.setting || []).length ? rememberedState.setting : anchorTags,
    lighting: rememberedState.lighting || [],
    outfits: wardrobeLinesFor(rememberedState, profilesForPrompt),
    clothingDigest: reparseDigest,
  })
  const guidance = (settings.parserInstruction || DEFAULT_PARSER_INSTRUCTION)
    .replaceAll('{{max_images}}', String(settings.maxImages || 2))
    .replaceAll('{{min_images}}', String(settings.minImages || 0))
  // What the rejected attempt actually produced. The history entry is the only
  // record of it, and without it a retry is just the same request again.
  const retry = source && source.prompt
    ? { previousPrompt: String(source.prompt), attempt: Math.max(1, Number(overrides.attempt) || 1) }
    : null
  const savedPlacesForParser = await getPlaces()
  const instruction = directMode
    ? buildDirectInstruction(profilesForPrompt, {
      maxImages: settings.maxImages || 2,
      maxSubjects: settings.maxSubjects || 2,
      wardrobe: (rememberedState && rememberedState.outfits) || null,
      clothingDigest: reparseDigest,
      places: savedPlacesForParser,
      banned: preset.bannedTags || '',
      fantasy: !!profiles.fantasySetting,
    }) + (retry
      ? `\n\nREPARSE ATTEMPT ${retry.attempt}. The prompt below was rejected by the user. Choose a meaningfully different drawable moment when the CURRENT PASSAGE supports one; never change the validated physical-presence rules.\nREJECTED PROMPT:\n${retry.previousPrompt}`
      : '')
    : applyDynamicGuidance(
      (await resolveMacros(guidance, userId, chatId)) +
        structuredParserSchema(settings.maxImages || 2, profiles, settings.minImages || 0),
      composeDynamicGuidance(dynamicGuidanceBlocks({ profiles, settings, places: savedPlacesForParser, retry, wardrobe: (rememberedState && rememberedState.outfits) || null })))
  if (retry) {
    spindle.log.info(`[lumidraw] ${directMode ? 'direct ' : ''}re-parse attempt ${retry.attempt} · the previous reading was sent back as rejected`)
  }

  const startedAt = Date.now()
  const report = {}
  let raw = await quietLLM(instruction, parserInput.input, settings, userId, true, null, report)
  const parserMs = Date.now() - startedAt

  let parsed = []
  let parseError = ''
  const results = []
  if (directMode) {
    const direct = parseDirectImages(raw, settings.maxImages || 2, profiles, passage, settings.maxSubjects || 2)
    if (!direct.images.length) {
      parseError = direct.error || 'Direct mode returned no usable prompt.'
    } else {
      const reconciled = await reconcileDirectPresence(direct.images, {
        preset, profiles, userId, chatId, scan: null, rawReply: raw, parserInput,
        instruction, settings,
      })
      raw = reconciled.rawReply
      const prefix = await resolveMacros(preset.promptPrefix, userId, chatId)
      await warnOnUnknownArtists(splitArtistTags(normalizeArtistTags(String(preset.qualityTags || ''))).artists)
      for (const item of orderScenesByPassage(reconciled.images, passage)) {
        const traceLines = []
        const trace = (label, status, detail) => traceLines.push({ label, status, detail })
        const finalized = finalizeDirectImagePrompt(item, { preset, profiles, prefix, trace })
        results.push({
          ok: true,
          anchor: item.anchor || '',
          sceneStatement: item.scene_summary || directSceneSentence(item.prompt),
          prompt: finalized.prompt,
          debug: { trace: traceLines, scene: { direct: true, anchor: item.anchor, sceneSummary: item.scene_summary || '', aspect: item.aspect, rating: item.rating, present: item.present || [] } },
          aspect: item.aspect || '',
          negativePrompt: finalized.negativePrompt,
          trace: traceLines,
        })
      }
    }
  } else {
    try {
      parsed = parseParserScenes(raw, settings.maxImages || 2, profiles)
    } catch (error) {
      parseError = error.message
    }
  }

  if (!directMode && !parseError) {
    for (const item of orderScenesByPassage(parsed.slice(0, Math.max(1, Math.min(4, Number(settings.maxImages) || 2))), passage)) {
      const assessment = assessStructuredScene(item.scene)
      if (!assessment.valid) {
        results.push({ ok: false, anchor: item.anchor || '', note: `Incomplete scene — ${assessment.summary}.` })
        continue
      }
      const compiled = await compileSceneWithPreset(
        item.scene, preset, settings, userId, chatId, passage, parserInput.contextPreview || '', reparseDigest)
      results.push({
        ok: true,
        anchor: item.anchor || '',
        sceneStatement: (compiled.scene && compiled.scene.sceneStatement) || '',
        prompt: compiled.prompt,
        debug: { trace: compiled.trace, scene: compiled.scene },
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
        const nativeReplacement = await replaceImagePlacement(userId, {
          placementId: String(payload.placementId || '').trim(),
          imageUrl: String(payload.chatImageUrl || imageUrl).trim(),
          imageId: sourceImage && sourceImage.id ? sourceImage.id : '',
          chatId: String(origin.chatId || '').trim(),
          messageId: String(origin.messageId || '').trim(),
        }, entry, prompt)
        if (nativeReplacement) {
          replaced = true
          note = 'Replaced the native LumiDraw image in place.'
          return { entry, newUrl, replaced, note }
        }
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
  if (userId) await rememberUserId(userId)
  const requestId = payload && payload.requestId
  let reply
  try {
    switch (payload && payload.type) {
      case 'init': {
        // Idempotent and non-destructive, so running it on every init is safe and
        // means nobody has to find a button. It creates casts from presets that
        // have people in them and modifies nothing.
        try { await migratePresetsToCasts() } catch (error) {
          spindle.log.warn('[lumidraw] cast migration skipped: ' + error.message)
        }
        try { await migratePresetPromptingToStorySettings() } catch (error) {
          spindle.log.warn('[lumidraw] story-prompt migration skipped: ' + error.message)
        }
        const [settings, presets, personas, characters, history, storyDebug, places, casts, chatCast] = await Promise.all([
          getSettings(), getPresets(), getPersonas(), getCharacters(), getHistory(), getStoryDebug(), getPlaces(),
          getCasts(), getChatCastMap(),
        ])
        reply = ok(payload, requestId, {
          settings, presets, personas, characters, history, storyDebug, places, lastAutoStatus,
          casts, chatCast,
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
        for (const k of ['mode', 'parserEngine', 'parserConnection', 'parserModel', 'parserRequestOverrides', 'parserInstruction', 'protocol', 'dtModelsPath', 'bridgeHost', 'cloudHost', 'cloudModel', 'storyQualityTags', 'storyPromptPrefix', 'storyNegativePrompt', 'storyBannedTags', 'storySceneAnchor']) {
          if (payload[k] !== undefined) settings[k] = String(payload[k])
        }
        if (payload.bridgePort !== undefined) settings.bridgePort = Number(payload.bridgePort) || DEFAULT_SETTINGS.bridgePort
        if (payload.cloudPort !== undefined) settings.cloudPort = Number(payload.cloudPort) || DEFAULT_SETTINGS.cloudPort
        if (payload.cloudEnabled !== undefined) settings.cloudEnabled = !!payload.cloudEnabled
        if (payload.cloudFallback !== undefined) settings.cloudFallback = !!payload.cloudFallback
        if (payload.autoScan !== undefined) settings.autoScan = !!payload.autoScan
        if (payload.autoCharTags !== undefined) settings.autoCharTags = !!payload.autoCharTags
        if (payload.chatLeads !== undefined) settings.chatLeads = !!payload.chatLeads
        if (payload.useLoomLedger !== undefined) settings.useLoomLedger = !!payload.useLoomLedger
        if (payload.parserMaxTokens !== undefined) settings.parserMaxTokens = Math.max(1200, Math.min(32000, Number(payload.parserMaxTokens) || 12000))
        if (payload.parserTemperature !== undefined) {
          const value = Number(payload.parserTemperature)
          settings.parserTemperature = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0.2
        }
        if (payload.storyUseBreakSeparators !== undefined) settings.storyUseBreakSeparators = !!payload.storyUseBreakSeparators
        if (['storyQualityTags', 'storyPromptPrefix', 'storyNegativePrompt', 'storyBannedTags', 'storySceneAnchor', 'storyUseBreakSeparators']
          .some((key) => payload[key] !== undefined)) settings.storyPromptMigrated = true
        if (payload.stripImageDirectives !== undefined) settings.stripImageDirectives = !!payload.stripImageDirectives
        if (payload.sizeChatImages !== undefined) settings.sizeChatImages = !!payload.sizeChatImages
        if (payload.optimizedPreviews !== undefined) settings.optimizedPreviews = !!payload.optimizedPreviews
        if (payload.deleteImagesWithChats !== undefined) settings.deleteImagesWithChats = !!payload.deleteImagesWithChats
        if (payload.chatImageWidth !== undefined) {
          settings.chatImageWidth = Math.min(1200, Math.max(200, Number(payload.chatImageWidth) || 500))
        }
        if (payload.parserContextMessages !== undefined) settings.parserContextMessages = Math.max(0, Math.min(4, Number(payload.parserContextMessages) || 0))
        if (!['legacy', 'anima'].includes(settings.parserEngine)) settings.parserEngine = 'legacy'
        if (!['off', 'inline', 'parser', 'direct'].includes(settings.mode)) settings.mode = 'off'
        settings.directMode = settings.mode === 'direct'
        settings.subjectBinding = settings.parserEngine === 'anima'
        if (payload.maxImages !== undefined) {
          settings.maxImages = Math.max(1, Math.min(4, Number(payload.maxImages) || 2))
        }
        if (payload.minImages !== undefined) {
          settings.minImages = Math.max(0, Math.min(4, Number(payload.minImages) || 0))
        }
        if (payload.maxSubjects !== undefined) {
          settings.maxSubjects = Math.max(2, Math.min(4, Number(payload.maxSubjects) || 2))
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
        // A page just loaded or reloaded. Its backlog is about to render and
        // every message in it will announce itself as freshly rendered.
        lastFrontendConnectAt = Date.now()
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
        const savedPreset = presets.find((p) => p.name === settings.activePreset)
        const preset = storyPresetFor(savedPreset, settings)
        if (!preset || settings.mode !== 'inline') { reply = ok(payload, requestId, { started: false }); break }
        pregenInflight.add(fp)
        reply = ok(payload, requestId, { started: true })
        ;(async () => {
          try {
            const chatId = await resolveActiveChatId(userId)
            const compiled = await compileInlineBody(body, preset, settings, userId, chatId)
            const dims = aspectDims(preset.config, aspect || compiled.aspect)
            const entry = await generateAndUpload({
              prompt: compiled.prompt,
              debug: { trace: compiled.trace, scene: compiled.scene }, negativePrompt: preset.negativePrompt, config: preset.config, extra: preset.extra, dims,
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
        const existingPreset = presets.find((item) => item && item.name === name) || null
        const preset = {
          ...(existingPreset || {}),
          name,
          config: payload.config,
          extra: payload.extra || null,
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
      // The wardrobe of record, readable and correctable.
      //
      // Since 0.53.2 the compiler actively corrects the parser back toward what it
      // remembers, which is right when the record is right and unfixable when it is
      // not: a hand-edited prompt never recompiles, so it teaches the record
      // nothing, and the profile default sits BELOW memory in the precedence chain.
      // Confidence without a correction is just a louder mistake.
      case 'wardrobe': {
        const settings = await getSettings()
        const presets = await getPresets()
        const preset = presets.find((p) => p.name === settings.activePreset)
        const presetName = preset ? preset.name : ''
        // The panel sends the chat it last saw an event for. Falling back to the
        // host's idea of "active" is the old behaviour and stays as a backstop,
        // but when BOTH are empty sceneMemoryKey returns '' and every chat shares
        // one wardrobe record — so that case is now said out loud rather than
        // silently producing another story's clothes.
        const chatId = String(payload.chatId || '').trim() || String((await resolveActiveChatId(userId)) || '')
        if (!chatId) {
          spindle.log.info('[lumidraw] wardrobe: no chat could be identified — this record is shared across every chat')
        }
        // Refresh used to re-read the preset and nothing else, so a character the
        // story introduced in THIS chat could never get a row: there was no path
        // from "who is in this chat" to "who is in the panel". It now reads the
        // whole chat for cast declarations before building the rows.
        let added = []
        let dressed = []
        let scanError = ''
        if (payload.scan && preset) {
          try {
            const read = await fetchMessages(userId, chatId)
            const messages = read.messages || []
            const absorbed = await absorbCastDeclarations(messages, null, preset, chatId)
            added = absorbed.added || []
            // "Pressing refresh on the wardrobe panel does not change the wardrobe
            //  of record text." It could not: refresh only ever absorbed CAST
            //  declarations. Clothing was never read from the chat at all, so the
            //  panel showed whatever was last typed into it by hand.
            const scanProfiles = await getStoryProfiles(preset, settings, userId, chatId)
            dressed = await absorbWearDeclarations(messages, null, scanProfiles, chatId,
              await sceneScopeFor(chatId, presetName))
            spindle.log.info(`[lumidraw] wardrobe scan read ${messages.length} message(s)` +
              (added.length ? ` and adopted ${added.join(', ')}` : ' and found no new cast declarations') +
              (dressed.length ? ` · re-dressed ${dressed.map((item) => item.name).join(', ')}` : ''))
          } catch (error) {
            scanError = error.message
            spindle.log.info(`[lumidraw] wardrobe scan could not read the chat: ${error.message}`)
          }
        }
        let synced = []
        let syncRejected = []
        let syncModel = ''
        let syncMessageId = ''
        if (payload.syncLatest) {
          const result = await syncWardrobeFromLatestPassage(userId, chatId, preset, settings)
          synced = result.updates || []
          syncRejected = result.rejected || []
          syncModel = result.model || ''
          syncMessageId = result.messageId || ''
        }
        // Swapping a cast member for one from your library.
        //
        // The story declares a character with whatever tags it invented. If you
        // already HAVE that person written properly — Fanny lives in a lorebook
        // here, not on the character card — the invented version is a worse
        // duplicate. This replaces it in the cast list, and deletes the story's
        // copy because nothing of yours was in it.
        let swapped = ''
        if (payload.replace && payload.replace.from && payload.replace.to && preset) {
          const from = String(payload.replace.from)
          const to = String(payload.replace.to)
          const boundCast = await castForChat(chatId)
          const source = boundCast || { castLibraryIds: [] }
          const ids = (source.castLibraryIds || []).map((id) => (String(id) === from ? to : String(id)))
          const characters = await getCharacters()
          const doomed = characters.find((item) => item && String(item.id) === from &&
            item.profile && item.profile.declaredByStory)
          if (doomed) await saveCharacters(characters.filter((item) => item !== doomed))
          await writeCastIds(preset, chatId, ids)
          swapped = to
          const named = (characters.find((item) => String(item.id) === to) || {}).name || to
          spindle.log.info(`[lumidraw] cast swap · using your saved "${named}" instead of the story's version` +
            (doomed ? `; the story's ${doomed.name} was deleted` : ''))
        }

        // ADD SOMEBODY FROM YOUR LIBRARY. "It's still using the lumicast Fanny
        // Price. I don't see how to change it." There was no control for this
        // anywhere that worked: the preset editor's cast list writes to the
        // PRESET, and a chat bound to a cast reads the CAST — so adding her
        // there was a no-op you could not see. This writes where the chat reads.
        let addedFromLibrary = ''
        if (payload.add && preset) {
          const wanted = String(payload.add)
          const boundCast = await castForChat(chatId)
          const source = boundCast || { castLibraryIds: [] }
          const ids = [...(source.castLibraryIds || []), wanted]
          const { where } = await writeCastIds(preset, chatId, ids)
          const named = ((await getCharacters()).find((item) => String(item.id) === wanted) || {}).name || wanted
          addedFromLibrary = wanted
          spindle.log.info(`[lumidraw] cast · added your saved "${named}" to ${where}`)
        }

        // Removing a cast member. The rule that keeps this safe: a character the
        // STORY invented is deleted outright, because nothing of yours is in it.
        // A character YOU added is only unlinked from this preset — never
        // deleted, because you wrote it and I have no business throwing it away.
        let removed = []
        if (Array.isArray(payload.remove) && payload.remove.length && preset) {
          const wanted = new Set(payload.remove.map((id) => String(id || '').trim()).filter(Boolean))
          const characters = await getCharacters()
          // Remove from wherever the rows CAME from. This was written in 0.73
          // against preset.castLibraryIds; two releases later the cast became the
          // source of the rows and nobody moved the removal, so the × edited a
          // list the panel no longer reads and appeared to do nothing.
          const boundCast = await castForChat(chatId)
          const source = boundCast || { castLibraryIds: [] }
          const keepIds = (source.castLibraryIds || []).filter((id) => !wanted.has(String(id)))
          const doomed = characters.filter((item) => item && wanted.has(String(item.id)) &&
            item.profile && item.profile.declaredByStory)
          if (doomed.length) {
            await saveCharacters(characters.filter((item) => !doomed.includes(item)))
          }
          if (keepIds.join('|') !== (source.castLibraryIds || []).join('|')) {
            if (boundCast) {
              const casts = await getCasts()
              const index = casts.findIndex((item) => item && item.id === boundCast.id)
              if (index >= 0) {
                casts[index] = { ...casts[index], castLibraryIds: keepIds }
                await saveCasts(casts)
              }
            }
          }
          removed = [...wanted]
          spindle.log.info(`[lumidraw] removed ${removed.length} from ` +
            (boundCast ? `the cast "${boundCast.name}"` : 'this unbound chat') +
            (doomed.length ? `; ${doomed.map((item) => item.name).join(', ')} were the story's and were deleted` : ''))
        }

        const entry = await readSceneMemory(chatId, presetName)
        const profiles = preset ? await getStoryProfiles(preset, settings, userId, chatId) : null
        const boundCastForRows = await castForChat(chatId)

        if (payload.set && typeof payload.set === 'object') {
          const memory = await getSceneMemory()
          const key = sceneMemoryKey(chatId, await sceneScopeFor(chatId, presetName))
          const previous = memory[key] || entry || {}
          const outfits = { ...(previous.outfits || {}) }
          const outfitMeta = { ...(previous.outfitMeta || {}) }
          for (const [ref, value] of Object.entries(payload.set)) {
            const tags = animaTagList(String(value || '').split(',')).slice(0, 12)
            if (tags.length) {
              outfits[ref] = tags
              outfitMeta[ref] = { source: 'manual', at: Date.now(), evidence: '' }
            } else {
              delete outfits[ref]
              delete outfitMeta[ref]
            }
            spindle.log.info(`[lumidraw] wardrobe edited by hand · ${ref} — ${tags.length ? tags.join(', ') : '(cleared)'}`)
          }
          memory[key] = { ...previous, outfits, outfitMeta, at: Date.now() }
          await spindle.storage.setJson(SCENE_MEMORY_FILE, memory, { indent: 2 })
        }

        const fresh = await readSceneMemory(chatId, presetName)
        const worn = fresh.outfits || {}
        const wornMeta = fresh.outfitMeta || {}
        const rows = []
        for (const profile of allKnownProfiles(profiles)) {
          if (!profile || !profile.ref) continue
          const recorded = worn[profile.ref] || []
          const fallback = profile.defaultOutfit || []
          const stateMeta = wornMeta[profile.ref] || {}
          rows.push({
            ref: profile.ref,
            name: profile.promptName || profile.anchor || profile.ref,
            tags: recorded.join(', '),
            fallback: fallback.join(', '),
            wardrobeSource: recorded.length ? String(stateMeta.source || 'remembered')
              : (fallback.length ? 'default' : 'none'),
            wardrobeAt: Number(stateMeta.at) || 0,
            wardrobeEvidence: String(stateMeta.evidence || ''),
            wardrobeMessageId: String(stateMeta.messageId || ''),
            // Only cast members carry a library id, so only they are removable —
            // the main character and the persona come from the preset itself and
            // there is nothing sensible to remove them from.
            id: profile.libraryId || '',
            // WHERE THE TAGS LIVE. "lumidraw has the Fanny character saved
            // somehow, somewhere cause the image it produced used the lumicast
            // tags. But I can't find where it is to edit it."
            //
            // It was findable — it is a row in the Characters tab — but nothing
            // on screen said so, and the panel's copy of that tab was stale
            // anyway. A row that produced tags should say where they came from
            // and take you there.
            source: profile.libraryId ? 'library' : (boundCastForRows ? 'cast' : 'chat'),
            // WHAT THIS ROW IS ACTUALLY CONTRIBUTING. The input beside it edits
            // clothes; "edit what it has to make it correct" is about these, and
            // until now they were invisible — so a wrong profile looked
            // identical to a right one.
            appearance: (profile.appearance || []).join(', '),
            declared: !!profile.declaredByStory,
            // Declared before the scoping existed, so it cannot be attributed to
            // a chat and will keep appearing in all of them until removed.
            unattributed: !!profile.declaredByStory && !profile.declaredInChat,
          })
        }
        // Anything recorded against a ref with no profile — shown so nothing is
        // invisible, even though 0.54.0 stopped writing anonymous refs.
        for (const [ref, tags] of Object.entries(worn)) {
          if (rows.some((row) => row.ref === ref)) continue
          const stateMeta = wornMeta[ref] || {}
          rows.push({
            ref,
            name: ref,
            tags: (tags || []).join(', '),
            fallback: '',
            orphan: true,
            wardrobeSource: String(stateMeta.source || 'remembered'),
            wardrobeAt: Number(stateMeta.at) || 0,
            wardrobeEvidence: String(stateMeta.evidence || ''),
            wardrobeMessageId: String(stateMeta.messageId || ''),
          })
        }
        const characterLib = await getCharacters()
        const library = characterLib.map((item) => ({
          id: item.id, name: item.name, story: !!(item.profile && item.profile.declaredByStory),
          // Two entries can share a name — a story invents "Fanny Price" while
          // you already have a "Fanny Price" — and until now the list showed
          // name only, so they were impossible to tell apart and the wrong one
          // got edited.
          inChat: String((item.profile && item.profile.declaredInChat) || ''),
          tags: String((item.profile && item.profile.appearanceTags) || '').slice(0, 90),
        }))
        // The panel reads the character library ONCE, at init. A story that
        // invents somebody mid-chat writes a new entry the panel never hears
        // about, so the Characters tab keeps showing the list from when it
        // opened — which is why a character that demonstrably exists could not
        // be found. Every wardrobe reply now carries the current library.
        reply = ok(payload, requestId, { rows, chatId, preset: presetName, added, scanError, removed, swapped,
          library, characters: characterLib, addedFromLibrary, dressed, synced, syncRejected, syncModel, syncMessageId })
        break
      }

      // Which cast is this chat using, and what is in it.
      // Load, inspect or clear Anima's artist vocabulary. Supplied by you rather
      // than bundled — see ARTIST_INDEX_FILE for why.
      case 'artist_index': {
        if (payload.clear) {
          await spindle.storage.setJson(ARTIST_INDEX_FILE, null, { indent: 2 })
          spindle.log.info('[lumidraw] artist index cleared; artist tags are no longer checked')
          reply = ok(payload, requestId, { count: 0, at: 0 })
          break
        }
        if (typeof payload.text === 'string' && payload.text.trim()) {
          const names = parseArtistIndex(payload.text)
          if (!names.length) throw new Error('No artist names found in that text — one name per line is expected.')
          await spindle.storage.setJson(ARTIST_INDEX_FILE, { names, at: Date.now() }, { indent: 2 })
          spindle.log.info(`[lumidraw] artist index loaded · ${names.length} names`)
          reply = ok(payload, requestId, { count: names.length, at: Date.now() })
          break
        }
        // A dry run against whatever is in the active preset right now, so the
        // answer arrives when you ask rather than on the next generation.
        const index = await getArtistIndex()
        const settingsNow = await getSettings()
        const tags = splitArtistTags(normalizeArtistTags(String(settingsNow.storyQualityTags || ''))).artists
        reply = ok(payload, requestId, {
          count: index ? index.names.length : 0,
          at: index ? index.at : 0,
          checked: tags,
          problems: checkArtistTags(tags, index),
        })
        break
      }

      case 'casts': {
        const chatId = String(payload.chatId || '').trim() || String((await resolveActiveChatId(userId)) || '')
        if (payload.bind !== undefined) {
          await bindChatToCast(chatId, String(payload.bind || ''))
        }
        // WHO YOU ARE PLAYING in this chat. The host records no persona, so this
        // is the only way to say it, and it is per chat rather than per cast so a
        // new story does not inherit whoever the last one was played as.
        if (payload.persona !== undefined) {
          await bindChatToPersona(chatId, String(payload.persona || ''))
        }
        if (payload.fantasy !== undefined && payload.castId) {
          const casts = await getCasts()
          const index = casts.findIndex((item) => item && item.id === String(payload.castId))
          if (index >= 0) {
            casts[index] = { ...casts[index], fantasy: !!payload.fantasy }
            await saveCasts(casts)
            spindle.log.info(`[lumidraw] cast "${casts[index].name}" is ${payload.fantasy ? 'now' : 'no longer'} a fantasy setting`)
          }
        }
        if (payload.rename && payload.castId) {
          const casts = await getCasts()
          const index = casts.findIndex((item) => item && item.id === String(payload.castId))
          if (index >= 0) {
            casts[index] = { ...casts[index], name: shortPhrase(payload.rename, 'cast name', 8, 64, false, true) }
            await saveCasts(casts)
          }
        }
        // Duplicating is how you start a new story from an existing cast without
        // touching the one you already have. Cheaper and far safer than editing.
        if (payload.duplicate) {
          const casts = await getCasts()
          const source = casts.find((item) => item && item.id === String(payload.duplicate))
          if (source) {
            const copy = JSON.parse(JSON.stringify(source))
            copy.id = `cast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            copy.name = `${source.name} copy`
            copy.migratedFromPreset = ''
            copy.createdAt = Date.now()
            casts.push(copy)
            await saveCasts(casts)
            if (chatId) await bindChatToCast(chatId, copy.id)
            spindle.log.info(`[lumidraw] duplicated cast "${source.name}" and bound this chat to the copy`)
          }
        }
        const [casts, map, characters, personaList, personaMap] = await Promise.all([
          getCasts(), getChatCastMap(), getCharacters(), getPersonas(), getChatPersonaMap()])
        const boundId = chatId ? (map[chatId] || '') : ''
        const sharedWith = boundId
          ? Object.entries(map).filter(([chat, id]) => id === boundId && chat !== chatId).length
          : 0
        reply = ok(payload, requestId, {
          chatId,
          boundId,
          sharedWith,
          personaId: chatId ? (personaMap[chatId] || '') : '',
          personas: personaList.map((item) => ({ id: item.id, name: item.name })),
          casts: casts.map((item) => ({
            id: item.id,
            name: item.name,
            migratedFromPreset: item.migratedFromPreset || '',
            fantasy: !!item.fantasy,
            character: (item.characterProfile && (item.characterProfile.promptName || item.characterProfile.anchor)) || '',
            persona: (item.personaProfile && (item.personaProfile.promptName || item.personaProfile.anchor)) || '',
            members: (item.castLibraryIds || [])
              .map((id) => (characters.find((c) => c && c.id === id) || {}).name)
              .filter(Boolean),
          })),
        })
        break
      }

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
        if (parse.parseError) throw new Error(parse.settings.mode === 'direct' || parse.settings.directMode === true
          ? `Direct parser returned no usable prompt: ${parse.parseError}`
          : `Parser returned invalid structured data: ${parse.parseError}`)
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
          const directReparse = parse.settings.mode === 'direct' || parse.settings.directMode === true
          reply = ok(payload, requestId, {
            reparsed: false,
            note: directReparse
              ? `Direct parser returned no usable prompt: ${parse.parseError}`
              : `Parser returned invalid structured data: ${parse.parseError}`,
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
          mode: parse.settings.mode === 'direct' || parse.settings.directMode === true ? 'direct' : 'parser',
          parserEngine: parse.settings.mode === 'direct' || parse.settings.directMode === true ? 'direct' : parse.settings.parserEngine,
          rawReply: String(parse.raw || ''),
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

      case 'diagnostic_report': {
        if (!LAST_DIAGNOSTIC) {
          reply = ok(payload, requestId, { report: '', note: 'Generate or re-parse an image first — this reports on the last compile.' })
          break
        }
        // Refreshed here rather than cached at compile time, so the negative
        // list reflects everything that ran.
        const report = { ...LAST_DIAGNOSTIC, negatives: negativeSnapshot() }
        reply = ok(payload, requestId, { report: JSON.stringify(report, null, 2) })
        break
      }

      case 'cloud_status': {
        const settings = await getSettings()
        reply = ok(payload, requestId, { cloud: await cloudRelayStatus(settings) })
        break
      }

      case 'save_places': {
        // Validated on the way in, not on the way out: a Place with no tags
        // would match a passage and then contribute nothing, which looks like
        // the matcher is broken rather than like an empty field.
        const places = normalizePlaces(Array.isArray(payload.places) ? payload.places : [])
        await savePlaces(places)
        spindle.log.info('[lumidraw] saved ' + places.length + ' place(s)')
        reply = ok(payload, requestId, { places })
        break
      }

      case 'delete_place': {
        const places = (await getPlaces()).filter((place) => place && place.name !== payload.name)
        await savePlaces(places)
        reply = ok(payload, requestId, { places })
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
        const { images } = await generateImages(settings, payloadOut, 'Studio generation')

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
        const history = await pushHistory(entry, userId)
        // Push the completed result independently of the request reply. This
        // keeps remote/mobile clients synchronized if the original response is
        // delayed or dropped after Draw Things has already finished.
        notifyFrontend(userId, 'history_updated', { history, entry, source: 'studio' })
        spindle.log.info('[lumidraw] Studio generation saved · images=' + uploads.length + ' · duration=' + entry.durationMs + 'ms')
        reply = ok(payload, requestId, { entry, history })
        break
      }

      case 'append_to_chat': {
        // 1.3.3: manual placement uses the same native mount store as automatic
        // story illustration. Do not prepend image markup into the message —
        // that changes the virtualized row itself and is what caused scroll jumps.
        const { imageUrl, imageId, alt, chatId, width, height } = payload
        if (!imageUrl) throw new Error('No image URL to add.')
        const fetched = await fetchMessages(userId, String(chatId || ''))
        const targetChatId = String(fetched.chatId || chatId || '').trim()
        let target = null
        for (let i = fetched.messages.length - 1; i >= 0; i--) {
          const bits = messageBits(fetched.messages[i])
          if (bits.id && bits.isAssistant) { target = bits; break }
        }
        if (!target || !target.id || !targetChatId) {
          throw new Error('Could not find the latest assistant story message to mount this image on.')
        }
        const placement = await recordImagePlacement(userId, {
          chatId: targetChatId,
          messageId: String(target.id),
          imageUrl,
          imageId: imageId || '',
          alt: alt || 'Generated image',
          width,
          height,
          source: 'manual',
          allowDuplicate: true,
        })
        reply = ok(payload, requestId, { mode: 'mounted', placement })
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

        const nativeRemoved = await removeImagePlacements(userId, {
          placementId: String(payload.placementId || '').trim(),
          imageUrl,
          chatId: rmChatId,
        })
        if (nativeRemoved.length) {
          reply = ok(payload, requestId, { removed: true, mode: 'mounted', placements: nativeRemoved })
          break
        }

        let removed = false
        for (const m of messages) {
          const contentKey = ('content' in m) ? 'content' : ('text' in m) ? 'text' : ('message' in m) ? 'message' : null
          if (!contentKey || typeof m[contentKey] !== 'string') continue
          const stripped = removeImageMarkupFromContent(m[contentKey], imageUrl)
          if (!stripped.removed) continue
          const messageId = m.id || m.messageId
          try {
            await updateMessageContent(messageId, contentKey, stripped.content, userId, rmChatId)
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
        // Native mounts are extension state and can exist in a chat that is not
        // currently open, so remove those globally before the legacy markup pass.
        try { await removeImagePlacements(userId, { imageUrl, imageId }) } catch { /* best effort */ }
        // best-effort: remove legacy message markup too (ignore not-found)
        try {
          const { messages, chatId: dChatId } = await fetchMessages(userId)
          for (const m of messages) {
            const bits = messageBits(m)
            if (!bits.contentKey || typeof bits.content !== 'string') continue
            const stripped = removeImageMarkupFromContent(bits.content, imageUrl)
            if (!stripped.removed) continue
            await updateMessageContent(bits.id, bits.contentKey, stripped.content, userId, dChatId)
            break
          }
        } catch { /* not in a chat / no chat open — fine */ }
        // delete the owned image itself
        const deleted = await deleteOwnedImage(userId, { id: imageId, url: imageUrl })
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


      case 'get_image_mounts': {
        let chatId = String(payload.chatId || '').trim()
        if (!chatId) chatId = String((await resolveActiveChatId(userId)) || '')
        const placements = chatId ? await listImagePlacements(chatId) : []
        reply = ok(payload, requestId, { chatId, placements })
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
              try { await removeImagePlacements(userId, { imageUrl: im.url, imageId: im.id }) } catch { /* best effort */ }
              if (await deleteOwnedImage(userId, im)) n++
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
      if (settings.mode !== 'inline' && settings.mode !== 'parser' && settings.mode !== 'direct') return a

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
          const inlinePersona = ap ? await effectivePersonaTags(ap, await resolveActiveChatId(userId)) : { tags: '' }
          if (inlinePersona.tags) {
            protocolText += '\nWhen the User/persona is visibly present in an illustrated moment, represent them with these tags (include only the parts actually visible; respect POV framing): ' + inlinePersona.tags
          }
        } catch (error) {
          spindle.log.warn('[lumidraw] could not add persona hints to inline protocol: ' + error.message)
        }
        const injected = { role: 'system', content: protocolText }
        const out = [...messages, injected]
        spindle.log.info('[lumidraw] inline protocol injected (' + injected.content.length + ' chars)')
        return wrapped ? { ...a, messages: out } : out
      }
      if ((settings.mode === 'parser' || settings.mode === 'direct') && settings.autoScan !== false) {
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
    on('GENERATION_ENDED', async (evt) => {
      try {
        const payload = normalizedPayload(evt)
        if (payload.error) return
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || await recallUserId()
        if (!uid || !messageId || !chatId) {
          spindle.log.info('[lumidraw] backend GENERATION_ENDED ignored — missing ' +
            [!uid && 'a user id (no browser has ever connected to this install)',
             !messageId && 'a message id', !chatId && 'a chat id'].filter(Boolean).join(' and '))
          return
        }
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
    on('MESSAGE_SWIPED', async (evt) => {
      try {
        const payload = normalizedPayload(evt)
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || await recallUserId()
        if (!messageId) return
        await removeImagePlacements(uid, { chatId, messageId })
      } catch (error) {
        spindle.log.warn('[lumidraw] MESSAGE_SWIPED image cleanup failed: ' + error.message)
      }
    })
    spindle.log.info('[lumidraw] MESSAGE_SWIPED native-image cleanup registered')
  } catch (error) {
    spindle.log.warn('[lumidraw] MESSAGE_SWIPED registration failed: ' + error.message)
  }

  try {
    on('CHAT_DELETED', async (evt) => {
      try {
        const payload = normalizedPayload(evt)
        const chatId = String((typeof payload === 'string' ? payload : '') || payload.id || payload.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || (evt && evt.userId) || await recallUserId()
        if (!chatId) return
        await cleanupDeletedChat(uid, chatId)
      } catch (error) {
        spindle.log.warn('[lumidraw] CHAT_DELETED storage cleanup failed: ' + error.message)
      }
    })
    spindle.log.info('[lumidraw] CHAT_DELETED image and chat-state cleanup registered')
  } catch (error) {
    spindle.log.warn('[lumidraw] CHAT_DELETED registration failed: ' + error.message)
  }

  try {
    on('MESSAGE_DELETED', async (evt) => {
      try {
        const payload = normalizedPayload(evt)
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || await recallUserId()
        if (!messageId) return
        await removeImagePlacements(uid, { chatId, messageId })
      } catch (error) {
        spindle.log.warn('[lumidraw] MESSAGE_DELETED image cleanup failed: ' + error.message)
      }
    })
    spindle.log.info('[lumidraw] MESSAGE_DELETED native-image cleanup registered')
  } catch (error) {
    spindle.log.warn('[lumidraw] MESSAGE_DELETED registration failed: ' + error.message)
  }

  try {
    on('CHARACTER_MESSAGE_RENDERED', async (evt) => {
      try {
        const payload = normalizedPayload(evt)
        const eventMessage = payload.message && typeof payload.message === 'object' ? payload.message : {}
        const messageId = String(payload.messageId || eventMessage.messageId || eventMessage.id || '')
        const chatId = String(payload.chatId || eventMessage.chatId || (payload.chat && payload.chat.id) || '')
        const uid = payload.userId || eventMessage.userId || await recallUserId()
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
