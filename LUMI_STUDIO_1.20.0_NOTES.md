# Lumi Studio 1.20.0 — Draw Things cloud, straight into the chat

## The LS Cloud Helper
- A small program for the Mac (`cloud-helper/`, see its HOW-TO). It makes pictures on Draw Things' cloud with the Draw Things+ API key, which it keeps in the Mac's Keychain. LS never sees the key.
- Tested on 3 Nov 2026: a 50-step MOSS picture came back in 51–73 seconds, adult prompts included.
- Lumiverse ends every extension request after 30 seconds, so LS hands the helper a job and checks back every few seconds until the picture is ready (up to 8 minutes).

## New image app: Draw Things cloud
- In the preset editor and the Studio tab, next to Draw Things, SwarmUI and NanoGPT.
- Model defaults to MOSS Image (`moss_image_sft_q8p.ckpt`), with MOSS's 50 steps, CFG 4 and shift 5. Sampler, steps, CFG, shift and size come from the preset. A Shift box appears for this app only. LoRAs are not available yet.
- Settings → Image apps has a "Draw Things cloud helper" card: whether the helper is running, whether a key is saved, and how many of the 200 monthly cloud pictures LS has used. The count resets each month.
- The old "Cloud" setting and relay are untouched; their card is now titled "Draw Things cloud (old relay)".

## Adult pictures can be drawn with another preset
- The "Adult pictures: prompt only" checkbox is now a list: **Draw with this preset**, **Prompt only (copy into Draw Things+)**, or **Draw with "another preset"**.
- With another preset chosen, NSFW and explicit pictures are written in that preset's prompt style and drawn with its app and settings. Everything else uses this preset. For example, a Krea preset can send its adult pictures to a Draw Things cloud MOSS preset.
- Presets that had the checkbox on keep working as Prompt only.
