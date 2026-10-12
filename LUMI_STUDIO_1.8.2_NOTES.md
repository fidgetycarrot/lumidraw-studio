# Lumi Studio 1.8.2: Fill from LumiCast

Adds one button to the reusable character / persona library editor: **Fill from LumiCast**.

- LumiCast 0.7.0 and newer publish their latest character sheet through Lumiverse's shared RPC pool at `lumicast.sheet.latest`.
- The button asks this extension's backend (`lumicast_latest`) to read it, then fills Count tag, Stable subject phrase, Always include, Permanent appearance tags, Default outfit tags and Conditional visible anatomy.
- Only fields LumiCast has a value for are filled, so an empty LumiCast field never clears an existing entry. Library name and Anchor are filled from LumiCast's name guess only when they are empty.
- Nothing is saved: the editor's own Save button still decides. Nothing else in Lumi Studio changed.
- Clear messages when Lumiverse lacks the shared pool, LumiCast has not translated anything since Lumiverse started, the shared format is unknown, or the sheet belongs to another Lumiverse user.

Checked before release: `node --check` on both files; the backend request exercised against a stubbed Lumiverse (no pool, nothing published, valid sheet, field length caps, other user, unknown format); and the panel loaded in headless Chromium with a stub host, where the button filled the fields, offered the name, and left a field LumiCast had no value for untouched. Not yet run inside a live Lumiverse.
