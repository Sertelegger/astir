import AppKit

/// How the badge is coloured: the way SwiftBar coloured it.
///
/// The symbol takes only `symbolColour` — SwiftBar's `sfcolor=` — and the text
/// only `colour`, SwiftBar's `color=`. The first version of this app tinted the
/// symbol with the text's colour whenever the symbol had none of its own, which
/// SwiftBar never did, and the difference is not cosmetic: a template image
/// with a tint is drawn in exactly that colour, while an untinted one is drawn
/// in whatever contrasts with the bar it sits on. Every badge astir sends has a
/// text colour and no symbol colour, so on a dark bar the idle badge became a
/// grey circle on black — the icon disappeared.
enum BadgeStyle {
    static func symbolTint(_ badge: MenuItemModel) -> NSColor? {
        badge.symbolColour.flatMap(NSColor.dynamic)
    }

    static func textColour(_ badge: MenuItemModel) -> NSColor? {
        badge.colour.flatMap(NSColor.dynamic)
    }
}
