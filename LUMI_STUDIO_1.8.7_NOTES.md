# Lumi Studio 1.8.7: LumiCast can save a tweaked character back

After Tweak in LumiCast, LumiCast 0.12.0 or newer shows **Update <name> in Lumi Studio**. Pressing it saves LumiCast's revised character sheet straight into the character it came from. No Fill from LumiCast and Save round trip.

## What changed

- **Tweak in LumiCast** now also sends the saved entry's id and whether it is a character or a persona. A character that has never been saved can still be tweaked, but LumiCast can't update it; the status line says so.
- **A new shared endpoint, `lumidraw_studio.lumicast.apply`**, saves the six sheet fields (count tag, subject phrase, always include, appearance, outfit, anatomy) into that entry. Empty fields are written too, so a tag Refine removed really goes. Everything else in the entry stays as it was: name, anchor, looks, forms, aliases, alternates, anatomy rule.
- **Safety checks.** The update is accepted only:
  - from LumiCast
  - for the character from the latest Tweak in LumiCast (same id, kind and send time)
  - for the same Lumiverse user

  Lumi Studio's usual profile checks still run before anything is saved. After a Lumiverse restart, press Tweak in LumiCast again.
- **The panel refreshes.** The library list updates. If that character is open in the editor, its six fields are replaced with the saved ones, so pressing Save later can't write the old tags back. A preset linked to it picks up the change.

## Porting to another build

- `backend.js`:
  - `let lastLumiCastSend` above `getCharacters`
  - the `lumicast_send` case stores it and adds `id`, `kind` to the synced value
  - `applyFromLumiCast()` and the `rpcPool.handle('lumicast.apply', …, { requires: [] })` registration, just above the "backend loaded" log line

  Profile field names used: `countTag, subject, identityTags, appearanceTags, defaultOutfitTags, anatomyTags`.
- `frontend.js`:
  - the `lumicast_send` call passes `id: personaEditorId`, `kind: libEditorKind`
  - the new status wording
  - the `lumicast_applied` branch in `ctx.onBackendMessage`

## Checked

Run against a fake host. Refused, with plain messages:
- an update before any send
- an update from another extension
- an update with nothing shared
- an update for a stale send or another id

Refused without saving: a character whose existing profile fails Lumi Studio's own checks.

On a matching update, the six fields were replaced (an emptied outfit stayed empty), other profile fields were kept, the library was saved, and the panel was told. Not tried in a live Lumiverse.
