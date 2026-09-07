// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "JiuzhangNativeShell",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "JiuzhangShellCore", targets: ["JiuzhangShellCore"]),
    .executable(name: "JiuzhangShell", targets: ["JiuzhangShell"]),
    .executable(name: "JiuzhangShellContractTests", targets: ["JiuzhangShellContractTests"]),
  ],
  dependencies: [
    .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.7.3"),
    .package(url: "https://github.com/mgriebling/SwiftMath.git", exact: "1.7.3"),
  ],
  targets: [
    .target(name: "JiuzhangShellCore"),
    .target(
      name: "JiuzhangShellUI",
      dependencies: [
        "JiuzhangShellCore",
        .product(name: "Markdown", package: "swift-markdown"),
        .product(name: "SwiftMath", package: "SwiftMath"),
      ],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("SwiftUI"),
      ]
    ),
    .executableTarget(
      name: "JiuzhangShell",
      dependencies: [
        "JiuzhangShellCore",
        "JiuzhangShellUI",
      ],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("SwiftUI"),
      ]
    ),
    .executableTarget(
      name: "JiuzhangShellContractTests",
      dependencies: ["JiuzhangShellCore", "JiuzhangShellUI"],
      path: "Tests/JiuzhangShellCoreTests"
    ),
  ],
  swiftLanguageModes: [.v5]
)
