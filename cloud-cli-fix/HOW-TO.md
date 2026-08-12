# Fixing the Draw Things cloud CLI

## What's broken, and why it isn't you

`swift build -c release` in `media-generation-kit` fails with:

```
error: unable to resolve module dependency: 'CLICloudAuth'
```

`Sources/MediaGenerationKitCLI/MediaGenerationKitCLI.swift` imports a module
called `CLICloudAuth`. That module is declared **nowhere**:

- `media-generation-kit/Package.swift` gives the CLI target exactly two
  dependencies — `MediaGenerationKit` and `ArgumentParser`.
- `draw-things-community`, at the exact revision this package pins
  (`d473a2f1…`), exports three products: `gRPCServerCLI`, `draw-things-cli`,
  and `_MediaGenerationKit`.

No `CLICloudAuth` in either. Their README says this repo is synced from an
internal one; the sync brought the client's source but not the module it needs,
and that module is the cloud-authentication one. Nobody can build this client on
any machine, and it can't be patched because the source isn't published.

**The SDK is fine.** `_MediaGenerationKit` contains `RemoteImageGenerator` and
`GRPCServer`, and `backend: .cloudCompute(apiKey:)` is public, documented API.
Only the example client is missing. So we replace the client.

`draw-things-cli` is not an alternative, incidentally — its target depends on
`LocalImageGenerator` with no remote or gRPC pieces at all. It is local-only by
construction.

## Steps

**1. Prove your toolchain is healthy** (dependencies are already compiled, so
this is quick):

```bash
cd ~/Downloads/media-generation-kit
swift build -c release --product MediaGenerationKit
```

If this succeeds, only the broken target was the problem. If it *fails* with the
`clang dependency scanning failure` lines, that is a different issue — you are on
Command Line Tools rather than full Xcode (the log shows
`/Library/Developer/CommandLineTools/…` and a missing framework search path).
Install Xcode, run `sudo xcode-select -s /Applications/Xcode.app`, and retry.

**2. Swap in the replacement client:**

```bash
cd ~/Downloads/media-generation-kit
cp Package.swift Package.swift.original
cp ~/Downloads/lumidraw-studio-0-12/cloud-cli-fix/Package.swift .
rm -rf Sources/MediaGenerationKitCLI
mkdir -p Sources/LumiDrawDTCLI
cp ~/Downloads/lumidraw-studio-0-12/cloud-cli-fix/main.swift Sources/LumiDrawDTCLI/
swift build -c release
```

**3. Point the relay at it.** Open `start-cloud-relay.command` and change the
`CLI_PATH` line to:

```bash
CLI_PATH="$HOME/Downloads/media-generation-kit/.build/release/lumidraw-dt-cli"
```

Then double-click it. The relay detects which client it has and adjusts its
flags, so nothing else needs changing — and if the official client is ever
fixed, pointing back at it works with no further edits.

**4. Tell me what this prints:**

```bash
~/Downloads/media-generation-kit/.build/release/lumidraw-dt-cli \
  --api-key "YOUR-KEY" --model "anima-model-id" --dump-config
```

This is the important one. The README documents only `width`, `height` and
`steps`. Guidance scale, seed, sampler and shift are certainly configurable, but
their property names are not published, and guessing costs a full recompile per
guess. `--dump-config` reflects over the live configuration object and prints
every field with its type. Send me that list and I will wire the rest from fact.

Until then the client sets width, height and steps, and everything else uses the
cloud defaults — so your first images will be correct in size and step count but
will not yet honour your preset's guidance or seed.
