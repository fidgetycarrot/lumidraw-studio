# Lumi Studio 1.13.0 — characters from Paige

When you press **Make my card** in Paige with the LumiCast box ticked, LumiCast 0.14.0 translates each character's look and Lumi Studio saves it:

- A new name becomes a new reusable character (or persona, for your Paige persona).
- A name that's already in your library keeps everything else and gets its six sheet fields replaced (count tag, subject, always include, appearance, outfit, anatomy).
- An open Lumi Studio panel shows the change right away.

Under the hood: a new shared endpoint, `lumidraw_studio.lumicast.add`, that only LumiCast can call. It reads the sheet LumiCast publishes at `lumicast.paige.sheet`. Nothing else changed.
