# LumiDraw Studio 0.29.4

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.29.4 — Stop fighting the reasoning; budget for it

`effort: "none"` did not take. A scan on 0.29.3:

```text
attempt 1   max_tokens=4100    →  EMPTY, 4100 tokens, 49s
retry       max_tokens=12300   →  finish=stop, 5715 tokens (~730 visible), 61s
total       110 seconds
```

`reasoning_tokens=not reported`, so the provider will not even say. Whatever
LumiDraw sends, the reasoning stays on — that is Lumiverse's side of the call
and nothing in this extension can reach it.

But the reasoning was never the expensive part. **The first attempt was.** It
burned 49 seconds producing nothing, then the retry paid the 6,651-token input
cost a second time. Given room to finish, one request returns the same JSON.

The first-attempt budget now defaults to **12,000 tokens** and is configurable
in Settings. The retry stays as a safety net and should rarely fire.

Expected: ~110s → ~60s, and one request instead of two.

The request log no longer claims `reasoning=off` regardless of truth; it prints
the object actually sent.

**If you ever confirm reasoning is genuinely off**, drop the budget to ~4000.
The JSON alone needs about 700 tokens, so that is still ample, and the call
should land near 12 seconds.


## 0.29.3 — Correcting 0.29.2 against the actual spec

0.29.2 sent every spelling of "reasoning off" at once on the theory that
providers ignore keys they do not recognise. Reading OpenRouter's reference
afterwards, two of those keys were wrong in ways that mattered.

**`exclude: true` does not disable reasoning.** The documentation is explicit:
*"The model will still use reasoning, but it won't be returned in the
response."* It hides the trace while still generating and billing the tokens —
the precise behaviour that made this failure so hard to see. Removed.

**`max_tokens: 0` may have switched reasoning on.** For Anthropic models
OpenRouter clamps the reasoning budget to a **1024-token minimum**, so a zero
budget becomes a 1024-token one. It also conflicts with `effort`, which the
reference states is "one of the following (not both)". Removed.

What is sent now:

```json
{ "reasoning": { "source": "off", "enabled": false, "effort": "none" } }
```

`effort: "none"` is documented as "disables reasoning entirely", and OpenRouter
derives Anthropic's thinking budget from `effort`, so it is the key that
decides. The other two ride along for providers that spell it differently.

Some models mark reasoning **mandatory** and reject `effort: "none"` outright;
that rejection is now also caught by the fallback, which retries once with the
minimal form rather than failing the scan.

For the Lumiverse preset's own Custom Body field, the equivalent is:

```json
{"reasoning": {"effort": "none"}}
```


## 0.29.2 — Finding out where the reasoning is actually coming from

The parser does not run through a Lumiverse preset. It calls the generation API
directly against a **connection**, so a preset's Reasoning / CoT panel never
reaches it. Turning API Reasoning off there is correct for the story and has no
effect on the parser.

Two changes so this stops being guesswork.

### Reasoning tokens are reported, not inferred

Every estimate so far came from subtracting visible characters from
`completion_tokens`. Providers report the real number, so LumiDraw now logs it:

```text
· tokens=7510/4100/11610 · reasoning_tokens=3508 (86% of output)
```

or `reasoning_tokens=not reported` when the provider does not send it. One scan
now answers the question outright.

### Every spelling of "reasoning off", plus an escape hatch

LumiDraw sent `reasoning: {source:'off'}` — one vendor's spelling. Providers
ignore keys they do not recognise, so all the common ones now ride together:
`source`, `enabled`, `effort`, `exclude`, `max_tokens`. If a strict provider
rejects the object, the request falls back to the minimal form once rather than
failing the scan.

For anything not covered, **Settings → Parser request overrides** takes raw JSON
and merges it into the parser request:

```json
{"reasoning": {"enabled": false}}
```

Keys replace what LumiDraw sends; a `parameters` object is merged into the
existing parameters rather than replacing them.


## 0.29.1 — Say it once, and say it in words the model knows

Two hand edits to a generated prompt produced a better image. Both are now made
by the compiler.

### The grapple was described three times

```text
statement    pins the alpha mycewolf's head against a crystal tree's roots
Rook's pose  pinning alpha's muzzle to tree root … gripping snout
relation     Rook pins the muzzle of the alpha mycewolf.
```

One grapple, three accounts, and the contact point drifts each time — head,
muzzle, snout — across two anchors, roots and tree root. Anima was being asked
to draw three slightly different holds at once.

`relationCoveredByStatement` exists to prevent exactly this, and missed by a
hair: it required 60% of the relation's content words to appear in the
statement, and `pins the muzzle of` against a statement saying `pins … head`
scores 1 of 2. A shared verb with **both subjects already named** now counts as
coverage regardless of how the contact point is worded.

Separately, a pose that names another subject is a relation written in the wrong
field. Those are now dropped from the pose clause — the relation sentence
already carries that geometry, bound to both names.

### "Mycewolf" meant nothing to anyone

A coined creature name is a dead token. The model has never seen a mycewolf; it
has seen ten thousand wolves. Coinages are almost always a real creature noun
with something welded to the front, so the real noun is recovered and used
throughout — labels, descriptions, and the scene statement alike.

Where a label contains no coinage to unpack, a creature noun is borrowed from
the subject's own appearance: `the alpha` + `large wolf` → `the alpha wolf`.

### Scenery was being rendered as anatomy

`and a cracked bark nearby` sat in the alpha's **appearance** array, so the
compiler described the wolf as having cracked bark on its body. Outfit has been
validated since 0.27.1; appearance never was. It is now — place words,
positional cues (`nearby`, `in the background`), and scenery nouns are routed
out, while anything naming a body feature stays put, so `moss-covered fur`
survives intact.

