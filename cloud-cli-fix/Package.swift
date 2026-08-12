// swift-tools-version:5.9
//
// Replacement Package.swift for ~/Downloads/media-generation-kit
//
// The tools-version line MUST be the first line of this file. Swift Package
// Manager reads it before parsing anything else, and a comment above it is a
// hard error rather than a warning.
//
// Two changes from the published version:
//
//   1. The broken MediaGenerationKitCLI target is removed. It imports
//      CLICloudAuth, which exists in neither this package nor
//      draw-things-community at the pinned revision, so it cannot build.
//
//   2. A lumidraw-dt-cli target is added in its place, over the same public
//      MediaGenerationKit API the broken client was meant to demonstrate.
//
// The library target, the pinned dependency revision, and the platform floors
// are untouched.

import PackageDescription

let package = Package(
  name: "media-generation-kit",
  platforms: [.macOS(.v13), .iOS(.v16), .tvOS(.v16), .visionOS(.v1)],
  products: [
    .library(name: "MediaGenerationKit", targets: ["MediaGenerationKit"]),
    .executable(name: "lumidraw-dt-cli", targets: ["LumiDrawDTCLI"]),
  ],
  dependencies: [
    .package(
      url: "https://github.com/drawthingsai/draw-things-community.git",
      revision: "d473a2f148b3e7dc9b90d0b7cfccc5cda999eb66"
    ),
    .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.1"),
    .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.4.5"),
  ],
  targets: [
    .target(
      name: "MediaGenerationKit",
      dependencies: [
        .product(name: "_MediaGenerationKit", package: "draw-things-community")
      ]
    ),
    .executableTarget(
      name: "LumiDrawDTCLI",
      dependencies: [
        "MediaGenerationKit",
        .product(name: "ArgumentParser", package: "swift-argument-parser"),
      ]
    ),
  ]
)
