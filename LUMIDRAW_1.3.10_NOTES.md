# LumiDraw Studio 1.3.10

Startup hotfix for the 1.3.7–1.3.9 frontend failure.

## Root cause

A UI tooltip added in 1.3.7 contained `chat\'s` inside a JavaScript single-quoted string embedded in a template expression. The unescaped apostrophe made `frontend.js` invalid as an ES module. The backend could still start normally, but Lumiverse could not import the frontend, so no launcher or diagnostic button could appear.

## Fix

- Corrected the invalid string literal.
- Keeps the 1.3.7 chat/cast isolation fixes.
- Keeps the 1.3.8/1.3.9 launcher recovery and startup diagnostic safeguards.
- No Direct-mode, image-mount, parser, wardrobe, or backend behavior was otherwise changed.
- Release validation now includes an actual ES-module import/parse test for `frontend.js`, matching how Lumiverse loads it more closely than `node --check`.
