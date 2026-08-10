# LumiDraw Studio 0.49.3

Includes 0.42.4 through 0.49.2.

## Found it, and the screenshots were the whole answer

Your message #131 was `[ooc]: the gabrielle monitor packet…`. The reply was a patch
note: wrapper tags, JSON keys, a wall of CSS, "Patch applied." Two images.

I fed that exact text through the classifier:

```
verdict: ILLUSTRATE
reason : the reply contains dialogue
```

**The CSS was the dialogue.** The dialogue test looks for a quoted string over
twelve characters — and `style="max-width:560px;margin:18px auto;font-family:Inter…"`
is a quoted string over twelve characters. A patch note full of attributes looked
like a scene full of speech.

So the gate ran, found your `[ooc]:`, looked at the reply, and was fooled by
punctuation.

## The fix

Markup is stripped before the reply is judged — fenced code, inline code, HTML
comments, tags and their attributes — and the verdict is taken on the prose that
remains. On top of that, a new check runs **before** everything else:

```
SKIP | the reply is about the story's plumbing — it names a code token (GABI_MONITOR_START)
```

It fires on a `SCREAMING_SNAKE` token in the prose, or on two independent technical
markers (`regex`, `json`, `wrapper tags`, `schema`, `patch applied`, `bonus fields`…).
It's checked first on purpose: a message about broken plumbing usually names the
character whose card is broken, and the cast-name test would otherwise rescue it.

### The part I nearly got wrong

Your ordinary messages embed **rendered UI cards**, so markup is normal in this chat
and can never by itself mean "don't illustrate". My first version tested the code
token against the raw text — and every one of your story messages is wrapped in
`<!-- UI_START -->`. It only passed because `UI_START` has two letters before the
underscore and my pattern wanted three. That's a coin landing on its edge, so the
token test now runs on the stripped prose, where a comment wrapper can't reach it.

Verified against both sides:

| message | verdict |
|---|---|
| The patch note | **skipped** — names `GABI_MONITOR_START` |
| Patch note that also says "Gabrielle here." | **skipped** — plumbing outranks the cast |
| A rendered UI card + "Gabrielle leaned back from the console…" | **illustrated** |
| `"The parser is down again," Gabrielle muttered` | **illustrated** — a scene about a terminal is still a scene |

## Still worth confirming

Install this and check the header reads **v0.49.3**. Everything above only matters
if the OOC code is actually on your machine, and until 0.49.1 the panel couldn't
tell you.

`ooc.mjs` is up to 86 assertions, including your patch note verbatim.
**41 suites · 1275 assertions · all green.**
