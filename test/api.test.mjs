import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createController} from '../src/controller.mjs';
test('public controller rejects non-loopback game endpoints',()=>{
  assert.throws(()=>createController({endpoint:'https://example.org/game'}),/loopback/);
});
test('already-cancelled harness tools never dispatch',async()=>{
  const controller=createController(),a=new AbortController();a.abort(Error('test cancellation'));
  await assert.rejects(controller.state({signal:a.signal}),/test cancellation/);
  await assert.rejects(controller.act('old','0',{signal:a.signal}),/test cancellation/);
});
