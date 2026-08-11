# LumiDraw Studio 0.52.0 — the story declares its own cast

Includes 0.42.4 through 0.51.2.

Two pieces: a block to paste into KittyLotus (**CAST-BLOCK-for-preset.md**), and the
LumiDraw side that reads it.

## Your instinct was right, and for a stronger reason than you gave

You said the decision belongs preset-side because the story generator has to make the
call when the prose doesn't describe someone. True — and there's a sharper version:

**If LumiDraw decided, the story would never find out what was decided.** The next
passage could give Mira black hair while every image shows her brown. Consistency has
to flow both ways, so the choice has to live where the story can see it. That's the
tracker, not my profile store.

## What I took from the preset file

Even though it's Kitty's stock rather than your live setup, it gave me the conventions,
which is what I needed:

- Payloads are `<payload>` + `[MARKER]{json}[/MARKER]` — that's how `[REFRESH]` and
  `[Motive Ledger]` work, so `[LUMICAST]` sits beside them rather than inventing a
  new idea.
- Lists are `+` delimited. Commas are accepted too, since a model asked for booru
  tags reaches for them by habit.
- Display regexes render or hide; prompt regexes strip from context.

**It also changed a design decision.** My first thought was to hang this off `<track>`
as a `[cast]` child tag. But Native, RPGHUD and SillySim are three different tracker
modules and I don't know which you run — so the block stands alone and works whichever
is active.

## The LumiDraw side

A declaration becomes a **real cast profile**, as you chose: saved to the Characters
tab, linked to the active preset, protected by the anatomy firewall and adjacency
binding exactly like Sovi's.

- **Absorbed before compiling**, so a character declared this turn is locked for
  *this* image, not the next one.
- **First declaration wins.** "Don't re-declare someone" is an instruction the model
  often *can't* follow, because Strip Aged Payload Blocks removes its own past
  declarations from context. Durability belongs with the record.
- **Your own profiles are never overwritten.** A name matching your Characters tab
  means yours wins.
- **A declaration with no tags is ignored** rather than creating an empty profile.
- **Cast slots raised 4 → 12.** Four was right when you filled them by hand; a story
  that can introduce people needs headroom, and silently dropping the fifth person is
  a mystery three sessions later. Prune in the Characters tab.

```
[lumidraw] the story declared new cast: Mira — saved to the Characters tab and
linked to "Fanny Price"
```

## Worth knowing before you try it

**A wrong first guess sticks.** That's the cost of first-wins. It's a normal profile
once it lands, so fix it in the Characters tab like any other.

**I couldn't test the preset half.** The LumiDraw half has 30 assertions against the
exact payload shape, but whether your story model reliably emits it — and whether it
picks real Danbooru tags rather than prose — is something only a real turn will tell
us. If it writes prose instead of tags, that's an instruction problem and I can tighten
the block.

**41 suites · 1291 assertions · all green.**