### One feature, one description

A profile and an active appearance state can each describe the same feature:

```text
before  wolf ears, animal ears, a wolf tail, a large tail,
        black fur, dark brown fur, and shaggy fur
after   wolf ears, a large wolf tail, and black shaggy fur
```

Traits are merged by their head noun. A specific modifier retires a generic one
(`wolf ears` beats `animal ears`), size and type combine rather than compete, and
**only one colour survives per feature**. Two coat colours is a coin flip the
model re-tosses every generation, which is one reason a character drifts between
images.

### The caption is a caption again

The demoted-scenery tail is capped at four phrases, and the phrases that
contributed nothing to the tag run are kept first — trimming should never delete
the only surviving copy of something while keeping a phrase the tags already
say.

Also: `a bared teeth`. `isPluralPhrase` only tested for a trailing *s*, so
irregular plurals and mass nouns got an article. `teeth`, `feet`, `bark`,
`blood`, `moss`, `ash` and friends no longer do.

### The same scene, compiled

```text
before  125 words, ending: … Rook pins the muzzle of the alpha mycewolf.
        The alpha mycewolf is on the left. Mycetheric expanse, pheromone
        grove, crystal trees, spore dust drifting, dynamic angle, pink
        grove glow, glittering spore dust, tense, visceral action.

after    88 words, ending: … head forced sideways and body writhing,
        snarling, dazed. Rook is on the right and the alpha wolf is on
        the left. Mycetheric expanse, dynamic angle, tense, visceral action.
```

37 new assertions; 518 across 22 suites.


## 0.29.0 — The tag run is made of real tags, and correct work stops being thrown away

A field run: **82.9 seconds, 22,676 tokens, zero images.** The parser had
understood the scene correctly — a partially-shifted Rook between a naked Sovi
and a circling wolf pack, setting carried forward, three subjects placed at
correct depth. Both images were then discarded by the compiler.

### Word counts were fatal; now they are repaired

- **Image 1** died because its scene statement was 19 words against a limit of
  16. Three words.
- **Image 2** died in a chain: a relation action was 10 words against a limit of
  9, so the relation was dropped, which left the image with no relations, which
  failed `missing cross-subject relation/action`. One word, via a cascade.

Counting to sixteen is not what a language model is for, and killing its correct
output when it miscounts is the worst use of tokens already spent. `shortPhrase`
now repairs in three escalating steps instead of throwing:

```text
19 words → cut at the last clause boundary that fits
           "Rook, in partial wolf form, stands between Sovi and a circling Mycewolf pack"
10 words → drop articles, which carry no visual information
           "grips fur at the small of the back of"
still over → truncate, last resort
```

The boundary chosen is the **longest** prefix that fits, not the first — the
first comma in that statement yields "Rook".

Two related floors:

- **A dropped relation can no longer kill an image.** A multi-subject scene left
  with none gets one rebuilt from the subject positions the parser already
  supplied — derived from its own data, not invented.
- **One over-long tag can no longer kill a list.** `setting` and friends now
  repair or skip a bad entry instead of throwing the whole scene away.

### The tag run was prose wearing a costume

Anima is trained on Danbooru tags. Sonnet has never been trained on which
strings *are* Danbooru tags, so asked for tags it writes plausible English. From
that same run:

```text
lighting: pink grove glow, glittering spore dust, dim undergrowth
style:    tense standoff, backlit spores
camera:   front view, wide shot
```

`backlighting` is a tag; `backlit spores` is not. `from front` is a tag; `front
view` is not. Roughly a quarter of the run was real. Since 0.28.0 put the prose
caption first, the prompt had **two prose blocks and no tag run** — the second
half was not doing the job the reorder was made for.

This is not a smartness problem and no prompt fixes it. Tags are now resolved
against a vocabulary drawn from Danbooru's own tag groups:

- **Exact match** passes through.
- **A known near-miss is rewritten** — `front view → from front`, `low crouch →
  crouching`, `snarling → clenched teeth`, `trousers → pants`. Better than
  demoting: the concept survives *and* lands in the model's vocabulary.
- **A miss is mined for the real tags inside it** — `dim undergrowth` yields
  `dim lighting` and `grass`; `backlit spores` yields `backlighting`.
- **The phrase itself moves to the caption**, where prose is understood, so your
  worldbuilding is never deleted. `mycetheric expanse` and `pheromone grove` are
  not booru tags and never will be; they belong in the sentence.

The same scene, before and after:

```text
before  sensitive, 2boys, 1other, mycetheric expanse, pheromone grove,
        crystal trees, spore dust drifting, front view, wide shot,
        pink grove glow, glittering spore dust, dim undergrowth,
        tense standoff, backlit spores

after   sensitive, 2boys, 1other, forest, crystal, tree, dust, from front,
        wide shot, glowing, dim lighting, grass, backlighting
```

A solo scene is deliberately tag-only and has no caption to demote into, so
there the phrase stays in the run — the weaker slot beats no slot.

### The instruction lost the rules the compiler already enforces

10,260 → **8,907 characters**, about 340 tokens per call. Nine rules were cut,
each one something code decides mechanically: casing and underscores
(`animaTag`), the quality/artist ban (the compiler owns that slot), hedged
prose (`normalizeVisualPhrase`), the generic-room ban (`reconcileSetting`), item
and word caps (`shortList`, and now the repair above), framing width
(`repairCameraTags`), and the anatomy field ban (`removeInventedAnatomy`).

