# LumiDraw Studio 0.51.0

Includes 0.42.4 through 0.50.0.

## Basic, as asked. And you were right.

**If the message before it was out of character, the reply is not illustrated
automatically.** No judgement about what the reply contains.

```
Skipped: you were talking out of character, so this reply was not illustrated
automatically — press Scan if it turned out to have a scene in it.
```

**Pressing Scan overrides it.** Only automatic scans are blocked, so the manual path
is your escape hatch exactly as you described. Re-run parser and Replace all images
were never on this path and are unaffected.

## Why you're right and I wasn't

The asymmetry decides it, and I should have seen it two versions ago:

- Guess wrong towards an image → a picture of nothing lands in your chat, costs a
  generation, and you delete it.
- Guess wrong towards no image → one press of a button.

Those are not the same size, so the automatic path should take the safe side and
leave the judgement to you, who can actually see the message. Instead I kept trying
to read the reply, and it guessed wrong twice — most memorably on a patch note where
`style="max-width:560px…"` is a quoted string over twelve characters and therefore
read as dialogue. Each fix made the rule longer without making the next surprise any
less likely.

## What I deleted

The whole classifier, not just its call site: `assistantReplyIsMeta`,
`META_ADDRESS_RE`, `META_NOUN_RE`, `NARRATIVE_QUOTE_RE`, `NARRATIVE_PROSE_RE`,
`TECHNICAL_META_RE`, `SCREAMING_TOKEN_RE` — about 90 lines. A heuristic nobody calls
is a heuristic somebody calls again by accident, and there are assertions now that
each of those names stays gone.

## Kept, because they're structural rather than guesses

- **Card stripping** (0.50.0). `<!-- UI_START -->…<!-- UI_END -->` and
  `<statuscard>…</statuscard>` never reach the parser. This is the one that had been
  quietly feeding "dependency load 34 / 100" into your prompts on every message.
- **A turn that is only a card is skipped**, at any rating, with or without an
  `[ooc]:` before it.
- **A message opening with an `[ooc]:` marker is skipped**, and a marker mid-message
  strips just that span.
- **Every branch logs**, including "no preceding user message found", which is the
  one that used to be silent when it failed.

**41 suites · 1255 assertions · all green.** The count dropped by 30 because the
classifier's tests went with it, which is the right direction.
