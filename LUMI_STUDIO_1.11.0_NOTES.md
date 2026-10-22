# Lumi Studio 1.11.0: one version again

Staging and main are joined. Main now has everything that was built on staging, and everything that went to main in the meantime. Install from **main** from now on.

## What main gains

- **The new pipeline** (1.9 → 1.10): one parser call, prompts in the Anima layout, and per-chat memory of how people look and what they wear. It's on by default. The old 1.8 pipeline is still under Settings → Old pipeline (1.8), in case a scene needs it.
- The reorganised panels, library search, the **Draw now** button, and twinkling stars instead of the spinner.
- Fixes from the reports: wardrobes follow the story's own wardrobe list, temporary clothing states aren't remembered, the leather-armor guard, one moment per picture, "duplicate, twins" for group shots, and the left-to-right line for three or more people.
- **Pick the size for each picture** in the preset editor.
- The MOSS Image prompt builder, parked. A preset only uses it when its prompt style is set to MOSS.

## What staging gains from main

- 1.8.7, from the LC thread: **LumiCast can save a tweaked character back.** Tweak in LumiCast now sends the saved character's id. LC 0.12's Update in Lumi Studio writes the six sheet fields into that one entry and nothing else, and only LumiCast is allowed to do it. The read-back check from 1.10.6 is kept, so the message still says how many fields went over.
- Notes for 1.8.4–1.8.7.

Everything else that went to main (the fetch fix, removing and deleting from the viewer, Tweak in LumiCast) was already on staging.

## Checked

- Syntax check on both files.
- A full story scan and a re-parse on the stub host.
- The handoff and save-back through Lumiverse's own shared-RPC code: the tweak is sent and read back, LC syncs `tweak.result`, `lumicast.apply` saves "round eyewear" and "grey sweater" into the right entry and tells the panel, and any other extension is refused.
- Tweak in LumiCast, viewer delete and Draw now in headless Chromium.

## 1.11.1: a new sheet for someone LS already remembers

When someone with no sheet shows up in a picture, LS remembers their look and outfit for that chat (Jean White's emerald gown, say). When you later make a sheet for them:

- The sheet decides the body from then on. The look LS remembered is never mixed in.
- Their remembered outfit carries over to the sheet once, so they don't suddenly change clothes.
- The parser sees them once, as a sheet. Before, they also appeared as a separate "remembered person", which could confuse it.
- The old remembered entry is removed after their first picture with the sheet.

## 1.11.2: the elevator kiss

Report: "Riley facing the wall. Should be grabbing Eric and looking at him." What actually happened: the picture split into two panels, Eric on the left and Riley on the right, and Riley was kissing his own reflection in the elevator mirror.

- **No mirrors unless the moment is about one.** The setting had "mirrored walls" and the scene line had "mirrored corner". Those are now left out, and "mirror, reflection" goes into the negative prompt. A mirror stays when the scene line itself is about a mirror.
- **Kissing pairs aren't placed left and right any more**, the same as sex acts since 1.10.8. Both also get "facing another".
- **"Riley pins against wall Eric."** now reads "Riley pins Eric against the wall."

## 1.11.3: who gives and who receives

Report: "Riley should be receiving fellatio from Eric." The picture swapped them.

- **Riley's sheet has no anatomy listed,** so the prompt never said Riley had a penis. The only penis was in Eric's paragraph ("hand on penis"), and the model went with the usual femboy-gives pairing. Now, when someone's part in an act needs anatomy their sheet doesn't list, LS adds it for that picture only. That's "penis" for the receiver of fellatio, a handjob or paizuri, "pussy" for a woman receiving cunnilingus, and so on. Picture details says what was added, so it can go on the sheet. It isn't remembered as theirs.
- **Each person's paragraph now says their part:** "giving fellatio" and "receiving fellatio" (also cunnilingus, handjobs and paizuri). Before, the act was only in the last line.
- **In the giver's pose, "hand on penis" becomes "hand on another's penis".**
