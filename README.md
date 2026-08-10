# LumiDraw Studio 0.38.1

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.38.1 — The field's own hint gave the wrong advice

0.38.0 shipped **Name in prompts** with the placeholder `Fanny Price` and the
hint *"A full name usually fixes it."* Both are the thing that does not work,
written before I understood why.

Placeholder is now `Price`, and the hint says what is actually true:

> Only needed when the name means something to the image model. "Fanny" is booru
> slang for a body part, "Rose" draws roses. Adding a surname does NOT help —
> the model matches tokens, not words, so "Fanny Price" still contains "fanny".
> Use a name with no trace of it: Price, or anything neutral. Leave blank
> otherwise.

The trace warning carried the same bad advice and now points at the field
instead.

### How the three name fields differ

| Field | Used for | Fanny's |
|---|---|---|
| **Library name** | finding the entry in your list | `Fanny Price` |
| **Anchor / name** | what the story calls her — how the parser recognises her in a passage, and how relations refer to her | `Fanny` |
| **Name in prompts** | what the image model is told, and nothing else | `Price` |

Only the third reaches Draw Things. Leave it blank and the anchor is used, which
is right for almost every character.


## 0.38.0 — When a character's name is also a thing

A character called Fanny produced nonsense, because `fanny` is booru slang for a
body part and Anima drew the body part. Changing the name to **Fanny Price** did
not help, and `Fanny_Price` would not either.

**A text encoder matches tokens, not words.** The `fanny` token is still there
in "Fanny Price", contributing exactly as much as it did alone. Putting another
word beside it neutralises nothing, and an underscore is converted to a space
before the model ever sees it.

The only fix is not to send that token.

### Name in prompts

Characters and personas gain an optional **Name in prompts**. Blank means use
the real name. Set it to anything unambiguous — `Price` on its own works — and
the image prompt uses that throughout while your story keeps the real name. The
prompt name exists only to bind traits to one subject consistently; the model
never needed the real one.

### Detection, so you are told rather than left guessing

A name is checked word by word against booru slang, the tag vocabulary, and a
list of given names that are strong visual nouns:

> rose · lily · iris · violet · jade · ruby · pearl · amber · holly · ivy ·
> daisy · poppy · willow · robin · raven · wren · fox · wolf · star · river ·
> dawn · summer · ginger · honey · angel · hunter · ash · briar · thorn …

A character called Rose gets roses in the picture. The trace says so:

```text
! prompt name · Rose — "rose" is also an object the model will draw, so the
  model may draw that instead of the character. Set a prompt name on this
  character — a full name usually fixes it.
```

And a prompt name that keeps the problem is refused rather than trusted:

```text
! prompt name · Fanny — "Fanny Price" does not fix it — "fanny" is booru slang
  for a body part. A text encoder reads tokens, not words, so adding a surname
  leaves the problem word contributing exactly as before.
```

### The statement had to be rewritten too

The first version substituted the name in the identity clauses and missed the
**scene statement**, which is the parser's own prose — leaving `Fanny` at the
very front of the prompt, its strongest position. Caught by a test asserting the
name appears nowhere in the output, not merely that the substitute appears
somewhere. Worth the distinction: the first assertion passed.

29 suites · 735 assertions.


## 0.37.1 — The learned list was probably not being saved

"Will it do the self-healing after every update and restart?" It should not, and
it very likely would have.

The rejected-settings list was written with `spindle.storage.get` and
`spindle.storage.set`. Those calls appear **nowhere else** in a file that uses
`getJson` and `setJson` thirteen times each — and they sat inside a silent
`try {} catch {}`, so a write that never happened looked exactly like one that
did.

The only symptom would have been the retry rounds reappearing after every
restart, which is precisely the question that prompted this.

Now on `getJson`/`setJson` like every other store here, and no longer silent:

```text
remembered 3 refused Draw Things setting(s); 3 total. This survives restarts
and updates — clear it in Settings after a Draw Things update.
```

A failure to save says so loudly instead of pretending:

```text
COULD NOT SAVE the rejected-settings list (…). Draw Things will refuse the
same settings again after a restart. This is worth reporting.
```

### What to expect

- **Once per setting, ever** — not once per restart.
- **A new Sync can add more**, but only genuinely new ones.
- **Settings → Settings Draw Things refused** shows the list. If it still lists
  keys after restarting Lumiverse, persistence is working.

Six assertions check the source directly: no plain `get`/`set` remain, the list
round-trips through `getJson`/`setJson`, and both failure paths report rather
than swallow.

**28 suites · 711 assertions.**


## 0.37.0 — Sync converges in one generation, not four

Three different Draw Things rejections in one evening, all from the same place:

```text
Unrecognized keys: [tiled_decoding]
Value for tea_cache_end must be between 0 and 1000, inclusive (was -1)
More than one key for Compression Artifacts specified
  (must only specify one of ["compression_artifacts", "compression_artifacts"])
```

### The design flaw underneath

**Sync reads `GET /`, which returns Draw Things' full internal configuration.
That is not the same shape as what its generation API accepts.** Full
pass-through was built on the assumption that it was — my assumption, and the
reason a fresh Sync can immediately stop working.

The read format carries settings the write API has never heard of, values that
are only meaningful internally (`-1` for "off"), and more than one spelling of a
single setting.

### One setting, two spellings

`compression_artifacts` and `compressionArtifacts` are distinct JavaScript keys
and the same Draw Things setting — the giveaway is the error printing the
canonical name **twice**. Sync captures snake_case; a preset's extras can hold
camelCase; both survive into one object and neither looks wrong.

`buildPayload` now collapses keys that normalise to the same setting, keeping
the later assignment so the visible workspace still wins.

### Converging in one generation instead of four

Draw Things reports only the **first** key it trips over. Retrying once meant a
config with four unusable settings needed four failed generations before it
settled — which is what "I clicked Sync and now it won't generate" actually
looked like.

