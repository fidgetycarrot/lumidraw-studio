# Lumi Studio 1.27.6: the style line for LumiCast's intro card

LumiCast 0.20.0 has an **Intro card** button that writes a NovelAI prompt of a character posed in front of their own name. Its style line now comes from Lumi Studio, so each chat's intro cards match that chat's pictures.

## What changed

- **A new shared endpoint, `lumidraw_studio.lumicast.style`.** LumiCast names the open chat, and Lumi Studio answers with the quality tags and prompt prefix of the preset that chat uses (the chat's own preset, else the default), plus the preset's name.
- **Read-only.** Nothing in Lumi Studio is changed or saved, and only LumiCast can call it.

Nothing else is different, and there is nothing to set up.

## Porting

`backend.js` only: `styleForLumiCast()` and its `rpcPool.handle('lumicast.style', …, { requires: [] })` registration, just above the "backend loaded" log line. It uses `getSettings`, `getPresets`, `presetNameForChat`, `storyPresetFor` and `resolveMacros`, and reads LumiCast's request at `lumicast.intro.request` (`{chatId, userId}`).

## Checked

Run against a fake host: another extension is refused, no chat named gives the default preset's line, and a chat with its own preset gives that preset's quality tags plus the story prefix. Not tried in a live Lumiverse.
