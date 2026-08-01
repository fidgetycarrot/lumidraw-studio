# LumiDraw Studio

A Spindle extension that bridges **Draw Things** and **Lumiverse**. Sync models
and settings straight from the Draw Things API, pin them as named presets, and
generate from inside Lumiverse — without ever hand-typing a case-sensitive
model filename again.

Inspired by the workflow of LumiSwarm-Studio, rebuilt for Draw Things' API.

## Why this exists

Draw Things' HTTP API doesn't implement the A1111 listing endpoints
(`/sdapi/v1/sd-models`, `/loras`, `/samplers` all 404), so Lumiverse's built-in
A1111 connector can't populate its model dropdown. But `GET /` returns the
app's full current recipe — exact model filename included — and
`/sdapi/v1/txt2img` honors a per-request top-level `model` key. This extension
leans on both: **capture recipes from the app, replay them exactly, forever.**

Because every generation carries its complete config, your presets are
independent of whatever you're currently experimenting with in the Draw Things
UI. Tinker freely; story gens stay pinned.

## Setup

1. In **Draw Things**: Settings → API Server → enable, protocol **HTTP**.
   Note the port (avoid 7860 if Lumiverse uses it — e.g. 7862).
2. Install this extension in Lumiverse's Extensions panel.
3. Click the 🎨 launcher (bottom right) → **Settings** tab → set host/port →
   **Test connection**.

## Usage

- **Sync ⟳** — captures the recipe Draw Things is currently showing. Note: DT
  displays the settings of whatever image is *selected*, so you can select any
  old favorite in the app and capture its exact recipe.
- **Presets tab** — name the synced recipe and save. Selecting a preset pins
  its full config (model, sampler, steps, CFG, size, LoRAs, clip skip, shift)
  for every generation. A prompt prefix and negative prompt can ride along.
- **Generate tab** — prompt, optional seed (blank = random, `↩ last` reuses
  the previous seed), Generate. Results land in the panel history and in
  Lumiverse's image library.
- **Rescan old message 📚** — in Parser mode, choose any earlier assistant
  message from the active chat and generate another illustration for that exact
  passage. The same action also appears in the chat input bar's **Extras** menu.
- **Choose old message 📚** — while Story illustrations is set to **Parser**,
  opens a searchable list of assistant messages in the current chat. Pick any
  passage to run the parser again and add a newly generated illustration to
  that exact message. Existing images are preserved.

## Verified Draw Things API behavior (July 2026)

- `GET /` → full current config as JSON (exact model names)
- `POST /sdapi/v1/txt2img` → accepts DT-native keys; a top-level `"model"`
  selects the checkpoint per request (verified via fixed-seed A/B outputs)
- Unknown payload keys are rejected loudly:
  `{"error":"HTTPException","detail":"Unrecognized keys: [...]"}` — typos fail
  fast instead of silently generating with wrong settings
- `override_settings` (A1111 style) is **not** supported; use top-level keys
- No `/sdapi/v1/sd-models`, `/loras`, `/samplers`, `/progress` (all 404)

## Roadmap

- **Cloud provider** — per-preset compute target using the official Draw
  Things Cloud API (api.drawthings.ai) with a DT+ API key stored in the
  secure enclave, so heavy story gens run on their GPUs instead of your Mac
- img2img support
- Optional model catalog via Draw Things' gRPC server or model directory scan

## Notes

- The backend runs in Spindle's `process` runtime and reaches Draw Things at
  `127.0.0.1` directly. If your Lumiverse server runs on a different machine
  than Draw Things, set the host accordingly (e.g. a Tailscale address).
- `requested_capabilities: ["base64_decode"]` is declared because the backend
  decodes Draw Things' base64 image responses for upload to the image library.

## Verifying an update

The panel header displays the loaded frontend version. For this release it must
show **v0.13.1**. If an older version remains visible after replacing files,
disable and re-enable the extension, then reload Lumiverse from origin so the
browser fetches the new frontend bundle.
