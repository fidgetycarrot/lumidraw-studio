# Lumi Studio 1.19.0 — Adult pictures: prompt only (for Draw Things+)

A preset setting that sends adult pictures to Draw Things+ and draws everything else as usual.

- **Library → Presets → Edit → "Adult pictures: prompt only (for Draw Things+)".** Tick it on the preset you draw with (for example your Krea preset).
- When the parser rates a picture **NSFW or explicit**, it is not drawn. Its prompt waits in the Prompt only sheet (the clipboard button), with MOSS's settings suggested (50 steps, CFG 4, shift 5) whatever the preset's own model is, and the sheet opens. Make it in Draw Things+ and use Paste picture.
- **Safe and sensitive** pictures are drawn with the preset as usual. When one passage gives both, the tame one is drawn and the adult one waits; the status says so.
- The prompt is written in the preset's prompt style; with plain English (MOSS) style it works for MOSS in Draw Things+.
- The general Prompt only switch on the clipboard sheet still sends every picture to Prompt only.

# 1.19.1 — search the NanoGPT model list
- A "Search models…" box sits above the NanoGPT model list in the preset editor and the Studio tab. Every word typed must appear in the model's name or id ("krea", "flux lora", "qwen 2.1"); the list shows how many match.
