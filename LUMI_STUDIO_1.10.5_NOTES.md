# Lumi Studio 1.10.5: Tweak in LumiCast

This is the change from main 1.8.5 (commit 8581c0f), brought onto staging. LUMI_STUDIO_1.8.5_NOTES.md has the full details.

- **Tweak in LumiCast** sits next to Fill from LumiCast in the character and persona editor. It sends the character as it is in the editor, unsaved edits included, to LumiCast's Get from Lumi Studio (LumiCast 0.11.0 or newer). When you're done there, come back to the same character, choose Fill from LumiCast, then save.
- Fill only fills fields LumiCast has something for, so it never wipes your own entries. If Refine empties a field completely, clear that field here by hand.

Everything in 1.10.4 is unchanged. Don't update Lumi Studio from GitHub main over this staging build, or you'd go back to 1.8.x.

## 1.10.6: Tweak checks its own handoff

After sending, Lumi Studio reads the character back the same way LumiCast does. The message under the editor now says which character went over, how many fields it had, and that the check passed. If the check fails, the message shows the error instead of saying "sent". The server log gets a line too: `lumicast_send published lumidraw_studio.lumicast.tweak; read-back ok`.

In LumiCast, Get from Lumi Studio puts the tags in "04 / Lumi Studio character sheet", not in the description box. The description box fills only when this chat's Cast lorebook has an entry for that character.

## 1.10.7: no button to press in LumiCast

LumiCast 0.11.1 loads a character sent with Tweak in LumiCast by itself when its panel is open. If loading would replace work in LumiCast, it asks first with Load it / Not now. The message here now says "Open LumiCast" instead of pointing to a Get from Lumi Studio button.
