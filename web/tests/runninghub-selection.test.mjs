import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

test('workflow import preserves zero/multiple inputs and complete subgraph IDs', () => {
  const source = readFileSync(new URL('../src/pages/canvas/server-model-admin.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('            form.setFieldsValue({ model: result.workflowId');
  const code = source.slice(start, source.indexOf('            message.success', start));
  const result = { workflowId: '123', images: [{ nodeId: '5702:8090:1', field: 'image', label: '图片' }, { nodeId: '8', field: 'image', label: '参考图' }], prompts: [], outputs: [{ nodeId: '9:1' }, { nodeId: '10' }] };
  let values;
  const context = vm.createContext({ result, form: { setFieldsValue: (value) => { values = JSON.parse(JSON.stringify(value)); } } });
  const run = () => vm.runInContext(stripTypeScriptTypes(code), context);
  run();
  assert.equal(values.runninghub.inputs.length, 2);
  assert.equal(values.runninghub.inputs[0].nodeId, '5702:8090:1');
  assert.deepEqual(values.runninghub.outputNodes, ['9:1', '10']);
  result.images = [];
  run();
  assert.deepEqual(values.runninghub.inputs, []);
  result.prompts = [{ nodeId: '8144:8143', field: 'text', label: '正向' }, { nodeId: '3', field: 'value', label: '反向' }];
  run();
  assert.equal(values.runninghub.inputs.length, 2);
  assert.equal(values.runninghub.inputs[0].nodeId, '8144:8143');
  assert.equal(values.runninghub.inputs[0].required, false);
});
