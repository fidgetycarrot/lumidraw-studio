# Lumi Studio 1.23.0 — NovelAI

- **NovelAI is an image app.** Settings → Image apps has a NovelAI card: paste your persistent API token (novelai.net → Account Settings → Get Persistent API Token). It is kept in Lumiverse's secure storage.
- **NovelAI presets.** Choose "NovelAI (online)" as a preset's image app. It starts with V5 Full (High effort), 28 steps, guidance 5, Euler Ancestral, 832×1216, and the style and undesired content from the first NovelAI test, which you can change. Models: V5 Full (High or Medium effort), V5 Curated, V4.5 Full, V4.5 Curated. Samplers: Euler Ancestral, Euler, DPM++ 2M, DPM++ 2S Ancestral, DPM++ SDE. LoRAs do not apply. Medium effort uses NovelAI's fixed settings (14 steps, no undesired content).
- **One Character line per person.** Story pictures for a NovelAI preset use the same parser, character sheets and chat memory as Anima, but the prompt is split the way NovelAI's Character Prompts work:
  - main prompt: style tags, `nsfw` for adult pictures, the count tags (`1girl, 1boy`), framing, setting, and the scene sentence with names swapped for "the man", "the woman" and so on;
  - `Character (left): girl, adult woman, …` and `Character (right, back): boy, …`: each person's look, clothes, pose and face, with their spot.
- **Spots.** The parser says left, center or right for each person, plus "back" for someone further from the viewer (behind a counter, in a doorway). LS sends spots only when everyone has one; otherwise NovelAI places them itself. People joined in a kiss or sex act get no spot, as with Anima.
- **Who does what to whom** is written NovelAI's way: `source#pour coffee` on the person doing it and `target#pour coffee` on the other; `mutual#kiss` for a kiss; `source#`/`target#` for sex acts.
- The same text format works in Studio: write `Character (left): …` lines under the main prompt. History and redraws keep the Character lines.
- Sizes are rounded to NovelAI's steps of 64 and kept at or under one megapixel, which is free on Opus at up to 28 steps.
- NovelAI's normal reply is a zip file, which Lumiverse's network proxy does not pass to extensions, so LS uses NovelAI's streaming endpoint, which sends the picture as text.
- Clear messages for a refused token, too few Anlas and a busy account.
- LumiCast needs no change: its sheets are already Danbooru tags.
