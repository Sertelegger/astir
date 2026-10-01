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
            switch AstirCommand.fetchMenu() {
            case .menu(let model):
                let symbol = model.badge.symbol ?? "-"
                print("ok: menu v\(model.v.major).\(model.v.minor), badge \"\(model.badge.text)\" \(symbol), \(model.items.count) item(s)")
                exit(0)
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
}
