import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParameters } from '../src/app/redcliffe-labs/parameters.js';

test('reads parameter names from package_details', () => {
  assert.deepEqual(normalizeParameters({data: [{name: 'CBC', package_details: [{name: ' Haemoglobin '}, {name: 'WBC'}, {name: ''}, null]}]}),
    [{name: 'CBC', parameters: ['Haemoglobin', 'WBC']}]);
});
test('supports legacy cached package_detail responses and missing details', () => {
  assert.deepEqual(normalizeParameters({data: [{name: 'Test', package_detail: [{name: 'Value'}]}, {name: 'Other'}]}),
    [{name: 'Test', parameters: ['Value']}, {name: 'Other', parameters: []}]);
  assert.deepEqual(normalizeParameters(null), []);
});
