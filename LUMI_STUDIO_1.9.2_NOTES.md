# Lumi Studio 1.9.2 (staging): an easier Library

Only the Library's look changes. The backend is the same as in 1.9.0.

- **Search box** on Presets, Characters and Personas. It matches names and tags
  (for example "pointy ears"), and for presets it also matches the model,
  sampler, image app and LoRA names. Separate words must all match.
- **Sort**: A to Z, newest first or oldest first. Lumi Studio remembers your
  choice.
- **"Hide ones a story made"** for Characters, which hides the characters a
  story invented. Lumi Studio remembers this too.
- A **count** showing "7 of 28 characters".
- **Compact cards in a grid** instead of one long column. Each card shows the
  name, count tag, a "story-made" or "in use" label, the subject, and the first
  few tags. For presets it shows the image app, model, sampler, steps, size and
  LoRAs.
- **While you edit, the list hides.** The editor opens at its top with
  "← Back to the list", so you don't scroll past everything to reach it. Back
  works the same as Cancel.
- Deleting a preset now asks first, like characters and personas already did.

Checked in headless Chromium with 28 characters, 4 personas and 5 presets:
search by name and by tag, sort, the story-made filter, the no-match message,
opening an editor and going back, the remembered sort and filter after a reload,
no sideways scrolling at phone width, and no page errors. All existing controls
are still there.