The retry now loops while each attempt names something new, up to five rounds,
dropping only keys the payload actually contains. A key Draw Things names that
we never sent is reported rather than retried — that setting is active in the
app itself, not in the request.

Combined with 0.36.3, all three rejection shapes now feed the same machinery:
learn the key, drop it, retry immediately, omit it from then on.

### The runner earned itself

The three assertions for this landed below `dtkeys.mjs`'s summary and would have
gone uncounted. `run-all.mjs` caught it on the first run — the fifth instance of
this mistake in the session and the first one I did not have to find by hand.
Its check reads the source rather than the output, because assertions that only
print on failure are invisible to any output-based guard.

**28 suites · 705 assertions.**


## 0.36.3 — A recognised key with an unusable value

```text
Draw Things rejected the generation:
Value for tea_cache_end must be between 0 and 1000, inclusive (was -1)
```

0.36.2's self-healing did not fire, because Draw Things refuses a payload in two
different ways and only one was being read:

```text
Unrecognized keys: [tiled_decoding]      ← the key does not exist
Value for tea_cache_end must be …        ← the key exists, the value does not work
```

`tea_cache_end` is a real setting. `-1` is what Draw Things stores internally for
"off", and its generation API will not accept that. We captured it verbatim on
Sync and sent it straight back — full pass-through faithfully returning a value
that is valid as app state and invalid as API input.

Both shapes now feed the same machinery: the key is dropped, the generation is
retried immediately, and it is omitted from then on. Dropping beats guessing a
replacement, because an absent key leaves Draw Things on its own setting —
which is what `-1` meant to begin with.

Also parsed: `Invalid value for X` and a bare `X must be between …`. Prose that
merely contains "must be" names nothing.

The error text explains this case on its own terms rather than talking about
unknown keys.

### And the runner caught itself again

The ten new assertions ran but were **not counted** — `dtkeys.mjs` printed its
summary above the appended block, so the total stayed at 12 while 22 executed.
Green, correct, and silently understating itself.

`run-all.mjs` now also requires the summary to be the **last** line, not merely
present. A suite whose summary sits mid-file reports as broken. That is the
fourth variant of this one mistake in a session, and the runner has now caught
two of them itself.

**28 suites · 694 assertions.**


## 0.36.2 — A dropped socket no longer costs a whole scan

```text
story scan stage · parsing · 28ms   · Waiting for the selected parser model.
parser request started · deepseek
story scan stage · error   · 72ms   · The socket connection was closed unexpectedly
```

Forty-four milliseconds between opening the request and the connection dying.
That is not a timeout, a refusal, or a bad reply — the request never landed.
Nothing was generated and nothing was billed, and LumiDraw threw the entire
scan away over it.

The existing retry only covers a truncated or empty reply, which is a response.
A dropped connection is the absence of one, and it now gets **two retries with a
short backoff** (1.2s, then 2.4s) before giving up. Failing three times reports
that it is the provider or the network rather than the extension, with where to
look.

Deliberately narrow — a timeout, a cancelled scan, an abort, and every
content-level failure are excluded. Only connection-level messages qualify:
socket closed, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `fetch failed`, `terminated`.

11 assertions cover both directions, because a retry loop that fires on the
wrong error is worse than none.

### The test runner was lying, three times over

Those 11 assertions did not run when I first wrote them. `resilience.mjs` had a
`process.exit(fail ? 1 : 0)` in the middle of the file, so an appended block
below it was never reached — 7 assertions, exit code 0, and my verification was
"read the last line of the output", which cannot tell *passed* from *never ran*.

`directives.mjs` had the same shape, and had been reported green all evening
while a third of it never executed.

There is now a `run-all.mjs` that checks the exit code, **requires a summary
line as the final output**, and prints per-suite assertion counts so a suite
that quietly shrinks is visible. It found both files on its first run.

This is the same blind spot as the two duplicate-call-site bugs earlier: a
verification that matches on text rather than on structure. Reading a tail is
not a test result.

**28 suites · 684 assertions · all green** — the real number, checked properly.

### Not the previous release

Worth recording, since the timing pointed at it. Everything 0.36.1 changed
worked in that same log:

```text
removed 29 image reference(s) from the prompt context
parser trigger protocol injected (396 chars)
auto trigger queued
```

Interceptor fine, strip fine, trigger fine. The failure was one layer further
out.

### Unrelated but visible in that log

Prompt assembly took **53.7 seconds** before the request was even made —
`databank-embed` 53.5s, `world-info-vector` 32.7s. That is Lumiverse-side and
worth watching; a host under that much strain is also more likely to drop a
socket. The runner also reports being 3 commits behind.


## 0.36.1 — The story model had learned to fake our markdown

Image markdown appeared in the roleplay again, and the images behind it did not
exist — not broken, not deleted, **never generated**. Five tags in one message,
three real and two with nothing behind them.

That rules out every rendering explanation. Markdown with no image means
somebody wrote markdown without generating an image, and LumiDraw only ever
writes one after a successful upload.

### The loop

`looksLikeImageDirective` decided what to remove from the prompt context, and
only recognised URLs ending in a bare verb:

```js
const DIRECTIVE_ENDPOINT_RE = /(?:^|\/)(?:gen|generate|create|render|txt2img)$/i
```

A real image ends in a **UUID**. So `/api/v1/images/facd6bb2-…` was not a
directive, not a filename, and fell through to "leave alone" — meaning every
image LumiDraw inserted stayed in the context sent to the story model on every
following turn.

Two or three examples per message, turn after turn, is a demonstration. The
model learned the pattern and started producing it: correct syntax, ~100
character alt text copied from ours, and a UUID it invented.

It got worse tonight because **0.35.2 made the minimum image count work**. More
images meant more examples meant faster imitation.

### The fix

