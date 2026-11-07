'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { normalizeOfficeTheme } = loadTs('src/shared/officeTheme.ts');

test('the removed brooklyn99 theme and unknown ids fall back to the office', () => {
  assert.equal(normalizeOfficeTheme('brooklyn99'), 'office');
  assert.equal(normalizeOfficeTheme('nonsense'), 'office');
  assert.equal(normalizeOfficeTheme(undefined), 'office');
  assert.equal(normalizeOfficeTheme(null), 'office');
  assert.equal(normalizeOfficeTheme(''), 'office');
});

test('known theme ids are kept', () => {
  for (const id of ['office', 'friends', 'siliconvalley', 'got', 'hogwarts']) {
    assert.equal(normalizeOfficeTheme(id), id);
  }
});
