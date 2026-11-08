import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

test('RunningHub dropdown keeps subgraph paths when selecting prompt and image fields', () => {
  const source = readFileSync(new URL('../src/pages/canvas/server-model-admin.tsx', import.meta.url), 'utf8');
  const values = {};
  const context = vm.createContext({ form: { setFieldValue: (path, value) => { values[path[1]] = value; } } });
  const code = source.slice(source.indexOf('    const chooseInput ='), source.indexOf('    const isComfy ='));
  vm.runInContext(stripTypeScriptTypes(code) + '\nglobalThis.choose = chooseInput;', context);
  context.choose('prompt', '8144:8143:text');
  context.choose('image', '5702:8090:1:image');
  assert.deepEqual(values, { promptNode: '8144:8143', promptField: 'text', imageNode: '5702:8090:1', imageField: 'image' });
  context.choose('prompt', '5622:value');
  assert.equal(values.promptNode, '5622');
});