Any URL on the host's image endpoint is now removed from the prompt context
alongside the directive shapes. External images, `data:` URIs and user
attachments are untouched, and this only ever edits the copy sent for a
generation — the stored chat keeps its images.

### An assertion inverted on purpose

`directives.mjs` asserted *"a message of only real images is untouched"*. That
encoded the exact behaviour that caused this. It now asserts the opposite, with
the reasoning written next to it, because a test that documents a bug as
intended behaviour is worse than no test.

### One tradeoff

A vision-capable story model can no longer see previously generated images in
its text context. Lumiverse passes attachments separately so this should not
affect them, and the behaviour is controlled by **Settings → Hide generated
images and image-request directives from the story model** if you want it back.

Also cleared: **Persona Paths is not involved.** It only injects its own card
after the message bubble and writes with `textContent`; it never reads or
rewrites message content.

11 new assertions; 680 across 28 suites.


## 0.36.0 — Why only Sovi's clothes drift

Sovi keeps ending up in a tunic and trousers. Rook never ends up in a dress.
The asymmetry is the whole clue, and there are two causes stacked on each other.

### The model's prior

Anima is trained on Danbooru, where `1boy` co-occurs overwhelmingly with tunics
and trousers, and `dress` co-occurs overwhelmingly with `1girl`. `1boy` in a
dress is a rare combination, so the model regresses toward its dominant mode.
Nothing pulls Rook toward a dress, so nothing does.

Arguing with a prior rarely works; removing what it reaches for does. When
somebody wears a dress, gown, robe or skirt and **nobody in the scene wears
trousers**, the substitutes are added to the negative prompt:

```text
✓ garment defence — negating pants, trousers, shorts, tunic — nobody in this
  scene wears them and the model's prior reaches for them
```

Never a garment somebody is actually wearing, so a mixed scene stays intact.

### The binding problem, again

This is the more interesting half. In a **solo** scene the garment is a tag,
sitting in the tag run beside `(trap:1.4)` — which is why your solo images have
been correct. In a **multi-subject** scene clothing is prose, and it sat about
forty words after the name:

```text
before  Sovi, [7 traits], wearing a ruined dress, standing behind rook, …
after   Sovi, in a ruined dress, an adult elf femboy with blonde long hair …
```

Identical to the staff in 0.35.0, and I fixed that without noticing clothing had
the same shape. Two garments bind to the name; anything beyond that still
trails as `wearing …`.

### Test wording

Six assertions matched `Name, a species…` with nothing between. The identity
text is unchanged, one clause later, so the patterns now allow a lead clause.
Behaviour was correct in every failing case — worth stating, since "update the
test" is exactly what a real regression sounds like.

18 new assertions; 669 across 28 suites.


## 0.35.2 — The minimum reached only half the app

Set to 2–3 images, still one per message — while **Re-run parser** on the same
passage returned three. That difference was the clue: two code paths, and 0.30.2
fixed one of them.

```text
auto-scan   structuredParserSchema(settings.maxImages || 2, profiles)
re-parse    structuredParserSchema(settings.maxImages || 2, profiles, settings.minImages || 0)
```

Without the third argument the schema falls back to its no-minimum wording —
*"Return at most 3 image object(s)"* — which never asks for a second image. The
`{{min_images}}` substitution was applied to both paths in 0.30.2; the schema
call was not.

Four structural assertions now check the source itself: every
`structuredParserSchema` invocation passes a minimum, both paths are present,
and every guidance path substitutes the placeholder. A half-applied fix of this
shape fails the suite rather than shipping.

That is the second time this session a fix landed on one of two identical call
sites — the other put a variable in the solo rendering path where it did not
exist. Worth a general lesson: in this file, a matched string is not a matched
location.


## 0.35.1 — Clothes the story gave you now have an owner

Sovi wears a ruined dress; Rook wears a ruined tunic. The prompt put a
travel-worn tunic on Sovi.

0.31.3 already refuses a garment belonging to another character — but only when
a **profile** declares it. `ruined tunic` was established by the story, so no
profile owned it, and the rule deliberately leaves unowned garments alone (that
is what lets a borrowed cloak work). Story clothing had no ownership check at
all.

### Scene memory now remembers the wardrobe

Alongside setting and lighting, each chat records what each character was last
seen wearing. That is real evidence: six messages of Rook in a tunic makes the
parser putting it on Sovi both detectable and correctable.

Merged rather than replaced, so a character absent from a scene keeps their
wardrobe. Recorded **after** the ownership check, so a garment just taken off
the wrong character is never learned as theirs.

### Matching on the head noun

The first version did not fire: `ruined tunic` and `travel-worn tunic` share no
substring. They are the same garment wearing a different adjective, so
comparison is now on the head noun — the same rule that merges `black fur` with
`shaggy fur`.

### Where this is deliberately conservative

- **A garment you own always wins.** If both characters have been seen in
  cloaks, neither loses one.
- **The other owner must be in the scene.** Rook absent, Sovi may wear a tunic
  freely.
- **A cold start strips nothing.** With no memory yet, the parser's attribution
  stands — and is then learned, so the first scene in a chat can still be wrong.

The honest cost: if a character genuinely puts on another's clothes while both
are present, it will be refused. The trace names it, so you can see it happen:

```text
✓ outfit ownership · Sovi — "travel-worn tunic" belongs to Rook
```

7 new assertions; 651 across 28 suites.


## 0.35.0 — Rook was holding Sovi's staff

Character identity is holding up well. What the characters are *doing* is not,
and a three-hander at a campfire showed why. In the story Sovi holds the staff
and Rook rests a hand on his calf; in the image Rook holds the staff.

The compiled clause explains it:

```text
Sovi, [7 traits], wearing a travel-worn tunic and a cloak, standing behind rook,
staff planted, and calf pressed into rook's palm, controlled breathing and
gripping staff, fire-flat ears.
```

