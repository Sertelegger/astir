import Foundation

enum Fetch {
    case menu(MenuModel)
    case failed(String)
}

/// Running `astir`, and the reason it is harder than it looks.
///
/// A GUI app is started by launchd with a PATH of roughly
/// `/usr/bin:/bin:/usr/sbin:/sbin`, which has never heard of a version manager.
/// `npm link` puts `astir` beside whichever `node` installed it — mise, nvm,
/// volta, asdf, Homebrew — so the bare name is not found and the bar would show
/// nothing. This mirrors the directory list the SwiftBar plugin has relied on
/// since it shipped, so both hosts find the same `astir`.
enum AstirCommand {
    static func searchPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var dirs = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.local/share/mise/shims",
            "\(home)/.volta/bin",
            "\(home)/.asdf/shims",
            "\(home)/.local/share/mise/installs/node/lts/bin",
            "\(home)/.nvm/current/bin",
        ]
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            dirs += versions.sorted().map { "\(nvm)/\($0)/bin" }
        }
        let inherited = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        return (dirs + [inherited]).joined(separator: ":")
    }

    /// One poll. Never throws: every failure becomes a reason the bar can show,
    /// because a surface that cannot reach astir must not look calm.
    static func fetchMenu() -> Fetch {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["astir", "menubar", "--json"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = searchPath()
        process.environment = env

        let out = Pipe()
        process.standardOutput = out
        // Discarded rather than piped: astir reports a down daemon INSIDE the
        // menu, so stderr carries nothing the bar needs, and a second pipe that
        // filled while stdout was being read would deadlock the poll.
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return .failed("could not run astir: \(error.localizedDescription)")
        }

        // A hung astir must not freeze the bar on its last answer.
        let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: watchdog)

        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        watchdog.cancel()

        if process.terminationStatus == 127 {
            return .failed("astir is not on PATH — run `npm link` in your astir checkout")
        }
        guard process.terminationStatus == 0 else {
            return .failed("astir exited with status \(process.terminationStatus)")
        }
        do {
            let model = try JSONDecoder().decode(MenuModel.self, from: data)
            guard model.v.major == supportedMajor else {
                return .failed(
                    "astir speaks menu v\(model.v.major); this app reads v\(supportedMajor) — update one of them"
                )
            }
            return .menu(model)
        } catch {
            // Most often an astir too old to know `--json`, which prints the
            // SwiftBar text instead. Saying so beats a decoding error.
            return .failed("could not read astir's menu — is astir up to date? (`git pull && npm run build`)")
        }
    }

    static func run(_ action: MenuAction) {
        guard let executable = action.argv.first else { return }
        if action.terminal {
            let command = action.argv.map(shellQuote).joined(separator: " ")
            let script = """
                tell application "Terminal"
                    activate
                    do script "\(appleScriptEscape(command))"
                end tell
                """
            let osascript = Process()
            osascript.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            osascript.arguments = ["-e", script]
            try? osascript.run()
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(action.argv.dropFirst())
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func appleScriptEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }
}
