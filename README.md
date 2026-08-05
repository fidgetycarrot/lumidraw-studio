# LumiDraw Studio 0.20.3

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.20.3 — Scene statement (anima-hybrid-v10)

Field observation: manually prepending one plain sentence stating the central
action ("Sovi and Rook are having anal sex", "Rook is fighting bandits") in
front of the caption block dramatically improved a two-character image. The
compiler previously buried the central action in relation fragments at the end
of the caption and never stated what the scene *is*.

The parser now emits a mandatory `scene_statement` — one blunt declarative
sentence naming the subjects and the central visible action, no mood words, no
scenery, under 15 words — and the compiler places it as the first sentence of
the caption block for both solo and multi-subject scenes.

- Placed immediately after `safety` in the truncation-survival field order.
- In nsfw/explicit scenes the parser is told to name the act plainly; a
  euphemism costs the image its subject.
- Guard: a statement naming a sexual act inside a scene the parser itself
  rated safe/sensitive contradicts the safety tag and is dropped.
- A relation sentence that merely restates the statement's action is deduped.
- Solo scenes without a parser-provided statement synthesize one from
  `core_action` ("Ilsa is casting a spell with great intensity."), so every
  solo prompt now leads its caption with a thesis sentence too.

## 0.20.2 — Compact two-character prompts (anima-hybrid-v9)

Field feedback on 0.20.1: two-character generations showed extra limbs and
clothing on the wrong subject. Two causes, both fixed.

**Unbound subject tags.** The multi-subject tag run still carried each
subject's outfit, pose, and action tags alongside the caption block that bound
them — so `dark linen shirt` floated free to land on either character, and an
unowned `grabbing a wrist` conjured hands belonging to nobody. In multi-subject
scenes the tag run now carries only scene-level tags (safety, counts,
character/series, artist, setting, camera, lighting, style); every
subject-specific detail lives exclusively in the caption where it is bound to a
name. `core_action` joins the tag run only when no relation sentence already
covers it. Solo scenes are unchanged — with one subject nothing can misbind.

**Caption budget.** Long prompts are themselves a confusion risk, so the
caption is tightened: two sentences per subject (identity, then one combined
outfit/pose/expression/action sentence, instead of up to five), at most seven
appearance traits per subject ordered so bleed-prone signature traits — now
including nonhuman features such as wolf ears, fangs, claws, snout, and fur —
survive the cut, build adjectives dropped, relation sentences capped at two,
and generic exclusivity anchors ("the only eyewear in the scene...") removed
entirely since the identity sentence is now the only place appearance exists.
Named-prop ownership keeps one sentence at most per subject.

A representative two-character scene compiles to roughly 630 characters, down
from about 880 in 0.20.1; explicit two-character scenes drop from ~770 to ~520.

## 0.20.1 — Truncation survival order, parser retry, startup echo guard

Fixes for two field failures observed on 0.20.0.

### Parser truncation no longer discards the scene

A reasoning-capable parser model routed through a gateway can burn most of the
completion budget on hidden reasoning tokens that the `reasoning: off` request
flag does not reliably suppress (observed: 3,450 completion tokens spent, ~250
tokens of visible JSON, `finish=length`). Three layers now handle this:

- **Survival field order.** The schema previously asked for scene essentials
  before subjects — so a truncated reply kept camera and lighting and lost the
  one field validation cannot live without. The order is now safety →
  core_action → setting → **subjects** → relations → camera/lighting/style:
  whatever survives a cutoff forms a usable scene.
- **Automatic retry.** When a structured reply ends with `finish=length`, the
  parser is retried once with a much larger output allowance sized from the
  observed hidden-token drain (capped at 12k). The truncated first reply is
  kept as a fallback if the retry fails.
- **Relation salvage.** A half-written or malformed relation (the typical tail
  of a truncated reply) is dropped with a log line instead of invalidating the
  entire scene.

### No more phantom scan at app start

