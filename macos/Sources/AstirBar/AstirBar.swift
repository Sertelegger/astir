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
            let coloured = coloursFollowTheBar()
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

    /// Every colour pair resolves to its dark half wherever the bar is dark.
    ///
    /// Checked under the appearances a status item is actually drawn with, not
    /// only the window ones: the bar draws its buttons under a *vibrant*
    /// appearance, so a pair that resolves correctly in a window can still pick
    /// its light half on a dark bar — a grey icon on a black bar. Printed per
    /// appearance, so a failure in CI says which one and what it got.
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

    private static func hex(_ c: NSColor) -> String {
        String(
            format: "#%02x%02x%02x",
            Int((c.redComponent * 255).rounded()),
            Int((c.greenComponent * 255).rounded()),
            Int((c.blueComponent * 255).rounded())
        )
    }
}
