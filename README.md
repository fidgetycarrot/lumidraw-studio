# LumiDraw Studio 0.51.2

Includes 0.42.4 through 0.51.1.

## No — and asking made me find the real bug

You were right to push. The `isAssistant break` I fixed in 0.51.1 needs an assistant
turn wedged between your question and the reply, and there wasn't one before #132.
It could never have explained the first image pair.

So I ran your transcript through 0.51.1's own decision logic:

```
#132  would illustrate ✗
#134  would illustrate ✗
```

**Still broken, both turns.** Two bugs, compounding.

### 1. `[ooc]:` closes the bracket before the colon

`stripOutOfCharacter` ran the delimited rule first. It matched `[ooc]` on its own,
removed it, and left this behind:

```
": the gabrielle monitor packet on top doesn't seem to be rendering correctly."
```

A line with no "ooc" left in it for the whole-line rule to find. The aside then read
as ordinary prose. Line rule runs first now; a mid-line `[ooc: nice]` is still
removed surgically.

### 2. The gate asked the wrong text

```js
const promptingText = cleanParserMessageText(prompting.content, …)
if (outOfCharacterVerdict(promptingText).ooc)
```

`cleanParserMessageText` **removes out-of-character markers.** So the gate was asking
whether a marker was present in text specifically chosen to have none. It reads the
raw message now.

### Why every test I wrote passed anyway

All my asides were short — *"[ooc]: brb"*, *"[ooc] can we back up a scene?"*. A short
one strips to nothing, and empty text hit the `|| prompting.content` fallback, so the
raw message got checked and the answer came out right by accident.

Yours were sentences. They kept enough words to look like prose, never hit the
fallback, and sailed through. The test suite was 96 assertions of the easy case.
There are now assertions using your exact wording, and the end-to-end check runs both
turns of the exchange:

```
#132  BLOCKED ✓
#134  BLOCKED ✓
```

## Keeping 0.51.1's fix too

The `isAssistant break` was a genuine hole even though it wasn't this one — a preset
that posts a card as its own turn would have hidden your question from the gate. It
stays fixed.

**41 suites · 1278 assertions · all green.**