**Rook is named twice inside Sovi's own sentence**, and the staff is mentioned
twice, forty words downstream of "Sovi" and immediately beside "rook". A
diffusion model binds an object to the nearest salient figure; that was Rook.

### The object sits beside its owner

Held objects are lifted out of the trailing pose list and placed immediately
after the name, and repeated mentions collapse:

```text
Sovi, holding a staff, an adult elf femboy with blonde long hair and gold eyes,
wearing a travel-worn tunic, controlled breathing.
```

Two words from its owner instead of forty, with nobody else named in between.
Contact phrases are excluded — "gripping the wrist" is not a prop — unless the
phrase also names a real object.

### A pose naming another character becomes a relation

"standing behind rook" was Sovi's *pose*, so Rook's name sat inside Sovi's
description. It is a relation written in the wrong field. 0.29.1 dropped such
poses when a relation covered them and otherwise left them in place; they are
now **promoted** — the geometry survives as `Sovi standing behind Rook`, and the
foreign name leaves the clause where the staff is trying to bind.

Also fixed: `resolveCrossSubjectPronouns` returned early unless there were
exactly two subjects, so in a three-character scene it did nothing at all.

### A bug I introduced and caught

The first version of this put the held-object filter in `subjectTagLine` — the
**solo** path — where `consumedHold` does not exist. Every solo scene would have
thrown a ReferenceError. Two functions in this file open with the same line;
the edit matched the wrong one. Both are correct now, each with its own scope.

13 new assertions; 644 across 28 suites.


## 0.34.2 — One presentation per character

Presentation tags describe mutually exclusive bodies. Danbooru's own wiki:
`futanari` is "both male and female genitals, but **female body**", with
`male futanari` as the separate male-bodied tag, and `trap` a male body that
reads feminine. Two of them on one character is the same coin flip as two coat
colours, except it decides the entire figure.

This mattered more after 0.34.1. Ranking presentation above everything else
means a stray tag now survives every cap that used to quietly remove it — the
change that protects the right tag protects a wrong one just as well.

A second presentation tag on a subject is now dropped and reported:

```text
! presentation · Sovi — "futanari" dropped — "trap" already sets this
  character's presentation, and the two describe different bodies
```

First stated wins, matching every other conflict rule here. A character with
exactly one is untouched, so a genuinely futanari character is unaffected.

6 new assertions; 631 across 27 suites.


## 0.34.1 — The presentation tag was being cut, unweighted, and duplicated

One line of a compile trace, three faults:

```text
✓ caption traits · Sovi — kept 7 of 10; dropped (trap 1.4), feminine body, flat chest
```

**`(trap 1.4)` is not a weight.** Anima's syntax is `(tag:1.4)`; without the
colon it is a parenthesised phrase and the emphasis silently does nothing —
indistinguishable from a weight set too low to notice. The colon is now
inserted.

**Presentation was scoring 99 and being cut.** 0.33.2 ranked hair and eyes as
identity, but `trap`, `futanari`, `androgynous`, `flat chest` and the rest sat
with incidental traits at the bottom, so the seven-trait cap discarded the tag
that decides how the whole figure reads. Presentation now ranks **above hair**.

**Profile traits never met the vocabulary.** The alias table added in 0.30.5 ran
only on setting, camera, lighting and style — so a saved `otoko no ko` stayed a
dead alias instead of becoming the canonical `trap`. Profile traits now go
through alias rewriting. Nothing is demoted there, because those traits *are*
the caption.

That last fix exposed a fourth: a profile holding both `otoko no ko` and
`(trap 1.4)` produced `a trap, (trap:1.4)` once the alias resolved. Same tag,
twice, once weighted. They now collapse, and the weighted form wins because it
is the one the author meant.

```text
before  Sovi, a trap, girly adult elf femboy with round glasses, …, an otoko no ko,
        a feminine body, and blonde long hair…      ← weight absent, tag duplicated
after   Sovi, a (trap:1.4) adult elf femboy with a flat chest, blonde long hair
        with light blue tips, bangs, gold eyes, pointed elf ears, …
```

12 new assertions; 625 across 27 suites.


## 0.34.0 — The action funnel

In a multi-subject scene, contact between characters reaches the prompt through
exactly one channel: relations. Subject tags are excluded from the tag run by
design (an unowned "grabbing a wrist" conjures a spare arm), so if a relation is
lost the action is simply not in the image. That funnel leaked at five points,
all fixed here.

**Details never rendered.** `relationSentence` used `relation.action` and
ignored `relation.details` entirely, while the tag run excludes them in
multi-subject scenes. So `["claws hooked into the nose", "knuckles white"]` —
the modifiers that make a hold specific — reached nothing at all. They now close
the sentence.

**A suppressed relation ate a sentence slot.** One counter did two jobs: capping
prose at two relation sentences, and recording whether the action was already
carried. A relation deduped against the scene statement incremented it, so a
scene whose first relation was covered could render only one more. Split into
two counters — one for sentences written, one for relations accounted for.

**A pose was deleted by any relation at all.** `poseBelongsToRelation` dropped
"pinning the alpha's muzzle" whenever the actor had *any* relation with a
target, even a bland "faces". The pose was often the only place that hold was
described. It is now dropped only when a relation actually carries the same
verb.

**A relation naming a subject by name was thrown away.** The parser is asked for
refs and reasonably writes "Rook" or "the alpha". Those failed a strict
`refs.has()` check, were dropped, and `synthesizeRelation` replaced the specific
hold with "stands with". Refs now resolve against subject labels and profile
anchors before anything is discarded.

**"pinning" and "pins" counted as different verbs.** The stemmer takes `-ing`
before `-s`, so "pinning" became `pinn` and "pins" became `pin`, and an equality
test said they disagreed. Comparison is now on the shorter stem's length. The
same test also demanded a subject's *full* anchor appear in the statement, which
"the alpha wolf" failed once grounded to "the alpha fantasy wolf" — one
distinctive word from each name is now enough.

