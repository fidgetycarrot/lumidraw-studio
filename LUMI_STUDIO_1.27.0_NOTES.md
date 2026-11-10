# Lumi Studio 1.27.0 — fuller faces

Ideas taken from LumiSwarm Studio's parser prompting (Nov 2026), whose pictures read emotions well.

- **The whole face, not one cue.** When a face is visible the parser gives one cue each for the eyes, the mouth and the brows ("narrowed eyes, clenched teeth, furrowed brow") instead of stopping at "smile", which drew the image model's default face.
- **One plain emotion tag** on top — angry, sad, scared, surprised, smug, nervous, worried, determined, happy… Vague labels such as "tense expression" are still turned into face details; these emotion tags are real Danbooru tags the image models learned from fan art. Banned words still drop out (e.g. embarrassed if it is on your list).
- **No face cues when the face is hidden** (turned away, from behind, in someone's shoulder, under a helmet), so the image model does not twist the head round to show it.
- Room for up to six face tags (eyes, mouth, brows, emotion, gaze) instead of four.

# 1.27.1
- No crypto library anywhere in the extension: picture ids are made without crypto.randomUUID/getRandomValues, which Lumiverse is blocking for extensions and which fail when Lumiverse is opened remotely over plain http.
- Removed an old leftover copy of the panel script (frontend-70039a83.js) that was never loaded.

# 1.27.2 — butt traits only when they can be seen
- A sheet's butt trait ("bubble butt", "(ass:1.3)", "round rear"…) turned people round in every picture to show it off. In Eric's test, no tag kept her facing the camera; both the tag and a plain-English phrase turned her round and looking back (the phrase also enlarged her whole lower half).
- LS now sends such a trait only when the picture shows the person from behind or the side (from behind, side view, looking back, bent over, all fours, walking away…). From the front it is left out — it cannot be seen there anyway — and the picture's notes say so. This applies to every image app, so Anima prompts drop it in front-facing pictures too.

# 1.27.3 — Anima weights work on NovelAI
- Sheets and style lines written with Anima's weights — `(trap:1.6)`, `(wide hips, thick thighs:1.3)` — are translated to NovelAI's form when a picture goes to NovelAI: `1.6::trap::`, `1.3::wide hips, thick thighs::`. NovelAI ignored the bracket form, so those weights did nothing there. One sheet now works for both.
- Brackets that are part of a tag name (`ork (warhammer)`, `painting (medium)`) are left alone; `\(` escapes become plain brackets. A weight of 1 just becomes the words.
