# Lumi Studio 1.21.0 — the parser writes MOSS scenes in plain English

## Why
MOSS reads plain English. LS used to take the parser's Danbooru tags for poses, expressions and contact and turn them into sentences with rules, and each scene found a new way for that to go wrong ("He has 45 years old", three people lined up inside a counter, "clenched teeth" drawn as a snarl). The parser is already a language model reading the story, so for MOSS it now writes those parts itself.

## What changes
- When a preset uses the MOSS Image prompt style (or its adult pictures go to one that does), the parser is asked for a few extra plain sentences alongside its usual tags:
  - **camera**: how close, from where, and the light with its source and side
  - **setting**: the place and the few things that matter for where people are
  - **each person's place**: "On the far side of the island", "Beside Lauren, on her own barstool"
  - **each person's action**: body, hands, face in plain words, where they look
  - **the moment**: what happens between people, whose body part touches what
- Rules for those sentences: no looks or clothes (LS adds them), physically possible positions, what each person sits or stands on, nobody sharing a seat, mild everyday words for faces, a camera that shows what the moment depends on.
- The MOSS prompt is then: style sentence → camera → scene summary → setting → for each person: place, **their MOSS description word-for-word**, what they are wearing (clothing memory), what they are doing → the moment.
- People without a MOSS description still get a description built from their tags, so writing MOSS descriptions (looks only) for recurring characters gives the best results.
- If the parser leaves a sentence out, or writes a tag list instead of a sentence, that part falls back to the 1.20 wording.
- If LS widened a crop to keep a foot in frame, its own camera words are used instead of the parser's.
- Anima (tags) prompts are unchanged, and Anima presets do not ask the parser for the extra sentences.

# 1.21.1 — a simpler Illustration mode menu
- "Parser" and "Direct" ran the same simple pipeline, so the menu is now: Off, Inline, Only when I press Scan, Automatic after replies.
- A saved Parser mode shows as the matching choice and is saved as Direct the next time settings are saved. Only the old (pre-1.9) pipeline treated them differently.

# 1.21.2 — from the 3 Nov MOSS research (only the parts the official guide backs)
- **Shorter MOSS negative.** New default: `worst quality, bad anatomy, watermark, jpeg artifact, extra fingers, fused fingers` — the official short negative without "nsfw" (adult pictures are wanted) plus the two hand failures it names. The old 19-term default is replaced wherever a preset still had it unchanged; a negative you wrote yourself is kept. The old list also fought styles that want cel shading or realism.
- **CFG 3 by default for Draw Things cloud MOSS** (and the Prompt only suggestion): the official guide uses 3 for long prompts and 5 only for short ones. A CFG already saved in a preset is kept.
- **No photo words in the parser's camera sentence** (lens, film, 35mm, bokeh, depth of field, "shot on"): they pull MOSS toward a photograph.
- Not taken from the research: a second style sentence at the end of every prompt (the research's own guess, and it makes every prompt longer), and its NanoGPT-specific notes.

# 1.21.3 — layout mode checked against OpenMOSS's own prompt tool
- OpenMOSS publishes a prompt-writing skill with a compiler for layout prompts (skills/moss-image-prompt-enhancer, updated 2 Nov 2026). Its layout items are labelled `object`, `character` or `text`; LS labelled people `person`, which is not in that list. Now `character`.
- The box format already matched (centre-based pixels, y-x-y-x order), as did the summary and field names.
- Layout mode's overall caption now uses the parser's plain-English camera, setting and moment sentences when it wrote them.
- The skill's caption rules (cohesive prose, spatial relations in words, subject/action/appearance/setting/camera/medium/light/materials/palette, no quality tags) match what 1.21 already asks the parser for.
