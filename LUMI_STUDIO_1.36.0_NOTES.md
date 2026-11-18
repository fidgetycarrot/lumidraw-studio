# Lumi Studio 1.36.0

## Studio looks like NovelAI when NovelAI is the image app

When Studio's image app is NovelAI, Studio switches to a layout like
NovelAI's own page:

- Left: App and Model, Effort (Medium/High, for V5 Full), one prompt box with
  Prompt and Undesired Content tabs, size buttons (portrait, landscape,
  square) with width × height, and one settings line (Steps, Guidance, Seed,
  Sampler) that opens when clicked. Generate is pinned at the bottom.
  Cmd/Ctrl+Enter in the prompt generates too.
- Middle: the picture, large. Click it for full screen. Under it: size, seed
  and time, and Reuse seed, Use prompt, Add to chat and Delete (asks twice).
- Right: a strip of small thumbnails, newest first, loaded as you scroll.
  "History" folds it away; that is remembered.

The LoRA library, the stack, bridge and Draw Things settings are not shown.
Switching the App back to Draw Things, SwarmUI and so on brings back the
regular Studio layout. Everything here writes into the regular Studio fields,
so the two layouts never disagree.

## Enhance

"✦ Enhance" above the picture redraws it from itself, as NovelAI's Enhance
does: image-to-image with the picture's own prompt and a new seed.

- Size: Same size (free on Opus) or 1.5× larger (uses Anlas).
- Change: Light, Medium or Strong.

The result is a new picture in history; the original is kept.

Not tested against NovelAI itself yet. Lumi Studio sends the picture inside
the normal request; if NovelAI refuses it, the message says so.

## Upscale is not included

NovelAI's upscaler answers with a zip file, and Lumiverse does not let an
extension receive zip files from a POST request. Enhance at 1.5× is the way
to get a larger picture for now.

# 1.36.1

The NovelAI layout's prompt box was cramped:

- The left column is wider (400 px).
- The prompt box grows to fill the left column instead of leaving empty space
  under the settings.
- A ⛶ button on the prompt box opens the Prompt or Undesired Content text
  full screen; Apply (or Cmd/Ctrl+Enter) puts it back.

# 1.36.2

"Fewest pictures per reply" was only read by the old parser. The current one
always told the model "usually one", so a minimum of 2 was ignored. The parser
is now told the minimum: with 2 it must find two different moments in the
reply (what led to the main moment, or what follows), up to the maximum. The
minimum cannot be higher than "Most pictures per reply".
