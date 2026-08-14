# LumiDraw Studio 0.69.0 — I looked in the wrong field

0.68.0 didn't fire. Your report showed it plainly: still
`persona anatomy "none"`, and **no `anatomy gate · Jason` line in the trace at
all**.

## Why it didn't fire

I made the gate accept the act as ownership evidence — then looked for the act in
the **relations**. LumiDraw's own instruction tells the parser to do the
opposite:

> The FIRST relation establishes the base body arrangement: *"straddles the lap
> of", "stands between the knees of", "leans over", "faces", "sits beside"*.

Relation actions are **spatial by design**. The act goes in the scene statement,
with the clinical word — *"[name] is performing fellatio on [name]."* So my check
searched a field the act is deliberately kept out of, and the one path that did
read the statement was restricted to solo scenes, which excluded the two-person
case it exists for.

It now reads the statement, and everyone in the scene is a party to the act it
names. The gate still requires `anatomy_visible` from the parser and saved
anatomy on the profile — this is the third of three conditions, not a bypass.
Spatial relations alone still qualify nobody.

## The report gained one field

```
"actNamed": true
```

Whether the scene statement names a sexual act at all — a boolean, so it says
nothing about which. That single fact decides whether the gate can open for a
clothed participant, and last round I had to *infer* it from the absence of a
trace line. Now it's stated.

## A test that encoded the bug

This assertion existed in 0.68.0 and passed:

```js
ok('but a two-subject statement needs the relation to say who', ...)
```

The code agreed with it, so it was green. **Both were wrong** — that's a
description of your scene, asserted as correct behaviour. A test written from
the same misunderstanding as the code confirms the misunderstanding.

That's what the report caught that no amount of mutation testing would have. The
mutations all asked "does the code do what I meant?" and the answer stayed yes.
Only the app could say "what you meant was wrong."

## Try it again

Re-parse and send the report. What I'm hoping for:

```
"actNamed": true
persona  anatomy "penis"
```

plus an `anatomy gate · Jason` line in the trace. If `actNamed` comes back
**false**, the parser isn't using a clinical act word in the statement, and the
fix is in the instruction rather than the gate — different problem, and the
report will now say which.

## About the orientation

Worth being straight: getting his anatomy into the prompt is necessary but may
not be sufficient. "Sitting on his chest, facing away, performing the act" is
three spatial facts at once, and Anima has to hold all of them against a strong
prior for the conventional arrangement.

If it's still wrong with the anatomy present, the next lever is the relation
vocabulary — the first relation should be establishing "sits on the chest of"
with a facing-away cue, and `hasAction` in the report tells us whether it's even
trying. That's a further round, and it's fixable in the same way this was.

**52 suites · 2,025 assertions · all green.** Mutation-tested three ways: the
statement path removed, widened to any statement, and subject membership
unchecked.
