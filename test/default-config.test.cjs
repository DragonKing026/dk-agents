'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(); point it at a
// throwaway userData root so the real application config is never touched.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-default-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig } = loadTs('src/main/config.ts');
const { argsWithAutoModeFlag, AGENT_PROVIDER_PRESETS } = loadTs('src/shared/agentProvider.ts');

const DANGEROUS = /bypassPermissions|--yolo|--dangerously|--auto\b|approval-mode=yolo/;

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a fresh install defaults to autoMode false and no config file is created', () => {
  assert.equal(fs.existsSync(path.join(userData, 'config.json')), false);
  assert.equal(readConfig().autoMode, false);
  assert.equal(fs.existsSync(path.join(userData, 'config.json')), false);
});

test('with the default config no provider gets a permission-bypass flag', () => {
  const { autoMode } = readConfig();
  const providers = AGENT_PROVIDER_PRESETS.map((x) => x.id);
  for (const p of providers) {
    const args = argsWithAutoModeFlag(['--model', 'x'], autoMode, p);
    assert.deepEqual(args, ['--model', 'x']);
    assert.doesNotMatch(args.join(' '), DANGEROUS);
  }
});

test('an existing config with autoMode true is left as the user saved it', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ autoMode: true, onboardingComplete: true }));
  const cfg = readConfig();
  assert.equal(cfg.autoMode, true);
  assert.match(argsWithAutoModeFlag([], cfg.autoMode, 'claude').join(' '), /bypassPermissions/);
});
