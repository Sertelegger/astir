<!-- Keep this short. Delete anything that doesn't apply. -->

## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

Closes #

## Requirements touched

<!-- Requirement ids from the design spec, e.g. CAP-05, MOD-01, PSH-06. Say "none" for chores. -->

## How it was verified

<!--
Tick what you actually did, not what you intended.

The one rule this project cares about most: unit tests passing is not evidence
that a thing works. A previous version of Clide had 214 green tests and a
`main()` that nothing ever called.
-->

- [ ] `npm run verify` passes (typecheck + lint + build + test)
- [ ] Added or updated a test that **fails without this change**
- [ ] If this touches an entrypoint: an artifact test **executes the built output**, not just `src/`
- [ ] If this touches a provider payload shape: the fixture is **captured from a real session**, not hand-written
- [ ] Ran it against a real session and watched it work

## Anything reviewers should look at closely

<!-- Known weak spots, tradeoffs, or things you're unsure about. -->
