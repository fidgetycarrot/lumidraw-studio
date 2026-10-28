# Lumi Studio 1.15.1: LumiCast fills the Description for MOSS

LumiCast 0.15.0 writes a **Description for MOSS** for every character it translates: face and body only, plain English, nothing explicit, starting in lower case so it reads after "Name, ". Lumi Studio now carries it everywhere the other sheet fields go:

- **Fill from LumiCast** fills the MOSS box too (only when LumiCast has one, as with the other boxes).
- **Tweak in LumiCast** sends the MOSS box, so it comes back with the character.
- **Update in Lumi Studio** saves it. An older LumiCast that sends no MOSS description leaves the box as it was.
- **Paige → LumiCast → Lumi Studio** saves it on new characters and personas.
- If the character is open in the editor when LumiCast updates it, the MOSS box refreshes with the other fields.

## Porting

Field name: `moss` in the shared sheet, `mossDescription` in the profile (1,500 characters).
- `backend.js`: `lumicast_latest` and `lumicast_send` pass `moss`; `applyFromLumiCast` and `addFromLumiCast` save it.
- `frontend.js`: the Fill field list, the Tweak sheet, and the `lumicast_applied` field list include `.ld-persona-ed-moss`.

## Checked

Syntax-checked. The update path was run against a fake host: the MOSS description was saved with the other six fields, and the rest of the profile was kept. Not tried in a live Lumiverse.
