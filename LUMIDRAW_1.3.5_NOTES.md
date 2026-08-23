# LumiDraw Studio 1.3.5

## Anchored native image mounts

1.3.4 proved that extension-owned `ctx.dom.inject()` mounts survive Lumiverse's
virtualized chat, but it attached the whole LumiDraw image host to the bottom of
the message bubble. That discarded LumiDraw's parser anchor placement.

1.3.5 keeps the native mount architecture and restores scene placement without
rewriting assistant message content:

- each generated image has its own injected mount;
- the saved parser/direct/inline anchor is matched against rendered message
  blocks by normalized `textContent`;
- the image is injected immediately after the paragraph/list/block containing
  that anchor;
- if a story anchor cannot be found, the image falls back to the top of the
  message, matching LumiDraw's pre-1.3.3 fallback;
- manual Studio insertions with no story anchor remain at the end;
- multiple images sharing one anchor preserve their stored order;
- image sizing still acts directly on LumiDraw-owned mounts;
- pre-1.3.3 inline images remain untouched.

No story/parser/wardrobe/generation logic changed from 1.3.4.
