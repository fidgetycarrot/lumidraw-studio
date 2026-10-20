# Lumi Studio 1.8.5: send a character back to LumiCast

A character that doesn't look quite right after a few pictures can now go back to LumiCast to be fixed with Refine, then come back.

## What changed

- **Tweak in LumiCast**, next to Fill from LumiCast in the character and persona editor, sends the character as it is in the editor (unsaved edits included) to LumiCast: count tag, subject phrase, always include, appearance, outfit, anatomy, and its name.
- In LumiCast 0.11.0 or newer, **Get from Lumi Studio** loads it. If the chat's Cast lorebook has that character, LumiCast also loads the written description, so Refine knows what the character should look like.
- When you're done in LumiCast, come back to the same character, choose **Fill from LumiCast**, then save.

Nothing is saved or changed in Lumi Studio by sending. The sent character is kept in memory only, replaced by the next send, and gone after Lumiverse restarts.

## Porting to another build

Two small additions, both next to the existing LumiCast code:

- `frontend.js`: the `send-lumicast` button beside `fill-lumicast` in the persona editor markup, and its click handler just above the `fill-lumicast` handler. It calls `lumicast_send` with `{sheet, name, anchor}`, read from `.ld-persona-ed-count/subject/identity/tags/outfit/anatomy/name/anchor`.
- `backend.js`: `case 'lumicast_send'` beside `case 'lumicast_latest'`. It publishes `rpcPool.sync('lumicast.tweak', {version:1, sheet, name, anchor, userId, sentAt}, {requires:[]})`. LumiCast reads it as `lumidraw_studio.lumicast.tweak`, so the extension identifier must stay `lumidraw_studio`.

## Known limit

Fill from LumiCast only fills fields that LumiCast has a value for, so it never wipes your own entry. If Refine empties a field completely (for example removes the only outfit tag), clear that field by hand in Lumi Studio.

## Checked

Syntax-checked both files. The backend case was run against a fake host: it published the sheet with text fields cleaned (a non-text outfit became empty) and replied `ok`. Not tried in a live Lumiverse.