One rule marked CUT in the audit was kept as a trim on review: `personaPovVisible`
*gates* on the POV staging cue, so a model never asked for one could never
produce a surviving `pov` tag. Cutting it would have removed POV entirely.

What remains is either enforced in code or irreducibly semantic. **A future
prompt edit can now only break a judgement call, never a guarantee.**

### Safety is the picture, not the mood

New, because the same run rated a wolf-pack standoff `sensitive`. Anima reads
the rating as an intensity dial, so that nudges an atmospheric scene toward skin
and suggestive framing for no reason. The four Danbooru ratings are now defined
explicitly, with the note that a tense, frightening, or violent scene carrying no
suggestive content is `safe`.

### The prompt has tests now

Every regression in this file's history came from editing the instruction. The
compiler had 400 assertions; the prompt had none. It now has 43:

- every semantic rule is still present, by distinctive phrase
- the instruction stays under a **9,000-character ceiling**, so growth must
  displace something rather than accumulate
- no real cast name appears in a worked example (the `counter` → kitchen class
  of priming bug)
- every "do not copy" rule is scoped and never reaches `scene_statement` — the
  exact 0.26.0 regression that deleted the thesis sentence for three versions
- no rule both forbids and requires the same field
- worked examples keep their WRONG/RIGHT shape
- each cut rule **stays** cut, so it cannot drift back and contradict the code

481 assertions across 21 suites. The original instruction is preserved at
`prompt-baseline/parser-instruction.0.27.2.txt`.

### Still worth fixing on your side

The same log shows 86% then 80% of each completion spent on hidden reasoning
that `reasoning: {source:'off'}` is not suppressing through OpenRouter. The JSON
needs ~700 tokens. Turning reasoning off on the connection — or choosing a
non-reasoning parser model — should take that call from 83 seconds to roughly
12, and the truncation retry would stop firing at all.


## 0.28.2 — Alt text broke the markdown (0.28.0 regression)

An image appeared in a story as loose text rather than a picture:

```text
![A pack of Mycewolves crouches in a loose arc among the crystal trees, watching.
sensitive, 1other, ](/api/v1/images/3ad352e9-…)
```

There is a **newline inside the alt text**. Markdown alt text must be a single
line, so the `![…]` never closes and the image cannot render.

Caused directly by 0.28.0. Alt text is the first 100 characters of the compiled
prompt. Before the reorder that prompt began with the single-line tag run and
100 characters could never reach a line break. Now it begins with the caption
and runs through the paragraph break — at exactly 100 characters, straight into
it.

Alt text is now flattened wherever markdown is built: newlines become spaces,
brackets are stripped, whitespace runs collapse, and the cap is applied after.
All four insertion paths share one helper.

Existing broken images stay broken — the markdown is already stored. Click one
and use **Fix this image…**, or delete it; new images render normally.

## 0.28.1 — A duplicate key was throwing away complete replies

`Structured scene needs at least one subject` on a reply that finished cleanly
(`finish=stop`) and contained three fully-formed images.

The first image object ended:

```json
… "aspect":"4:3"},"scene":{}}
```

Two `"scene"` keys. `JSON.parse` keeps the **last** occurrence, so the complete
scene was replaced by an empty object before any validation ran. The scene was
never malformed; it was deleted by the parse.

- **Empty duplicate keys are stripped before parsing.** An empty object or
  array carries no information in either position, so `"scene":{}` and
  `"images":[]` are dropped when they repeat a key that already has content.
- **One unusable image no longer discards the rest.** Images are independent;
  a failure is now skipped and logged, and the reply fails only when nothing
  usable survives — in which case the underlying reason is still reported.
  Three good illustrations were lost to a stray key on the first one.

Also recognised as POV staging cues, from the same reply: `hand visible only`,
`face turned away`, `only the hands visible`. `bare arm` and `bare torso` were
already rejected as clothing by 0.27.1.

## 0.28.0 — Sentence first, then tags (anima-hybrid-v14)

Prompt order is reversed. The natural-language block now leads and the tag run
follows:

```text
masterpiece, best quality, score_9, @artist. Sovi is performing oral sex on
Rook, chin tipped up. Sovi, an elf femboy with round glasses…, nude, kneeling,
tearful. Rook, a masculine adult man with…, nude, standing.

nsfw, 2boys, pheromone grove, crystal trees, from above, full body,
pink violet glow, intimate
```

A sentence naming what is happening, read first, frames everything the tags
then specify — and the tags keep full booru control over characters, clothing,
and lighting. This also matches the model card's own example shape, where
quality tags are followed by prose.

- The **quality header still leads the whole prompt** and is now separated from
  the sentence by a full stop rather than a comma, exactly as the card writes
  it: `masterpiece, best quality, @big chungus. An anime girl…`
- A tag-only scene (solo, no caption) is unchanged and still joins with a comma.
- No schema change: the parser contract is untouched.

Twelve assertions pin the order, the two-block shape, the full-stop join, and
the guarantee that character detail never appears in the tag run.

## 0.27.2 — The scene statement says what is happening again

The opening sentence was still being written, but it had drifted from naming
the act to describing a gesture: an oral sex scene opened with *"Rook tips
Sovi's chin up, forcing tear-streaked eye contact."* True, but not what the
image is of.

### The regression

0.26.0 added this to the tag rules, to stop a format example leaking into tags
as a location:

> no word used to explain a rule may be copied into your answer as if it were
> part of the scene

That is over-broad. The scene-statement examples live in the same instruction,
and they are the one place where copying the wording's shape is exactly what is
wanted. The rule is now scoped to tags, and explicitly exempts
`scene_statement`, whose examples should be imitated closely.

