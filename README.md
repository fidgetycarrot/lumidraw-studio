# LumiDraw Studio 0.72.0 — the panel knows which chat it's in, and Anima knows what jeans are

Two reports, four fixes, and one of them was worse than what you described.

---

## 1. Every chat was sharing one wardrobe record

The settings panel isn't opened by a chat event, so it never knew which chat it
was looking at. It sent nothing and let the backend guess with `chats.getActive`.

When the host doesn't answer that, `chatId` is empty — and `sceneMemoryKey('')`
returns `''`. **One bucket, shared by every chat.** Your two stories with the same
cast have been overwriting each other's clothes, in both directions, silently.

That's the failure mode I like least: it produces plausible wrong output and says
nothing. Fanny gets dressed in the wrong story's outfit and there's no trace line
to notice.

Three changes:

- **The panel sends the chat it last saw an event for.** Both `GENERATION_ENDED`
  and `CHARACTER_MESSAGE_RENDERED` already carry a chat id — remembering the last
  one is far better than a guess, because it's the chat whose messages actually
  reached us. Reads and saves both use it.
- **The status line names the chat it read.** It was invisible before, which is
  why neither of us could tell which failure you were hitting.
- **When no chat can be identified it says so in red** and logs it. That case
  can't be *prevented* — if nothing can name a chat there's nothing to key on —
  but it can stop being silent.

## 2. Refresh couldn't discover anyone

Rows come from `allKnownProfiles(preset)`: main character, persona, preset cast
list. There was **no code path at all** from "who is in this chat" to "who gets a
row." So a character your story introduced here could never appear, while the
*other* story's cast — absorbed into the shared preset — showed up in every chat
forever. Both halves of what you described, one cause.

Refresh now reads the whole chat for `[LUMICAST]` declarations before building
the rows, and reports who it adopted.

**One honest limit:** it can only find what the model actually declared. If that
chat never emitted a `[LUMICAST]` block, the scan finds nothing — and it now says
so rather than looking like it worked.

**And `[ooc]` was never going to work.** `stripOutOfCharacter` deletes those lines
upstream of everything — it's the function that stopped a four-message OOC
exchange getting illustrated. An OOC aside is the one thing guaranteed not to
reach the cast absorber.

---

## 3. Joggers — and 28 other garments

You were right, and it was bigger than the word.

`BOORU_VOCAB` grew up around a fantasy story: **robe, cloak, cape, armor, hood.**
It had no jeans, no t-shirt, no bra, no sneakers. I probed the thirty commonest
modern garments and **twenty-nine resolved to nothing** — which means
`partitionBooruTags` dropped them out of the tag run and into the caption, where
a Danbooru-trained model can barely use them.

Every contemporary outfit you've written has been reaching Anima as prose.

About seventy real garment tags added, plus the near-misses a language model
reliably produces — *trousers, tee, hoody, cutoffs, tights, heels, trainers,
knickers, pyjamas*.

**On joggers specifically:** a jogger *is* a sweatpant. The tapered cuff is a
**cut**, not a garment class, and Danbooru has no tag for it. So the fix isn't to
invent one — `joggers` anchors `sweatpants` in the tag run while the original
phrase rides along in the caption, where the cut can be described. `"grey
joggers"` now yields the tag `sweatpants` **and** keeps `grey joggers` in the
caption. Not mapped to `track pants`, which carry athletic stripes.

**Worth spot-checking:** Danbooru's API wouldn't respond while I was working, so
these are from knowledge rather than verified post counts. The common ones I'm
confident about. If a garment comes out wrong, tell me the word and I'll move it.
The failure is cheap — an unknown tag is ignored, it doesn't corrupt the image.

---

## Two bugs the tests found that you hadn't reported

- **`fetchMessages` returns `{ messages, chatId }`, not an array.** I passed the
  wrapper to `absorbCastDeclarations`, which failed `Array.isArray` and returned
  silently — the scan would have found nothing, ever, with no error. A source
  reading would have looked fine.
- **`ass` reached the tag run through a self-alias** (`'ass': 'ass'`) because it
  was never in the vocabulary. It worked, but it meant the alias table was quietly
  acting as a second vocabulary and the invariant "every tag we emit is a verified
  entry" wasn't holding. There's now a test asserting **every alias target is
  itself a real vocabulary entry** — a dead alias resolves to a string the model
  was never trained on, which is worse than demoting to the caption because it
  *looks* like it worked.

## Verification

**55 suites · 2,157 assertions · all green.** 76 new across `wardrobe.mjs` and
`clothing.mjs`.

`wardrobe.mjs` is driven through the real message handler, not source patterns —
two chats with different clothes, asserting they don't leak into each other.

Mutation-tested four ways, all caught: backend ignoring the panel's chatId (5
failures), scan branch disabled (3), joggers alias deleted (6), vocabulary block
trimmed (7).

## Still open

The **0.60.0 `AWAY_RELATION_RE` revert** for the merged-subjects problem. One
line, isolates the suspect, keeps every other fix. Say the word.
