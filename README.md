# LumiDraw Studio 0.55.0

Includes 0.42.4 through 0.54.2 — everything since your last install.

Both things, and the manual one is first because it's the one you can lean on while
you're out.

## The wardrobe panel — Story tab

Under the auto-illustration status:

```
Wardrobe of record — this chat                    ↻

  Price     [ white shirt, denim shorts, sneakers ]
  Jason     [ grey henley, work jeans             ]

  [ Save wardrobe ]
```

- **Edit a line and Save** — the next image uses it immediately. No scan needed.
- **Clear a line** — LumiDraw forgets and re-learns from the next scan.
- Placeholder text shows the character's profile default when nothing is recorded.

This is what images are built from when the passage doesn't describe clothing, and
it **outranks the character's default outfit** — which is why editing that default
wasn't fixing anything for you. It's scoped to this chat and preset, like the rest
of scene memory.

If a scan goes wrong while you're out: open the panel, type what she should be
wearing, Save, carry on. That's the escape hatch.

## The clothing digest — 30 messages

Agreed on 30. When the wardrobe has **no record for someone in the scene**, LumiDraw
scans back 30 messages and keeps only the sentences that mention clothing:

```
[lumidraw] clothing digest · 2 earlier mention(s) found in the last 30 messages,
because the wardrobe has no record for someone in this scene
```

```
- She pulled on her denim shorts and a white tank top before dawn.
- Later she kicked off her sneakers by the door.
```

Oldest first, and the parser is told a later line undoes an earlier one — because
that ordering is the whole reason a digest beats a wider window. Capped at ~900
characters, so it costs roughly a fiftieth of what six full messages would.

**It stays out of the way when the record is populated.** A wardrobe that knows the
answer is authoritative, and the digest on top of it would just be more material for
the parser to second-guess itself with.

Cards and out-of-character asides are stripped before the search, so Gabrielle's
console can't contribute a crown.

## What I'd watch for

**The panel is the thing to try first**, since it verifies everything else — if what
it shows doesn't match what you'd expect, the record is the problem rather than the
compiler, and you can fix it in place.

**The digest is the least tested thing here.** It fires only on the cold-start case,
and whether the parser reads a list of past clothing sentences well is something only
a real turn will show. If it produces worse outfits than no digest at all, clearing
that character's wardrobe line is what makes it fire again, and telling me so is what
gets it removed.

**42 suites · 1470 assertions · all green.**
