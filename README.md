# LumiDraw Studio 0.94.0 — "no wait", and Elliot

## Yes, I see the "2boys, no wait, 1girl, 1boy"

The parser started writing a two-boy scene, realised it was a girl and a boy, and
wrote the correction **into** the prompt instead of over it. Draw Things received
a literal `no wait` **and** a count tag the model had already abandoned, fighting
the one it settled on.

Fixed with two narrow rules, and deliberately nothing else:

1. A self-correction marker is never a Danbooru tag. Dropped.
2. A **count** tag before such a marker in the same run is the attempt the model
   just abandoned. Dropped.

Only counts. A scene tag written before the model changed its mind about the
count is still a scene tag, and sweeping everything to the left would lose real
work. `hallway, 2boys, no wait, 1girl` → `hallway, 1girl`.

Direct mode's verbatim promise stands: a prompt with no artifacts comes back
byte-identical, and that's the assertion I leaned on hardest. A tag that merely
*contains* a marker word — `waiting`, `waist`, `actually cute` — is not a marker.

## And Elliot — the more interesting one

Look at the two runs in that prompt. Fanny's is detailed and correct: `futanari,
small breasts, blue hair, thick thighs, bulge`. That's a real sheet being copied.
Elliot's is `1boy, short hair, t-shirt` — generic invention, and `short hair`
directly contradicts his `medium hair, messy hair`.

**His sheet was never in the context.** The persona slot has never resolved to
him, and it can't: your chat DTO is `id, character_id, name, metadata,
created_at, updated_at`. There is no persona on a chat, and 0.91's metadata walk
found nothing either. No amount of key-guessing produces a field that isn't
there.

So it's asked once and remembered. New **Playing as** picker in the Cast panel,
above the fantasy checkbox. Pick Elliot; this chat is played as Elliot. It's per
**chat**, not per cast, so a new story doesn't inherit whoever the last one was
played as — which is the thing that pinned Jason to everything.

It beats the cast's persona and is applied last, so nothing can overwrite your
choice with a guess.

## Verification

**58 suites · 2,752 assertions · all green.**

Mutations caught: the marker surviving into the prompt (7 failures — the reported
bug), the repair sweeping every tag left of the marker instead of only counts
(2), markers matching substrings so `waiting` and `waist` get eaten (1), and the
chosen persona being applied before the chat probe where a guess could overwrite
it (whole suite).
