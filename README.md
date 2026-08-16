# LumiDraw Studio 0.92.0 — it was saved. It just never told you where.

## Where Fanny was

**In your Characters tab, the whole time.** When LUMICAST fires it writes a real,
editable character into your library — same list as your Fanny Price.

Two things hid it:

1. **The panel reads that library exactly once, at init.** A story that invents
   somebody mid-chat writes an entry the panel is never told about, so the tab
   keeps rendering the list from the moment it opened. You'd have had to close
   and reopen Lumiverse to see her.
2. **No wardrobe row said where its tags came from.** Even looking straight at
   the row that produced those tags, there was nothing to follow.

## What changed

**Every wardrobe read now refreshes the Characters tab.** No reopening.

**Each row says where its tags live**, on hover:

- *a saved character — click to edit it* → the name is a link; clicking it jumps
  to Cast & presets and opens that character
- *stored in the active preset* / *stored in the bound cast* → the leads, which
  aren't library entries and have nothing to open

So the row that made the image now takes you to the thing that owns it.

## Still true from 0.91

The **— use mine —** picker on each cast row. Now that you can *see* the story's
Fanny, the picker is how you replace her with yours — and if you'd rather just
fix her tags in place, the link gets you there instead.

## Verification

**58 suites · 2,657 assertions · all green.**

Mutation-tested four ways, all caught: the reply dropping the library (3
failures — the original bug, reproduced), every row claiming to be a library
entry (2), the panel ignoring the refresh (1), the swap select falling through
to the link (1).