### The ongoing act outranks the gesture

A passage is usually one beat inside a continuing act, and the continuing act
is what the image is of. The instruction now states that plainly, with a worked
contrast:

```text
WRONG:  "[name] tips [name]'s chin up."
RIGHT:  "[name] is performing oral sex on [name], chin tipped up."
```

A hand, glance, shift of weight, or change of expression during an act is a
detail of that act — it belongs in pose, expression, or action, never in place
of the act. When the current passage alone does not reveal the continuing act,
the parser is told to consult prior context and the established scene state
before falling back to the gesture.

### Two related fixes

- **Real cast names are no longer hard-coded** into the statement examples.
  Priming the model with actual character names is the same mistake as
  `counter`; the examples use a `[name]` placeholder instead.
- **The statement can no longer silently vanish.** A sexual statement in a
  scene the parser under-rated as safe or sensitive was deleted outright,
  leaving no thesis sentence at all. It is now rebuilt from the characters
  present and the core action, so every prompt still opens by saying what is
  happening.

## 0.27.1 — Phantom limbs: three compiler faults

A field prompt contained `wearing a bare hand`, described a viewer's hand and
the character's own hand in the same clause, and asked for `pov, full body,
from above` simultaneously. Extra limbs were the predictable result. All three
are compiler faults.

### Outfit is now validated as clothing

`bare hand` reached the outfit array and the compiler rendered outfit as
"wearing X" without ever asking whether X could be worn. Telling an image model
that a man *wears a hand* is a request for a spare one.

Outfit entries are now checked: garments and bare-states pass, body parts,
staging cues, and verb phrases are dropped.

### POV staging cues no longer describe bodies

The schema asks the parser to record POV cues — "viewer hands visible", "face
out of frame" — in the persona's pose or action, because that is the only place
it can put them. The compiler then rendered them as descriptions of that
character, so a single subject was described as having a viewer's hand *and* a
thumb tracing a jaw: two hands, one of which belongs to the camera.

Those cues are now consumed rather than described. They still prove the shot is
POV — which is what they were for — and never reach the caption.

### POV framing is no longer widened

`pov, full body, from above` asks for three incompatible cameras. The `full
body` came from 0.26.0's camera repair, which widened the frame to reach a
kneeling figure's legs without noticing the shot was POV. Framing is never
widened while `pov` is present, and a conflicting wide framing already in the
list is removed.

The reported prompt now compiles without any of the three faults: no worn hand,
no viewer's hand in the description, and `pov, from above` with no framing
conflict.

## 0.27.0 — Established scene state

Why the parser lost the location at all: it is a separate, stateless request.
It never sees the chat. Its entire world is the system instruction, the current
passage, and a recency window of up to four prior messages capped at 3,000
characters — and during a long scene the prose stops naming the location
precisely because everyone already knows it. The window goes blank on exactly
the fact the schema still requires, so the parser fills the gap.

A sliding window is the right instrument for what just changed — pronouns,
contact, who moved — and the wrong one for stable facts. Those need memory.

### Scene state, supplied outright

LumiDraw now keeps a per-chat record of the established location and lighting,
and hands it to the parser on every request as a short authoritative block:

```text
----- ESTABLISHED SCENE STATE — AUTHORITATIVE -----
Location: mycetheric grove, pink bioluminescent mushrooms
Lighting: bioluminescent glow
```

It costs a few dozen tokens, is always present regardless of how far back the
location was last mentioned, and states plainly that the place may only change
when the current passage says the characters moved. The record updates itself
from each successful scan, using only values the text supported — so a genuine
move is followed, and an invented one never enters the record.

### Scene anchor

Presets gain a **Scene anchor**: the story's default location, as tags. It
seeds a fresh chat, and acts as the fallback whenever nothing else has
established a place — author-declared canon underneath the automatic record,
matching how character profiles already work.

This supersedes the Loom ledger as the continuity mechanism. The ledger
required the roleplay model to emit a block every turn; this requires nothing.
Ledger support remains for anyone using it.

## 0.26.1 — The location arrived through the lighting field

The 0.26.0 setting firewall guarded `setting`. The kitchen was never in
`setting` — the parser wrote **"kitchen lighting"** three times across three
images, and the location rode in through a field nothing was checking.

Worse, the support test had a hole that would have let it through even in
`setting`: it accepted a tag when ANY of its words appeared in the passage, and
that passage reads *"pink mushrooms **lighting** the moss"*. "kitchen lighting"
would have matched on "lighting".

- **Place words are now checked specifically.** A tag containing a location
  noun is trusted only when that noun itself appears in the text — a
  neighbouring word can no longer vouch for it.
- **Every atmosphere field is guarded**, not just `setting`: lighting, style,
  camera, and relation details. A tag naming a place the story never mentions
  is dropped whole, because "kitchen lighting" minus "kitchen" is not a
  lighting instruction. Genuine lighting alongside it survives untouched.
- Drops are logged with the field and the offending tags.

Your case now compiles to `mycetheric grove, glowing moss, wide shot,
blue-white bioluminescent glow` — both kitchen variants gone, the real glow
kept.

## 0.26.0 — Setting continuity, camera repair, tighter captions

### The story stays where it is

A scene set for its entire length in a bioluminescent mushroom forest compiled
with the setting **kitchen**. Two causes, both ours.

The parser instruction demonstrated tag formatting with the words
`"sitting", "counter", "from side"` — handing the model a piece of indoor
furniture as an example — while simultaneously *requiring* at least one setting
tag. An uncertain parser reached for the nearest primed word, and "counter" is
one step from "kitchen". Format examples are now abstract, and the instruction
states that a setting must come from the passage or the established location,
that a story continues where it was unless it says otherwise, and that generic
rooms are never an acceptable fallback.

Prompt wording alone is not a guarantee, so there is now a **setting
firewall**. A setting tag is trusted only when the text supports it:

- When nothing offered is supported by the passage or recent context, the
  scene keeps the location the chat already established.
- A generic room riding along with genuine tags is dropped on its own.
- A real move ("they crossed the stone bridge") is honoured normally.
- The established location is remembered per chat, so continuity survives
  across messages.

This is the field-level inheritance Inlay Illustrator uses for character
attributes, applied to place.

### Camera repair

A framing tag is a promise about what the viewer can see, and the parser
frequently broke it — a close-up on a scene whose meaning is at the hips, or a
from-behind angle on a moment defined by a facial expression. Instructing the
parser to "choose framing wide enough" was unreliable.

The compiler now derives which body regions the scene actually requires (face,
hands, hips, legs, feet) from its poses, expressions, actions, relations, and
visible anatomy, then compares them against what the chosen framing reveals.
Framing is widened to the narrowest tag that shows everything required, and a
face-defining moment shot from behind gains `looking back` — keeping the
author's angle rather than overriding the composition. Scenes that need
nothing special are left alone.

### Captions read like captions

Each subject was three narrative sentences: *"Sovi is an elf woman with… Sovi
wears… Sovi is standing and laughing."* About a third of that is copulas and
connectives carrying no visual information, and on a model that degrades with
prompt length that is pure cost. Subjects now compile to a single appositive
phrase — *"Sovi, an elf woman with…, wearing…, standing, laughing."* — matching
the register of Anima's own documented example. A representative two-character
caption drops from roughly 410 to 343 characters with no information lost.

### Filler no longer reaches the model

`unknown`, `unspecified`, `not specified`, `n/a`, `default clothing`, `none`,
`tbd` and similar are dropped wherever they appear. A placeholder is the
absence of a value, not a value; some of them are also real words Anima will
try to draw.

## 0.25.0 — Partial features (anima-hybrid-v12)

A passage said a werewolf character "slightly changed" — one feature, not a
transformation — and the image came back as a full hybrid werewolf.

That was not a parser mistake. Appearance states are all-or-nothing: exactly
one is active and it defines the whole look. Asked to represent a partial
change, the parser's only options were the fully human state (no wolf at all)
or the hybrid state (ears, muzzle, furred arms, claws, tail). It chose the
closest available option, which was far too much. The data model had no way to
express the truth.

### Partial features

Character and persona profiles gain **Partial features**: a vocabulary of
atomic, named traits that can show *without* changing state.

```text
wolf eyes = yellow eyes, slit pupils
claws = claws, elongated nails
fangs = fangs, sharp teeth
```

The parser may switch these on per subject while leaving `appearance_state`
alone, so a character shows wolf eyes while remaining, in every other respect,
the human man his state describes. Its instructions now say plainly that a
partial change — "slightly", "partly", "just his eyes", "beginning to" — must
use these rather than a state switch, and that switching state transforms the
whole character.

- **Only saved names resolve.** A feature the parser invents is dropped, and
  anatomy terms cannot be smuggled in through this route; the profile is the
  only source of truth.
- **Several features can be active together**, layered onto whichever state is
  current.
- Active feature tags are treated as legitimately present, so the form
  firewall never scrubs them as inactive-form vocabulary.
- A full, completed transformation still uses `appearance_state` exactly as
  before.

## 0.24.1 — "Unrecognized response shape" was a lie

Fixes `Parser returned an unrecognized response shape:
content,reasoning,finish_reason,tool_calls,reasoning_details,usage`.

The shape was recognised perfectly well — `content` is the first field
LumiDraw reads. It was **empty**. The reasoning model had spent its entire
completion budget thinking and emitted no visible text, and a truthiness check
(`res.content || res.text || …`) skipped the empty string and fell through to
"nothing matched". The message blamed the wrong thing and hid a cause we had
already met twice, in its most extreme form: 3,450 completion tokens spent,
zero characters returned.

- **Empty is no longer confused with unknown.** Text extraction accepts only a
  non-empty string, so an empty `content` correctly falls through to later
  candidates, and a reply that genuinely has a known shape but no text is
  reported as such instead of as an unrecognised shape.
- **Reasoning is searched before giving up.** Reasoning models sometimes leave
  the JSON in `reasoning` / `reasoning_details` without ever emitting final
  content. If that text contains the contract's payload it is used.
- **An empty reply retries like a truncated one**, with a markedly larger
  allowance (double the observed spend, minimum +4,800, capped at 16,000),
  since an empty reply proves reasoning consumed everything.
- **The final error names the real fix.** If it still returns nothing, the
  message states how many tokens were spent on reasoning and says to turn
  reasoning off for that model on its Lumiverse connection, or choose a
  non-reasoning parser model in Settings.

## 0.24.0 — Every Draw Things setting, edited in Studio

Studio previously exposed six settings — model, sampler, steps, CFG, width,
height — plus LoRAs. Everything else (shift, high-res fix, refiner, upscaler,
seed mode, tiling…) could only reach LumiDraw by being changed inside Draw
Things and re-synced, and a fixed ten-key whitelist silently dropped most of
it on the way to generation.

Studio is now the full workbench: generate freely with every setting, then save
the result to a preset.

### All settings, edited in place

A **Draw Things settings** card in the Tune pane generates a control for every
setting the last Sync reported, grouped into Sampling, Refiner, High-res fix,
Upscaling, Guidance, Tiling, Masking, and everything else.

Controls are generated *from the synced config* rather than a hard-coded list.
That matters twice over: the key names are always Draw Things' own rather than
guesses, and a Draw Things update that adds a setting makes it appear here
automatically. Curated entries add friendly labels, sensible steps and ranges,
and dropdowns; anything uncurated is typed from its value — checkbox for
booleans, number input for numbers, JSON editor for structures.

Any `*_model` setting (refiner, upscaler…) gets a dropdown from the Bridge
catalog, so no more typing case-sensitive checkpoint filenames.

### Nothing is dropped on the way out

- **Sync captures the whole config**, not a ten-key slice.
- **Generation sends the whole workspace.** The payload builder no longer
  filters against a whitelist.
- `prompt`, `negative_prompt`, `seed`, and `batch_count` stay owned by
  LumiDraw and cannot be overridden by a config or extras block — a preset
  cannot silently re-prompt or re-seed a story image, and `batch_count` stays
  pinned at 1.
- `0` and `false` are real values and are sent; only empty strings and nulls
  are omitted.

### Rejected settings say what and where

Draw Things refuses unknown payload keys by name. That error is now translated:
it lists the exact settings refused, says to clear them in Studio → Draw Things
settings, and notes the usual cause — a setting that exists in the Draw Things
interface but not in its generation API, or a Draw Things older than the
setting. The generation fails rather than silently dropping the value.

## 0.23.1 — Directive detection made conservative

The 0.23.0 classifier could misjudge a real image as a directive. It required
an "id-like" segment of eight or more consecutive alphanumerics, which ordinary
filenames do not have (`scene.png`), and it accepted a verb anywhere in the
path, so a file stored under a folder named `gen`, `new`, or `create` was
condemned by its parent directory (`/media/gen/render-4471.webp`).

Such an image was never deleted — stored messages are untouched — but it would
have been hidden from the model, which is the wrong outcome.

Detection is now conservative: a URL ending in a filename is always a real
image, only a path that ENDS at a bare verb is a directive, and anything
unrecognised is left alone. A missed directive is harmless; a real image
wrongly classified is not.

## 0.23.0 — Hide dead image-request directives from the model

Other image integrations teach the model to *request* a picture by writing
markdown whose href is a fixed endpoint rather than a stored file — for
example `![tags](/api/v1/images/gen)`. Those never render, and each one left
in the history is a few-shot example teaching the model to write another, so
they breed. When such a preset is active alongside LumiDraw the model also
blends the two conventions, taking LumiDraw's danbooru tag vocabulary and the
other integration's markdown wrapper.

A new Settings option, **Hide dead image-request directives from the model**
(on by default), removes them from the conversation sent for each generation.

- **Stored messages are never modified** — this edits only the copy handed to
  the model for that request.
- **Deliberately narrow.** A markdown image is removed only when its URL is a
  bare endpoint. Anything carrying an identifying segment — LumiDraw's own
  images, uploads, `data:` URLs, external links — is always left alone, so a
  working SwarmUI-style setup in another chat is not sabotaged.
- Removals are logged (`removed N dead image-request directive(s)`).
- Turn it off in Settings if you want the raw history passed through.

LumiDraw's parser input already stripped markdown images, so these directives
were never reaching scene extraction; this addresses the prompt side only.

**A host regex script is the stronger fix** if the directives are still being
generated: a Find & Replace rule on the **Response** pipeline stops them being
saved at all, where this setting only hides what is already there.

## 0.22.6 — The viewer no longer implies an accept step

**Regeneration has no accept step.** "Regenerate & replace now" both generates
the image and swaps it into the story message in place. When the new image
appears, the work is already done — close with **Done**.

The old button row invited the opposite conclusion. Next to "Fix this image"
sat **Insert into chat**, which reads like "accept this image" but actually
adds a *second* copy at the top of the latest message — producing exactly the
"a new image appeared at the top and the old one is still there" outcome, from
a button press that seemed like the natural way to confirm.

- **Insert into chat → "Add copy to chat"**, with a tooltip stating what it
  does and that it is not needed after a regeneration.
- **Confirmation before duplicating.** Adding a copy of an image that is
  already placed in a story message now asks first, and points at
  "Fix this image…" as the way to replace rather than duplicate.
- **The fix panel states its contract up front** ("one button does everything;
  there is no separate accept step") and, on success, says the replacement is
  complete, in its original position, and explicitly warns against pressing
  "Add copy to chat" afterwards.

## 0.22.5 — Replace the right image, and keep it where it sits

A regeneration replaced the wrong illustration: the new image appeared at the
top of the message while the failed one stayed put. Image placement at the
right story beat is the whole point of the parser's anchor logic, so this was
worse than a cosmetic slip.

**Cause.** Alt text is the first 100 characters of the compiled prompt, so two
illustrations from the same scene in one message share an opening. Both alts
appear inside the recorded prompt, the 0.22.4 lookup matched several, and it
replaced the first — the topmost image — rather than the one being fixed.

- **The exact alt is now recorded** with every generated image and used to
  identify it, so a shared prefix no longer causes a collision.
- **Ambiguity refuses to act.** When the exact image still cannot be
  identified, nothing is replaced and the panel says so. A wrong swap destroys
  a good image and moves an illustration away from its story beat; leaving the
  new image in History is strictly better.
- **Clicking the image in the chat now works on rebuilt chats.** Chat images
  are matched to History by alt text as well as URL, so the click handler
  fires even after the host has rewritten every URL. The clicked image's
  current URL is sent with the regeneration and used as the authoritative
  target — no inference at all, and it is the reliable way to fix one specific
  image in a message that holds several.
- Replacement continues to swap only the URL inside the existing markdown, so
  the image keeps its exact position between the surrounding paragraphs.

## 0.22.4 — Alt-text matching survives the host's chat rebuild

The 0.22.3 forensics identified the real cause of "image not found": the
host's chat rebuild ("Surgically rebuilt chat … re-chunked") canonicalizes
image markdown to `/api/v1/images/<uuid>` — with **freshly minted uuids**. The
URL, filename, and upload id LumiDraw recorded at generation time no longer
appear anywhere in the stored message text. No identifier-based match can
survive that.

One thing does survive the rebuild: the alt text, which LumiDraw itself wrote
as the first 100 characters of the compiled prompt — and the full prompt is in
History.

- **Tier-2 lookup by alt text.** When no recorded identifier matches, the
  lookup scans markdown images whose alt text appears verbatim inside the
  recorded prompt (normalized, minimum lengths enforced). The replacement is
  then applied to whatever URL that image currently carries — the canonical
  `/api/v1/images/<uuid>` form included.
- **Refuses to guess.** Prompt prefixes are similar across images from the
  same preset, so an alt match that is ambiguous across several messages is
  rejected rather than risking a wrong swap that would destroy a good image.
  The recorded message id resolves the ambiguity when available (all images
  generated on 0.22.0+). Multiple same-prefix images inside one message are
  logged before the first is replaced.
- Short prompts and short alts can never trigger alt matching, so generic
  images ("Generated image") cannot false-positive.

## 0.22.3 — Encoded URLs, and forensics for the not-found case

Follow-up to a field report where the right chat was searched (51 messages)
and none of the four identifiers matched — the stored message text holds the
image reference in some other spelling.

- **Encoded-content matching.** The lookup now normalizes message text before
  matching (HTML entities such as `&amp;`, markdown escapes such as `\_` and
  `\(`), and the replacement tries every encoded spelling of the identifier —
  including entity encoding and markdown escaping applied together — so a URL
  the host re-encoded on save is still found and still swapped.
- **Forensics.** When the image genuinely cannot be found, both the panel note
  and the Terminal line now include a sample of the image references that ARE
  present in the scanned messages, next to the identifiers that were searched
  for. "Not found" is now a visible diff between what LumiDraw expected and
  what the host actually stores, which is exactly what is needed to close the
  remaining gap if one exists.

## 0.22.2 — Finding the image to replace

Fixes `Generated, but the original image is no longer in any visible message`.

Locating the image to replace relied on an exact, full-URL string match against
message text, and searched only the recorded chat and the active one. That is
brittle: the host may rewrite the markdown it stores, proxy the path, or drop a
query string, and the image may live in a chat that is not currently open.

- **Match on stable identifiers.** The lookup now also matches the URL without
  its query string, the filename, and the upload id — any one of which is
  enough to find the message. The replacement is then applied to whichever
  identifier actually matched, so a rewritten URL is still swapped correctly.
- **Search more chats.** After the recorded and active chats, any other chat
  the host will list is searched too.
- **Say what happened.** When the image genuinely cannot be found, the panel
  now reports which chats were searched and how many messages each held,
  instead of a bare "no longer visible", and the Terminal logs the exact
  identifiers that were tried (`[lumidraw] image not found in any message`).
  When a match is found by something other than the full URL, that is logged
  too.

## 0.22.1 — Regeneration could not find the chat

Fixes `Generated, but replacing it in the message failed: updateMessage failed:
Chat not found | Chat not found | Chat not found`.

When the image lookup searched the active chat, it passed an empty chat id to
`fetchMessages`, which resolves it to the real one and reports which it used —
but that resolved id was discarded. The empty value then reached
`updateMessage`, whose three chat-scoped call shapes are guarded by
`if (chatId)` and were skipped entirely; the three remaining chat-less shapes
each answered "Chat not found", producing exactly the three errors above.

- The resolved chat id is now carried back from the lookup and used for the
  update.
- As a backstop, a missing chat id is resolved from the active chat before
  updating, and a genuinely unresolvable one now reports that plainly instead
  of failing three times over.
- When the same image appears in more than one message, the recorded message
  is preferred rather than whichever was found first.

## 0.22.0 — Fix a failed image instead of deleting it

A generation that comes out wrong no longer has to be thrown away. Click any
LumiDraw image — in the chat transcript or in the History panel — to open it in
the viewer, edit the prompt that produced it, and regenerate. The new image
replaces the old one in the story message, in place.

### Fixing an image

- **Click to open.** A delegated click handler opens any image LumiDraw
  generated in the viewer, with the fix panel already expanded. The handler is
  deliberately narrow: it only intercepts URLs that appear in LumiDraw's own
  history, so avatars, host UI, and unrelated images behave exactly as before.
  Fixable images get a zoom cursor.
- **Edit before regenerating.** The compiled prompt is loaded into an editable
  textarea, alongside the negative prompt and a seed control.
- **Seed reuse is the default** when the original seed is known: holding the
  seed steady keeps the composition and shows what your prompt edit actually
  changed. Uncheck to roll a fresh image. When the original was generated with
  a random seed, the control says so and is disabled.
- **Replace in place.** Only the image URL inside the markdown is swapped —
  alt text, surrounding prose, and sibling images in the same message are
  untouched.
- **The original is kept in History**, so a failed attempt is still there to
  compare against or fall back to.
- After a successful regeneration the viewer re-points at the new image, so a
  still-imperfect result can be fixed again immediately.

### Exact recipes

History entries now record the recipe an image was made with (full config plus
extras) and its origin (message, chat, content key, preset). A regeneration
reuses the original recipe, so editing a preset in between does not silently
change the model, sampler, or size of the replacement. Where no recipe was
recorded — images from older versions — it falls back to the originating
preset, then the active one.

The owning message is found by scanning for the image URL rather than trusting
the recorded id, which also covers pre-generated images whose message did not
exist yet when they were made. If the message has since been deleted or edited
beyond recognition, the new image is still generated and kept in History, and
the panel says exactly that instead of failing silently.

## 0.21.1 — Form firewall (anima-hybrid-v11)

Field failure: a werewolf character in **human** form still put wolf traits in
the prompt, and an unrelated elf character came out as a wolf boy with ears and
a tail.

### Root cause: substring state matching

Appearance-state recognition matched with a plain substring test, so the state
named "Wolf" matched inside the words "werewolf" and "wolfish". A passage that
merely *called* the character a werewolf — or described a wolfish grin — flipped
him into full wolf form and injected fur, ears, and a tail.

Matching is now whole-word, and a multi-word cue ("wolf form", "fully shifted")
outranks a bare one-word state name, so narration about a wolf elsewhere in the
scene cannot transform the character.

### Form firewall

Even with correct state selection, one loose "wolf ears" anywhere in a
multi-character prompt is enough for Anima to hang it on the wrong character.
So, mirroring the existing anatomy firewall, the vocabulary of every **inactive**
form is now banned from the entire scene — not just from its owner:

- Words and two-word phrases drawn from each inactive state's name, recognition
  cues, subject phrase, and appearance tags are collected.
- Anything legitimately visible in the scene (any subject's active noun,
  appearance, or outfit) is subtracted, so shared vocabulary is never lost —
  an elf's "pointed elf ears" survive a werewolf's "wolf ears" being banned.
- The remainder is scrubbed from scene_statement, core_action, relation actions
  and details, setting/camera/lighting/style, and every subject's tags.
- Tags containing banned vocabulary are dropped whole rather than mangled;
  sentences are scrubbed and re-tidied.
- Characters with fewer than two appearance states are untouched — a plain
  werewolf with no forms stays a werewolf.

The parser is also told directly that being called by species, a past or future
transformation, or a figure of speech is not a transformation, and that a
character's inactive-form vocabulary must not appear anywhere in its JSON,
including `scene_statement`.

## 0.21.0 — Character Library and multi-character casts

Characters get the same reusable-library treatment personas have had since
0.19.0, and presets scale past the fixed character + persona pair.

### Reusable character library

A new Character Library sits alongside the Persona Library on the Presets tab,
sharing the same editor (identity, permanent appearance, default outfit,
appearance states/forms, named props, conditional anatomy). Save a character
once, then link it anywhere:

- **Main character slot** — a preset's main character can now link a library
  character (mirroring the persona link). Swap image parameters freely; the
  character definition lives in one place and edits apply to every linked
  preset on the next parser run.
- **Additional cast** — a preset can add up to 4 more saved characters beyond
  the main character and persona, for a maximum of six profiled subjects.

### Named cast refs through the whole pipeline

Each cast member gets a ref derived from their name ("maren", "old_hendrick"),
listed in the parser contract next to character and persona. Cast members are
first-class: locked profiles injected by the compiler (the parser is forbidden
from describing their permanent appearance), appearance states, named props,
conditional anatomy rules and the anatomy firewall, natural-language identity
binding in multi-subject captions, and count-tag aggregation ("2girls, 1boy")
all work identically for them. A parser that emits `other_1` with a matching
label still rebinds to the saved cast member automatically.

The parser illustrates whoever appears in the passage — cast members absent
from a scene are simply not drawn, so a large cast costs nothing until they
show up.

### Format notes

- Preset fields: `characterLibraryId` (main-slot link) and `castLibraryIds`
  (array, additional members). Both empty by default; existing presets are
  unchanged.
- Subject labels are now required only for anonymous `other_N` refs; named
  refs carry their identity in the ref itself.

## 0.20.4 — Scan watchdog: no more immortal timers

Field failure: the Story panel showed "Starting message … · 2130s — Preparing
story message." — a scan pinned at its first stage for over half an hour, with
the elapsed counter climbing forever. Worse than cosmetic: the stuck scan held
the single scan lane, so every subsequent scan was rejected as "already
running" until the extension was reloaded.

Root cause: the chat-read RPCs used to locate the story message had no
timeouts, so one hung host call blocked the scan before its own parser/
generation timeouts ever applied; and the panel timer ticks on local time,
only stopping when a terminal status arrives — which a hung or restarted
backend never sends.

- Every chat-read RPC (`getMessages`, active-chat resolution) now has a
  10–15 s timeout.
- A stage-aware watchdog guards each scan: "starting" may take 90 s, parsing
  its own timeout plus margin, compiling 60 s, generating 20 min, 30 min
  absolute cap. On breach it aborts the scan, emits a terminal error status
  itself (a truly hung promise never reaches its own error handler), and
  releases the scan lane.
- A scan the watchdog has declared dead cannot resurrect the panel widget if
  its hung promise settles minutes later.
- If a dead scan is still holding the lane when a new scan arrives (including
  lanes stuck from before this version), it is evicted and the new scan
  proceeds.
- The backend heartbeats every running scan every 10 s; the panel now marks a
  scan dead and stops the counter after 45 s of silence instead of counting
  into eternity.

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
