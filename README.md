# LumiDraw Studio 0.56.0 — install this one

Includes everything through 0.55.0. This is the clothing-persistence release.

## The advice was good, and its one-sentence version was the diagnosis

*0.55 trusted the record more than the story, and the record was the least
trustworthy thing in the pipeline.* I verified all three claims in code before
building — every one reproduced, and 1a was worse than claimed (the old outfit
layered itself *under* a reported sundress, three garments deep, because `sundress`
had no zone).

The self-sealing loop was real: wrong memory → correction forces it onto the
descriptor → the snapshot re-learns the corrected version → `garmentSupported`
passes anything already in memory → defended forever. A scan structurally could not
fix a bad record. Only the panel could — which is exactly what you observed.

## What changed

### 1. Memory's veto is now limited to adjective drift

Correction matches on garment **family** (head noun, folded across spelling
variants), not zone:

| record says | parser reports | result |
|---|---|---|
| white shirt | baggy blue shirt | **white shirt** — same family, drift killed |
| blouse | tank top | **tank top** — different family = a change; passage wins |
| silk blouse | fresh white blouse + "she changed into…" | **fresh white blouse** — change verbs escape the drift kill |

The family table is deliberately *finer* than the grounding synonyms: `blouse` and
`t-shirt` are different families here, because a parser told to report the outfit
only on change means it when it says one over the other.

**One departure from the advice:** `OUTFIT_CHANGE_RE` stays, rather than being
deleted. Family-matching cannot see a same-family real change (blouse → different
blouse), and the regex's false positives — "changed the subject" — now merely skip
the correction, which is the passage-wins direction anyway. Its failure mode
switched sides, so it went from dangerous to cheap.

### 2. The digest's discoveries are learned

Digest lines now count as grounding evidence in the memory write, on both the scan
and re-parse paths. Cold start self-heals: the digest finds "she pulled on her denim
shorts" thirty messages back, the outfit renders, **and it is remembered** — so the
digest stops firing. Previously it was "rendered but NOT remembered" forever and the
panel was the only write path that stuck.

### 3. Wardrobe lines use the anchor

The parser was being told "**Price** is wearing…" about a passage that only ever
says **Fanny**. It couldn't bind the line to anyone, treated it as a stranger's
wardrobe, and guessed — a strong candidate for why your scans went bad while the
plumbing was fine. The parser-facing name is always the anchor; `promptName` stays
what it was built for, the image model.

### Also in this pass

- The digest fires only for cast **present in this scene** (character/persona
  always; cast members only when the passage names them) — a big cast no longer
  runs it forever for someone offstage.
- The parser has a sanctioned dispute channel: *"If the CURRENT PASSAGE clearly
  shows different clothes — a change, not a re-wording — report the passage's
  version; your report outranks the wardrobe line."* With fix 1, that report flows
  through and gets learned, so the record self-corrects.
- `sundress`, `nightdress`, `minidress`, `romper` now zone as full-body garments.
- The odd-but-covered composition (remembered one-piece kept alongside a reported
  garment) gets a trace line: *"note: a one-piece was kept alongside the reported
  garment — odd but covered."*

## One thing to do per existing chat

Pre-0.56 records are still polluted and still defended until replaced. One pass with
the wardrobe panel — correct or clear each line — and from then on the system keeps
itself honest.

## What the traces should show now

- `re-worded garment(s) put back` **only** on same-family drift.
- Different-family reports passing through untouched, then `learned:` in the outfit
  memory lines.
- `rendered but NOT remembered` should stop appearing for digest-sourced outfits.
  If it doesn't, the digest isn't reaching grounding — send me that line.

**42 suites · 1482 assertions · all green.**
