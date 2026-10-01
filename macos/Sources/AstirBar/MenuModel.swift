import Foundation

// The shape `astir menubar --json` emits, mirrored from `src/status/menu.ts`.
// Field names match exactly so `Decodable` needs no coding keys.

struct MenuVersion: Decodable {
    let major: Int
    let minor: Int
}

/// The major version this build reads. An unknown MINOR is additive and is
/// accepted; an unknown MAJOR is refused rather than drawn from a misreading.
let supportedMajor = 1

/// Already split by astir, so nothing here parses "#a,#b".
struct ColourPair: Decodable {
    let light: String
    let dark: String
}

struct MenuAction: Decodable {
    /// `[interpreter, script, ...args]`, resolved by astir. Run as-is.
    let argv: [String]
    /// True for exactly one action — starting the daemon — whose output is
    /// worth seeing when it fails.
    let terminal: Bool
}

struct MenuItemModel: Decodable {
    let text: String
    let depth: Int
    let colour: ColourPair?
    let symbol: String?
    let symbolColour: ColourPair?
    let monospace: Bool?
    let action: MenuAction?
    let refresh: Bool?
}

enum MenuNode: Decodable {
    case separator
    case item(MenuItemModel)

    private enum Keys: String, CodingKey { case separator }

    init(from decoder: Decoder) throws {
        let keyed = try decoder.container(keyedBy: Keys.self)
        if (try? keyed.decode(Bool.self, forKey: .separator)) == true {
            self = .separator
        } else {
            self = .item(try MenuItemModel(from: decoder))
        }
    }
}

struct MenuModel: Decodable {
    let v: MenuVersion
    let badge: MenuItemModel
    let items: [MenuNode]
}
