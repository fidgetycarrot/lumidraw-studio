# Lumi Studio 1.27.8: refine a character from LumiCast's cast picture

LumiCast 0.22.0 can load a cast member's saved look, fix it in Refine and save it back, without a trip through Tweak in LumiCast. Lumi Studio now allows that.

## What changed

- **The library lookup hands over the whole sheet.** `lumidraw_studio.lumicast.library` now returns each matching character's id, a hand-over time, and all seven sheet fields, the anatomy field included, so saving back does not wipe it. LumiCast keeps that field out of its pictures.
- **Updates are accepted for looked-up characters.** `lumicast.apply` used to accept only the character from the latest Tweak in LumiCast. It now also accepts one that Lumi Studio handed over in a lookup. The id, kind and hand-over time must all match, and the last 40 lookups are remembered in memory only.
- **Wording.** The refusal messages now say "Load it into LumiCast again", since Tweak is no longer the only way in.

## Porting

`backend.js` only:
- `const lumiCastLookups = new Map()` beside `lastLumiCastSend`
- `libraryForLumiCast()` records each entry and returns `id`, `sentAt` and `sheet.anatomy`
- the top of `applyFromLumiCast()` picks the matching hand-over (the Tweak or a lookup) instead of only `lastLumiCastSend`

## Checked

Run against a fake host:
- an update with no hand-over is refused
- a lookup returns the id and the anatomy field
- an update with the wrong time is refused
- a matching update saves the new tags and keeps the anatomy field

Not tried in a live Lumiverse.
