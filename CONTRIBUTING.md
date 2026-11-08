# Contributing to DK Code

Thanks for your interest. Please read this first: DK Code is a **personal fork of
[Code - OSS](https://github.com/microsoft/vscode)**, built for the author's own needs, mostly with AI (Claude), and
**maintained by one person**. It is public so that others can use it, learn from it and suggest improvements, but it
is not a team project.

This repository is not the place for Visual Studio Code problems. Report those
[to the VS Code project](https://github.com/microsoft/vscode/issues).

## How you can help

- **Report a bug**: open an issue with the *Bug report* template. Include your Linux distribution, the version or
  commit and the exact steps to reproduce.
- **Suggest an improvement**: open an issue with the *Feature request* template. Describe the problem you want
  solved, not only the solution.
- **Ask a question**: open an issue, there is no separate forum.
- **Security problems**: do **not** open a public issue, see [SECURITY.md](SECURITY.md).

Requests are welcome, but there is no promise that they will be implemented, or when. Planned work is grouped into
[milestones](https://github.com/DragonKing026/dk-code/milestones).

## Pull requests

Pull requests are accepted, but please open an issue first for anything larger than a small fix, so we can agree on
the approach before you spend time on it.

- `main` is protected for everyone, including the author: every change goes through a pull request, and only the
  author merges.
- Branch from the current `main` and keep one topic per pull request.
- Describe what you changed, why, and how you checked it. The template asks for this.
- GitHub Actions do **not** run on pull requests, to save CI minutes. The author checks pull requests locally.
- Do not add assets you are not allowed to redistribute, such as artwork, fonts or sounds.
- Third-party code must have a compatible licence and be listed in [NOTICE](NOTICE). AGPL and FSL code cannot be
  included.
- Features inspired by an existing extension are written from a description of the result. Do not copy its code,
  icons or artwork unless its licence allows it.
- Do not add telemetry or network calls that run without the user turning them on.

## Development setup

See [Build from source](README.md#build-from-source) in the README.

The tree is close to upstream, so the checks are the upstream ones: `npm run compile` for the build and
`./scripts/test.sh` for the unit tests.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