### Two supporting changes

**Conflict vocabulary.** There was none, so every tag describing a fight was
demoted to the caption. Added `fighting`, `battle`, `fighting stance`,
`pinned down`, `restrained`, `wrestling`, `biting`, `grabbing`, `baring teeth`,
`blood on face`, `injury`, `bleeding`, `weapon`, `sword` and others.

**The instruction now says relations are load-bearing.** It described *how* to
write one and never *why* they matter, with examples drawn entirely from
intimacy. It now opens: relations are the only channel for contact, name the
visible hold and the body part it takes, and motion verbs — "fights", "attacks",
"struggles with", "pounds" — describe nothing an artist could draw.

To stay near the character ceiling this replaced the old solo-scene rule, which
`multi` already enforces in code, and merged two overlapping relation
paragraphs. 9,603 characters against a 9,650 ceiling.

17 new assertions; 613 across 27 suites.


## 0.33.2 — Hair was being cut, so characters converged

Sovi's hair kept disappearing from prompts, and he came out with Rook's.

The caption keeps at most seven appearance traits, ordered by
`signaturePriority`. Hair scored **99** — it appeared in no tier at all, so it
sorted last and was the first thing cut:

```js
if (/glasses|eyewear|goggles/.test(value)) return 1
if (/elf ears|animal ears|horns?|tails?|fur/.test(value)) return 2
if (/tattoo|scar|birthmark/.test(value)) return 3
if (/piercing/.test(value)) return 4
return 99                    // ← hair, eyes
```

That has the ranking close to backwards. Hair and eye colour are how a
booru-trained model tells two characters apart — they lead almost every
character tag set on Danbooru. Glasses are an accessory. And a character with no
stated hair does not get *no* hair; the model borrows from whatever hair the
prompt does mention, which in a two-hander is the other character. Two people
converge on one look.

New order: **hair → eyes → species markers → eyewear → scars → piercings →
everything else.**

Ordering alone was not enough. A character with several identity traits could
still crowd itself out, so the cap is now filled from identity traits *before*
anything incidental is considered. Whatever gets dropped is traced:

```text
✓ caption traits · Sovi — kept 7 of 9; dropped slender build, pale skin
```

Sovi now compiles as:

```text
Sovi, a trap elf femboy with blonde long hair with light blue tips, gold eyes,
pointed elf ears, round glasses, pale skin, a feminine body, and freckles
```

Hair first, eyes second, and nothing identity-bearing lost — while Rook keeps
his own `dark messy facial hair`.

12 new assertions; 596 across 26 suites.


## 0.33.1 — Arrow keys move the cursor

Editing a prompt in **Fix this image…** was close to impossible. Pressing left
or right flipped to the previous or next image, and the same keystroke carried
on into Lumiverse underneath and swiped the message.

Two causes, both fixed.

The lightbox key handler claimed the arrow keys unconditionally. It now checks
what has focus: inside a textarea, input, select, or anything contenteditable,
arrows do what arrows do. Outside one, they still page through images.

And the keystroke did not stop there — Lumiverse listens on the document, so
even a handled event kept travelling. Keys typed inside the fix panel are now
contained at the panel's own boundary.

Escape keeps working from anywhere: in a text field it drops focus, so a second
press closes the lightbox as before.


## 0.33.0 — Studio survives a setting Draw Things will not accept

Exposing every Draw Things setting was the right call for control and the wrong
one for reliability. **Draw Things refuses the entire generation if a single key
is not in its API**, so one unsupported setting does not degrade Studio — it
breaks it completely, and finding the offender meant clearing fields by hand
until something worked.

Draw Things already names the offenders:

```json
{"detail":"Unrecognized keys: [tiled_decoding, refiner_start]"}
```

That is now acted on rather than merely reported.

- **A rejection is learned and immediately retried.** The offending keys are
  dropped and the same generation is sent again, so the request that meets a new
  unsupported setting still produces an image.
- **The keys are remembered.** Later generations omit them before sending, so
  each unsupported setting costs one retry ever rather than one failure per
  attempt.
- **Reserved keys are never dropped** — prompt, negative prompt, seed and batch
  count are not settings and are exempt.

Settings shows the list, with a **Clear** button:

```text
Settings Draw Things refused
  tiled_decoding, refiner_start                              [Clear]
```

Clear it after updating Draw Things and every setting is offered again. If it
still refuses, the list rebuilds itself on the next generation at no cost.

I considered building the allowlist from Sync instead — only sending keys that
`GET /` returns. Learning from rejections is better: it needs no assumption
about whether every settable key appears in that response, and a wrong
allowlist would silently drop settings that *do* work.

12 new assertions; 584 across 25 suites.


## 0.32.1 — The model may be left blank

Draw Things refuses Cloud Compute for a model named by local filename, even when
that same model is a Community one and runs on cloud fine when generated from
the app itself. The documented behaviour of `/sdapi/v1/txt2img` is to run on
**the model currently selected in the Draw Things UI** — so sending no `model`
key at all is worth testing, since it is the configuration that already works
by hand.

`buildPayload` has always dropped empty values, so a blank model already sent no
key. Five separate guards refused to let it get that far:

- `generateAndUpload` threw *"Active preset has no model."*
- Preset save threw *"Preset has no model — sync from Draw Things first."*
- Studio generation threw *"No model set."*
- The Studio button refused before calling the backend.
- Save-as-new-preset refused too.

All five now allow it and say what blank means rather than treating it as a
mistake. The model field is also free text with autocomplete instead of a
dropdown limited to installed models.

**This is a test, not a fix.** If it works, Cloud Compute is reachable and the
model key was the obstacle. If Draw Things still refuses, the HTTP API path is
local-only and nothing in this extension can change that — the question for
Draw Things is whether a generation submitted through the API server honours
Server Offload, and their answer decides whether this is worth pursuing.


