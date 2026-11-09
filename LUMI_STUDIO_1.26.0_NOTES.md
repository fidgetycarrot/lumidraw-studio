# Lumi Studio 1.26.0 — settings from existing stories

- **Setting box in presets.** Write the world the preset's chats take place in ("Warhammer 40K", "Harry Potter"), or leave it empty for your own worlds. Short notes are fine too ("Tyranids: living chitin, no armour"); a weaker or older parser model gets the knowledge handed to it.
- **The parser draws the world its way.** With a Setting, it names creatures, peoples, factions, uniforms, gear and places the way that setting does, and lists every named thing in the picture with a plain description and, when it names a person or creature, who it is.
- **LS checks each name** on Danbooru (no key needed), or on Gelbooru when Danbooru does not answer:
  - plenty of pictures (100 or more): the name is sent as its tag, since the image model learned it from that fan art;
  - few or none: the plain description is sent instead.
  A name with a series in brackets is used only when the series matches the Setting, so "ork" in a 40K chat becomes `ork (warhammer)` and never another game's ork.
- Answers are kept for a month per setting, so each name is looked up once. When neither site answers, the description is used and the name is tried again next time.
- What a name became shows in the picture's notes, e.g. `Name "ork" → known (900 pictures on Danbooru): "ork (warhammer)"`.
- **Gelbooru key (optional)** in Settings → Image apps: paste the "&api_key=…&user_id=…" line from Gelbooru's account page. Kept in Lumiverse's secure storage.
- Chats whose preset has no Setting are unchanged.

# 1.26.1 — closing LS on iPhone
- On phones the panel's top edge sat under the iPhone's status bar and Dynamic Island, where taps go to the phone, so the minimize (–) button could not be pressed — in fullscreen always, and in the normal phone panel when Lumiverse runs full-screen as a web app. A header style from 1.18.1 had also undone the header's own room for the status bar. The panel now keeps clear of the status bar and home bar, and the fullscreen header starts below the status bar.
- The minimize and fullscreen buttons are bigger on phones (40 × 40, easier to tap) and stay on the title row.

# 1.26.2 — Test connection
- Settings → Image apps → Gelbooru has a **Test connection** button. It asks Danbooru and Gelbooru for a tag every picture site has and says, for each, whether it works — and for Gelbooru whether your key was used or turned down.

# 1.26.3
- Test connection says "the site is down right now" instead of showing the web page a down site sends back.

# 1.26.4
- NovelAI presets can use the **DPM++ 2M SDE** sampler.
