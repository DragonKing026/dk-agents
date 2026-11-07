# Security policy

DK-Agents runs AI coding agents on your machine, so security reports are taken seriously.

## Supported versions

The project is at an early stage. Only the latest commit on `main` (and the latest release, once releases exist)
receives fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/DragonKing026/dk-agents/security/advisories/new>).

Please include:

- what an attacker can do and under which conditions;
- steps to reproduce, or a proof of concept;
- the version or commit you tested.

You can expect an acknowledgement within about a week. This is a one-person project, so fixes may take longer;
you will be told about progress in the advisory.

## Scope

Especially relevant: an agent escaping its permitted area or running without the user's approval, secrets or tokens
leaking (including CLI login tokens), network connections made without the user turning them on, and anything that
lets a web page, repository or message trigger actions on the user's machine.

The CLI agents themselves (Claude Code, Codex and others) are separate products; report their vulnerabilities to
their vendors.
