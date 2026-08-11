# LumiDraw Studio 0.53.0

Includes 0.42.4 through 0.52.0. (The cast block from 0.52.0 is in here too.)

## Clothing was a bug, not a hard problem

You were right that the story has no reason to keep repeating the outfit. LumiDraw
was already recording it — `outfitSnapshot()` saves what each character wore, every
scene, into chat memory. But the wardrobe was **only ever read to take a garment
off the wrong person**, never to keep one on the right one:

```js
const outfit = subject.outfit.length ? subject.outfit : inheritedOutfit
```

Passage says nothing about clothes → straight past the memory to the profile default.
So Fanny changed outfits every time the prose stopped mentioning them, which is
exactly your ten-messages-later problem.

The precedence is now:

1. **What this passage says** — she changed, or is described. Wins outright.
2. **What she was last seen in** — the passage is about what's happening, not what
   she's wearing.
3. **Her profile default** — nothing remembered yet.

```
✓ outfit continuity · Fanny — the passage did not describe clothing, so what she
  was last seen in was kept: denim shorts, tank top
```

Changing clothes still works, undressing still works, and a transformation whose
state says `omit` doesn't resurrect the old outfit.

## Cars: not a token problem

Worth saying plainly, because it changes what's worth trying. Anima has
comparatively **few car-interior images, and the ones it has are overwhelmingly
tight** — a face through a windscreen, two people from the waist up. Ask for
`full body` in a car and it has to invent the geometry of a cabin it never learned:
seats face the wrong way, the dashboard wraps, the door becomes a wall.

More description can't fix that. It isn't short of instructions, it's short of
training. So:

**Framing is capped at `cowboy shot` inside a vehicle.** That's where its training
actually lives. Applied before the widening logic and again after it, because "the
scene needs legs" has to lose to "this model cannot draw a cabin".

```
✓ camera repair — narrowed full body to cowboy shot — this model has barely seen a
  wide shot inside a vehicle and invents the cabin
```

**And the cabin tags are real now.** `car interior`, `vehicle interior`, `car seat`,
`steering wheel`, `dashboard`, `windshield`, `seatbelt`, `rear-view mirror`,
`driving`, plus bus, train, aeroplane and boat. None of these were in the vocabulary,
so anything the parser wrote about a car was being demoted to caption prose — where
it meant nothing to the model.

The cap also covers `cockpit`, `elevator`, `phone booth` and `shower stall`, which
fail the same way for the same reason.

**Honest expectation:** this should stop the worst of it — no more inventing a whole
cabin — but a tight shot of two people in a car is still the model's best case, not
a good case. If it's still wrong at cowboy shot, that's the ceiling rather than the
prompt, and the answer would be a LoRA rather than more words.

## Try it

Clothing is the one to watch: describe an outfit once, then play five or six turns
that don't mention it. She should stay dressed.

**42 suites · 1329 assertions · all green**, including a new `continuity` suite of 38.
