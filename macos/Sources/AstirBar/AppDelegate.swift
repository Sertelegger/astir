import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var polling = false
    /// Set while the dropdown is open. A menu replaced mid-interaction would
    /// shift rows under the pointer between press and release.
    private var menuOpen = false
    private var pending: Fetch?

    /// SwiftBar's plugin is `astir.3s.sh`; the same interval keeps the two
    /// hosts agreeing about how fresh "fresh" is.
    private let interval: TimeInterval = 3

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "…"
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        // One poll at a time. A slow astir must not queue up a backlog of
        // processes, each about to draw a stale answer over a newer one.
        guard !polling else { return }
        polling = true
        Task.detached(priority: .utility) { [weak self] in
            let result = AstirCommand.fetchMenu()
            await self?.finish(result)
        }
    }

    private func finish(_ result: Fetch) {
        polling = false
        if menuOpen {
            pending = result
            return
        }
        render(result)
    }

    private func render(_ result: Fetch) {
        switch result {
        case .menu(let model):
            drawBadge(model.badge)
            statusItem.menu = buildMenu(model.items)
        case .failed(let reason):
            // A bar that cannot reach astir must never look calm. The same rule
            // the badge already follows for a dead daemon: unreachable is a
            // warning, not an empty space.
            drawBadge(MenuItemModel(
                text: "", depth: 0, colour: nil, symbol: "exclamationmark.triangle",
                symbolColour: nil, monospace: nil, action: nil, refresh: nil
            ))
            let menu = NSMenu()
            menu.delegate = self
            menu.addItem(info(reason))
            menu.addItem(.separator())
            menu.addItem(refreshItem())
            menu.addItem(quitItem())
            statusItem.menu = menu
        }
    }

    // MARK: the bar

    private func drawBadge(_ badge: MenuItemModel) {
        guard let button = statusItem.button else { return }
        let colour = badge.colour.flatMap(NSColor.dynamic) ?? badge.symbolColour.flatMap(NSColor.dynamic)

        if let symbol = badge.symbol,
           let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "astir") {
            image.isTemplate = true
            button.image = image
            button.imagePosition = badge.text.isEmpty ? .imageOnly : .imageLeading
        } else {
            button.image = nil
        }
        button.contentTintColor = colour

        // Monospaced digits so a count going from 9 to 10 does not nudge every
        // status item to its left.
        let font = badge.monospace == true
            ? NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
            : NSFont.menuBarFont(ofSize: 0)
        var attributes: [NSAttributedString.Key: Any] = [.font: font]
        if let colour { attributes[.foregroundColor] = colour }
        button.attributedTitle = NSAttributedString(string: badge.text, attributes: attributes)
    }

    // MARK: the dropdown

    /// `depth > 0` items become the submenu of the depth-0 row above them —
    /// the same structure SwiftBar draws from a `--` prefix.
    private func buildMenu(_ nodes: [MenuNode]) -> NSMenu {
        let root = NSMenu()
        root.delegate = self
        var parent: NSMenuItem?
        for node in nodes {
            switch node {
            case .separator:
                root.addItem(.separator())
                parent = nil
            case .item(let model):
                let item = menuItem(model)
                if model.depth > 0, let parent {
                    if parent.submenu == nil { parent.submenu = NSMenu() }
                    parent.submenu?.addItem(item)
                } else {
                    root.addItem(item)
                    parent = item
                }
            }
        }
        root.addItem(.separator())
        root.addItem(quitItem())
        return root
    }

    private func menuItem(_ model: MenuItemModel) -> NSMenuItem {
        let item = NSMenuItem(title: model.text, action: nil, keyEquivalent: "")
        let size = NSFont.menuFont(ofSize: 0).pointSize
        let font = model.monospace == true
            ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
            : NSFont.menuFont(ofSize: 0)
        var attributes: [NSAttributedString.Key: Any] = [.font: font]
        if let colour = model.colour.flatMap(NSColor.dynamic) {
            attributes[.foregroundColor] = colour
        }
        item.attributedTitle = NSAttributedString(string: model.text, attributes: attributes)

        if let symbol = model.symbol,
           let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            if let tint = model.symbolColour.flatMap(NSColor.dynamic) {
                item.image = image.withSymbolConfiguration(.init(paletteColors: [tint]))
            } else {
                item.image = image
            }
        }

        if let action = model.action {
            item.action = #selector(runAction(_:))
            item.target = self
            item.representedObject = action
        } else if model.refresh == true {
            item.action = #selector(refreshNow(_:))
            item.target = self
        }
        // No action: AppKit disables it, which is correct — a row that looks
        // clickable and does nothing reads as broken rather than as a heading.
        return item
    }

    private func info(_ text: String) -> NSMenuItem {
        NSMenuItem(title: text, action: nil, keyEquivalent: "")
    }

    private func refreshItem() -> NSMenuItem {
        let item = NSMenuItem(title: "Refresh", action: #selector(refreshNow(_:)), keyEquivalent: "r")
        item.target = self
        return item
    }

    private func quitItem() -> NSMenuItem {
        NSMenuItem(title: "Quit astir", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @objc private func runAction(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? MenuAction else { return }
        AstirCommand.run(action)
        // Dismiss, forget and focus all change state. Show the result now
        // rather than up to three seconds later.
        refresh()
    }

    @objc private func refreshNow(_ sender: NSMenuItem) {
        refresh()
    }

    // MARK: NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        menuOpen = true
    }

    func menuDidClose(_ menu: NSMenu) {
        menuOpen = false
        if let result = pending {
            pending = nil
            render(result)
        }
    }
}
