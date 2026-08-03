# LumiDraw Studio 0.16.3

Desktop interaction and in-app image-viewer hotfix. This release keeps the
0.16 Studio / Story design and the proven 0.15 generation backend.

## What changed

- Replaces the desktop CSS Grid workspace with two ordinary nested flex rows.
  The visible Tune / Create / History and LoRA Library / Active Stack layout is
  retained, but Safari no longer has independently scrolling image panes inside
  a fixed-position grid.
- Reserves pane scrollbar space to prevent one-pixel layout oscillation.
- Replaces raw clickable `<img>` elements with stable button hitboxes. The image
  pixels ignore pointer events, so desktop clicks land on one consistent target.
- Adds a unified in-app image viewer for desktop and mobile.
- Removes all `window.open()` image behavior; images no longer launch separate
  browser windows or tabs.
- The viewer supports previous/next navigation, Escape to close, arrow-key
  navigation, backdrop close, and Insert into chat.
- Uses a uniform cursor inside the desktop LumiDraw surface as a WebKit cursor-
  flicker workaround. Controls remain fully clickable.

## Functionality retained

- Bridge-powered image-model, sampler, and LoRA catalogs.
- Standalone Studio workspace and committed Story presets.
- Inline and Parser story illustration modes.
- Old-message rescanning and exact insertion.
- Draw Things `batch_count: 1` safety guard.
- Fullscreen mode, expanded text editors, history actions, and preset editing.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer at `127.0.0.1:7863`.
3. Install the ZIP with all five files at the archive root.

## Verify

The header must show **v0.16.3**. On desktop, hover should no longer produce a
rapidly changing cursor. Clicking the central output or any History thumbnail
must open the image inside LumiDraw. The same in-app viewer is used on mobile.
