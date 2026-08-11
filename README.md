# LumiDraw Studio 0.53.1

Includes 0.42.4 through 0.53.0.

## The prompt shows it: "Price, in a t-shirt and sneakers"

A top and shoes, and nothing between them. 0.53.0 only restored the wardrobe when
the passage described **no** clothing at all — a partial outfit still replaced the
whole thing.

And a partial outfit is the commoner case, for a reason your passage makes obvious:
Jason was *fisting the back of her shirt*. The shirt is load-bearing in the prose, so
the parser reports the shirt. Nobody had cause to mention shorts, so there were none.

## Restored by zone

Garments now carry a zone — top, bottom, feet, legs, or full-body — and only the
zones the passage left silent are filled in from what she was last seen wearing.
What the passage *did* say is never touched.

| the passage says | result |
|---|---|
| `t-shirt`, `sneakers` | **+ denim shorts** |
| `cargo shorts` | **+ tank top** |
| `red dress` | nothing — a dress covers both |
| nothing at all | the whole remembered outfit (0.53.0) |

Only top and bottom are restored. Shoes nobody mentioned are noise, not immersion.

## Bareness is a decision, not an omission

The obvious way to get this wrong is to dress someone the story deliberately
undressed, so stated bare zones block the restore for exactly that zone:

- `nude` → nothing restored at all
- `topless` + shorts → stays topless
- `bottomless` + t-shirt → stays bottomless
- `barefoot` → stays barefoot

```
✓ outfit continuity · Price — the passage dressed only part of her (t-shirt,
  sneakers); denim shorts restored from what she was last seen in
```

## The thing to watch

This depends on her having been *seen* in the shorts — the wardrobe is written from
compiled scenes, so the first image after installing has nothing to draw on. It
should settle from the second image in a scene onward.

If she turns up half-dressed again, the trace line above is the one to send me: it
says what the passage reported and what was restored, so I can tell a memory problem
from a zone problem.

**42 suites · 1356 assertions · all green.**
