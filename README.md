# DK-Agents

This is a custom fork of [Munder Difflin](https://github.com/HarnessMD/munder-difflin), made for the author's own
needs. It is built mostly with AI (Claude) and edited only by the author. The repository is public, and requests
for improvements are welcome as issues. If you want an app maintained by a larger team, use the original project:
<https://github.com/HarnessMD/munder-difflin>.

## Status

Early stage, not ready for use. The fork has just been imported: the pixel-art office runs on flat-colour
placeholder tiles and a placeholder logo (the original artwork cannot be redistributed), and the app still carries
the original project's name and features in many places. Expect things to change or break.

## Placeholder art

`tools/placeholder-tiles.cjs` generates the placeholder tilesets, `resources/brand/logo.png` and `build/icon.png`
(`node tools/placeholder-tiles.cjs`). The tile files keep the dimensions of the originals, so the office map still
loads.

## Build

Requires Node.js and npm.

```bash
npm ci               # install dependencies (native modules are rebuilt)
npm run dev          # run the app in development
npm run typecheck    # type checks
node --test test/*.test.cjs   # tests
npm run dist:linux   # build a Linux package
```

## License

MIT, see [LICENSE](LICENSE). The copyright of the original project stays with its author.
Third-party credits (the original project, the office map, bundled fonts) are in [NOTICE](NOTICE).
