import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {actions,stateId} from '../src/game.mjs';
import {execute,battle} from '../src/runner.mjs';
import {planCandidates} from '../src/planning.mjs';
import {choose} from '../src/jev.mjs';
import {createController} from '../src/controller.mjs';
import {strategyPreference,strategyApplies,bindStrategy} from '../src/strategy.mjs';


const temporary=async fn=>{const dir=await mkdtemp(join(tmpdir(),'spire-core-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const card=(index,label,type='Attack')=>({id:type==='Attack'?'STRIKE':'DEFEND',index,name:label.split(':')[0],type,cost:'1',
  target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,description:label,keywords:[],is_upgraded:false});
const combat=(overrides={})=>({state_type:'monster',run:{act:1,floor:4,seed:'run-a'},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','Skill')],
    potions:[],discard_pile_count:0,draw_pile_count:5,exhaust_pile_count:0,...overrides.player},
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
  if(/伤害/.test(played.description))next.battle.enemies[0].hp-=6;
  return next;
}

test('unchanged visible state after a successful send stays halted and cannot resend',()=>temporary(async dir=>{
  const x=combat();
  let sent=0;
  const game={read:async()=>x,settled:async()=>{throw Error('No settled state transition; do not repeat the action');},
    send:async()=>{sent++;return{status:'ok'};}};
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/No settled state transition/);
  assert.match(await readFile(join(dir,'HALTED'),'utf8'),/No settled state transition/);
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/outcome unknown/);
  assert.equal(sent,1);
}));

test('an explicit rejected receipt is no-effect and does not leave a halt',()=>temporary(async dir=>{
  const x=combat();
  const game={read:async()=>x,settled:async()=>x,
    send:async()=>{throw Error('Game rejected request: {"status":"error","message":"illegal"}');}};
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/rejected/);
  await assert.rejects(readFile(join(dir,'HALTED')),{code:'ENOENT'});
}));

test('two-card candidate is one Jev call and two verified sends',()=>temporary(async dir=>{
  const start=combat();
  const options=actions(start);
  const candidates=planCandidates(start,options);
  const two=candidates.find(c=>c.steps.length===2);
  assert.ok(two,'a modeled two-card prefix exists');
  assert.ok(two.steps.every(step=>step.expect),'each prefix step carries an expect patch');
  let calls=0;
  const fetcher=async()=>{calls++;return{ok:true,json:async()=>({model:'jev-latest',
    answers:{plan:{type:'choice',choice:two.id,confidence:.82}},usage:{input_tokens:40,output_tokens:4}})};};
  const {game,sends}=playGame(start,applyKnown);
  const decide=(s,o,shortlist,extra)=>choose(s,o,{apiKey:'k',fetcher,shortlist,...extra});
  const result=await battle(game,decide,{dir,max:4});
  assert.equal(calls,1);
  assert.ok(sends()>=2,'the prefix dispatched both cards');
  const rows=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(rows.filter(row=>row.event==='ask').length,1);
  assert.equal(rows.filter(row=>row.event==='plan_verified').length,2);
  assert.equal(rows.find(row=>row.event==='ask').requests,1);
  assert.equal(rows.filter(row=>row.event==='plan_dispatch').length,2);
  assert.ok(['left_combat','plan_complete','step_budget'].includes(result.reason));
}));

test('a prediction mismatch blocks the second prefix send',()=>temporary(async dir=>{
  const start=combat();
  const options=actions(start);
  const two=planCandidates(start,options).find(c=>c.steps.length===2);
  const fetcher=async()=>({ok:true,json:async()=>({answers:{plan:{choice:two.id,confidence:.9}}})});
  const {game,sends}=playGame(start,(s,command)=>{
    const next=applyKnown(s,command);
    next.player.energy=3;
    return next;
  });
  const result=await battle(game,(s,o,shortlist,extra)=>choose(s,o,{apiKey:'k',fetcher,shortlist,...extra}),{dir,max:4});
  assert.equal(sends(),1);
  assert.equal(result.reason,'plan_deviation_no_replay');
  assert.match(await readFile(join(dir,'HALTED'),'utf8'),/deviated/);
}));

