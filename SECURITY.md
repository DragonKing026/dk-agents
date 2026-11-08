# Security policy

DK Code runs AI coding agents on your machine, so security reports are taken seriously.

## Supported versions

The project is at an early stage and there are no releases yet. Only the latest commit on `main` receives fixes.

DK Code is a one-off fork of Code - OSS and does not follow upstream releases. Upstream fixes, including Electron and
Chromium updates, are taken selectively, so a problem fixed in Visual Studio Code may still be present here. Reports
of that kind are welcome.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/DragonKing026/dk-code/security/advisories/new>).

Please include:

- what an attacker can do and under which conditions;
- steps to reproduce, or a proof of concept;
- the commit you tested.

You can expect an acknowledgement within about a week. This is a one-person project, so fixes may take longer. You
will be told about progress in the advisory.

## Scope

Especially relevant:

- an agent escaping its permitted area or running without the user's approval;
- secrets or tokens leaking, including CLI login tokens;
- network connections made without the user turning them on;
- anything that lets a web page, repository or message trigger actions on the user's machine, including through the
  built-in browser.

The CLI agents themselves (Claude Code, Codex and others) are separate products, so please report their
vulnerabilities to their vendors. Do not report vulnerabilities in Microsoft products here.
