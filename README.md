# LumiDraw Studio 0.93.0 — the declaration was being read as prose

## You were right, and I was chasing the wrong thing twice

There is **no invented character.** Nothing was saved. Your two screenshots
together show exactly what happened:

```
[LUMICAST]{"name":"Fanny Price","count":"1boy","tags":"blue hair+long hair+
 hair down+blue eyes+slender+otokonoko","outfit":"sheer harem silks+gold
 jewelry+anklet+barefoot"}[/LUMICAST]
```

```
… BREAK 1boy, Fanny Price, blue hair, long hair, hair down, blue eyes,
slender, otokonoko, sheer harem silks, gold jewelry, anklet, barefoot …
```

Verbatim, in declaration order.

**The LUMICAST block was being sent to the parser as story prose.** In direct
mode the parser writes the prompt from the passage — and a block of ready-made
booru tags sitting *in* the passage is the easiest thing in it to copy.

You couldn't find that character to edit because it doesn't exist. LumiDraw had
already matched the name to the Fanny Price *you* wrote and correctly put yours
in the cast — that's why the log said "no **new** cast declarations" and why
there's only one in your list. Your sheet was right there. The declaration text
just overrode it on the way past.

## The fix, and where it should have been obvious

One line in `cleanParserMessageText` — the function that already strips thinking
blocks, utility cards and out-of-character asides before the parser sees
anything. The line directly above the fix reads:

> *Before the tag strip, so an aside can never reach the parser as story prose
> and become scenery.*

Same bug. Same function. One line away. I went looking for a hidden character
store twice instead of asking what text the parser actually receives.

Absorption is unaffected — it still reads the raw message, so declarations are
picked up exactly as before. It's only the parser's copy that's cleaned.

## Also in this release (from 0.92)

- **A card with no visual tags no longer evicts a written character.** Your
  "The Remote" world card was taking the lead slot.
- **Add to cast** picker in the wardrobe panel, writing to the cast the chat
  actually reads — the preset editor's list was a no-op for a bound chat.
- Rows show the tags they contribute; the Characters tab marks story-invented
  entries.

## Verification

**58 suites · 2,711 assertions · all green.**

Mutations caught: the declaration reaching the parser again (8 failures), an
over-broad strip eating the prose after the block (3), the tagless card evicting
the lead (5), never taking chat leads (13), the add writing to the wrong store
(2).
