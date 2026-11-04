# Lumi Studio 1.22.0 — LoRAs for Draw Things cloud

- **LS Cloud Helper 1.1** adds `ls-cloud-helper add-lora FILE`: converts a `.safetensors` LoRA with Draw Things' own converter (which supports MOSS Image LoRAs), says which model family it was made for and warns if it is not MOSS, uploads it to your Draw Things cloud storage, and remembers it. `ls-cloud-helper loras` lists them. The helper serves the list at `/loras` and applies `loras: [{file, weight}]` to each cloud picture.
- **Draw Things cloud presets** show the LoRA rows again. The list offers the LoRAs the helper has added (it refreshes whenever the helper is checked, e.g. when the preset is opened). Up to six per picture; weight as in other presets.
- The Spindle log line and the helper log both list the LoRAs used for each cloud picture.
- An older helper (1.0) simply has no LoRA list; pictures still work without LoRAs.
