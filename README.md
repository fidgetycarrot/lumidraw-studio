# LumiDraw Studio 0.16.4

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.16.4 — history reuse and zoomable viewer

- Clicking a History thumbnail now loads that image into the center Create stage
  instead of immediately opening the viewer.
- The image's saved positive prompt, negative prompt, and seed are restored into
  the Create fields. History created before 0.16.4 may not contain a saved
  negative prompt; LumiDraw leaves the current negative prompt intact in that
  case.
- On phones, selecting a History image automatically returns to the Create tab.
- Tapping/clicking the centered image opens the in-app viewer.
- The viewer is constrained to the real iPhone safe-area viewport and no longer
  relies on `100dvh` for its mobile dialog height.
- Zoom controls are visible on both desktop and mobile.
- Supports pinch-to-zoom, double-tap/double-click zoom, wheel zoom, and drag-to-pan.
- Zoom range is 100%–600%; the percentage button resets to fit.
- Newly generated history entries now retain their negative prompt for exact reuse.

## Retained behavior

- Studio / Story / Presets / Settings redesign.
- Desktop Tune, Create, History, LoRA Library, and Active Stack panes.
- Mobile Create / Tune / LoRAs / Stack / History tabs.
- Bridge-powered image-model, sampler, and LoRA catalogs.
- Committed chat presets remain isolated from temporary Studio experiments.
- Old-message rescanning and inline/parser story generation.
- Draw Things `batch_count` is forced to `1` and only one image is accepted per
  requested illustration.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Verify

The header must show **v0.16.4**. Test both desktop and mobile:

1. Select a History thumbnail; it should move to Create and restore prompt/seed.
2. Tap the centered image; the viewer should stay inside the screen.
3. Pinch or use +/− to zoom, drag to pan, and tap the percentage to reset.
