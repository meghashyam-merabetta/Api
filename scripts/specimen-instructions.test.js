import test from 'node:test';
import assert from 'node:assert/strict';
import { specimenInstructions } from '../src/app/redcliffe-labs/instructions.js';

test('provider HTML becomes readable instructions without losing qualifiers', () => {
  assert.equal(specimenInstructions('<li>Avoid alcohol.</li><li>Follow your doctor&rsquo;s advice (unless advised otherwise).</li>'), '• Avoid alcohol.\n• Follow your doctor’s advice (unless advised otherwise).');
  assert.equal(specimenInstructions('<p>Documents<br>&#8226; Prescription &amp; ID</p>'), 'Documents\n• Prescription & ID');
  assert.equal(specimenInstructions('<script>ignore()</script><strong>Instructions</strong>'), 'Instructions');
});
test('missing provider instructions remain empty', () => {
  for (const value of [null, undefined, '', '<p><br></p>', {}]) assert.equal(specimenInstructions(value), '');
});
