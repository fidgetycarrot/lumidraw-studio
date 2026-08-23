# LumiDraw Studio 1.3.1 — Lumiverse virtualized-chat optimization

- New story images are inserted as sanitized `<img>` markup with intrinsic width/height, `loading="lazy"`, and `decoding="async"` so Lumiverse can reserve their aspect ratio before decode.
- Removed LumiDraw's 4-second document-wide image scan; click-to-fix remains event-driven.
- Replaced relational `:has(img)` / hashed-class image sizing CSS with one stable MessageContent image selector.
- Image lookup, replacement, removal, old-message picker detection, and prompt-context scrubbing now understand both legacy markdown images and new HTML images.
- Version bumped to 1.3.1 across frontend, package, and Spindle manifest.
