# Lumi Studio 1.15.0 — MOSS description box, NanoGPT in Studio

## Description for MOSS
- Character and persona sheets have a new box, **Description for MOSS (plain English)**, under Permanent appearance tags.
- Write face and body only, each trait once. MOSS presets use it word for word in place of the sentences LS builds from the tags. Clothes, pose and expression still come from the story, so wardrobe changes keep working.
- Anima presets ignore it. Empty means nothing changes.
- Used only for the sheet's own body: a character with alternate appearances switched to another look keeps the tag-built sentences.
- Macros such as {{char}} work in it. LumiCast's Fill and Tweak leave it alone.

## NanoGPT in the Studio tab
- Studio → Tune → Image renderer → **NanoGPT (online)**. Starts on `fal-ai/moss-image` at 1024×1024; Sync refreshes the model list.
- Sampler, LoRAs and Draw Things settings are hidden for NanoGPT. The prompt box is sent as written, so write plain English for MOSS.
- "Save new" turns the workspace into a NanoGPT preset as usual.
