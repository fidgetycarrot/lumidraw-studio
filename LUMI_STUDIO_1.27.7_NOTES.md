# Lumi Studio 1.27.7: LumiCast's cast picture can use saved looks

LumiCast 0.21.0 makes a **cast picture**: up to four of a story's people in one image. So they look the same there as in story pictures, LumiCast now asks Lumi Studio for the saved look of anyone it already has.

## What changed

- **A new shared endpoint, `lumidraw_studio.lumicast.library`.** LumiCast names the people it is staging; Lumi Studio answers with the matching reusable characters and personas: count tag, subject phrase, always include, appearance, outfit and the MOSS description. A full name matches, and so does a first name when that is all either side has.
- **Read-only, and never the anatomy field.** Nothing in Lumi Studio is changed, and only LumiCast can call it.

## Porting

`backend.js` only: `libraryForLumiCast()` and its `rpcPool.handle('lumicast.library', …, { requires: [] })` registration, beside `styleForLumiCast`. It reads LumiCast's request at `lumicast.cast.request` (`{names}`) and uses `getCharacters` and `getPersonas`.

## Checked

Run against a fake host: another extension is refused, no request gives an empty list, and names match by full name or first name without the anatomy field. Not tried in a live Lumiverse.