## 0.32.0 — Knowing which moment you are looking at

A story message can produce several images. Opened later out of context they are
indistinguishable, including to the person deciding which one to re-parse, and
`Scene 1 / Scene 2 / Scene 3` on the chips said nothing at all.

### Images remember which moment they were

Parser-generated images now record their position, so the fix panel opens with

```text
moment 2 of 3 · deepseek-v4-flash · 9.9s
```

and the tooltip carries that moment's scene statement. Scales to any count; no
change needed if the maximum goes up.

Older images have no recorded position and simply omit the label rather than
guessing.

### Chips say what the scene is

```text
before   Scene 1        Scene 2        Scene 3
after    1. Rook rinses blood from…   ● 2. Sovi seals the bandage…   3. …
```

Each chip carries a few words of that scene's statement, so a scene is chosen by
meaning rather than by counting. The tooltip has the full statement plus the
anchor it was taken from.

The **●** marks the scene occupying the same position in the reply as the image
being fixed. Deliberately worded as position rather than identity — a fresh
parse may order or choose its moments differently, and claiming "this is the
same scene" would sometimes be a lie.

The picker also appears for a single result now, since a labelled chip is worth
reading even when there is only one, and **Original** sits alongside it.


## 0.31.3 — Rook was wearing Sovi's dress

One line of a re-parsed prompt, three separate faults:

```text
Rook, a therianthrope adult male werewolf with a large wolf tail, black shaggy
body fur, sharp claws, a short muzzle, claws, fangs, and dark messy facial
hair, wearing a ruined dress, cracked …
```

### Outfit bleed

`a ruined dress` and `cracked glasses` are **Sovi's**. The parser attached them
to Rook, and nothing checked. Anima renders what it is told, so a man in a dress
is not a subtle error.

Profiles already declare what each character owns. A garment belonging to
another cast member in the same scene — and not to the wearer — is now refused:

```text
✓ outfit ownership · Rook — "ruined dress" belongs to Sovi; "cracked glasses"
  belongs to Sovi
```

Deliberately narrow. A garment owned by nobody in particular is left alone, so a
borrowed cloak or an improvised bandage still works; only demonstrably
misattributed clothing is removed. The rule needs at least two profiled subjects
before it does anything.

### `sharp claws, … claws`

The trait merge skipped single-word traits:

```js
if (words.length < 2 || !MERGEABLE_TRAIT_HEADS.has(head)) { passthrough.push(tag); continue }
```

A bare `claws` went straight to passthrough, so it could never combine with
`sharp claws` and both reached the prompt. A single-word trait is just its group
with no modifiers, and is now merged like any other.

```text
before  a large wolf tail, black shaggy body fur, sharp claws, a short muzzle,
        claws, fangs, dark messy facial hair
after   large wolf tail, black shaggy body fur, sharp claws, short muzzle,
        fangs, dark messy facial hair
```

### The werewolf, still

Rook being described as a therianthrope werewolf is **not** the 0.31.0 bug
returning — that fallback is fixed and tested. Two possibilities remain, and the
compile trace distinguishes them in one line:

- `✓ appearance state · Rook — Hybrid — parser asked for "hybrid"` — the parser
  chose it, so the fix is upstream in the passage or the parser.
- `✓ appearance state · Rook — Hybrid — passage says "half shifted"` — a
  recognition cue matched, so the cue is too loose for that state.

Either way it is now a stated decision with a stated reason rather than a
silent one.

9 new assertions; 572 across 24 suites.


## 0.31.2 — Count tags: the profile decides, unless it has nothing to say

**Gender presentation is not implemented.** 0.30.5 added only the *vocabulary* —
`trap` and its aliases, `futanari`, `androgynous`, `crossdressing (mtf)` and the
rest. The profile field that would drive count tag and appearance tags is still
just a sketch.

That said, the parser writing `1girl` for a femboy should already have been
harmless, because a profile's count tag outranks the parser's guess for any
known ref. Reading that code closely turned up a real fault beside it:

```js
const countTag = state?.countTag ? state.countTag : (profile ? profile.countTag : subject.countTag)
```

When a profile exists but its count tag is **blank**, that yields `''` — and the
subject's own count tag is discarded rather than used. A blank field is *no
opinion*, not a veto. The effect was a subject silently contributing no count at
all, so a two-person scene could compile as `1boy` with the second person
uncounted.

Precedence is now: appearance state → profile → parser → nothing.

Both outcomes are traced, because a silent override is exactly the thing that is
impossible to notice:

```text
✓ count tag · Sovi — parser said "1girl", profile says "1boy" — the profile wins
! count tag · Sovi — no count tag saved on the profile, so the parser's "1girl"
  is being used. Set one on the character to lock it.
```

The `!` line is the actionable one. If Sovi is coming out as `1girl`, that trace
line will say so and name the fix: save a count tag on his character entry.

5 new assertions; 563 across 24 suites.


## 0.31.1 — Re-parse never replied, and anchors were killing images

### The reply was never sent

Re-run parser did the work and the prompt box never changed. The backend log was
unambiguous:

```text
[lumidraw] re-parsed message 0bbdbe91… in 9109ms · 1/1 scene(s) usable
```

Every other RPC case assigns `reply = ok(payload, requestId, {…})` and breaks,
after which the dispatcher calls `spindle.sendToFrontend(reply)`. The
`reparse_image` case used a bare `return`, which exits the whole handler — so
`reply` stayed undefined and nothing was ever sent. The frontend waited out its
300-second timeout in silence.

All three exit paths now use the envelope. The response field was also renamed
`ok` → `reparsed`, because the envelope already carries an `ok` and two of them
in one object is a trap for whoever reads it next.

### Anchors were rejected instead of trimmed

From the same run:

```text
skipped 2 unusable image object(s)
  image 1: anchor must stay under 14 words; prose is rejected.
  image 2: anchor must stay under 14 words; prose is rejected.
```

