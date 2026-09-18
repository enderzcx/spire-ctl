import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPlan} from '../src/plan.mjs';
import {stateId} from '../src/game.mjs';
import {analyzeTurns,turnMetrics} from '../src/metrics.mjs';

const fixture=()=>({state_type:'monster',run:{act:1,floor:8,ascension:0},
 player:{hp:40,max_hp:80,energy:3,max_energy:3,block:0,status:[],relics:[],potions:[],
 draw_pile_count:5,discard_pile_count:0,exhaust_pile_count:0,
 hand:[0,1].map(index=>({id:'DEFEND',index,name:'防御',type:'Skill',cost:'1',can_play:true,target_type:'Self',description:'获得5点格挡。'}))},
 battle:{round:3,turn:'player',ready_for_action:true,action_running:false,action_queue_empty:true,
 enemies:[{entity_id:'E',combat_id:1,hp:30,max_hp:30,block:0,status:[],intents:[{type:'Attack',label:'8'}]}]}});

test('real prefix transaction logs two sends once, preserving decision owner and turn',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spire-telemetry-'));let state=fixture(),sends=0;
 const game={read:async()=>structuredClone(state),send:async command=>{
  sends++;state.player.hand.splice(command.card_index,1);state.player.hand.forEach((c,i)=>c.index=i);
  state.player.energy--;state.player.block+=5;state.player.discard_pile_count++;return {status:'ok'};
 }};
 try{
  const result=await runPlan(game,{state_id:stateId(state),steps:[
   {card_index:0,expect:{energy:2,block:5}},{card_index:1,expect:{energy:1,block:10}}
  ]},{dir,source:'jev'});
  assert.equal(result.completed,2);assert.equal(sends,2);
  const rows=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r=>r.event==='plan_dispatch'||r.event==='dispatch').length,2);
  const report=analyzeTurns(rows);assert.equal(report.actions.length,2);assert.equal(report.turns.length,1);
  const turn=report.turns[0];assert.equal(turn.turn,'1:8:3');assert.equal(turn.cards_by_source.jev,2);
  assert.equal(turn.plan_steps,2);assert.equal(turn.complete,false,'two cards do not prove a whole turn finished');
  for(const row of rows.filter(r=>r.event==='plan_verified')){
   assert.equal(row.source,'jev');assert.ok(Number.isFinite(row.action_ms));
  }
  const verified=rows.filter(r=>r.event==='plan_verified');
  assert.equal(report.actions[0].settled_at,Date.parse(verified[0].at),'do not add action_ms twice');
  assert.equal(turnMetrics(rows).batches[0].summary.cards,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed model requests without any game action remain visible with unknown usage',()=>{
 const state=fixture();const rows=[
  {protocol:4,at:'2026-09-18T00:00:00Z',event:'ask',source:'jev',state,requests:1,usage:{unavailable:true}},
  {protocol:4,at:'2026-09-18T00:00:01Z',event:'takeover',source:'planner',state,reason:'provider unavailable'}
 ];
 const report=turnMetrics(rows).batches[0];
 assert.equal(report.turns[0].turn,'1:8:3');assert.equal(report.summary.jev_requests,1);
 assert.equal(report.summary.usage_unavailable_requests,1);assert.equal(report.summary.takeovers,1);
 assert.equal(report.summary.turns_complete,0);
});

test('same run with a protocol change is two evidence windows, never a dominant-version blend',()=>{
 const state=fixture();const rows=[3,4].map(protocol=>({protocol,event:'ask',source:'jev',state,requests:1}));
 const report=turnMetrics(rows);assert.equal(report.runs,2);
 assert.deepEqual(report.batches.map(b=>b.protocol),[3,4]);
});

test('patch versions using the same protocol still have separate evidence windows',()=>{
 const rows=['0.2.0','0.2.1'].map(core_version=>({protocol:4,core_version,event:'ask',state:fixture(),requests:1}));
 const report=turnMetrics(rows);assert.equal(report.runs,2);
 assert.deepEqual(report.batches.map(b=>b.core_version),['0.2.0','0.2.1']);
});
