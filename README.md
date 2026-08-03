# LumiDraw Studio 0.16.2

Safari hit-testing compatibility hotfix. Keeps the 0.16 workspace layout and 0.15 generation backend while removing nested paint containment, isolation, translucent core surfaces, and inherited compositor effects that can cause cursor and hover flicker.


**Current build: v0.16.2**

A Spindle extension that turns Draw Things into a responsive image-generation
workspace inside Lumiverse. LumiDraw keeps automatic story illustration separate
from temporary Studio experiments and uses LumiDraw Bridge for installed image
models, LoRAs, and sampler choices.

## v0.16.2 — Studio / Story redesign

This release changes the interface shell while keeping the proven v0.15.0
Bridge and generation backend intact.

### Studio

- Desktop workspace with dedicated **Tune**, **Create**, **History**, **LoRA
  Library**, and **Active Stack** panes.
- Mobile Studio tabs for **Create**, **Tune**, **LoRAs**, **Stack**, and
  **History** so the phone view no longer becomes one long settings form.
- The newest generated image is displayed on a proper Create stage.
- Prompt, negative prompt, seed, and Generate stay together in the Create pane.
- Installed LoRAs are searchable and can be added directly to the temporary
  active stack.
- Model, sampler, steps, CFG, dimensions, Sync, and workspace actions live in
  Tune.
- Main section and mobile Studio tab choices are remembered locally.

### Story

- Story illustration controls now have their own focused section.
- Inline / Parser / Off, image limits, parser connection, parser instruction,
  inline protocol, latest-message scan, and old-message rescanning are grouped
  together.
- The committed chat preset is shown clearly, with an explicit reminder that
  temporary Studio changes do not affect story generation until saved.

### Persistent state header

The header continuously shows:

- committed chat preset;
- workspace state and model;
- Bridge connection, image-model count, and LoRA count.

### Presets and Settings

- Preset management remains separate from generation.
- Draw Things and Bridge connection controls remain under Settings.
- Fullscreen mode and expanded text editors are retained.

## Generation behavior retained from v0.15.0

- Bridge-powered image-model, LoRA, and sampler catalogs.
- Backend-local Bridge access, including when Lumiverse is used from a phone.
- Offline fallback to remembered catalog entries and saved preset values.
- Committed chat presets for Parser and Inline story images.
- Temporary workspace for standalone/manual generations.
- Exact old-message rescanning and insertion.

## Safety retained from v0.14.3

- Draw Things `batch_count` is forced to `1` for every requested illustration.
- Only the first returned image is accepted if Draw Things unexpectedly returns
  a batch.
- Visible preset values override hidden legacy `extra` values.
- The effective Draw Things payload is logged in the Lumiverse server log.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`, with the Draw
   Things Models folder authorized.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Verify the update

The header must show **v0.16.2**. On desktop, Studio should display five panes.
On a phone, Studio should display the Create / Tune / LoRAs / Stack / History
tab rail. Models, samplers, and LoRAs should populate exactly as they did in
v0.15.0.


## 0.16.2 Safari hit-testing hotfix

- Prevents duplicate LumiDraw UI mounts from stacking over each other.
- Removes backdrop-filter and sticky-layer combinations from the main workspace.
- Replaces the dynamic `:has()` status selector with explicit visibility updates.
- Makes noninteractive output metadata ignore pointer hit-testing.
- Keeps the 0.16.0 layout and the 0.15.0 generation backend unchanged.
