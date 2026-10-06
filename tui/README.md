# astir-tui

astir inside Claude Code's own terminal. It draws two things and does nothing
else:

- **A status line under the prompt** when there is something to say: first a
  warning if no one would be told when an agent blocks, then how many announced
  blocks are waiting and for how long. Nothing at all when all is well.

  ```
  ⚠ astir-tui: daemon not running — no one will be told
  ⚠ astir-tui: 2 waiting on you · oldest 3m
  ```

  Claude Code draws the `⚠ astir-tui:` part. The rest is `astir status --line`,
  word for word, less the `astir:` it leads with for a tmux bar.

- **A footer label**, `astir <n>`, beside the other modes at the right of the
  prompt footer: how many agents are blocked on you right now, announced or not.
  `astir ?` means there is no count to trust: astir could not be read, or it
  says it cannot see every block (no daemon, another machine's daemon on the
  port, a daemon or notifier it could not read). The status line says which.

Both refresh every five seconds.

## Install

From a terminal session:

```
/plugin install astir-tui --marketplace Sertelegger/astir
```

`y` to add the marketplace if you have not already, then pick a scope. If
`astir install` already registered the marketplace from your checkout, this is
all it takes:

```bash
claude plugin install astir-tui@astir-marketplace
```

astir itself must be installed and running as usual (see the main README):
this plugin only reads what the daemon already knows.

## Which astir it runs

In order:

1. The `entry` setting, run with the `node` setting (or `node` on your PATH).
2. The build of the checkout the plugin sits in, `<checkout>/dist/cli/main.js`,
   when the plugin is installed in place from a local checkout (which is what
   `astir install` sets up). The folder above the plugin counts as that checkout
   only when its `.claude-plugin/marketplace.json` lists `astir-tui` with this
   folder as its source. A copy of the plugin folder somewhere else never runs
   whatever `dist/cli/main.js` happens to sit above it.
3. `astir` on your PATH.

The `node` and `entry` settings are asked for when you install the plugin, and
can be changed later from Claude Code's config menu.

## What it never does

It is display only (NG4). It hooks no tool call and no prompt, adds nothing to
the conversation, asks no model, writes no file and keeps nothing after the
session. It never draws a tool's input, a file path or a description (SEC-01):
the only text it shows is the line astir writes, which is counts and fixed
words. `claude plugin validate tui` lists every hook and every call the module
makes. Check it there rather than taking this paragraph's word for it.

## Why your session is not asked about at first

astir can warn that it `hears nothing from this session`, meaning the
session's hooks are not reaching the daemon. A session that has not had a
prompt yet has not fired any hooks, so astir has not heard from it, and that is
expected. The plugin only asks about the session once a turn has completed.
After `/clear`, the new session starts unasked again.

## `astir unreachable`

This means the plugin could not get an answer from astir's CLI: it could not be
started, it ran past three seconds, it exited non-zero, or it printed something
this plugin cannot read. A daemon that is down is not one of these, because
astir says so itself in the status line. The footer reads `astir ?` either way.

`astir predates status --line — update astir` means the astir that ran is older
than `status --line` (0.2.0 and before): it ignores `--line` and prints its
daemon's whole state instead. Update it: `git pull && npm run build` in your
checkout, or point the `entry` setting at a current build. While that older
astir's daemon is down, it exits non-zero, so you see `astir unreachable`
instead.

`astir speaks status --line vN; astir-tui reads v1` means the CLI and this
plugin disagree on a major version. Update whichever is older.

## Developing

```bash
claude plugin validate tui   # the manifest, the hooks module, the hooks and calls it makes
claude plugin test tui       # hooks/astir.test.ts, against the engine itself
```

The tests answer everything beneath the plugin (astir's CLI, the clock, the
session id, the file system), so they need no daemon, no session and no
network.
