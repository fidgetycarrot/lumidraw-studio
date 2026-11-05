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

# 1.23.1 — names stay out of NovelAI prompts; a way back to the starting style
- First names are swapped too: "Lauren leans against the island" became "The woman in the center leans…" only when the story used her full sheet name, so "Lauren" and "Tara" reached NovelAI as plain words. With two women (or two men) the sentence says which one by spot.
- Inside a Character line, another person's name becomes "another", as in booru tags: "looking at Lauren Vance" → "looking at another".
- NovelAI presets have a **Go back to the starting NovelAI style** button: it puts the starting style and negative prompt back (press Save to keep them).
- The starting negative prompt also has `blush`.

# 1.23.2 — closer shots for NovelAI
- Same prompt, same settings: one person filling the frame came out right, three people in a wide shot got caricature faces about 60 pixels tall. For NovelAI presets the parser now picks the closest shot that still shows the moment: upper body or cowboy shot for people talking, touching or sitting together; full body when feet, legs or the whole pose matter; wide shot only when the place or the distance between people is the point.
- NovelAI presets always draw at the full size (up to NovelAI's free one megapixel), even with "Pick the size for each picture" on: smaller pictures only made faces smaller.
- Sizes snap to NovelAI's own shapes (1344×768 for 16:9, not 1344×704).
- The starting undesired content is Eric's own list from the picture he liked, plus `blush`.

# 1.23.3 — NovelAI's hidden undesired words
- The same prompt drew good faces on NovelAI's website and cartoonish ones through LS. The difference: the website's **Undesired Content preset** (Heavy by default) adds its own words to every picture without showing them — `lowres, artistic error, film grain, worst quality, bad quality, very displeasing, chromatic aberration, …` — and puts `nsfw` first for pictures that are not adult. V5 is trained on those words. LS sent only the typed list.
- LS now does the same as the website. NovelAI presets have an **Undesired Content preset** menu (Heavy, Light, Human focus, None), Heavy unless changed; existing NovelAI presets use Heavy. Its words go before the preset's negative prompt, with `nsfw` first unless the picture is an adult one.
- Medium effort uses the Heavy preset, as on the website.
