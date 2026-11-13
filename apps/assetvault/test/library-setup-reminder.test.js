import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldRemindSetup} from '../server/setup.mjs';

test('ready and usable fallback dependencies do not prompt, including first launch',()=>{
 assert.equal(shouldRemindSetup([{state:'ready'},{state:'degraded'}],null),false);
});

test('missing dependencies respect a full seven-day dismissal cooldown',()=>{
 const now=Date.parse('2026-10-19T12:00:00Z'),day=24*60*60*1000;
 for(const state of ['missing','blocked']){
  const items=[{state}];
  assert.equal(shouldRemindSetup(items,null,now),true);
  assert.equal(shouldRemindSetup(items,new Date(now-6*day).toISOString(),now),false);
  assert.equal(shouldRemindSetup(items,new Date(now-7*day+1).toISOString(),now),false);
  assert.equal(shouldRemindSetup(items,new Date(now-7*day).toISOString(),now),true);
  assert.equal(shouldRemindSetup(items,'invalid',now),true);
 }
});
