# LumiDraw Studio 0.47.0

Includes 0.42.4 through 0.46.1.

## It wasn't my commits — I checked before answering

Every version I shipped this session, diffed on the image markup:

```
0.42.3   newContent.slice(0, paraEnd) + '\n\n' + mds[i]
0.42.4   ... identical ...
0.46.1   newContent.slice(0, paraEnd) + '\n\n' + mds[i]
```

`markdownAltText` is byte-identical between 0.42.3 and 0.46.1. All four image
templates are unchanged. And **LumiDraw's frontend injects no CSS touching message
images at all** — it never has.

So nothing LumiDraw emits changed what your selectors match. The image still goes in
as `\n\n![alt](url)\n\n`, which is what makes `p:has(img)` work in the first place.

### What I'd look at instead

Your stylesheet leans on two kinds of selector, and only one of them is stable:

- `[data-component="MessageContent"]`, `[data-part="user"]` — **stable.** Deliberate
  attributes Lumiverse puts there.
- `[class*="_avatar_"]`, `[class*="_prose_"]`, `[class*="_bubble_"]`,
  `[class*="inlineImageBtn"]`, `[class*="_bodyWrapperOpen_"]` — **not stable.** Those
  are CSS-module class names, generated at build time. A Lumiverse update can rename
  `_avatar_1a2b3` to something else and every rule keyed to it silently stops
  matching, with no error anywhere.

If the breakage is in the Moonlit Echoes half — portraits, glass panels, headers —
that half is entirely class-name-driven and a Lumiverse rebuild is the first
suspect. Checking one of those elements in devtools for its current class name
would settle it in about thirty seconds.

## And yes — LumiDraw can size images itself

**Settings → "Set the display width of images in chat"**, with a slider and a number
box (200–1200px, default 500). Applies immediately as you drag, to every image in the
conversation. Presentation only: no message is modified, nothing is regenerated.

It covers the *Full Width Images* half of your CSS — the part that is LumiDraw's
business — and is written to survive a rebuild better: stable `[data-component]`
attributes where they exist, attribute-substring matches for the hashed names where
they don't.

**Off by default, deliberately.** If your own stylesheet is still setting
`--lumi-image-size`, the two would fight. Either delete the *Full Width Images* block
and use this, or leave this off and keep yours. Not both.

The Moonlit Echoes theming — portrait rails, masks, glass content panels, Cormorant
headings, justified prose — is out of scope for an image extension, and I have not
tried to absorb it.

## One caveat

I could not test the CSS against a live Lumiverse from here. The stylesheet is
brace-balanced and the six rules are what I'd expect to work, but if a selector
misses, tell me which element and I'll adjust it against the real markup.

**39 suites · 1171 assertions · all green**, including 17 new ones for this feature.
