# Lumi Studio 1.19.0 — Adult pictures: prompt only (for Draw Things+)

A preset setting that sends adult pictures to Draw Things+ and draws everything else as usual.

- **Library → Presets → Edit → "Adult pictures: prompt only (for Draw Things+)".** Tick it on the preset you draw with (for example your Krea preset).
- When the parser rates a picture **NSFW or explicit**, it is not drawn. Its prompt waits in the Prompt only sheet (the clipboard button), with MOSS's settings suggested (50 steps, CFG 4, shift 5) whatever the preset's own model is, and the sheet opens. Make it in Draw Things+ and use Paste picture.
- **Safe and sensitive** pictures are drawn with the preset as usual. When one passage gives both, the tame one is drawn and the adult one waits; the status says so.
- The prompt is written in the preset's prompt style; with plain English (MOSS) style it works for MOSS in Draw Things+.
- The general Prompt only switch on the clipboard sheet still sends every picture to Prompt only.

# 1.19.1 — search the NanoGPT model list
- A "Search models…" box sits above the NanoGPT model list in the preset editor and the Studio tab. Every word typed must appear in the model's name or id ("krea", "flux lora", "qwen 2.1"); the list shows how many match.

# 1.19.2 — prompt rewriting off everywhere LS can reach
- MOSS's prompt expansion was already sent as off (confirmed in a live test: with it off, NanoGPT draws from LS's prompt as written).
- Other models use other names for the same thing. Any of these a model lists in NanoGPT's model list is now switched off too: prompt_expansion, expand_prompt, enhance_prompt, prompt_enhancement, prompt_enhancer, prompt_upsampling, prompt_extend, enable_prompt_optimizer, prompt_optimizer, magic_prompt (magic_prompt_option is set to OFF).
- If a model rewrites the prompt anyway, its reply says so (actual_prompt / revised_prompt). LS now notices: a warning goes to the Spindle log and the rewritten prompt is saved with the picture, so a report shows what the model actually drew from.

# 1.19.3 — "This chat" lists who is in it again
- The 1.9.1 layout moved the list of people into Clothing tracking, leaving the "This chat" card with only "No saved cast bound". It now shows an **In this chat** row with everyone the chat is using (the chat character is marked). A saved character's name opens its sheet. Outfits and removing someone stay under Clothing tracking.
- The no-cast line now reads "No saved cast picked — that is fine. This chat keeps its own list."

# 1.19.4 — MOSS prompts lose the tag line
- MOSS prompts no longer start with the short tag line ("masterpiece, best quality, anime style, safe, 2girls, 1boy."). They open with the preset's style sentence. The Anima prompts are unchanged.
- Fixed "In the center is A 23-year-old woman…" when a person's MOSS description starts with "A", "An" or "The" and has no name in front.

# 1.19.5 — pictures land under their paragraph again
- Cause: Lumiverse staging (31 Oct, "render the message list more efficiently") now shows a message empty for a moment and fills its text just after. LS placed the picture in that moment, found no paragraph to follow, put it at the top, and never moved it.
- LS now waits while a message's text is still loading, and a picture that is not directly under its paragraph is moved there once the text appears.
- Anchors also match through curly vs straight quotes, dash styles and leftover * or _ marks.
- A picture whose words truly are not in the message still goes to the top, as before.

# 1.19.6 — pasting pictures from Mac apps
- ⌘V, Paste picture and drag-and-drop also accept a picture file that arrives with no type but a picture's name (.png, .jpg, .tiff, .heic…), as some Mac apps send it.
- When nothing usable arrives, the message now says what the clipboard or drop actually held (for example "text/uri-list, text/plain"), and the same goes to the browser console. A blocked clipboard read shows the browser's own reason.
- ⌘V in a text box with plain text is left alone.