Two of three images destroyed by the length of a *quotation*. 0.29.0 taught
`shortPhrase` to repair rather than throw, and this field was missed.

The anchor exists only to locate a moment in the passage, and a trimmed quote
locates it exactly as well as a complete one. The parser is asked for 5–12
words; it naturally quotes a whole sentence, because that is what quoting is.
It is now trimmed like every other over-long field.

This compounded directly with the 0.30.2 minimum-image fix: asking for 2–3
images is pointless if two of them are then discarded over the length of a
quote.

### Confirmed working from the same log

- `appearance state · Rook — Human — parser asked for "human"` — the 0.31.0 fix
  holds, and the trace says why in one line.
- `trait merge · Rook — 24 → 17` — seven duplicate or conflicting traits removed.
- Reasoning genuinely off: 997 completion tokens for 3,727 characters, 9.1s.

### Worth a look

The parser tagged Sovi `1girl`. He is an elf femboy, so the intended tags are
`1boy` + `trap` (see 0.30.5). That is a parser judgement rather than a compiler
fault, and the gender-presentation work sketched for next session is the proper
fix.


## 0.31.0 — A human character was being transformed, and now the compiler shows its work

### The bug

Rook is human. LumiDraw kept describing him as transformed, and re-parsing never
helped — because the decision was not the parser's. `selectAppearanceState`
ended:

```js
return states.find((s) => s.name.toLowerCase() === defaultName) || states[0]
```

When no cue matched the passage and `defaultAppearanceState` was unset — or named
a state that had since been renamed or deleted — it fell through to
**`states[0]`**, whichever state happened to sit first in the list. A character
with a transformed state first was transformed in every passage that failed to
mention shifting.

An appearance state is a *departure* from a character's base form. "No cue and no
declared default" means the base form, not an arbitrary state. It now returns
none, and a default naming a state that no longer exists logs a warning by name
instead of silently picking something else.

This was deterministic, which is why re-parsing could not shake it: the parser
had already finished before the choice was made.

### The compile trace

"Is our rule being followed?" had no answer short of adding `console.log` by
hand, because **a rule that silently does not fire looks exactly like a rule that
fired and had nothing to do.**

Every compile now records both. The log carries a block like:

```text
[lumidraw] compile trace (6 rules)
  · appearance state · Rook — base form — no cue in the passage and no declared default
  · trait merge · Rook — no duplicate or conflicting traits
  ✓ form firewall — scrubbed 13 inactive-form term(s): partial shift, wolf ears, …
  ✓ camera repair — added framing "full body" (scene needs legs)
  · setting continuity — kept: forest
  · booru vocabulary — 3 real tag(s) kept, 0 rewritten, 0 moved to the caption
```

`✓` fired and changed something. `·` ran and found nothing to do. The second mark
is the one that was missing: it distinguishes "the rule is working" from "the
rule never executed".

Traced: appearance-state selection **with its reason**, per-subject trait merge,
scenery removed from appearance, creature grounding, the form firewall, camera
repair, setting continuity, relation dedup, and the vocabulary partition. The
trace is attached to each story-debug entry as well as logged.

For an appearance-state problem the first line now answers it outright — which
state, and why that one.

### On the debugging guide

Several steps in it chase things that do not exist. There is no `v8`/`v14`
compiler switch — the string is a single constant, not a loaded module, so it
cannot be stale. There are no `backend(1).js` variants; Spindle loads what
`spindle.json` names. There is no vitest; the suites are plain Node files run
directly. And its expected output puts count tags before the scene statement,
which is the pre-0.28.0 layout.

Its instinct was right, though — trace which repairs run — and that is what this
release builds, as a permanent part of the app rather than a temporary flag.

17 new assertions; 555 across 24 suites.


## 0.30.5 — Gender-presentation tags, verified against Danbooru

Checked directly against Danbooru's own tag pages, because I had previously told
Eric the opposite and been wrong.

**`trap` is the canonical tag.** `femboy`, `otoko_no_ko` and `otokonoko` are all
aliased *to* it. `trap` carries roughly 73,000 posts; the aliases carry none.
Anima trained on the canonical tag, so the aliases are dead strings occupying a
slot in the prompt.

A profile listing both `a trap` and `an otoko no ko` therefore had one live tag
and one inert one. Both now resolve to `trap`, and the duplicate collapses.

Added to the vocabulary, all verified: `trap`, `androgynous`, `bishounen`,
`girly boy`, `reverse trap`, `crossdressing`, `crossdressing (mtf)`,
`crossdressing (ftm)`, `futanari`, `male futanari`, `futa without pussy`,
`cuntboy`, `male focus`, `female focus`, `bulge`, `flat chest`.

With aliases: `femboy`/`otoko no ko`/`otokonoko`/`tomgirl`/`feminine male` →
`trap`; `futa`/`dickgirl`/`hermaphrodite` → `futanari`; `androgyne` →
`androgynous`; `crossdresser` → `crossdressing`.

Terms that are **not** Danbooru tags and are demoted to the caption rather than
emitted: `transgender`, `female_presentation`, `soft features`, `slim build`,
`feminine`. They are not wrong as description — they simply have no embedding to
activate, so the caption is where they can do work.


## 0.30.4 — The fix panel opens at the top

**Re-run parser** was invisible on a phone. Not missing — above the fold.

Opening the panel focused the prompt box and scrolled it into view, which pushed
everything above it off the top. On a desktop the panel is tall enough that this
costs nothing; on a phone it is capped at 46% of the screen, so the first
control ended up somewhere you had to know to scroll up to find.

The panel now opens scrolled to the top, and the re-parse chips scroll back to
the top when they appear.

Focus is also skipped below 840px. Focusing a textarea on a phone raises the
keyboard, which covered most of the panel before any of it had been read.


## 0.30.3 — Undoing part of the 0.29.0 prompt audit

