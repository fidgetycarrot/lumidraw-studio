# LumiDraw Studio 0.76.0 — casts, part 1 of 3: the data, and not losing yours

> "Build it. And I would love to not lose my character details and tags."

That second sentence is the specification. This release does the risky part —
the data model and the migration — and does it in the one way that can't lose
your work.

## The rule I held to

**Nothing is ever removed from a preset.**

The migration *copies* your character data into a new cast store. It doesn't move
it. Every preset keeps `characterProfile`, `personaProfile`, `castLibraryIds`,
every field, byte for byte. If every idea in this redesign turns out to be wrong,
your originals are still sitting exactly where they were.

Before it touches anything it also writes `presets_backup_pre_cast.json` — a
complete copy, written **once** and never overwritten, so even a later bug can't
damage the record of what you started with.

## What's new

- **`casts.json`** — a cast is *who is in a story*: main character, persona,
  supporting cast, with all their tags, anatomy, looks, states and aliases.
- **`chat_cast.json`** — which cast a chat is using.
- **One seam.** `castSourceFor` decides whether a chat's people come from a cast
  or from the preset. Everything downstream is unchanged.

## Nothing changes yet — deliberately

A chat with no cast bound behaves **exactly** as it did before. Same people, same
prompts, same everything. That's the whole reason this is safe to ship on its
own: the machinery is in place and inert until part 2 gives you a way to bind a
chat to a cast.

The migration runs on init, is idempotent, and creates one cast per preset that
has people in it.

## The failure I was most worried about

Not deletion — **reversion**. You fix a tag in a cast, init runs again, and the
preset's stale copy overwrites your correction. That would look like the app
eating your edits at random.

The migration never touches a cast that already exists. Rename it, rewrite every
tag in it, and a hundred later inits leave it alone.

## Verification

**57 suites · 2,357 assertions · all green.** 65 new in `cast2.mjs`, most of them
about your data specifically: every field of a fully-loaded profile asserted
individually through the migration — anchor, prompt name, count tag, appearance,
default outfit, anatomy and its mode, noun, named flag, appearance states, looks,
partial features, visual aliases, library links, supporting cast.

Mutation-tested four ways: migration overwriting an edited cast (3 failures),
backup overwritten on every init (1), the seam bypassed (3), shallow copy sharing
references with the preset (4).

**That last one escaped the first time.** My deep-copy test was written against
the host mock, which clones on every read and write — so aliasing was invisible
and removing the spreads passed clean. It's tested against the function directly
now, and the same mutation fails four.

## What's next

- **Part 2** — the Cast tab, binding a chat to a cast, and `[LUMICAST]` filling
  the chat's cast instead of a global list.
- **Part 3** — wardrobe keyed by chat + cast, so changing visual presets stops
  moving your characters' clothes. Then cast fields come out of the preset editor.

You can install this now or wait for part 2 — it does nothing visible either way,
which is the point.
