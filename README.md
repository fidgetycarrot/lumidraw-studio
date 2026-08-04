# LumiDraw Studio 0.18.6

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.18.6 — Context and Loom continuity

This build changes only the experimental **Anima hybrid** Parser engine. Legacy
instruction-only mode remains current-message-only and otherwise unchanged.

### Reference context

Anima hybrid can now receive up to four immediately preceding chat messages as
reference context. The default is **2 previous chat messages**.

Reference context may resolve:

- pronouns and subject identity;
- carried or renamed props;
- clothing and accessory continuity;
- location and ongoing physical state.

The context is separated from the current passage with strict labels. The parser
is instructed that only the **CURRENT PASSAGE** may provide the illustrated
moment, action, pose, and exact anchor quote. Current-message facts always
supersede older context.

### Loom ledger continuity

When enabled, LumiDraw searches the current and recent messages for the newest
`<loomledger>...</loomledger>` block. It converts the HTML ledger into compact
reference text and sends it to the structured parser as continuity evidence.
The ledger itself is removed from the passage that may be illustrated.

This works with ledgers that track attire, accessories, location, state, props,
and per-character visual reminders. It does not require another LLM call and it
does not alter the roleplay message.

The Story tab now includes:

- **Reference context:** current message only through four previous messages;
- **Use latest `<loomledger>` as continuity reference:** on by default.

The last-parser debug panel reports whether a ledger was found and shows capped
previews of the context actually supplied.

### Stronger generic ownership anchoring

In multi-subject images, a selected signature trait now uses an exclusive
ownership sentence:

```text
Sovi is the only subject wearing round glasses.
```

This logic is character-agnostic and also applies to other eyewear, pointed
ears, horns, wings, tails, visible markings, and piercings. Only one selected
signature trait per subject is lifted into natural language; the remainder of
the prompt stays compact and tag-oriented.

### Generic signature-prop recovery

Named prop aliases can now activate when the parser uses only the generic object
class. For a profile mapping such as:

```text
Aegis-fang = single massive warhammer
```

an extracted phrase such as `holds hammer one-handed` can compile to:

```text
Wulfgar holds Aegis-fang, a single massive warhammer.
```

The matching is based on generic object classes and profile data. No character
or item names are hardcoded into the compiler.

The compiler identifier is now `anima-hybrid-v5`.

## Parser reliability retained

- Structured JSON truncation recovery and per-image token allowances.
- Scan lock and duplicate-trigger protection.
- Live stage updates, elapsed timer, Cancel Parser, and four-minute timeout.
- Maximum-image hard cap before Draw Things generation.
- Legacy instruction-only mode as the known-good fallback.

## Other retained behavior

- User quality tags and negative prompts remain untouched.
- Inline mode remains on the simpler pre-0.17 tag-only path.
- Immediate History updates and manual History refresh.
- Old-message rescanning with chat-message and story-message numbering.
- In-app image viewer with zoom, pan, prompt restoration, and reuse.
- Bridge-powered model, sampler, and LoRA catalogs.
- Draw Things `batch_count` is forced to `1`; only the first returned image is
  accepted for each requested illustration.

## Suggested test

1. Confirm the header and Terminal show **v0.18.6**.
2. Select **Anima hybrid experimental**.
3. Leave Reference context at **2 previous chat messages** and Loom ledger on.
4. Run a scene whose current reply uses a pronoun, generic prop name, or carried
   clothing/accessory established just before it.
5. In Last Anima hybrid compile, verify `contextMessageCount`, `ledgerFound`, and
   the capped context previews.
6. Check whether signature accessories stay on their owning subject and whether
   generic props expand through the preset's visual alias mapping.