The rules are not being followed. They are not being followed because I removed
them, and the reasoning I removed them with had a hole in it.

The audit marked nine rules CUT on the grounds that "the compiler enforces this
mechanically, so the instruction buys nothing." That is true of the *guarantee*
and false of the *outcome*. A compiler enforcing a limit means bad output gets
truncated or dropped — it does not mean good output gets produced. Cutting
"no more than 4 setting items" does not yield four well-chosen tags; it yields
seven sprawling ones and an arbitrary subset surviving.

The spring-pool run shows exactly that:

```text
setting     7 items   (old cap: 4)
pose        3 items   (old cap: 2)
expression  3 items   (old cap: 2) — including "clinical focus releasing"
lighting    4 items   (old cap: 3)
```

`clinical focus releasing` is not a thing an artist can draw. The rule banning
non-visual and hedged values was cut in the same pass.

There is a second, larger mistake underneath. **The audit was calibrated on
Sonnet**, which followed the compactness rules implicitly, so removing them cost
nothing measurable at the time. A smaller, faster parser model needs them
stated. A cut list is a property of a specific model, not of the instruction.

Restored, tersely:

- item caps, restated as **choices rather than truncation points** — "pick the
  strongest few rather than listing everything true"
- the seven-word cap on array values
- values must name something an artist could draw, with `clinical focus
  releasing` and `heat radiating` named as counter-examples alongside the old
  hedges

Genuinely mechanical rules stay cut: casing and underscores, the quality/artist
ban, the generic-room ban, framing width, the anatomy field ban. Those the
compiler decides outright.

The invariant suite's char ceiling moves 9,000 → 9,600, and its comment now says
plainly that the number is a function of the parser model rather than a
universal truth. Five assertions were flipped from "stays cut" to "is present",
so a future audit cannot quietly remove them again.


## 0.30.2 — The minimum image count was never sent

Set to 2–3 images, one image produced. Not a compiler rejection — the parser
genuinely returned a single image object and stopped cleanly.

**`{{min_images}}` was never substituted on the Anima path.** Only
`{{max_images}}` was replaced, so a custom instruction reading *"Include between
{{min_images}} and {{max_images}} tag(s)"* reached the model with a literal
`{{min_images}}` still in it. The inline path had always substituted both; the
structured path never did.

The built-in schema was no better. It said only:

> Return at most 3 image object(s).

"At most" never asks for a second image. With a minimum set, it now reads:

> Return between 2 and 3 image objects. 2 is a FLOOR, not a suggestion: find
> that many distinct visual moments in the passage even when one seems dominant
> — a second character's reaction, a change of position, or a detail shown close
> are all separate images. Each needs its own anchor quoting a different part of
> the passage.

With no minimum set, the wording is unchanged.

### Three defects from the same compiled prompt

**`wearing a dressed`.** "dressed" is a state, not a garment — the same family
as 0.27.1's `wearing a bare hand`. It now renders alongside `nude` as a state
word. `wet clothes`, `clothed` and `undressed` join it.

**`wearing blood-covered and a bitten forearm`.** Two failures at once: a
condition is not a garment, and `\barm\b` never matched "forearm". Conditions
(`blood-covered`, `soaked`, `singed`, `tattered`…) are now rejected as clothing,
and the body-part list gained forearm, calf, shin, ankle, forehead, abdomen,
muzzle, snout, wound, scar and bite.

**`from side, from behind, full body, looking back`.** The camera stands in one
place. Horizontal angles (front / side / behind) and vertical angles (above /
below) are independent, so one of each survives and the first stated wins.
Comparison happens on canonical tags, so the parser's "side view" is recognised
as the same angle as "from side" *before* the vocabulary rewrites it — checking
after was how both survived.

20 new assertions; 538 across 23 suites.


## 0.30.1 — Re-parse now uses the model you just picked, and says which one ran

Switching the parser model and pressing **Re-run parser** kept running the old
one. Two causes, both fixed.

**The button read saved settings.** A model typed into Settings but not saved
did not reach the request. It now sends the connection and model exactly as they
appear in the fields, so a model can be tried without committing to it — which
is the entire point of a comparison button.

**The panel reported the requested model, not the one that ran.** These come
apart whenever a model override cannot be applied: if the chosen connection
exposes no raw provider route, LumiDraw falls back to the connection's own model
and, until now, said so only in the Spindle log. The panel now shows **the model
the request actually resolved to**, and if an override was refused it says so in
orange, in the panel, with what to do about it — change the model on the
Lumiverse connection itself.

Reasoning tokens appear next to the timing when the provider reports them, so
two candidate models can be compared on speed and hidden cost at a glance.

The button is also labelled **Re-run parser (prompt only)** now. It loads a new
prompt for you to read; pressing **Regenerate & replace** is still a separate,
deliberate step.


## 0.30.0 — Re-run parser

Comparing parser models meant regenerating a whole story message and hoping the
model picked the same moment to illustrate. **Fix this image…** now has a
**Re-run parser** button.

It re-reads the passage the image came from, runs whichever parser model is
currently selected, compiles the result, and loads the new prompt into the
editable box. It does **not** generate and it does **not** touch the story
message — so a comparison costs one parser call and no Draw Things time.

- The parser model and how long it took are shown next to the button, which is
  most of what you want when the question is "is this one faster".
- When the parser returns several scenes you get **Scene 1 / Scene 2 …** chips
  to flip between the compiled prompts, each tooltipped with its anchor text.
- An **Original** chip restores the prompt the image was actually made with, so
  you can read old against new without losing the old one.
- Scenes the compiler rejects are reported by count rather than hidden — a
  rejected scene is exactly what you want to see when judging a model.

Read the prompt, and press **Regenerate & replace** only if it is better.

Re-parsing needs the source message, so it works on images made by a story scan.
Studio images and images whose message has since been deleted will say so rather
than failing quietly.


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
