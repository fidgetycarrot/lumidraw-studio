# LumiDraw Studio 0.18.4

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.18.4 — Signature ownership and named prop aliases

Parser mode still has two clearly separated engines. **Legacy instruction-only**
remains unchanged and dependable. This build changes only the experimental Anima
hybrid compiler.

### Signature ownership anchors

Multi-character prompts now lift at most one distinctive visible trait per
subject into a short ownership sentence immediately beside that subject's tag
block. This is deliberately narrow and prioritizes details that commonly bleed:

- glasses and other eyewear;
- pointed ears, horns, wings, or a tail;
- visible tattoos, scars, birthmarks, and piercings.

Examples:

```text
Sovi wears round glasses.
Sovi, adult elf femboy, ...
```

```text
Wulfgar has tribal tattoo on left shoulder.
Wulfgar, adult human man, ...
```

Solo prompts remain tag-only. The compiler still avoids turning the entire
prompt into natural-language captions.

### Visibility-aware markings

Appearance markings are no longer treated as universally visible. Tattoos,
torso scars, and navel piercings are omitted when the current outfit appears to
cover them, unless the parsed outfit explicitly exposes the relevant area.
This prevents a hidden tattoo from becoming a floating trait that Anima can
attach to another subject.

### Named props / visual aliases

Each identity profile now has an optional **Named props / visual aliases** field.
Use one mapping per line:

```text
Aegis-fang = single massive warhammer
```

When the parser places that named prop in the character's outfit, pose, or
action, LumiDraw keeps the proper name and injects the visual description. A
non-bladed prop described as `sheathed` is normalized to `carried on back`.

The alias is not injected into unrelated scenes, keeping prompts compact.

### Recommended Wulfgar setup

- Stable subject phrase: `adult human man`
- Permanent appearance tags: keep the physical traits you want in every scene.
- Named props / visual aliases:
  `Aegis-fang = single massive warhammer`

The compiler identifier is now `anima-hybrid-v4`.

## Parser reliability and diagnostics

- Both engines retain the scan lock, duplicate-trigger protection, live stages,
  elapsed timer, Cancel Parser button, and four-minute timeout.
- Legacy Terminal logs begin with `legacy parser request started`.
- Anima hybrid Terminal logs begin with `parser request started`.
- Auto Parser and old-message rescanning use the selected Parser engine.
- Maximum images is enforced before Draw Things generation.

## Retained behavior

- Inline mode remains on the simpler pre-0.17 tag-only path.
- Immediate History updates and manual History refresh.
- Old-message rescanning with chat-message and story-message numbering.
- Studio / Story / Presets / Settings redesign.
- In-app image viewer with zoom, pan, prompt restoration, and reuse.
- Bridge-powered model, sampler, and LoRA catalogs.
- Draw Things `batch_count` is forced to `1`; only the first returned image is
  accepted for each requested illustration.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Suggested testing

1. Confirm the header and Terminal show **v0.18.4**.
2. Keep **Legacy instruction-only** available as the known-good baseline.
3. Set Wulfgar's Stable subject phrase to `adult human man`.
4. Add `Aegis-fang = single massive warhammer` under his Named props / visual
   aliases.
5. Re-run the Sovi/Wulfgar scene. Confirm the final prompt says that Sovi wears
   round glasses, omits Wulfgar's covered shoulder tattoo, and expands
   Aegis-fang only when the parser includes it.
6. Compare both returned images before deciding whether ownership improved.
