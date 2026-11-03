# LS Cloud Helper

A small program for your Mac. Lumi Studio gives it a prompt and settings; it makes the picture on Draw Things' cloud with your Draw Things+ API key and hands the picture back. Use it by making a preset whose image app is **Draw Things cloud**.

- Your API key stays in the Mac's Keychain (item "LS Cloud Helper"). Lumi Studio never sees it.
- It only listens on this Mac (127.0.0.1, port 7865), never on the network.
- Draw Things+ covers 200 cloud pictures a month. Lumi Studio counts them in Settings → Image apps.

## Install (first time)

This reuses the folder from the test on 3 Nov 2026, so Draw Things' engine does not have to compile again.

```
cd ~/ls-dt-test
curl -fsSL https://raw.githubusercontent.com/fidgetycarrot/lumidraw-studio/main/cloud-helper/Package.swift -o Package.swift
curl -fsSL https://raw.githubusercontent.com/fidgetycarrot/lumidraw-studio/main/cloud-helper/Sources/main.swift -o Sources/main.swift
swift build -c release
```

Save your key (from api.drawthings.ai/dashboard). It asks twice, and nothing shows while you paste:

```
.build/release/ls-cloud-helper save-key
```

Start it now and at every login:

```
.build/release/ls-cloud-helper install
```

Check it:

```
.build/release/ls-cloud-helper status
```

Keep the `~/ls-dt-test` folder: the login item runs the program from there.

## After an update

```
cd ~/ls-dt-test
curl -fsSL https://raw.githubusercontent.com/fidgetycarrot/lumidraw-studio/main/cloud-helper/Sources/main.swift -o Sources/main.swift
swift build -c release
.build/release/ls-cloud-helper restart
```

## Other commands

| Command | What it does |
|---|---|
| `test "a prompt"` | Makes one picture and saves it to the Desktop |
| `restart` | Restarts the running helper |
| `uninstall` | Stops it and removes it from login (the key stays in the Keychain) |
| `serve` | Runs it in the Terminal window instead, to watch what it does |

The log is at `~/Library/Logs/ls-cloud-helper.log`.

## How Lumi Studio talks to it

Lumiverse ends every extension request after 30 seconds, and a 50-step MOSS picture takes about a minute, so the helper works in jobs:

- `POST /jobs` with `{model, prompt, negative_prompt, width, height, steps, guidance_scale, shift, seed, sampler}` → `{id}` at once
- `GET /jobs/<id>` → `{state: queued | running | done | failed, step, totalSteps, image (base64 PNG when done), seed, error}`
- `GET /health` → `{ok, version, keySaved, busy, queued}`

Jobs run one at a time. Finished jobs are kept for 20 minutes.
