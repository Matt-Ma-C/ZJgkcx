import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumAdmittedWrittenScore as minimum } from '../app/admission-score.ts';

test('uses only admitted candidates and takes the lowest written score', () => {
  assert.equal(minimum({ admitted: [{ticket:'a'}, {ticket:'b'}], interviewees: [
    {ticket:'a',writtenScore:130}, {ticket:'b',writtenScore:125}, {ticket:'c',writtenScore:100},
  ]}), 125);
});
test('summary minimum is available without loading people, with unknown completeness retained', () => {
  assert.equal(minimum({admitted:[], interviewees:[], admittedCount:2, minAdmittedWrittenScore:128}),128);
  assert.equal(minimum({admitted:[], interviewees:[], admittedCount:2, minAdmittedWrittenScore:null}),null);
  assert.equal(minimum({admitted:[], interviewees:[], admittedCount:0, minAdmittedWrittenScore:128}),null);
});
test('does not present incomplete or conflicting scores as a final minimum', () => {
  assert.equal(minimum({admitted:[],interviewees:[]}), null);
  assert.equal(minimum({admitted:[{ticket:'a'},{ticket:'b'}],interviewees:[{ticket:'a',writtenScore:130}]}), null);
  assert.equal(minimum({admitted:[{ticket:''}],interviewees:[{ticket:'',writtenScore:130}]}), null);
  assert.equal(minimum({admitted:[{ticket:'a'}],interviewees:[{ticket:'a',writtenScore:130},{ticket:'a',writtenScore:131}]}), null);
  assert.equal(minimum({admitted:[{ticket:'a'}],interviewees:[{ticket:'a',writtenScore:null}]}), null);
});
