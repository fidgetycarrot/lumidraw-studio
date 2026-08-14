# LumiDraw Studio 0.68.0 — the missing half of the act

Your report found a real bug, and it's very likely the reason the positioning was
wrong. It also caught a flaw in the report itself.

## What the report showed

```
character  anatomy "penis"   profileAnatomy "penis"   anatomyVisible true
persona    anatomy "none"    profileAnatomy "penis"   anatomyVisible true
```

**The receiving partner's anatomy wasn't in the prompt at all.**

The parser did its job — it set `anatomy_visible: true` for him. The gate then
threw it away. `anatomyMode: relevant` needs one of two things: the subject is
nude, or the passage names the anatomy *and* attributes it to him possessively.
He's in jeans with an open fly, so not nude; and prose like "she took him in her
mouth" names no anatomy at all.

So LumiDraw asked Anima for an image of an act, with the thing the act is
performed **on** absent from the description. The model had no anchor for what
was physically happening between the two bodies — which is exactly when they come
out arranged wrong. You were seeing the downstream symptom of a missing noun.

## The fix

**The act itself is the ownership evidence the gate was looking for.** If the
scene names fellatio and he is the target of it, whose anatomy is involved isn't
ambiguous.

`anatomyRequiredByAct` now satisfies the gate when the scene is nsfw or explicit,
a relation names an act that necessarily involves genitals, and the subject is a
party to that relation. Scope is deliberate:

- **Both actor and target count.** In these acts at least one participant's
  anatomy is the subject of the image.
- **An ordinary relation doesn't qualify.** "holds the hand of" in an explicit
  scene changes nothing — otherwise every embrace would expose somebody.
- **Safety still gates it.** Safe and sensitive scenes never reach this path.
- The parser must still have set `anatomy_visible`, and the profile must still
  have saved anatomy. This loosens one of three conditions, not all of them.

## The flaw in my own diagnostic

The report told you `camera: ["pov", "from above", "foreshortening"]` and I
started building a case that `pov` was fighting your described arrangement.

Then I checked where the report is captured: **before the POV filter runs.** With
two subjects both described as visible figures, the compiler had almost certainly
already dropped `pov` — the rule for that has existed for a while. I was reading
the parser's *request* and treating it as what was *sent*, off my own instrument.

The report now gives both, because the difference is the diagnosis:

```
"cameraRequested": ["pov", "from above", "foreshortening"],
"cameraSent":      ["from above", "foreshortening"]
```

If those differ, a rule fired. If they don't, it didn't. Either way you can see
it, which you couldn't before.

## Worth trying on that scene

Re-parse it once on 0.68.0. If the report now shows `persona anatomy "penis"`,
the missing noun is back and the arrangement has a fair chance of landing. If it
still shows `"none"`, send me the report again — the next suspect is the parser
not marking a relation with an act term, and that's visible in `hasAction`.

## Verification

**52 suites · 2,020 assertions · all green.**

Mutation-tested: the act gate removed, and the act filter widened so any relation
qualifies. Both caught.

One of my new assertions asserted the opposite of its own name — *"somebody not
in the relation does not"* was checking that they **did**. The function was right;
the test was wrong. That's the fourth test tonight that was wrong rather than the
code, and the reason to keep saying so is that a green number is only worth what
the assertions behind it are.
