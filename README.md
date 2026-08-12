# LumiDraw Studio 0.57.0 — Draw Things Cloud Compute

Includes everything through 0.56.0.

## Getting the API key

1. Go to **[api.drawthings.ai/dashboard](https://api.drawthings.ai/dashboard)** and sign in with
   the account your Draw Things+ subscription is on. (Sign-in is Google.)
2. Request a key. If you are not on Draw Things+ yet you can still get one — the
   free tier issues a key too, just with a smaller allowance.
3. Copy it. It is shown to you there; the dashboard is also where you top up if
   you go past the included allowance.

**The allowance is the thing to watch.** The key includes **20 generations a
month on the free tier, 200 on Draw Things+**, and it is metered separately from
the 40,000 compute units you get inside the app. Past that it is pay-as-you-go.
At 2–3 images per story message, 200 is roughly 70–100 illustrated messages.

## Read this before you subscribe

Three things I could not settle from here, in the order they are likely to bite:

**1. Anima almost certainly is not in the cloud catalog.** This is the big one.
Cloud Compute runs models from the Official or Community channels only — that is
the exact refusal you already hit: *"Cloud Compute can only access models from
Official or Community channels. Your local models cannot be used for this
generation."* Anima is your local file. If it is not offered in the cloud
catalog, **cloud images will not look like your local ones** — different model,
different tag behaviour, and every preset you have tuned is tuned for Anima. Your
custom LoRA can be uploaded (`lora upload`, a Draw Things+ feature), but the base
model cannot. Check the catalog on the dashboard before paying for a month.

**2. The CLI has to be built from source.** The cloud path is gRPC, published as
a Swift package. There is no REST endpoint, which is why LumiDraw could not just
point at a URL. You build `media-generation-kit-cli` with Swift Package Manager.
Worth knowing: a user hit Swift toolchain version mismatches building the sibling
`draw-things-cli`, so this may not be a clean five minutes.

**3. A cloud preset is a different preset.** Drop the turbo LoRA, guidance back
to ~5–7, steps to 40. Cloud did 40 steps plus a LoRA in under a minute against
your 47s for 17 turbo steps — but only if you stop asking it to run a turbo
config it does not need.

So: **get the free key first and test it end to end before subscribing.** 20
generations is enough to find out whether the output is usable.

## What shipped

### The relay

`lumidraw-cloud-relay.mjs`, included in this release. LumiDraw runs inside
Lumiverse's Node process and can neither speak gRPC nor run a Swift binary, so
the transport lives in a small local process instead — the same shape as the
Bridge. Zero dependencies; runs on plain `node`.

```bash
export DRAWTHINGS_API_KEY="dt-..."
node lumidraw-cloud-relay.mjs
```

**Your API key never reaches LumiDraw.** It is read from the environment in that
process, and nothing sends it onward. It is not in settings storage, not in the
frontend, not in a settings dump you might paste into a bug report, and it is
redacted from the relay's own log. LumiDraw cannot leak a secret it was never
given. `/health` reports only *whether* a key is present.

### Settings → Draw Things Cloud Compute

```
☐ Generate on Draw Things cloud instead of this Mac

  Relay host [ 127.0.0.1 ]   Port [ 7864 ]
  Cloud model [                              ]
              a catalog id or hf:// link — not a local filename

☑ If cloud fails, generate locally instead of not at all

  [ Test cloud relay ]
```

**Test cloud relay** distinguishes the three ways this fails, because they have
three different fixes: no relay running, relay up but CLI missing, or CLI up but
the key was rejected.

### Fallback is on by default

An image that arrives slowly beats no image. If the relay is not running, the
network hiccups, or the cloud errors, the generation is done locally and the
chat keeps illustrating. The history entry records `backend: 'cloud' | 'local'`
and, on a fallback, why — so a silent downgrade is still visible after the fact.

Two failures do **not** fall back silently into a shrug: **quota exhaustion**
and **no cloud model set**. Both are yours to fix, and spending local time on
them would hide the thing you need to see. Sending a local filename is
specifically prevented rather than attempted, since that request is the one
Cloud Compute is guaranteed to refuse.

## Verification

**43 suites · 1571 assertions · all green** — 88 of them new in `cloud.mjs`.

The new suite was mutation-tested rather than trusted for passing: I broke the
fallback, the payload filter, the model guard and the quota detector in turn and
confirmed each break was caught. The first attempt caught the fallback break by
*crashing*, which would have taken every later assertion down with it — that is
now a clean failure.

The relay was run for real: booted, health-checked, generated against a stand-in
CLI, and checked afterwards for a leaked key in its log (none) and leftover temp
files (none). `--seed -1` correctly omits the flag rather than sending -1.

## Still worth doing

The cheaper fix I mentioned is still unbuilt: a **background queue**, so
generation happens while you keep reading instead of while you wait. That costs
nothing per month and helps whether or not cloud works out. Say the word.
