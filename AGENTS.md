## Profile
- Purpose: `pi-orch`, a supervisor CLI for long-lived Pi worker agents, plus `/agents`, a Pi extension that watches and steers them
- Stage: prototype (repository standard 2026-10-17)
- Gate: `npm run gate` (CI job `gate`)
- Landing: direct to main after a green gate; agents land: yes
- Release: none; agents release: no
- Outside issues and PRs: agents triage; outside PRs merge: owner approves

## Map

- `bin/pi-orch.mjs`: CLI entry; imports `src/cli.ts` directly through Node's type stripping, with no build step.
- `src/`: CLI (`cli.ts`), per-worker supervisor (`supervisor.ts`), `pi --mode rpc` client (`rpc.ts`),
  state directory and worker records (`registry.ts`), control socket (`control.ts`), admission
  control (`admission.ts`), roster (`profiles.ts`), tmux integration (`tmux.ts`).
- `src/extension/` and `extensions/pi-agent-dashboard.ts`: the Pi extension (`/agents` overlay, `orch_*` tools).
- `test/`: `node --test` suites; `fake-pi.mjs` stands in for `pi --mode rpc`, with behaviour chosen by `FAKE_PI_SCENARIO`.
- `docs/`: architecture, config, tmux and troubleshooting notes for users.

## Landing (prototype)

1. Small commits straight to `main`, Conventional Commits subjects.
2. Run `npm run gate` and push when it passes; push at the end of every session.
3. Risky ideas go on `spike/<slug>` branches; merge them, or tag `archive/<slug>` and delete them.

## Rules

- Source must stay erasable TypeScript (`erasableSyntaxOnly`): the CLI and the extension run the `.ts` files as they are.
- Tests and the gate never start the real `pi` or call a model: real runs spend the owner's provider quota. Use `test/fake-pi.mjs`, and extend it when Pi's RPC protocol changes.
- Every test that runs the CLI sets `PI_ORCH_STATE_DIR` to a temporary directory and `PI_ORCH_PROFILES` to `test/profiles.json`; nothing may read the real home directory.
- RPC framing splits records on LF only; never use `readline` on Pi's stdout (it splits on U+2028/U+2029).
- Pi compatibility: dev dependencies track the newest Pi 1.x and the tests and type check run against it; the peer ranges stay open. Before moving to a new Pi major, read its changelog (`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`) and `docs/rpc*.md` for extension API and RPC changes.
- The package is not published to npm; installing from npm is an open owner decision. Do not publish.
- The gate has no formatter or linter yet.

## Focused tests

```bash
node --test test/registry.test.ts
node --test --test-name-pattern="stale" test/control.test.ts
```

The tmux tests need tmux 3.2 or newer and skip without it.
