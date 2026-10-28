# Lumi Studio 1.14.0 — NanoGPT and MOSS prompts

## NanoGPT (online pictures)
- **Settings → Image apps → NanoGPT (online):** paste your API key and press Save key. It is kept in Lumiverse's secure storage and never shown again. Remove key deletes it.
- **Library → Presets → Edit → Image renderer → NanoGPT (online).** Pick a model from the list (for example `fal-ai/moss-image`). Sampler and LoRAs are hidden because NanoGPT has neither.
- Steps and CFG are sent only when the model takes them; leave them empty for NanoGPT's defaults. Width × height (and "Pick the size for each picture") picks the nearest size the model offers.
- Choosing a MOSS model switches the prompt style to MOSS; choosing an Anima model switches it to Anima.
- Pictures go into the chat like any other. The cost and balance NanoGPT reports are written to the Spindle log, along with the settings that were sent (not the prompt or key).
- If the model's safety filter blacks out a picture, LS says so and adds nothing to the chat.
- MOSS's own prompt expansion is turned off, since LS already writes a full prompt.

## Style toggles
NanoGPT's website style buttons are not part of its API. The preset editor now has a **Picture style** list (Anime, Anime poster, Painterly, Semi-realistic, Comic book) that fills the style sentence at the start of every MOSS prompt. The sentence stays editable. Anime is the new default.

## MOSS prompts rewritten
Whole sentences instead of tags with commas:
- Franchise tags become their own sentence: "He is a Space Wolves space marine from Warhammer 40,000."
- Booru shorthand is spelled out: trap / otoko no ko → "a slim adult man with a soft, pretty, feminine face and a flat chest. He is clearly a man, not a woman." When nobody in the picture is a woman, "woman, girl, breasts, cleavage" goes in the negative.
- Articles and pronouns come back ("a corset", "a scar on his face", "aiming at the drop pod", "light through the rose window").
- Duplicates are trimmed ("scar" inside "scar on nose"; the longer of two eye-colour descriptions wins; "black hair" + "asymmetrical hair" become one).
- A worn helmet hides face, hair and eye details; sealed armour also hides skin, scars and tattoos.
- The sheet's default expression (e.g. smirk) is used only when the scene gives none.
- Mirror and twin negatives from the Anima path carry over.

# 1.14.1 — NanoGPT goes through Lumiverse's own connection
- 1.14.0 sent pictures through the extension network proxy, which gives up after 30 seconds. MOSS at 50 steps takes longer, so every picture timed out ("Request timed out after 30000ms").
- Pictures now go through Lumiverse's Image Generation connection, which has no such limit. The key lives there; LS no longer stores its own.
- Setup: in Lumiverse's **Image Generation** drawer, add a connection, choose **Nano-GPT**, paste the key. In LS → Settings → Image apps → NanoGPT, press Refresh and pick that connection (picked for you when there is only one).
- Size, steps, CFG, seed and the negative prompt are passed through the connection's raw request override, so the connection's own size list does not limit them.
- Lumiverse keeps its own copy of each connection picture; LS removes that copy after placing its own.
