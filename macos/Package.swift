// swift-tools-version:5.9
import PackageDescription

// A Swift Package rather than an Xcode project, so building it needs only the
// command-line tools and nothing here is generated or binary. Language mode 5:
// this is a small AppKit app and strict concurrency checking would add noise
// without catching anything a three-second poll can get wrong.
let package = Package(
    name: "AstirBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AstirBar", path: "Sources/AstirBar"),
    ]
)