`CHARACTER_MESSAGE_RENDERED` fires for every message the host renders,
including existing history painted while a chat loads. On startup this queued
an automatic scan for the last old message — a visible "Preparing story
message" timer, minutes of chat lookups, and potentially an image nobody
requested. Now:

- render-events arriving within 12 s of backend start are ignored as startup
  echoes (`GENERATION_ENDED`, the real completion signal, is never gated);
- an auto trigger for an already-illustrated message is settled from local
  storage before any scan widget or chat fetch is started;
- the automatic message lookup has a 20 s overall budget and stops early once
  the chat's message list has visibly settled, instead of always burning ten
  full chat fetches.

## 0.20.0 — Anima-native prompt assembly

The compiler is now `anima-hybrid-v8`. The parser contract is unchanged in
shape; what changed is how the extracted scene is turned into a prompt.

### Natural-language identity binding

Previously each subject compiled to a comma-separated run headed by its proper
name:

```text
Ilsa, a half-elf woman, round glasses, silver hair, white blouse, sitting, ...
Corin, a tall human man, black hair, stubble, dark linen shirt, standing, ...
```

Anima has no mechanism to bind a name to the tags that follow it. The name is an
unknown token, and every trait after it sits in the same undifferentiated tag
soup as the other subject's traits — which is precisely how glasses, hair
colour, markings, and species features end up on the wrong character.

Anima's own guidance is to name a character and then describe them in prose.
Multi-subject scenes now emit sentences, and permanent appearance is kept out of
the shared tag run entirely:

```text
safe, 1girl, 1boy, white blouse, sitting, laughing, dark linen shirt, standing, kitchen, night, cowboy shot, dim light

Ilsa is a half-elf woman with silver hair, long hair, green eyes, pointed elf
ears, round glasses, a shoulder tattoo, freckles, and a slender build. Ilsa
wears a white blouse. Ilsa is sitting on the counter. Corin is a tall human man
with black hair, short hair, brown eyes, stubble, and a muscular build. Corin
grips the wrist of Ilsa. The only eyewear in the scene is round glasses, worn by
the half-elf Ilsa. Ilsa is on the right and Corin is on the left.
```

Solo scenes remain tag-only. With one subject there is nothing to bind, and tags
are what the model renders best.

### Trained tag order

Output follows Anima's documented order — quality/meta/year/safety, then count
tags, then character, series, artist, then general tags. Subjects may now carry
`booru_character` and `booru_series` for recognisable published characters;
original characters are carried by the caption block instead.

### Safety-tag reconciliation

A preset's quality field almost always ends `..., score_7, safe`. On an
nsfw/explicit passage that compiled to `safe, ..., explicit` — two mutually
exclusive tags in one prompt. The scene's classification now wins and the stale
tag is dropped from the header.

### Single tag run

The prompt was previously split into six labelled lines. Anima saw newlines
almost exclusively in its dataset-tagged captions, so a multi-line prompt is
off-distribution. Tags now flow as one comma-separated run, with a single
paragraph break before the caption block.

### Artist tags

Anima requires the `@` prefix or the effect is very weak. `artist:foo` and
`by foo` in a preset are rewritten to `@foo`, and artist tags are moved into
Anima's artist slot regardless of where the preset put them.

### Smaller compiler fixes

- Hedge phrasing such as `sitting on the clearly visible counter edge` has no
  booru counterpart; pose and support surface are separate tags again.
- Named props expanded on every mention, repeating a long descriptor two or
  three times per prompt. Expansion is now once per subject, description only.
- Standing characters no longer inherit furniture from the setting.
- Redundant tags are collapsed: `desk, study, wooden desk` and
  `carrying hammer, carrying a hammer` no longer pay twice for one concept.
- Left/right placement is a sentence rather than the pseudo-tag `ilsa on right`.

## 0.19.1 — Truncation recovery and cleaner parser context

- Strips `<scenecard>`, `<adventurecard>`, and similar utility-card blocks from
  current and prior parser prose so UI/state metadata cannot crowd out the
  actual roleplay scene.