test('unmatched strategy never implicit end-turn while an attack is playable',()=>{
  const options=[
    {id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'end_turn'},label:'End turn'}
  ];
  const strategy={order:[{match:'痛击',why:'vulnerable first'}]};
  assert.equal(strategyPreference(strategy,options),null);
});

test('a strategy without run identity fails closed and does not transfer by floor number',()=>{
  const s=combat({player:{hp:40}});
  const loose={strategy_id:'x',conditions:[{kind:'same_floor',act:1,floor:4}],order:[{match:'打击'}]};
  assert.equal(strategyApplies(loose,s).ok,false);
  const other=bindStrategy({strategy_id:'x',conditions:[{kind:'same_floor',act:1,floor:4}],order:[{match:'打击'}]},
    combat());
  const nextRun=combat();nextRun.run={act:1,floor:4,seed:'run-b'};
  assert.equal(strategyApplies(other,nextRun).ok,false);
  assert.equal(strategyApplies(other,s).ok,true);
});

test('unknown expiry kinds invalidate a strategy',()=>{
  const s=combat();
  const strategy=bindStrategy({strategy_id:'x',conditions:[{kind:'same_floor',act:1,floor:4}],
    expires_on:[{kind:'phase_of_the_moon'}],order:[{match:'打击'}]},s);
  assert.equal(strategyApplies(strategy,s).ok,false);
});

test('repeated state is detected before a second Jev request',()=>temporary(async dir=>{
  const start=combat({player:{hp:60,energy:3,hand:[
    card(0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),card(1,'防御: 获得5点格挡。','Skill')
  ]},battle:{enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:40,max_hp:40,block:0,status:[],
    intents:[{type:'Buff',label:'',title:'强化'}]}]}});
  let calls=0;
  const game={read:async()=>start,settled:async()=>start,send:async()=>{throw Error('must not send');}};
  const decide=async(_s,offered)=>{calls++;return{option:offered.find(o=>o.command.card_index===0),
    answer:{confidence:.3},usage:{input_tokens:5},requests:1};};
  const first=await battle(game,decide,{dir});
  assert.equal(first.reason,'low_confidence');
  const second=await battle(game,decide,{dir});
  assert.equal(second.reason,'repeated_state');
  assert.equal(calls,1);
}));

test('the public controller can save a strategy through the API seam',()=>temporary(async dir=>{
  const start=combat();
  const fake={read:async()=>start,settled:async()=>start,send:async()=>({status:'ok'})};
  const controller=createController({runtimeDir:dir,controlDir:dir,apiKey:'unused',openGame:()=>fake,
    decide:async()=>({option:actions(start)[0],answer:{confidence:.9}})});
  const saved=await controller.saveStrategy({strategy_id:'boss-1',reason:'chip',
    conditions:[{kind:'same_floor',act:1,floor:4}],expires_on:[],order:[{match:'打击'}]});
  assert.equal(saved.saved,true);
  assert.equal(JSON.parse(saved.strategy.run_identity).id,'run-a');
  const loaded=await controller.strategy();
  assert.equal(loaded.strategy.strategy_id,'boss-1');
}));

test('Jev is asked once and usage is the accounted request, not a shopped retry',async()=>{
  const start=combat();
  const options=actions(start);
  let calls=0,tokens=0;
  const fetcher=async()=>{calls++;return{ok:true,json:async()=>({answers:{next:{choice:'0',confidence:.4}},
    usage:{input_tokens:12,output_tokens:3}})};};
  const result=await choose(start,options,{apiKey:'k',fetcher});
  assert.equal(calls,1);
  assert.equal(result.requests,1);
  assert.equal(result.usage.input_tokens,12);
  assert.equal(result.narrowed,false);
  assert.equal(result.stable,false);
  tokens+=result.usage.input_tokens;
  assert.equal(tokens,12);
});
