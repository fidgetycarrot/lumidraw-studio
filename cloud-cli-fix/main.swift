// LumiDraw's replacement for media-generation-kit-cli.
//
// WHY THIS EXISTS
//
// The published media-generation-kit cannot build its own example client:
// Sources/MediaGenerationKitCLI/MediaGenerationKitCLI.swift does `import
// CLICloudAuth`, and no target or product by that name exists in either
// media-generation-kit/Package.swift or draw-things-community at the pinned
// revision. The module is not in the public packaging, so the build fails with
// "unable to resolve module dependency: 'CLICloudAuth'" on any machine.
//
// The SDK is unaffected. `MediaGenerationPipeline` and
// `backend: .cloudCompute(apiKey:)` are public, documented API. This file is a
// small client over exactly that, with the flags LumiDraw's cloud relay sends.
//
// FIELD TYPES ARE OBSERVED, NOT GUESSED
//
// The README documents width, height and steps and nothing else. The rest of
// the configuration was read off a live pipeline with --dump-config, which is
// why the casts below are exact:
//
//   seed: UInt32        guidanceScale: Float    shift: Float
//   steps: Int          strength: Float         clipSkip: Int
//   width/height: Int   sampler: SamplerType    batchCount: Int
//
// --dump-config is kept because it is how that list was obtained, and the next
// SDK revision may move things.

import Foundation
import ArgumentParser
import MediaGenerationKit