- Keeps the nearest configured previous messages while capping their combined
  text, preserving continuity without sending several oversized cards.
- Repairs structured replies that stop inside the final optional key, string,
  or array item by discarding only the unfinished tail and safely closing the
  JSON containers.
- Recovered scenes still pass the normal minimum-scene validation before Draw
  Things can run; malformed or skeletal results remain rejected.
- Tightens optional JSON fields and raises the structured output allowance
  modestly while retaining compact scene extraction.

## 0.19.0 — Persona Library and Appearance States

- Added a reusable **Persona Library** stored independently of Story presets.
- A Story preset can link to one saved persona; edits to that persona apply to
  every linked preset on the next parser run.
- Presets retain a local fallback copy, so deleting a library persona does not
  erase the profile fields already stored in those presets.
- Added **Appearance States / Forms** to character profiles and reusable
  personas. Only one state is injected into an Anima prompt at a time.
- Each state may define recognition phrases, a subject/count override, and
  whether the profile's default outfit is inherited or omitted.
- The structured parser receives the saved state names and may select one with
  `appearance_state` when the current passage or reference context establishes
  it. When uncertain, LumiDraw uses the configured default state.
- Shared identity traits remain in Permanent appearance; state-specific tags
  are appended only for the selected form, preventing Human/Hybrid/Wolf traits
  from being mixed together.
- Retains the 0.18.12 essentials-first parser gate, fully isolated Studio mode,
  remote History delivery, auto-trigger diagnostics, prop locks, and selective
  Anima hybrid prompting.

### Appearance-state line format

One state per line:

```text
Name [count=1boy; outfit=inherit; appearance=inherit; subject=adult human man] | recognition phrases => appearance tags
```

Example:

```text
Human [count=1boy; outfit=inherit; subject=adult human man] | human form, unshifted => broad shoulders, messy dark brown hair
Hybrid [count=1boy; outfit=inherit; subject=humanoid werewolf] | hybrid form, half-shifted => wolf ears, partial muzzle, furred arms, claws, tail
Wolf [count=1other; outfit=omit; appearance=replace; subject=massive wolf] | wolf form, fully shifted, on four paws => dark brown fur, amber eyes, quadruped
```

The directive block belongs immediately after the state name, before the `|`
separator. Directives placed after the recognition phrases are ignored.

`outfit=inherit` keeps the profile's default outfit when the scene does not
specify clothing. `outfit=omit` suppresses that fallback, useful for full animal
forms. `count` and `subject` are optional.

`appearance=inherit` (the default) layers the state's tags over the profile's
Permanent appearance, which is right for a costume change or a partial shift.
`appearance=replace` discards the permanent tags for that form — added in
0.20.0, because a fully shifted werewolf was otherwise still carrying its human
hair, and any form declaring its own eye colour produced two eye colours at
once.

For a three-form werewolf, `Human` and `Hybrid` want `inherit` and `Wolf` wants
`replace`. If a hybrid form needs to override a specific permanent trait rather
than add to it, either drop that trait from Permanent appearance and let each
form declare it, or mark the hybrid `replace` and restate the shared traits.

## Retained automatic Anima pipeline

This release addresses the case where the full experimental Anima pipeline works
from **Manual Parser** but a completed roleplay response produces no automatic
images. Manual Anima parsing, Legacy instruction-only parsing, context windows,
and Loom ledger continuity remain available.

### Saved-message auto-trigger fan-in

Automatic Parser mode no longer depends on a single XML callback. LumiDraw now
accepts the completed assistant message from several compatible lifecycle paths:

- the saved-message `GENERATION_ENDED` event;
- `CHARACTER_MESSAGE_RENDERED` as a fallback;
- the existing `<lumidraw-parse>` tag interceptor;
- frontend forwarding of the same saved-message events when backend event scope
  is unavailable.

