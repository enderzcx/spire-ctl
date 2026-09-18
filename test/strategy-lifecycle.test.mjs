import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stateId} from '../src/game.mjs';
import {createController} from '../src/controller.mjs';
import {handoffKey,policyFingerprint,noteHandoff,seenHandoff} from '../src/strategy.mjs';

const temporary=async fn=>{const dir=await mkdtemp(join(tmpdir(),'spire-lifecycle-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const card=(index,label,type='Attack')=>({id:type==='Attack'?'STRIKE':'DEFEND',index,name:label.split(':')[0],type,cost:'1',
  target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,description:label,is_upgraded:false});
const combat=(overrides={})=>({state_type:'monster',run:{act:1,floor:4,ascension:0},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','Skill')],
    potions:[],status:[],relics:[],discard_pile_count:0,draw_pile_count:5,exhaust_pile_count:0,...overrides.player},
  battle:{ready_for_action:true,round:1,turn:'player',action_running:false,action_queue_empty:true,
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,status:[],
      intents:[{type:'Attack',label:'8',title:'攻势'}]}],...overrides.battle}});

function playGame(initial,apply){
  let s=structuredClone(initial),sends=0;
  return {
    sends:()=>sends,
    game:{
      read:async()=>structuredClone(s),
      settled:async previous=>{
        const id=stateId(s);
        if(previous&&id===previous)throw Error('No settled state transition; do not repeat the action');
        return structuredClone(s);
      },
      send:async command=>{
        sends++;
        s=apply(s,command);
        return {status:'ok'};
      }
    }
  };
}

function applyKnown(s,command){
  const next=structuredClone(s);
  if(command.action==='end_turn'){
    next.state_type='rewards';next.rewards={items:[],can_proceed:true};return next;
  }
  if(command.action!=='play_card')return next;
  const index=next.player.hand.findIndex(c=>c.index===command.card_index);
  const played=next.player.hand[index];
  next.player.hand.splice(index,1);
  next.player.hand.forEach((c,i)=>c.index=i);
  next.player.energy-=1;
  next.player.discard_pile_count+=1;
  if(/格挡/.test(played.description))next.player.block+=5;
  if(/伤害/.test(played.description)&&!/格挡/.test(played.description))next.battle.enemies[0].hp-=6;
  return next;
}

function reply(o,extra,confidence){
  const option=o.find(x=>x.command.action==='play_card')??o[0];
  const candidate=extra.candidates?.find(c=>c.kind==='single'&&c.option_id===option.id);
  return {option,candidate,answer:{choice:candidate?.id??option.id,confidence},
    usage:{input_tokens:1,output_tokens:1},requests:1};
}

test('handoff keys ignore strategy_id and in_call bookkeeping',()=>{
  const a=handoffKey('board',{strategy_id:'one',in_call:true,expected_state_id:'x',
    conditions:[{kind:'hp_at_least',value:40}],order:[{match:'打击'}]},{protocol:4});
  const b=handoffKey('board',{strategy_id:'two',in_call:false,
    conditions:[{kind:'hp_at_least',value:40}],order:[{match:'打击'}]},{protocol:4});
  const c=handoffKey('board',{conditions:[{kind:'hp_at_least',value:10}],order:[{match:'打击'}]},{protocol:4});
  assert.equal(a,b);
  assert.notEqual(a,c);
  assert.equal(policyFingerprint({strategy_id:'ignored'}),policyFingerprint({}));
});

test('a new semantic strategy on the same board is asked once',()=>temporary(async dir=>{
  const start=combat();
  const pg=playGame(start,applyKnown);
  let calls=0;
  const c=createController({runtimeDir:dir,controlDir:join(dir,'control'),openGame:()=>pg.game,
    decide:async(s,o,extra)=>reply(o,extra,++calls===1?.1:.9)});
  const initial=await c.state();
  await c.battle(1);
  const result=await c.battle(1,{expectedStateId:initial.state_id,strategy:{
    strategy_id:'new-information',conditions:[{kind:'hp_at_least',value:40}],order:[{match:'打击'}]}});
  assert.equal(calls,2);
  assert.equal(pg.sends(),1);
  assert.notEqual(result.reason,'repeated_state');
}));

test('the same board and same semantic policy stay blocked',()=>temporary(async dir=>{
  const start=combat();
  const pg=playGame(start,applyKnown);
  let calls=0;
  const c=createController({runtimeDir:dir,controlDir:join(dir,'control'),openGame:()=>pg.game,
    decide:async(s,o,extra)=>reply(o,extra,++calls===1?.1:.9)});
  await c.battle(1);
  const again=await c.battle(1);
  assert.equal(again.reason,'repeated_state');
  assert.equal(calls,1);
  assert.equal(pg.sends(),0);
}));

test('invalidated in-call strategy hands off before the next send',()=>temporary(async dir=>{
  const start=combat();
  const pg=playGame(start,(s,cmd)=>{const n=applyKnown(s,cmd);n.player.hp-=1;return n;});
  let calls=0;
  const c=createController({runtimeDir:dir,controlDir:join(dir,'control'),openGame:()=>pg.game,
    decide:async(s,o,extra)=>{calls++;return reply(o,extra,.9);}});
  const initial=await c.state();
  const result=await c.battle(2,{expectedStateId:initial.state_id,
    strategy:{strategy_id:'expires-after-loss',conditions:[{kind:'hp_at_least',value:40}]}});
  assert.equal(pg.sends(),1);
  assert.equal(calls,1);
  assert.match(result.reason,/invalid strategy/);
}));

test('a defend-only strategy is not overridden by a local strike kill',()=>temporary(async dir=>{
  const start=combat();
  start.battle.enemies[0].hp=6;
  const pg=playGame(start,applyKnown);
  let calls=0;
  const c=createController({runtimeDir:dir,controlDir:join(dir,'control'),openGame:()=>pg.game,
    decide:async(s,o,extra)=>{calls++;return reply(o,extra,.9);}});
  const initial=await c.state();
  await c.battle(1,{expectedStateId:initial.state_id,strategy:{
    strategy_id:'defend-only',conditions:[{kind:'hp_at_least',value:40}],order:[{match:'防御'}]}});
  const final=await c.state();
  assert.equal(final.state.player.block,5);
  assert.equal(final.state.battle.enemies[0].hp,6);
  assert.equal(calls,1);
}));

test('journal entries for distinct policies on one board coexist',()=>temporary(async dir=>{
  await noteHandoff(dir,handoffKey('s',null,{protocol:4}),'low_confidence');
  assert.ok(await seenHandoff(dir,handoffKey('s',null,{protocol:4})));
  assert.equal(await seenHandoff(dir,handoffKey('s',{conditions:[{kind:'hp_at_least',value:40}]},{protocol:4})),null);
}));
