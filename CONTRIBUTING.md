# Contributing

Thanks for looking. Astir is a personal open-source project, so issues and PRs get best-effort attention.

## Getting set up

```bash
npm install
npm run verify     # typecheck + lint + build + test
```

Requires Node.js ≥ 20.

## Scope

Astir answers two questions and tries not to answer others:

- **Is an agent blocked on me?** — the ambient surface exists for this.
- **Where in the repo is work happening?** — the map exists for this.

It is **live-only**: no persistent history, no replay, no forensic timeline. Session-scoped aggregates (a cumulative map, a timelapse of the current session) are in scope; anything that survives the session or lets you inspect a past moment is not.

Astir also never steers the AI session. It observes. It does not block, approve, deny, or inject context.

## The one rule

**A passing test suite is not evidence that something works.**

A previous version of this project had 214 passing tests, strict TypeScript, and a hook entrypoint that exported a `main()` function nothing ever called. It had never processed a single event. Every unit test passed because every unit test exercised the pure core with fake dependencies, and every integration seam was marked "verified manually" and never verified.

So:

- **Entrypoints get an artifact test.** Build it, run the built file, assert an externally observable effect. `node --check` is a parse check and does not count.
- **Provider fixtures are captured, never invented.** If you need a hook payload or a transcript record, record a real one and note the CLI version. The old test suite asserted a thinking-block shape that does not exist, so it passed while the feature was dead.
- **A test named for a requirement asserts that requirement.** The old revive test asserted session state while agent state stayed broken.
- **Time, filesystem, network, notifications and process spawning go behind injectable seams.** That is what makes the above testable at all.

## Conventions

- TypeScript, strict, `moduleResolution: NodeNext` for both typecheck and build so they cannot disagree.
- Biome for lint and format (`npm run lint`, `npm run format`).
- Tests live in `test/` and are typechecked along with `src/`.
- Commit messages: a short imperative subject, then *why* rather than *what* if it isn't obvious.

## Design docs

The design spec is maintained locally and is not published in this repository. Requirement ids you'll see in code comments and PR templates (`CAP-05`, `MOD-01`, `PSH-06`, …) refer to it. If you need context for one, ask in the issue or discussion and it'll be quoted.

## Releases

`CHANGELOG.md` **is** the release. A GitHub Release is a pointer to it: the body
is that version's section verbatim. Release prose written only into the GitHub
object is not in the repository, is not reviewed with the code, and does not
survive the repository being recreated — astir has the scar to prove it, since
v0.1.0's notes still describe a binary called `clide`.

Cutting one:

1. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD (Codename)`.
2. Add the matching link definition at the foot of the file, and repoint
   `[Unreleased]` at the new tag's compare range. **Every version needs a
   definition** or it renders with visible brackets.
3. Open a fresh empty `## [Unreleased]`.
4. `node scripts/bump-version.mjs X.Y.Z`. There are **four** version stamps and
   one of them is a `<bitbar.version>` comment in a shell script, which no JSON
   tooling would ever find — the script exists so three can never agree while
   the fourth lags. It fails loudly if any stamp does not match.
5. Commit, tag `vX.Y.Z`, push both. Tagging triggers
   `.github/workflows/release.yml`, which refuses to publish unless the tag, the
   manifest version and a non-empty changelog section all agree.

`.claude-plugin/marketplace.json`'s version is **load-bearing, not cosmetic**:
it is what tells an already-installed `claude plugin install` there is something
newer. A release that forgets it ships to nobody.

Nothing is published to npm — `package.json` is `private: true`.

### Naming

**`astir X.Y.Z (Codename)`.** No `v` prefix on the release name; the tag keeps
its `v`. The workflow reads the version off the tag and the codename off that
version's changelog heading — the one place it already sits beside its version,
so there is no second file to update and no way for the two to disagree. A
version whose heading carries no codename is named `astir X.Y.Z`.

### Codenames

Baked goods, alphabetically, one per release. No hyphens and no diacritics, so
a codename is always safe in a tag message, a filename or a shell.

The sequence starts at the first release, so **0.1.0 is Amaretti** even though it
shipped before the scheme existed — named retroactively in the changelog, which
is cheap while there is one release to renumber and gets more expensive with
every one that is not.

| | | | |
|---|---|---|---|
| A Amaretti | B Bagel | C Croissant | D Doughnut |
| E Eclair | F Focaccia | G Gingerbread | H Hobnob |
| I Injera | J Jalebi | K Kolache | L Lamington |
| M Madeleine | N Naan | O Oatcake | P Pretzel |
| Q Quiche | R Rugelach | S Scone | T Tiramisu |
| U — | V Victoria | W Waffle | X — |
| Y Yufka | Z Zeppole | | |

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
