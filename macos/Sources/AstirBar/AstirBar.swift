import AppKit

/// astir's menu-bar app (#64).
///
/// The status item is the product: it answers "does anything need me" without
/// being opened. Everything with words in it lives in the dropdown. That split
/// is not a styling choice — `astir menubar --json` delivers the badge as a
/// separate field from the items precisely so no host can treat it as the
/// first row.
@main
struct AstirBar {
    @MainActor
    static func main() {
        // One poll, printed, then exit — no GUI. For CI, which builds this on
        // macOS and runs it against a real `astir menubar --json`, and for a
        // person whose bar shows a warning and wants the reason in a terminal.
        if CommandLine.arguments.contains("--check") {
            let coloured = coloursFollowTheBar() && badgeColouredLikeSwiftBar()
            switch AstirCommand.fetchMenu() {
            case .menu(let model):
                let symbol = model.badge.symbol ?? "-"
                print("ok: menu v\(model.v.major).\(model.v.minor), badge \"\(model.badge.text)\" \(symbol), \(model.items.count) item(s)")
                exit(coloured ? 0 : 1)
            case .failed(let reason):
                print("failed: \(reason)")
                exit(1)
            }
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // Menu-bar only: no Dock icon and no app menu.
        app.setActivationPolicy(.accessory)
        app.run()
    }

    /// Every colour pair resolves to its dark half under every dark appearance.
    ///
    /// Including the *vibrant* ones a status item is drawn with, which no window
    /// uses. This was written to prove that a dark bar picked the light half of
    /// a pair — the first guess at why the icon disappeared on a dark bar — and
    /// it passed: the pairs were right. It stays as the guard on that, printed
    /// per appearance so a failure says which one and what it got. The actual
    /// cause is in `badgeColouredLikeSwiftBar`.
    private static func coloursFollowTheBar() -> Bool {
        let pair = ColourPair(light: "#6c6c70", dark: "#98989d")
        guard let colour = NSColor.dynamic(pair) else {
            print("failed: the probe colour pair did not parse")
            return false
        }
        let expected: [(NSAppearance.Name, String)] = [
            (.aqua, pair.light),
            (.vibrantLight, pair.light),
            (.accessibilityHighContrastAqua, pair.light),
            (.accessibilityHighContrastVibrantLight, pair.light),
            (.darkAqua, pair.dark),
            (.vibrantDark, pair.dark),
            (.accessibilityHighContrastDarkAqua, pair.dark),
            (.accessibilityHighContrastVibrantDark, pair.dark),
        ]
        var ok = true
        print("colours:")
        for (name, want) in expected {
            let label = name.rawValue.replacingOccurrences(of: "NSAppearanceName", with: "")
                .padding(toLength: 40, withPad: " ", startingAt: 0)
            guard let appearance = NSAppearance(named: name) else {
                // The high-contrast names may exist only for `bestMatch(from:)`;
                // that is AppKit's limit, not a wrong colour. The other four
                // are the ones the bar uses, so missing one is a failure.
                let optional = name.rawValue.contains("HighContrast")
                ok = ok && optional
                print("  \(optional ? "skip" : "FAIL") \(label) not constructible")
                continue
            }
            var got = "?"
            appearance.performAsCurrentDrawingAppearance {
                got = colour.usingColorSpace(.sRGB).map(hex) ?? "?"
            }
            let pass = got == want
            ok = ok && pass
            print("  \(pass ? "ok  " : "FAIL") \(label) \(got) (want \(want))")
        }
        return ok
    }

    /// The symbol is tinted only by its own colour, never the text's.
    ///
    /// Every badge astir sends has a text colour and no symbol colour, so the
    /// symbol must be left untinted — that is what keeps it visible on a dark
    /// bar, and what SwiftBar always did. See `BadgeStyle`.
    private static func badgeColouredLikeSwiftBar() -> Bool {
        let green = ColourPair(light: "#248a3d", dark: "#30db5b")
        let textOnly = MenuItemModel(
            text: "3", depth: 0, colour: green, symbol: "circle.fill",
            symbolColour: nil, monospace: true, action: nil, refresh: nil
        )
        let ownColour = MenuItemModel(
            text: "", depth: 0, colour: nil, symbol: "circle.fill",
            symbolColour: green, monospace: nil, action: nil, refresh: nil
        )
        let checks: [(String, Bool)] = [
            ("symbol untinted when only the text has a colour", BadgeStyle.symbolTint(textOnly) == nil),
            ("text keeps its colour", BadgeStyle.textColour(textOnly) != nil),
            ("symbol tinted by its own colour", BadgeStyle.symbolTint(ownColour) != nil),
            ("text not coloured by the symbol's colour", BadgeStyle.textColour(ownColour) == nil),
        ]
        print("badge:")
        for (label, pass) in checks { print("  \(pass ? "ok  " : "FAIL") \(label)") }
        return checks.allSatisfy { $0.1 }
    }

    private static func hex(_ c: NSColor) -> String {
        String(
            format: "#%02x%02x%02x",
            Int((c.redComponent * 255).rounded()),
            Int((c.greenComponent * 255).rounded()),
            Int((c.blueComponent * 255).rounded())
        )
    }
}
