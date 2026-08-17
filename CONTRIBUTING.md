# Contributing

Thanks for looking. Clide is a personal open-source project, so issues and PRs get best-effort attention.

## Getting set up

```bash
npm install
npm run verify     # typecheck + lint + build + test
```

Requires Node.js ≥ 20.

## Scope

Clide answers two questions and tries not to answer others:

- **Is an agent blocked on me?** — the ambient surface exists for this.
- **Where in the repo is work happening?** — the map exists for this.

It is **live-only**: no persistent history, no replay, no forensic timeline. Session-scoped aggregates (a cumulative map, a timelapse of the current session) are in scope; anything that survives the session or lets you inspect a past moment is not.

Clide also never steers the AI session. It observes. It does not block, approve, deny, or inject context.

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

## Reporting security issues

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
