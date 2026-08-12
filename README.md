# LumiDraw Studio 0.59.0 — cloud generation works

Includes 0.57.0 (cloud plumbing) and 0.58.0 (the scan queue).

## Set this and you're done

**Settings → Draw Things Cloud Compute → Cloud model:**

```
anima_base_1.0_f16.ckpt
```

That's the Exact variant. Not `_q8p`, which is what I'd have had you burn a
generation discovering — your saved PNG's metadata had the real answer.

Then start the relay (double-click `start-cloud-relay.command`), tick **Generate
on Draw Things cloud**, and press **Test cloud relay**.

## What the saved PNG changed

Your metadata showed two things I had wrong:

**Two LoRAs** — a style LoRA at 0.8 and the Fanny/Price character LoRA at 0.4.
I hadn't carried LoRAs at all. Without the character LoRA, every cloud image of
Fanny would have been a stranger who happened to match the tags. That is the
kind of bug that looks like "cloud quality is worse" rather than like a missing
field.

**Hires fix on**, second stage 0.7, at 512×704. I had deliberately excluded
hires fix as "a local performance setting a cloud GPU doesn't need". Wrong — for
you it is part of the picture, not part of the speed.

Both now cross over. So does the exact `shift: 2.003709`, CLIP skip 2, DDIM
Trailing, and guidance 4.

Still deliberately dropped: tiled decoding, compression artifacts, the refiner.
Those genuinely are local-performance settings.

## What was actually wrong all along

Worth recording, because four wrong turns happened before this worked and only
one was avoidable by me:

1. **Their CLI cannot be built by anyone.** `MediaGenerationKitCLI.swift` imports
   `CLICloudAuth`, which exists in neither package manifest. We replaced it.
2. **`downloadableModels` returns the Official channel only.** All 317 of them,
   current — but Anima lives in the **Community** channel, which the SDK cannot
   enumerate. I concluded "Anima isn't available on cloud" from that and was
   wrong; you corrected me.
3. **I searched your disk for a cloud model.** Cloud compute means the server
   holds the weights. It was never going to be there.
4. **My `--dump-config` probe validated nothing.** All six candidate names
   "resolved", including one I invented, with `your-key` as the API key.
   `fromPretrained` accepts anything shaped like a filename and defers
   resolution to generation time.

The lesson worth keeping: the authoritative source turned out to be a file you
already had. Your own saved output had the model id, every setting, and both
LoRA weights in its metadata.

## Verification

**44 suites · 1630 assertions · all green.** The cloud suite now tests your exact
recipe as a fixture — both LoRA weights, hires fix, the literal shift value — so
a future change that silently drops the character LoRA fails a test instead of
producing a stranger.

Also covered: a bare-string LoRA, `name`/`model` spellings, and a LoRA with no
filename being dropped rather than sent empty. A missing weight defaults to 1,
never 0 — a LoRA at zero is a LoRA that silently did nothing.

The relay was run end to end against a stand-in CLI and emits:

```
--width 512 --height 704 --num-inference-steps 40 --guidance-scale 4
--seed 273041214 --sampler DDIM Trailing --shift 2.003709 --clip-skip 2
--hires-fix --hires-fix-strength 0.7
--lora incase_style.ckpt@0.8 --lora fanny_priceanimalora_lora_f16.ckpt@0.4
```

## Worth checking first

Open `~/Downloads/cloudtest.png` and compare it to the original you pulled those
settings from — same seed, same everything, so they should be near-identical. If
they are, the whole chain is faithful and LumiDraw will produce the same.

If the character looks wrong, your LoRAs may not be on Draw Things' cloud storage
and are being silently ignored. That's what `lora upload` is for, and it is a
Draw Things+ feature — which would be the first real reason to subscribe.
