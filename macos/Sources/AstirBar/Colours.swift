import AppKit

extension NSColor {
    static func fromHex(_ hex: String) -> NSColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        return NSColor(
            srgbRed: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }

    /// One colour that follows the system appearance.
    ///
    /// astir sends every colour as a light/dark pair because collapsing them to
    /// one value is what once made the SwiftBar menu unreadable — every colour
    /// chosen against a dark menu, white titles on light grey. AppKit resolves
    /// this at draw time, so switching appearance needs no redraw from us.
    static func dynamic(_ pair: ColourPair) -> NSColor? {
        guard let light = fromHex(pair.light), let dark = fromHex(pair.dark) else { return nil }
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }
}
