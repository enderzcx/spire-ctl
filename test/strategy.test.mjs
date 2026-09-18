import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strategyApplies,strategyPreference,loadStrategy,saveStrategy,clearStrategy,
  noteHandoff,seenHandoff,clearHandoffs,guardSignature,noteGuard,clearGuards} from '../src/strategy.mjs';

const combat=(overrides={})=>({state_type:'monster',run:{act:1,floor:9,...overrides.run},
  player:{hp:40,max_hp:80,block:0,energy:3,...overrides.player},
  battle:{enemies:overrides.enemies??[{entity_id:'E_0',hp:20,intents:[{label:'8'}]}]}});
const temp=async fn=>{const dir=await mkdtemp(join(tmpdir(),'spire-strategy-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};

const strategy=(overrides={})=>({strategy_id:'s1',created_state_id:'x',reason:'survive the boss opener',
  conditions:[{kind:'hp_at_least',value:20},{kind:'same_floor',act:1,floor:9}],
  expires_on:[{kind:'enemy_count_at_most',value:0}],
  order:[{match:'痛击',why:'apply vulnerable'},{match:'防御',why:'block'}],...overrides});

test('a strategy applies only while every condition still holds',()=>{
  assert.equal(strategyApplies(strategy(),combat()).ok,true);
  assert.equal(strategyApplies(strategy(),combat({player:{hp:10}})).ok,false);
  assert.equal(strategyApplies(strategy(),combat({run:{floor:10}})).ok,false);
});

test('an expiry condition invalidates a strategy even when conditions hold',()=>{
  const ended=strategyApplies(strategy(),combat({enemies:[]}));
  assert.equal(ended.ok,false);
  assert.match(ended.reason,/invalidated by/);
});

test('unknown condition kinds never count as satisfied',()=>{
  const unreadable=strategy({conditions:[{kind:'phase_of_the_moon',value:1}]});
  assert.equal(strategyApplies(unreadable,combat()).ok,false);
  assert.equal(strategyApplies({strategy_id:'s'},combat()).ok,false);
  assert.equal(strategyApplies(strategy({conditions:[]}),combat()).ok,false);
});

test('a preference binds to an advertised option, not to a stored index',()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:2},label:'防御: 获得5点格挡。'},
    {id:'1',command:{action:'play_card',card_index:0},label:'痛击: 造成8点伤害。'}];
  const picked=strategyPreference(strategy(),options);
  assert.equal(picked.option.id,'1','the first preference wins');
  assert.equal(strategyPreference(strategy(),[{id:'9',label:'打击: 造成6点伤害。'}]),null);
});

test('strategies and the handoff journal survive a process restart',()=>temp(async dir=>{
  await saveStrategy(dir,strategy());
  assert.equal((await loadStrategy(dir)).strategy_id,'s1');
  await clearStrategy(dir);
  assert.equal(await loadStrategy(dir),null);

  const first=await noteHandoff(dir,'state-a','low_confidence');
  assert.equal(first.count,1);
  const second=await noteHandoff(dir,'state-a','low_confidence');
  assert.equal(second.count,2,'a repeat on the same state is visible');
  assert.equal((await seenHandoff(dir,'state-a')).count,2);
  assert.equal(await seenHandoff(dir,'state-b'),null);
  await clearHandoffs(dir);
  assert.equal(await seenHandoff(dir,'state-a'),null);
}));

test('intent signatures detect a changed plan for the same enemies',()=>{
  const before=strategy({conditions:[{kind:'intents_unchanged',signature:'E_0:8'}],expires_on:[]});
  assert.equal(strategyApplies(before,combat()).ok,true);
  const after=combat({enemies:[{entity_id:'E_0',hp:20,intents:[{label:'15'}]}]});
  assert.equal(strategyApplies(before,after).ok,false);
});

