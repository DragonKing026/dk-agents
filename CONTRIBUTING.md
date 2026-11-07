# Contributing to DK-Agents

Thanks for your interest. Please read this first: DK-Agents is a **custom fork of
[Munder Difflin](https://github.com/HarnessMD/munder-difflin)** built for the author's own needs, mostly with AI
(Claude), and **edited only by the author**. It is public so that others can use it, learn from it and suggest
improvements, but it is not a team project.

## How you can help

- **Report a bug** — open an issue with the *Bug report* template. Include your Linux distribution, the app version
  and the exact steps to reproduce.
- **Suggest an improvement** — open an issue with the *Feature request* template. Describe the problem you want
  solved, not only the solution.
- **Ask a question** — open an issue; there is no separate forum.
- **Security problems** — do **not** open a public issue; see [SECURITY.md](SECURITY.md).

Requests are welcome, but there is no promise that they will be implemented, or when. Planned work is grouped into
[milestones](https://github.com/DragonKing026/dk-agents/milestones) (stages 0–9).

## Pull requests

Pull requests are accepted, but please open an issue first for anything larger than a small fix, so we can agree on
the approach before you spend time on it.

- `main` is protected for everyone, including the author: every change goes through a pull request, and only the
  author merges. Merges are squash merges.
- Branch from the current `main`; keep one topic per pull request.
- Before opening the pull request, run:

  ```bash
  npm ci
  npm run typecheck
  node --test test/*.test.cjs
  ```

  Describe in the pull request what you changed, why, and how you checked it (the template asks for this).
- GitHub Actions do **not** run on pull requests (to save CI minutes); the author checks pull requests locally.
- Do not add assets you are not allowed to redistribute (artwork, fonts, sounds). Third-party code must have a
  compatible licence and be listed in [NOTICE](NOTICE). AGPL and FSL code cannot be included.
- Do not add telemetry or network calls that run without the user turning them on.

## Development setup

See [README.md](README.md#build). On Fedora the native modules need `gcc-c++`, `make` and `python3`.

When you run the app from source for testing, it uses your real home directory for its data
(`~/.config/DK-Agents`, `~/.local/share/dk-agents`). Use a separate `HOME` if you do not want that.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
