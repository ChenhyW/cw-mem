const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateObservation, VALID_OBS_TYPES, VALID_OBS_CONCEPTS, RESULT_SUMMARY_TEMPLATE } = require('../lib/llm');

test('validateObservation normalizes a valid object', () => {
  const o = validateObservation({ title:'x', type:'bugfix', concepts:['gotcha','nonsense'], filesChanged:['a.js',''], result:'ok' });
  assert.equal(o.type, 'bugfix');
  assert.deepEqual(o.concepts, ['gotcha']);
  assert.deepEqual(o.filesChanged, ['a.js']);
});

test('validateObservation defaults bad type to change', () => {
  assert.equal(validateObservation({ type:'unknown' }).type, 'change');
});

test('validateObservation returns null on non-object/array', () => {
  assert.equal(validateObservation(null), null);
  assert.equal(validateObservation('text'), null);
  assert.equal(validateObservation([]), null);
});

test('validateObservation fills concepts default when empty', () => {
  assert.deepEqual(validateObservation({ type:'feature' }).concepts, ['what-changed']);
});

test('RESULT_SUMMARY_TEMPLATE has 6 fields', () => {
  for (const f of ['request','investigated','learned','completed','next_steps','notes']) {
    assert.ok(RESULT_SUMMARY_TEMPLATE.includes(f), 'missing ' + f);
  }
});
