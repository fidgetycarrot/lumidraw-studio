# LumiDraw Studio 0.49.1

Includes 0.42.4 through 0.49.0.

## The header was lying, and it was my fault

The version in the panel was a **literal string in the HTML**:

```html
<span class="ld-head-title">LumiDraw <small …>v0.42.3</small></span>
<button class="ld-launcher" title="LumiDraw Studio v0.42.3" …>
```

Not a variable. So bumping `package.json`, `spindle.json`, and even
`EXTENSION_VERSION` changed nothing you could see — the panel has read **v0.42.3
through six releases**. Your install was almost certainly fine; the label just
couldn't tell you.

There were two more stale copies of the same number in `backend.js`, as fallbacks:
`(spindle.manifest && spindle.manifest.version) || '0.42.3'`. If the manifest ever
failed to load, the extension would have confidently reported 0.42.3 forever.

## One source of truth

The header now shows whatever the **backend reports from the installed
`spindle.json` manifest** — the file you actually install. There is no version to
display that the installed extension doesn't own. The backend's fallback is now an
empty string and the log says `unknown — no manifest` rather than naming a version
it can't verify.

## And a check for the failure mode you've already hit

Copying `backend.js` but not `frontend.js` leaves two versions running against each
other, and every symptom of that looks like a bug in whichever feature you were
testing. If the two disagree now, the header says so:

```
LumiDraw  v0.49.1 · UI v0.46.1
```

in amber, with a console warning naming the file that didn't get copied.

## Sanity check for this build

```
package.json   0.49.1
spindle.json   0.49.1
frontend.js    0.49.1
```

After installing, the panel should read **v0.49.1** with no amber. If it shows two
numbers, one file didn't land.

**40 suites · 1256 assertions · all green**, including 14 new ones asserting no
version literal survives in the markup.
