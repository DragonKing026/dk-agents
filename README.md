# DK Code

A personal, opinionated fork of [Code - OSS](https://github.com/microsoft/vscode) for working with AI agents on
Linux. Built mainly for its author's own needs and shared publicly. It is free, and improvement requests are welcome
as issues.

**Status: early work.** There is no release yet. This tree is still close to the upstream import.

## Direction

- Editor first, with the features in the source tree. No extension marketplace, no telemetry.
- Any model: subscription CLIs as real sessions, plus API and local models.
- Agent changes shown live in files with accept and reject, a terminal shared by you and the agent, and a built-in
  browser for handing page elements to an agent.
- An office tab that shows the folders open in the current window as floors, with their agents.

This is a one-off fork. It does not track upstream releases, and fixes are taken selectively.

The previous code, based on Munder Difflin, is on the `archiwum/munder-difflin` branch. Planned work is in the
[milestones](https://github.com/DragonKing026/dk-code/milestones).

## Build from source

So far this has only been done on Fedora 44.

1. Install the Node.js version from [.nvmrc](.nvmrc), and the packages for native modules. On Fedora these are
   `gcc-c++`, `make`, `python3`, `libX11-devel`, `libxkbfile-devel`, `libsecret-devel` and `krb5-devel`.
2. Run `npm ci`, then `npm run compile`.
3. Start it with `./scripts/code.sh`.

Known problems:

- The install fails if the path to the repository contains a space, see
  [#10](https://github.com/DragonKing026/dk-code/issues/10).
- Starting it from a terminal inside VS Code can fail because `ELECTRON_RUN_AS_NODE` is inherited. Unset that variable
  first.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE.txt](LICENSE.txt). Sources and attributions are in [NOTICE](NOTICE) and
[ThirdPartyNotices.txt](ThirdPartyNotices.txt).

Not affiliated with or endorsed by Microsoft. "Visual Studio Code" is a Microsoft trademark.