test('the battle loop records a handover and blocks the second ask on that state',async()=>{
  const {battle}=await import('../src/runner.mjs');
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'spire-repeat-'));
  const card=(i,label,type='Attack')=>({id:`C${i}`,index:i,name:label.slice(0,2),type,cost:'1',
    target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,unplayable_reason:null,description:label,
    keywords:[],is_upgraded:false,rarity:'Common',star_cost:null});
  const combat2={state_type:'monster',run:{act:1,floor:9},player:{hp:60,max_hp:80,block:0,energy:3,
    hand:[card(0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),card(1,'防御: 获得5点格挡。','Skill')],potions:[]},
    battle:{ready_for_action:true,round:1,turn:'player',action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:40,max_hp:40,block:0,status:[],
        intents:[{type:'Buff',label:'',title:'强化'}]}]}};
  let sends=0,calls=0;
  const game={read:async()=>combat2,settled:async()=>combat2,send:async()=>{sends++;return{status:'ok'};}};
  const decide=async(_s,offered)=>{calls++;return{option:offered.find(o=>o.command.card_index===0),
    answer:{confidence:.3,stable:true,second_confidence:.31},usage:{input_tokens:5}};};
  try{
    const first=await battle(game,decide,{dir});
    assert.equal(first.reason,'low_confidence');
    const second=await battle(game,decide,{dir});
    assert.equal(second.reason,'repeated_state','the same state is not asked twice');
    assert.equal(calls,2,'one ask per battle call, never a resample loop');
    assert.equal(sends,0);
    const rows=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
    const takeovers=rows.filter(row=>row.event==='takeover');
    assert.equal(takeovers.length,2);
    assert.equal(takeovers[1].repeat_count,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('an agreed strategy carries the loop through a safety guard, not past a new decision',async()=>{
  const {battle}=await import('../src/runner.mjs');
  const {route}=await import('../src/game.mjs');
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'spire-carry-'));
  const card=(i,label,type='Attack')=>({id:`C${i}`,index:i,name:label.slice(0,2),type,cost:'1',
    target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,unplayable_reason:null,description:label,
    keywords:[],is_upgraded:false,rarity:'Common',star_cost:null});
  const lowHp={state_type:'monster',run:{act:1,floor:11},player:{hp:12,max_hp:80,block:0,energy:3,
    hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','Skill')],potions:[]},
    battle:{ready_for_action:true,round:2,turn:'player',action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:30,max_hp:30,block:0,status:[],
        intents:[{type:'Attack',label:'8',title:'攻势'}]}]}};
  const after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:lowHp.run,player:lowHp.player};
  try{
    // Without a strategy the low-HP guard returns to the caller.
    const guarded={read:async()=>lowHp,settled:async()=>lowHp,send:async()=>({status:'ok'})};
    const blocked=await battle(guarded,async()=>({option:{id:'0'},answer:{confidence:.9}}),{dir});
    assert.equal(blocked.reason,'Low HP: reassess survival and potions');
    assert.equal(route(lowHp).strategic,false);

    // With an agreed strategy whose conditions hold, the loop continues locally.
    await saveStrategy(dir,{strategy_id:'low-hp-1',created_state_id:'x',reason:'keep chipping',
      conditions:[{kind:'same_floor',act:1,floor:11},{kind:'hp_at_least',value:5}],
      expires_on:[{kind:'enemy_count_at_most',value:0}],
      order:[{match:'打击',why:'chip'}]});
    let sends=0,modelCalls=0;
    const carried={read:async()=>sends?after:lowHp,settled:async()=>sends?after:lowHp,
      send:async()=>{sends++;return{status:'ok'};}};
    const result=await battle(carried,async()=>{modelCalls++;return{option:{id:'0'},answer:{confidence:.9}};},{dir,max:2});
    assert.equal(sends,1,'the strategy issued the play');
    assert.equal(modelCalls,0,'no model round trip was needed');
    assert.equal(result.reason,'left_combat');
    const rows=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(rows.find(row=>row.event==='local_decision').kind,'strategy');

    // A strategic route still returns: an unrecognized intent is a new decision.
    const unknown={...lowHp,player:{...lowHp.player,hp:60},
      battle:{...lowHp.battle,enemies:[{...lowHp.battle.enemies[0],intents:[{type:'Attack',label:'?'}]}]}};
    assert.equal(route(unknown).strategic,true);
    const stopped=await battle({read:async()=>unknown,settled:async()=>unknown,send:async()=>({status:'ok'})},
      async()=>({option:{id:'0'},answer:{confidence:.9}}),{dir});
    assert.equal(stopped.reason,'Unrecognized attack intent');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a strategy may close a turn it cannot otherwise act on',()=>{
  const options=[{id:'0',command:{action:'end_turn'},label:'End turn'}];
  const picked=strategyPreference(strategy(),options);
  assert.equal(picked.option.command.action,'end_turn');
  assert.match(picked.preference.why,/nothing else is playable/);
  // A playable preference still outranks the implicit end turn.
  const both=[{id:'1',command:{action:'play_card',card_index:0},label:'痛击: 造成8点伤害。'},
    {id:'0',command:{action:'end_turn'},label:'End turn'}];
  assert.equal(strategyPreference(strategy(),both).option.id,'1');
});

test('a strategy from a previous run is discarded instead of steering a new one',()=>temp(async dir=>{
  await saveStrategy(dir,{...strategy(),created_floor:11,conditions:[{kind:'same_floor',act:1,floor:11}]});
  // Still on floor 11: it applies.
  assert.equal((await loadStrategy(dir,{run:{act:1,floor:11}})).strategy_id,'s1');
  // A new run starts at floor 1, so the old strategy is dropped and removed.
  assert.equal(await loadStrategy(dir,{run:{act:1,floor:1}}),null);
  assert.equal(await loadStrategy(dir),null,'the file was cleared, not just ignored');
}));

test('a repeated guard state stops interrupting, but a real change reports again',()=>temp(async dir=>{
  const low=combat({player:{hp:22},enemies:[{entity_id:'E_0',hp:31,intents:[{label:'8'}]}]});
  const signature=guardSignature(low);
  assert.equal((await noteGuard(dir,'low_hp',signature)).repeated,false,'first time reports');
  assert.equal((await noteGuard(dir,'low_hp',signature)).repeated,true,'same band and enemies stays quiet');
  // Health dropping into another band is a real change.
  const worse=combat({player:{hp:14},enemies:[{entity_id:'E_0',hp:31,intents:[{label:'8'}]}]});
  assert.equal((await noteGuard(dir,'low_hp',guardSignature(worse))).repeated,false);
  // A new enemy in the same band is also a real change.
  const more=combat({player:{hp:22},enemies:[{entity_id:'E_0',hp:31,intents:[{label:'8'}]},{entity_id:'E_1',hp:20,intents:[{label:'6'}]}]});
  assert.equal((await noteGuard(dir,'low_hp',guardSignature(more))).repeated,false);
  await clearGuards(dir);
}));
