import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stateId} from '../src/game.mjs';
import {runPlan,validatePlan} from '../src/plan.mjs';
const initial=()=>({state_type:'monster',run:{floor:1},battle:{round:1,turn:'player',ready_for_action:true,action_running:false,action_queue_empty:true,enemies:[{combat_id:1,entity_id:'E_0',hp:20,block:0,status:[]}]},player:{hp:60,energy:3,block:0,hand:[0,1].map(index=>({index,id:'DEFEND',name:'Defend',description:'Gain 5 block',cost:'1',can_play:true,target_type:'Self'})),draw_pile_count:5,discard_pile_count:0,exhaust_pile_count:0}});
async function temp(fn){const dir=await mkdtemp(join(tmpdir(),'spire-plan-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('a two-card plan rebinds original indices and makes no model calls',()=>temp(async dir=>{
  let s=initial(),sent=[];
  const game={read:async()=>structuredClone(s),send:async c=>{sent.push(c);s.player.hand.splice(c.card_index,1);s.player.hand.forEach((c,i)=>c.index=i);s.player.energy--;s.player.block+=5;s.player.discard_pile_count++;return{status:'ok'};}};
  const plan={state_id:stateId(s),steps:[{card_index:1,expect:{energy:2,block:5}},{card_index:0,expect:{energy:1,block:10}}]};
  const r=await runPlan(game,plan,{dir});assert.equal(r.reason,'plan_complete');assert.deepEqual(sent.map(x=>x.card_index),[1,0]);
}));
test('late damage is awaited instead of sending the second planned action',()=>temp(async dir=>{
  const s=initial();s.player.hand[0]={...s.player.hand[0],id:'STRIKE',target_type:'AnyEnemy'};
  let readsAfter=0,sent=0;
  const game={read:async()=>{if(sent&&++readsAfter>=3)s.battle.enemies[0].hp=14;return structuredClone(s);},send:async()=>{sent++;s.player.hand.shift();s.player.hand[0].index=0;s.player.energy=2;s.player.discard_pile_count=1;return{status:'ok'};}};
  const plan={state_id:stateId(s),steps:[{card_index:0,target_combat_id:1,expect:{energy:2,enemies:[{combat_id:1,hp:14,block:0,status:[]}]}}]};
  const r=await runPlan(game,plan,{dir});assert.equal(r.reason,'plan_complete');assert.equal(sent,1);assert.ok(readsAfter>=5);
}));
test('unexpected draw stops the prefix and persists a no-replay halt',()=>temp(async dir=>{
  let s=initial(),sent=0;
  const game={read:async()=>structuredClone(s),send:async()=>{sent++;s.player.hand.shift();s.player.hand.push({index:1,id:'UNEXPECTED',cost:'0'});return{status:'ok'};}};
  const plan={state_id:stateId(s),steps:[{card_index:0,expect:{energy:2,block:5}},{card_index:1,expect:{energy:1,block:10}}]};
  const r=await runPlan(game,plan,{dir,timeout:130});assert.equal(r.reason,'plan_deviation_no_replay');assert.equal(sent,1);assert.match(await readFile(join(dir,'HALTED'),'utf8'),/deviated/);
}));
test('repeated original cards, stale plans and predicted unknown draws are rejected',()=>{
  const s=initial();assert.throws(()=>validatePlan({state_id:'old',steps:[]},s),/stale/);
  assert.throws(()=>validatePlan({state_id:stateId(s),steps:[{card_index:0,expect:{}},{card_index:0,expect:{}}]},s),/twice/);
  assert.throws(()=>validatePlan({state_id:stateId(s),steps:[{card_index:0,expect:{draw:4}}]},s),/draws/);
});
test('old bridge cannot execute a batch',()=>{
  const s=initial();delete s.battle.action_running;
  assert.throws(()=>validatePlan({state_id:stateId(s),steps:[{card_index:0,expect:{}}]},s),/queue-aware/);
});
test('changed enemy intent stops before the next planned card',()=>temp(async dir=>{
  let s=initial(),sent=0;s.battle.enemies[0].intents=[{type:'Attack',label:'5'}];
  const game={read:async()=>structuredClone(s),send:async()=>{sent++;s.player.hand.shift();s.player.hand[0].index=0;s.player.energy=2;s.player.block=5;s.player.discard_pile_count=1;s.battle.enemies[0].intents[0].label='99';return{status:'ok'};}};
  const plan={state_id:stateId(s),steps:[{card_index:0,expect:{energy:2,block:5}},{card_index:1,expect:{energy:1,block:10}}]};
  const r=await runPlan(game,plan,{dir,timeout:130});assert.equal(sent,1);assert.equal(r.reason,'plan_deviation_no_replay');
}));
test('unknown frame resets consecutive confirmation count',()=>temp(async dir=>{
  let s=initial(),sent=false,reads=0;
  const game={read:async()=>{if(sent&&++reads===3)return {state_type:'unknown'};return structuredClone(s);},send:async()=>{sent=true;s.player.hand.shift();s.player.hand[0].index=0;s.player.energy=2;s.player.block=5;s.player.discard_pile_count=1;return{status:'ok'};}};
  const r=await runPlan(game,{state_id:stateId(s),steps:[{card_index:0,expect:{energy:2,block:5}}]},{dir});
  assert.equal(r.reason,'plan_complete');assert.equal(reads,6);
}));
