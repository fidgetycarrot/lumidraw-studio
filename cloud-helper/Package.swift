// swift-tools-version:5.9
import PackageDescription

// LS Cloud Helper — sends Lumi Studio pictures to Draw Things' cloud.
// The engine revision matches the one used for the first successful test
// (3 Nov 2026), so an existing build folder reuses its compiled dependencies.
let package = Package(
  name: "ls-cloud-helper",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(url: "https://github.com/drawthingsai/draw-things-community.git",
             revision: "f48e6e8ae175cf885eca70f8fa39e2fd5fabc071"),
  ],
  targets: [
    .executableTarget(
      name: "ls-cloud-helper",
      dependencies: [.product(name: "_MediaGenerationKit", package: "draw-things-community")],
      path: "Sources"),
  ]
)
