'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { AGENT_NAME_POOL, randomAgentName } = loadTs('src/shared/agentNames.ts');

test('the pool has at least 60 distinct names', () => {
  assert.ok(AGENT_NAME_POOL.length >= 60);
  const lower = AGENT_NAME_POOL.map((n) => n.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});

test('a random name is never one that is taken, whatever its case', () => {
  const taken = AGENT_NAME_POOL.slice(0, 10).map((n) => n.toUpperCase());
  for (let i = 0; i < 200; i++) {
    const name = randomAgentName(taken);
    assert.ok(!taken.some((t) => t.toLowerCase() === name.toLowerCase()), name);
  }
});

test('rnd = () => 0 gives the first pool name', () => {
  assert.equal(randomAgentName([], () => 0), AGENT_NAME_POOL[0]);
});

test('an rnd of nearly 1 stays in range', () => {
  assert.equal(randomAgentName([], () => 0.999999999), AGENT_NAME_POOL[AGENT_NAME_POOL.length - 1]);
});

test('when the pool is exhausted the name gets a numeric suffix', () => {
  assert.match(randomAgentName(AGENT_NAME_POOL), / 2$/);
  const taken = [...AGENT_NAME_POOL, ...AGENT_NAME_POOL.map((n) => `${n} 2`)];
  assert.match(randomAgentName(taken), / 3$/);
});
