# Lumi Studio 1.27.0 — fuller faces

Ideas taken from LumiSwarm Studio's parser prompting (Nov 2026), whose pictures read emotions well.

- **The whole face, not one cue.** When a face is visible the parser gives one cue each for the eyes, the mouth and the brows ("narrowed eyes, clenched teeth, furrowed brow") instead of stopping at "smile", which drew the image model's default face.
- **One plain emotion tag** on top — angry, sad, scared, surprised, smug, nervous, worried, determined, happy… Vague labels such as "tense expression" are still turned into face details; these emotion tags are real Danbooru tags the image models learned from fan art. Banned words still drop out (e.g. embarrassed if it is on your list).
- **No face cues when the face is hidden** (turned away, from behind, in someone's shoulder, under a helmet), so the image model does not twist the head round to show it.
- Room for up to six face tags (eyes, mouth, brows, emotion, gaze) instead of four.