All sources enter one deduplicating queue. A tag callback that arrives first can
be enriched by a later saved-message event carrying the exact chat ID, message
ID, and final content. Only one parser job may be created for that message.

### Exact message targeting and delayed-save recovery

Automatic jobs now:

- fetch the event's explicit chat rather than relying only on the current chat;
- target the exact assistant message ID;
- retry while a newly saved message becomes queryable;
- use final message content as a last-resort identity check;
- allow a later lifecycle event to retry when lookup—not parsing—was the only
  failure.

If another scan already owns the parser/Draw Things lane, an automatic job waits
rather than being silently discarded as `busy`.

### Visible automatic-job diagnostics

The Story panel and Terminal now expose automatic stages including queued,
waiting, parsing, compiling, generating, inserting, generated, skipped, and
error. Expected Terminal lines include:

```text
[lumidraw] documented GENERATION_ENDED auto trigger registered
[lumidraw] auto trigger queued · source=...
[lumidraw] auto trigger deduplicated/enriched · source=...
[lumidraw] story scan stage · parsing ...
[lumidraw] auto scan result · source=...
```

The original event sources are retained in the result log, which makes it clear
whether the tag, frontend event, backend event, or a combination started the
job.

## Anima hybrid refinements

Retained from earlier releases. The compiler identifier is now
`anima-hybrid-v8`.

### Generic signature ownership

For multi-subject scenes, one distinctive trait may be moved to the beginning of
its owner's tag block and reinforced with a short generic ownership anchor, for
example:

```text
The only eyewear in the scene is round glasses, worn by the elf Sovi.
```

The behavior is profile-driven rather than character-specific. It applies to
traits such as eyewear, pointed ears, horns, wings, tails, visible markings, and
piercings.

### Generic named-prop expansion

A profile mapping such as:

```text
Aegis-fang = single massive warhammer
```

may expand a generic extracted action such as `holds hammer one-handed` into a
more visually useful named-prop sentence and tag phrase. The inference is used
only when one profile alias unambiguously matches the generic object class.

### POV gating

Bare `pov` / `first person view` tags are removed unless a visible persona is
actually represented from the viewer's body or eye position. Normal two-subject
camera compositions retain their other framing tags.

## Parser continuity retained

- Up to four previous messages as reference context; default is two.
- Optional latest `<loomledger>` as attire, accessory, location, state, and prop
  continuity reference.
- Current passage remains the only allowed source of the illustrated action and
  anchor quote.
- Structured JSON truncation repair and per-image output allowances.
- Conditional visible anatomy remains subject-owned and safety-gated.
- Legacy instruction-only Parser remains the known-good fallback.
- Live elapsed timer, Cancel Parser, and four-minute parser timeout.

## Other retained behavior

- User quality tags and negative prompts remain untouched.
- Inline mode remains on the simpler tag-only path.
- Immediate History updates and manual History refresh.
- Old-message rescanning with chat-message and story-message numbering.
- In-app image viewer with zoom, pan, prompt restoration, and reuse.
- Bridge-powered model, sampler, and LoRA catalogs.
- Draw Things `batch_count` is forced to `1`; only the first returned image is
  accepted for each requested illustration.
- Maximum-image limits are enforced before generation.

## Suggested test

1. Confirm the header and Terminal show **v0.20.0**.
2. Select **Parser**, **Anima hybrid experimental**, and enable automatic scans.
3. Leave reference context at **2 previous messages** and Loom ledger on.
4. Complete one new roleplay response without pressing Manual Parser.
5. Confirm Terminal shows an auto trigger, a parser stage, and a final auto scan
   result.
6. If no image is warranted, the Story panel should show that decision rather
   than remaining silent.
7. Run Manual Parser once afterward to compare the same Anima pipeline directly.
8. Inspect a two-character prompt in the Story debug panel: the tag run should
   contain no character names and no permanent appearance tags, and the caption
   block below it should name each character and describe them.
9. If you use appearance states, confirm a fully shifted form no longer carries
   its human traits once marked `appearance=replace`.
