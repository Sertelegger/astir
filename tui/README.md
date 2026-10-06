# astir-tui

astir inside Claude Code's own terminal. It draws three things, and does two
only when you press for them:

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
  port, a daemon or notifier it could not read, a machine it lost contact
  with, a daemon older than astir). The status line says which.

- **`/astir`**, a pane listing the sessions astir knows of, with a key that
  takes you to the one waiting on you. See [`/astir`](#astir) below.

All three refresh every five seconds.

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

1. The `entry` setting, run with the `node` setting (or `node` on your PATH).
2. Otherwise, `astir` on the PATH Claude Code runs with. `npm link` in your
   checkout puts it there (see the main README). The `node` setting is not
   used here.

Nothing else is tried. In particular, the plugin never runs a build it finds
in the folder above its own. That folder is your checkout when the plugin is
installed in place, but for a plugin folder loaded from a shared directory such
as `/tmp` it is anyone's to write, `dist/cli/main.js` and whatever vouches for
it included. The plugin runs astir as you every five seconds, so it runs only
what your settings or your PATH name.

With no `entry` set and no `astir` on that PATH, the status line reads
`astir unreachable`. Run `npm link`, or set `entry` to your checkout's
`dist/cli/main.js`.

The `node` and `entry` settings are asked for when you install the plugin, and
can be changed later from Claude Code's config menu.

## `/astir`

Type `/astir` to open a pane above the prompt. It works mid-turn too: it opens
at once rather than waiting for the turn to end, and it never interrupts the
turn or touches what you have typed.

```
g: go to api (3m)  d: dismiss web · macbook (5m)  [ Close ]
api            blocked  for 3m                        [ Go ]
web · macbook  blocked  for 5m
cli            waiting  for 10m  dismissed            [ Go ]
docs           idle                                   [ Go ]
```

The keys and astir's last answer sit above the sessions, so they stay in view
however many sessions there are. Each row is a session, in astir's order:
blocked first, then the rest. Each row shows the session's repo, the machine it
runs on if that is not this one, astir's word for its state, and how long it
has waited when it is blocked. `dismissed` marks a block you have already
dismissed.

The keys:

- **`g`** goes to the session that has waited longest, among those blocked,
  not dismissed, and offered Go (see below). It runs `astir focus`, which
  selects that session's tmux window and pane, and then the pane closes.
- **`d`** dismisses the session that has waited longest, among those blocked
  and not dismissed, on any machine (`astir dismiss`). The row then updates,
  and astir's answer is shown above the rows.
- **Tab** walks the buttons, each row's **Go** among them, and **Enter**
  presses the one it is on.
- **Esc** closes the pane while it holds the keys (see below), and so does
  **Close**, always.

The `g` and `d` buttons name the session they act on and how long it has
waited, so you can see what a key will do before you press it. Neither appears
when nothing qualifies.

**Why some rows have no Go.** Go raises a tmux pane on this machine. A session
on another machine has no window here to raise. A local session that is not
running inside a tmux pane has nothing astir can find. astir says which
sessions it can raise, and the pane offers Go only on those. You can still
dismiss a remote session with `d`.

**When Go fails**, the pane stays open and shows the first line of astir's
answer (for example, that no daemon is running). The message stays for at
least five seconds, so it is there to read, and then clears the next time
astir answers properly. If astir stops answering, the message stays.

**When the keys do nothing.** The pane asks for the keyboard when it opens.
Claude Code refuses that if the prompt has text in it, so that typing is never
interrupted. The pane then says so: press `ctrl+x tab` to give it the keys.
Close is there for the same reason. While the prompt holds the keys, Esc is the
prompt's whenever it has text or a turn is running, and there it would
interrupt Claude rather than close the pane.

**When astir cannot be read**, the pane shows `astir unreachable` and only
Close, never the last rows it saw: a press on one of those could act on a
session that has since gone. When astir answers but says it cannot see every
session (the daemon is down, a machine is out of reach), the pane says so too,
rather than showing an empty or partial list as if it were the whole picture.
The status line says what is wrong.

`/astir` gives Claude nothing to read: it answers with no output text and no
notes for the model.

## What it never does

Apart from Go and Dismiss, which run only when you press them, it is display
only (NG4). It hooks no tool call and no prompt, adds nothing to the
conversation, asks no model, writes no file and keeps nothing after the
session. It never draws a tool's input, a file path or a description (SEC-01).
The only text it shows is what astir writes: the status line, which is counts
and fixed words, and in the pane each session's repo name, host and state, with
control characters removed.

It runs `astir status` every five seconds. `astir focus` and `astir dismiss`
run only when you press Go, `g` or `d`. Nothing else is ever run, and never
`astir view`, whose fallback on a headless machine prints a URL with its
token in it. `claude plugin validate tui` lists every hook and every call the
module makes. Check it there rather than taking this paragraph's word for it.

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
session id, the pane's opening and closing), so they need no daemon, no session
and no network. The `/astir` pane's tests draw it on the terminal and desktop
surfaces and press its buttons.
