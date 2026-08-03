# LumiDraw Studio

**Current build: v0.15.0**

A Spindle extension that bridges **Draw Things**, **LumiDraw Bridge**, and
**Lumiverse**. It keeps stable per-chat image presets while providing a separate
workspace for experiments and complete native dropdowns for installed image
models and LoRAs.

## v0.15.0 — Bridge catalog integration

- Connects from the Lumiverse backend to LumiDraw Bridge at `127.0.0.1:7863`.
  This works while Lumiverse is being used remotely on a phone because the
  browser never needs to reach localhost itself.
- Loads installed Draw Things image-model candidates and LoRAs from the native
  Bridge catalog.
- Filters obvious support weights such as VAEs, CLIP/text encoders, Qwen 3
  language weights, and LTX/Wan video weights out of the image-model dropdown.
- Converts model, sampler, and LoRA selection to real `<select>` dropdowns in
  both the temporary workspace and preset editor.
- Adds **Rescan catalog ⟳** to the Generate tab.
- Adds Bridge host/port, connection testing, and catalog status to Settings.
- Falls back to the remembered catalog and all saved preset values if Bridge is
  unavailable.
- Sampler choices combine the current Draw Things recipe, sampler values found
  in `/sdapi/v1/options`, previously saved samplers, and a conservative built-in
  compatibility list.

## Safety retained from v0.14.3

- Forces Draw Things `batch_count` to `1` for each requested illustration.
- Keeps only the first returned image if Draw Things unexpectedly returns a
  batch anyway.
- Visible preset values override hidden legacy `extra` values.
- Logs the effective Draw Things payload in the Lumiverse server log.

## Core workflow

- **Chat preset** — committed recipe used by Parser and Inline story images.
- **Workspace / draft settings** — temporary model, sampler, steps, CFG, size,
  LoRA, and negative-prompt changes for experimentation.
- **Update active preset** — commits the workspace to the selected chat preset.
- **Save as new preset** — preserves the experiment as a separate preset.
- **Rescan old message 📚** — runs Parser mode on a selected earlier assistant
  message and inserts the image back into that exact message.
- **Fullscreen and expanded text editors** — designed for phone use.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863` with the Draw
   Things Models folder authorized.
3. Install this extension by replacing its root files or importing the flat ZIP
   where `spindle.json` is at the archive root.

## Verify the update

The panel header must show **v0.15.0**. In the Generate tab, the catalog line
should report a connected Bridge and counts for image models, LoRAs, and
samplers. Use **Rescan catalog ⟳** after installing or removing Draw Things
models.

## Draw Things API notes

Draw Things' HTTP API reports the current recipe and accepts complete generation
configurations, but does not implement the usual A1111 listing endpoints for
models and LoRAs. LumiDraw Bridge supplies the missing filesystem-backed
catalog, while LumiDraw continues to send generation requests to Draw Things.
