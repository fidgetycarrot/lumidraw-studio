# LumiDraw Studio 0.59.0

Includes 0.57.0 (cloud plumbing) and 0.58.0 (the scan queue).

## Read this first: leave cloud switched off

The cloud path is built, tested and working — and **unusable for Anima.** The
setting stays off by default and LumiDraw is unchanged for you in daily use.

Proven working: a clean cloud image from `animagine_xl_v3.1_f16.ckpt` through the
relay, with LoRAs, hires fix, sampler, shift and CLIP skip all crossing over
correctly. The plumbing is sound.

Proven impossible: Anima.

```
$ lumidraw-dt-cli --model "anima_base_1.0_f16.ckpt" --inspect
resolveModel: nil
inspectModel threw: unresolvedModelReference(query: "anima_base_1.0_f16.ckpt", suggestions: [])

$ lumidraw-dt-cli --model "animagine_xl_v3.1_f16.ckpt" --inspect
resolveModel: Optional(... version: Optional("Stable Diffusion XL Base") ...)
```

MediaGenerationKit resolves a model's **architecture client-side**, from the
Official catalog only — 317 entries, none of them Community. Anima is a Community
model. With no version, the pipeline configures the wrong architecture, the
server generates happily, and the client decodes the result as rainbow static.
That is exactly what both of your Anima attempts produced, including one stripped
to nothing but model, size, steps and guidance.

**Animagine is not a workaround**, because your LoRAs are Anima LoRAs — one of
them is literally named `..._illustrious_and_anima___anima_lora_f16.ckpt`, and
`fanny_priceanimalora_lora_f16.ckpt` is your character. Neither loads on SDXL.
Cloud without the character LoRA makes every picture of Fanny a stranger, which
defeats the point of the whole app.

**So: don't subscribe to Draw Things+.** The thing you'd buy it for isn't
available. Nothing about that is your setup's fault, and no amount of further
client work changes it.

## What you actually gained

**0.58.0's scan queue**, which is the real fix for what slow generation was
costing you. The old code gave a waiting message 5½ minutes and then threw it
away un-illustrated — and at your speeds, two messages behind one slow scan meant
the second was silently lost. It also had no ordering, which matters because
scene memory learns in sequence. Both fixed, and both are local.

If cloud ever becomes possible, everything is already in place: set the model in
Settings → Cloud, start the relay, tick the box.

## The one thing that could reopen it

`cloud-cli-fix/BUG-REPORT.md` is a short, reproducible report for Draw Things.
Community-channel resolution may well be a small change on their side — their own
README already flags remote model listing as an unfinished area. Worth sending;
not worth waiting for.

## Also in this release

Your recipe is now a test fixture — both LoRA weights, hires fix, the literal
`shift: 2.003709` — so if cloud ever works, a change that silently drops the
character LoRA fails a test instead of producing a stranger.

**44 suites · 1630 assertions · all green.**
