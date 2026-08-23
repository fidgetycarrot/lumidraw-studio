# LumiDraw Studio 1.3.3 — Lumiverse-native image mounts

## Why
Current Lumiverse virtualizes chat rows. LumiDraw 1.3.2 still displayed story images by storing image markup in the assistant message, which makes the host reconcile and remeasure that virtualized row. The 1.3.2 CSS sizing fix also remained constrained by Lumiverse's inline-image wrapper on this install.

## 1.3.3
- New LumiDraw story images are persisted in `image_placements.json`, keyed by chat + message.
- The frontend renders those placements with `ctx.dom.findMessageElement()` + `ctx.dom.inject()` into the mounted message bubble, following SimTracker's host-native pattern.
- Hot path: unchanged mounted images do nothing.
- Warm path: changed placement data updates the existing injected host in place.
- Cold path: first mount / remount injects into the exact message bubble.
- Chat switches, message deletion, and message swipes clear/reload native mounts appropriately.
- New images no longer require a message-content rewrite just to appear.
- Direct, Parser, and Legacy Parser modes write native placements.
- Inline mode writes a native placement and edits the message only to remove the private `<dt-image>` directive.
- Manual “Insert” uses the same native placement store.
- Regenerate/replace updates a native placement in place before falling back to legacy markup replacement.
- Remove/Delete understand native placements first, then old message markup.

## Image size fix
- Native images are not rendered through Lumiverse's inline-image component, so its wrapper can no longer cap LumiDraw's display width.
- The LumiDraw width slider directly sets the width of `.ld-chat-image-item` mounts with inline `!important` sizing.
- Intrinsic `width`/`height` remain on the image so aspect ratio is known before decode.
- Older pre-1.3.3 LumiDraw images keep an event-scoped legacy resize path when their virtualized message mounts. There is no periodic full-document scan.

## Permissions
`app_manipulation` and `event_tracking` are now declared, matching the current DOM/event APIs this rendering path uses.

## Validation performed here
- `node --check frontend.js`
- `node --check backend.js`
- backend top-level smoke load with a mocked Spindle context
- native placement storage: create → list → replace → remove smoke test
- ZIP integrity test

This environment cannot run the actual Lumiverse browser virtualizer, so real-host scroll behavior still needs an install test.
