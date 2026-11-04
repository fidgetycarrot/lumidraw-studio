# Lumi Studio 1.22.0 — LoRAs for Draw Things cloud

- **LS Cloud Helper 1.1** adds `ls-cloud-helper add-lora FILE`: converts a `.safetensors` LoRA with Draw Things' own converter (which supports MOSS Image LoRAs), says which model family it was made for and warns if it is not MOSS, uploads it to your Draw Things cloud storage, and remembers it. `ls-cloud-helper loras` lists them. The helper serves the list at `/loras` and applies `loras: [{file, weight}]` to each cloud picture.
- **Draw Things cloud presets** show the LoRA rows again. The list offers the LoRAs the helper has added (it refreshes whenever the helper is checked, e.g. when the preset is opened). Up to six per picture; weight as in other presets.
- The Spindle log line and the helper log both list the LoRAs used for each cloud picture.
- An older helper (1.0) simply has no LoRA list; pictures still work without LoRAs.

# 1.22.1 + LS Cloud Helper 1.2 — cloud pictures can match the Draw Things app
- Why they differed: the helper started from MOSS's built-in defaults and changed only size, steps, CFG, shift, sampler and seed. The app also applies seed mode (which decides what a seed draws), sharpness, CFG zero star, tea cache and more, so the same prompt and seed gave a different picture.
- Cloud presets have a **Draw Things settings** box. Paste the app's Copy Configuration text there; the helper applies steps, CFG, shift, sampler, seed mode, resolution-dependent shift, sharpness, CFG zero star, sampling gamma, zero negative prompt, tea cache, guidance embed, CLIP skip and weight, hires fix and the app's LoRAs. Size, seed and prompt still come from LS; LoRAs picked in the preset replace the app's. While something is pasted, the preset's steps/CFG/shift/sampler boxes are hidden.
- Accepts the app's camelCase numbers and the HTTP API's snake_case names.
- The helper log lists which pasted settings it applied.

# 1.22.2 — an empty MOSS style means no style sentence
- Leaving the MOSS style box empty now sends no style sentence, so a style LoRA sets the look. Before, an empty box was quietly refilled with the default style ("A dark, atmospheric high-detail anime illustration…") on the Story tab, in the preset editor and when drawing.
- The style picker's first choice is now "No style sentence (a LoRA sets the look)", and the empty box says so.
- A preset that has never had a MOSS style (new presets, or switching a preset to MOSS for the first time) still starts with the default style.