@main
struct LumiDrawDTCLI: AsyncParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "lumidraw-dt-cli",
    abstract: "Minimal Draw Things Cloud Compute client for LumiDraw."
  )

  @Option(name: .customLong("api-key")) var apiKey: String = ""
  @Option var model: String = ""
  @Option var prompt: String = ""
  @Option(name: .customLong("negative-prompt")) var negativePrompt: String = ""
  @Option var width: Int = 512
  @Option var height: Int = 768
  @Option(name: .customLong("num-inference-steps")) var numInferenceSteps: Int = 30
  @Option var output: String = ""

  // Everything below is optional. A negative value means "leave the cloud
  // default alone" rather than "set it to a negative number".
  @Option(name: .customLong("guidance-scale")) var guidanceScale: Double = -1
  @Option var seed: Int = -1
  @Option var shift: Double = -1
  @Option(name: .customLong("clip-skip")) var clipSkip: Int = -1
  @Option var strength: Double = -1
  @Option var sampler: String = ""

  // Repeatable: --lora "file.ckpt@0.8" --lora "other.ckpt@0.4"
  // Without these, a cloud image of a character LoRA subject is a stranger.
  @Option(name: .customLong("lora")) var loras: [String] = []

  // 512×704 with hires fix is a different picture from 512×704 without it.
  @Flag(name: .customLong("hires-fix")) var hiresFix = false
  @Option(name: .customLong("hires-fix-width")) var hiresFixWidth: Int = -1
  @Option(name: .customLong("hires-fix-height")) var hiresFixHeight: Int = -1
  @Option(name: .customLong("hires-fix-strength")) var hiresFixStrength: Double = -1

  @Flag(name: .customLong("check")) var check = false
  @Flag(name: .customLong("dump-config")) var dumpConfig = false
  @Flag(name: .customLong("dump-samplers")) var dumpSamplers = false
  // The catalog uses ids, not the display names the app shows. "Anima Base 1.0"
  // on screen is some other string here, and "Model not found on remote server"
  // does not say what it wanted — so ask the catalog directly.
  @Flag(name: .customLong("list-models")) var listModels = false
  @Option(name: .customLong("find-model")) var findModel: String = ""

  func resolvedKey() -> String {
    if !apiKey.isEmpty { return apiKey }
    return ProcessInfo.processInfo.environment["DRAWTHINGS_API_KEY"] ?? ""
  }

  // SamplerType is an enum whose case names are not published. Rather than
  // hard-code a mapping that silently rots, sweep the raw values and match on
  // how each one prints — the same strings --dump-samplers lists, and the same
  // ones Draw Things shows in its own UI.
  func findSampler(_ name: String) -> SamplerType? {
    let flatten = { (s: String) in
      s.lowercased().replacingOccurrences(of: " ", with: "")
    }
    let want = flatten(name)
    guard !want.isEmpty else { return nil }
    for raw in 0..<128 {
      guard let candidate = SamplerType(rawValue: numericCast(raw)) else { continue }
      if flatten(String(describing: candidate)) == want { return candidate }
    }
    return nil
  }

  mutating func run() async throws {
    // Needs neither a key nor a model.
    if dumpSamplers {
      for raw in 0..<128 {
        if let s = SamplerType(rawValue: numericCast(raw)) {
          print("  \(raw): \(s)")
        }
      }
      return
    }

    // Catalog lookups need no key and no model. Signatures are from the DocC
    // symbol graph, not guessed: the async overloads are the network-capable
    // ones and are non-throwing; only inspectModel throws.
    if listModels {
      let models = await MediaGenerationEnvironment.default.downloadableModels(
        includeDownloaded: true, offline: false)
      print("\(models.count) models in the catalog:")
      for entry in models { print("  \(entry)") }
      return
    }

    if !findModel.isEmpty {
      let matches = await MediaGenerationEnvironment.default.suggestedModels(
        for: findModel, limit: 25, offline: false)
      print("\(matches.count) close match(es) for \"\(findModel)\":")
      for entry in matches { print("  \(entry)") }
      return
    }

    let key = resolvedKey()

    if check {
      // The relay only needs to know the binary runs and has a key to use. It
      // deliberately does not print the key, or any prefix of it.
      print(key.isEmpty ? "no-key" : "ok")
      if key.isEmpty { throw ExitCode(1) }
      return
    }

    guard !key.isEmpty else {
      FileHandle.standardError.write(Data("no API key: pass --api-key or set DRAWTHINGS_API_KEY\n".utf8))
      throw ExitCode(1)
    }
    guard !model.isEmpty else {
      FileHandle.standardError.write(Data("no model: cloud needs a catalog id, not a local filename\n".utf8))
      throw ExitCode(1)
    }

    // "Model not found on remote server: anima" does not say what it wanted, and
    // the catalog id is not the name the app displays. Turn the dead end into a
    // list of near matches rather than making the next guess blind.
    var pipeline: MediaGenerationPipeline
    do {
      pipeline = try await MediaGenerationPipeline.fromPretrained(
        model,
        backend: .cloudCompute(apiKey: key)
      )
    } catch {
      var report = "\(error)\n"
      let near = await MediaGenerationEnvironment.default.suggestedModels(
        for: model, limit: 15, offline: false)
      if near.isEmpty {
        report += "no close catalog matches. Run --list-models for everything available.\n"
      } else {
        report += "closest catalog entries:\n"
        for entry in near { report += "  \(entry)\n" }
      }
      FileHandle.standardError.write(Data(report.utf8))
      throw ExitCode(1)
    }

    if dumpConfig {
      let mirror = Mirror(reflecting: pipeline.configuration)
      print("configuration fields (\(mirror.children.count)):")
      for child in mirror.children {
        print("  \(child.label ?? "?"): \(type(of: child.value)) = \(child.value)")
      }
      return
    }

    pipeline.configuration.width = numericCast(width)
    pipeline.configuration.height = numericCast(height)
    pipeline.configuration.steps = numericCast(numInferenceSteps)

    if guidanceScale >= 0 { pipeline.configuration.guidanceScale = Float(guidanceScale) }
    if shift > 0 { pipeline.configuration.shift = Float(shift) }
    if strength >= 0 { pipeline.configuration.strength = Float(strength) }
    if clipSkip > 0 { pipeline.configuration.clipSkip = numericCast(clipSkip) }
    // seed is UInt32 on the far side; -1 is LumiDraw's "random", and leaving it
    // alone keeps the randomly-seeded default the pipeline already carries.
    if seed >= 0 { pipeline.configuration.seed = UInt32(truncatingIfNeeded: seed) }

    if hiresFix { pipeline.configuration.hiresFix = true }
    if hiresFixWidth >= 0 { pipeline.configuration.hiresFixWidth = numericCast(hiresFixWidth) }
    if hiresFixHeight >= 0 { pipeline.configuration.hiresFixHeight = numericCast(hiresFixHeight) }
    if hiresFixStrength >= 0 { pipeline.configuration.hiresFixStrength = Float(hiresFixStrength) }

    // LoRA(file:weight:) is the one thing here I have not seen the declaration
    // for — the config dump showed `loras: Array<LoRA> = []` and an empty array
    // reveals nothing about its element. If this does not compile, the error
    // names the real initialiser; rebuilds are ~12s now, so that is a cheap way
    // to learn it.
    if !loras.isEmpty {
      var built: [LoRA] = []
      for spec in loras {
        let parts = spec.split(separator: "@", maxSplits: 1)
        let file = String(parts[0])
        let weight = parts.count > 1 ? (Float(parts[1]) ?? 1.0) : 1.0
        built.append(LoRA(file: file, weight: weight))
      }
      pipeline.configuration.loras = built
    }

    if !sampler.isEmpty {
      if let resolved = findSampler(sampler) {
        pipeline.configuration.sampler = resolved
      } else {
        // Not fatal. A wrong sampler name should cost you the sampler, not the
        // image — and the message names the flag that lists the real ones.
        FileHandle.standardError.write(Data(
          "unknown sampler \"\(sampler)\"; using the default. Run --dump-samplers for the list.\n".utf8))
      }
    }

    let results = try await pipeline.generate(
      prompt: prompt,
      negativePrompt: negativePrompt
    )
    guard let first = results.first else {
      FileHandle.standardError.write(Data("the cloud returned no image\n".utf8))
      throw ExitCode(1)
    }
    guard !output.isEmpty else {
      FileHandle.standardError.write(Data("no --output path given\n".utf8))
      throw ExitCode(1)
    }
    try first.write(to: URL(fileURLWithPath: output), type: .png)
    print("wrote \(output)")
  }
}
