import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stateId} from '../src/game.mjs';
import {battle} from '../src/runner.mjs';
import {choose} from '../src/jev.mjs';
import {localPolicy} from '../src/policy.mjs';
import {saveStrategy} from '../src/strategy.mjs';

const temporary=async fn=>{const dir=await mkdtemp(join(tmpdir(),'spire-local-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const rows=async dir=>(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));

const enemy=({hp=6,intents=[{type:'Attack',label:'5',title:'攻势'}],...overrides}={})=>({entity_id:'E_0',combat_id:1,name:'Enemy',hp,max_hp:hp,block:0,intents,status:[],...overrides});
const card=(index,label,{cost='1',target=null,type='Attack'}={})=>({id:`CARD_${index}`,index,name:label.split(':')[0],type,cost,
  target_type:target?'AnyEnemy':'Self',can_play:true,unplayable_reason:null,description:label,keywords:[],is_upgraded:false,rarity:'Common',star_cost:null});
const combat=(overrides={})=>({state_type:'monster',run:{act:1,floor:4},player:{hp:40,max_hp:80,block:0,energy:3,
  hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。')],potions:[],...overrides.player},
  battle:{ready_for_action:true,turn:'player',round:1,action_running:false,action_queue_empty:true,
    enemies:[enemy()],...overrides.battle}});

test('the program takes a decided lethal line without asking the model',()=>temporary(async dir=>{
  const start=combat({battle:{enemies:[enemy({hp:6})]}});
  const after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:start.run,player:{...start.player,hand:[]}};
  let calls=0,sends=0;
  const game={read:async()=>sends?after:start,settled:async()=>sends?after:start,send:async()=>{sends++;return{status:'ok'};}};
  const result=await battle(game,async()=>{calls++;return{option:{id:'0'},answer:{confidence:.99}};},{dir,max:3});
  assert.equal(calls,0);
  assert.equal(result.reason,'left_combat');
  const events=await rows(dir);
  const local=events.find(row=>row.event==='local_decision');
  assert.equal(local.kind,'kill');
  assert.match(local.reason,/cover all 1 living enemies/);
  assert.equal(events.find(row=>row.event==='dispatch').source,'local');
}));

test('unblockable displayed lethal damage hands over instead of guessing',()=>temporary(async dir=>{
  const start=combat({player:{hp:25,block:0,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'打击: 造成6点伤害。')],max_hp:80,potions:[]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'26',title:'重击'}]})]}});
  let sent=0;
  const game={settled:async()=>start,send:async()=>{sent++;return{status:'ok'};}};
  let calls=0;
  const result=await battle(game,async()=>{calls++;return{option:{id:'0'},answer:{confidence:.9}};},{dir});
  assert.match(result.reason,/^Potential lethal incoming damage$/);
  assert.equal(sent,0);
  assert.equal(calls,0);
}));

test('a mitigation shortlist is handed to the model and recorded on the decision',()=>temporary(async dir=>{
  const start=combat({player:{hp:60,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。',{type:'Skill'})],max_hp:80,block:0,potions:[]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'18',title:'重击'}]})]}});
  const after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:start.run,player:{...start.player,hand:[]}};
  let sends=0;
  const game={read:async()=>sends?after:start,settled:async()=>sends?after:start,send:async()=>{sends++;return{status:'ok'};}};
  let observed=null;
  await battle(game,async(_s,_o,shortlist)=>{observed=shortlist;
    return {option:{id:'1'},answer:{confidence:.8,shortlist_reason:shortlist?.reason,narrowed:Boolean(shortlist)},usage:{input_tokens:5}};},{dir,max:2});
  assert.equal(observed.kind,'shortlist');
  assert.match(observed.reason,/significant|Significant|mitigation/i);
  const decision=(await rows(dir)).find(row=>row.event==='decision');
  assert.equal(decision.shortlist_reason,observed.reason);
  assert.equal(JSON.parse(JSON.stringify(decision)).option.id,'1');
}));

test('a low-confidence answer is retried on a narrowed menu before escalating',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'play_card',card_index:1},label:'防御: 获得5点格挡。'},
    {id:'2',command:{action:'end_turn'},label:'End turn'}];
  const state=combat().player&&combat();
  const menus=[];
  const fetcher=async(_url,init)=>{
    const body=JSON.parse(init.body);
    menus.push(Object.keys(body.questions.next.criteria));
    // Full menu answers '0' at .3; the narrowed menu answers '1' at .4; the
    // stability probe repeats '1' at .35. Everything stays under the cutoff, so
    // the caller receives a low-confidence answer that it may verify and use.
    const round=menus.length;
    return {ok:true,json:async()=>({model:'jev-latest',usage:{input_tokens:10},
      answers:{next:{choice:round===1?'0':'1',confidence:round===1?.3:round===2?.4:.35}}})};
  };
  const result=await choose(state,options,{apiKey:'test-key',fetcher,shortlist:{options:[options[1]],reason:'5 block against 18 displayed damage'}});
  // Full menu, the narrowed retry, then the stability re-ask on that menu.
  assert.equal(menus.length,3);
  assert.deepEqual(menus[0],['0','1','2']);
  assert.deepEqual(menus[1],['1']);
  assert.deepEqual(menus[2],['1']);
  assert.equal(result.narrowed,true);
  assert.equal(result.retried,true);
  assert.equal(result.stable,true);
  assert.equal(result.second_confidence,.35);
  assert.equal(result.option.id,'1');
  assert.equal(result.answer.confidence,.4);
});

test('a narrowed answer that clears the cutoff is used without a stability probe',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'play_card',card_index:1},label:'防御: 获得5点格挡。'},
    {id:'2',command:{action:'end_turn'},label:'End turn'}];
  const menus=[];
  const fetcher=async(_url,init)=>{
    menus.push(Object.keys(JSON.parse(init.body).questions.next.criteria));
    const round=menus.length;
    return {ok:true,json:async()=>({answers:{next:{choice:round===1?'0':'1',confidence:round===1?.3:.7}}})};
  };
  const result=await choose(combat(),options,{apiKey:'test-key',fetcher,shortlist:{options:[options[1]],reason:'5 block against 18 displayed damage'}});
  assert.equal(menus.length,2);
  assert.equal(result.narrowed,true);
  assert.equal(result.stable,false);
  assert.equal(result.answer.confidence,.7);
});

test('the original cutoff still escalates when no shortlist exists',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'end_turn'},label:'End turn'}];
  let calls=0;
  const fetcher=async()=>{calls++;return{ok:true,json:async()=>({answers:{next:{choice:'1',confidence:.4}}})};};
  const result=await choose(combat(),options,{apiKey:'test-key',fetcher});
  // Two asks: the original and the stability check. The cutoff still stands,
  // so the caller receives the low-confidence answer either way.
  assert.equal(calls,2);
  assert.equal(result.stable,true);
  assert.equal(result.narrowed,false);
  assert.equal(result.answer.confidence,.4);
  const quiet=combat({battle:{enemies:[enemy({hp:40,intents:[{type:'Buff',title:'强化',label:''}]})]}});
  assert.equal(localPolicy(quiet,options).kind,'decline');
});

test('choose refuses an empty menu instead of inventing an action',async()=>{
  await assert.rejects(choose(combat(),[],{apiKey:'test-key',fetcher:async()=>{throw Error('must not be called');}}),/No options/);
});

test('a low-confidence fallback is not overwritten by the model answer',()=>temporary(async dir=>{
  // Two playable cards, quiet turn: the model answers '0' at .3 twice, so the
  // program's stability check may act on it. A stray unconditional assignment
  // after the branch used to replace the chosen option and its source, which
  // silently defeated every low-confidence protection. Pin the behaviour.
  const start=combat({
    player:{hp:60,block:0,energy:3,max_hp:80,potions:[],
      hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。',{type:'Skill'})]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Buff',label:'',title:'强化'}]})]}});
  const after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:start.run,player:{...start.player,hand:[]}};
  let sends=0;
  const game={read:async()=>sends?after:start,settled:async()=>sends?after:start,send:async()=>{sends++;return{status:'ok'};}};
  // The adapter must answer with an advertised option, id and label together.
  await battle(game,async(_s,offered)=>({option:offered.find(o=>o.command.card_index===0),
    answer:{confidence:.3,stable:true,second_confidence:.32},usage:{input_tokens:5}}),{dir,max:2});
  const events=await rows(dir);
  const dispatch=events.find(row=>row.event==='dispatch');
  assert.equal(dispatch.source,'local','a verified stable answer is executed as a local decision');
  assert.equal(dispatch.option.command.card_index,0,'the dispatched option is the verified proposal');
  const decision=events.find(row=>row.event==='decision');
  assert.equal(decision.answer.confidence,.3,'the recorded confidence stays below the cutoff');
  const local=events.find(row=>row.event==='local_decision');
  assert.equal(local.kind,'jev_stable');
}));

test('an unverifiable low-confidence answer still hands over untouched',()=>temporary(async dir=>{
  // Same shape, but the fast model proposes a card the program cannot bound
  // (random effect). Stability is not correctness, so the packet goes back.
  const start=combat({
    player:{hp:60,block:0,energy:3,max_hp:80,potions:[],
      hand:[card(0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),card(1,'防御: 获得5点格挡。',{type:'Skill'})]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Buff',label:'',title:'强化'}]})]}});
  let sends=0;
  const game={read:async()=>start,settled:async()=>start,send:async()=>{sends++;return{status:'ok'};}};
  const result=await battle(game,async(_s,offered)=>({option:offered.find(o=>o.command.card_index===0),
    answer:{confidence:.3,stable:true,second_confidence:.31},usage:{input_tokens:5}}),{dir});
  assert.equal(result.reason,'low_confidence');
  assert.match(result.stable_rejection,/cannot bound/);
  assert.equal(sends,0);
}));

test('a low-confidence answer is retried on a narrowed menu before escalating',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'play_card',card_index:1},label:'防御: 获得5点格挡。'},
    {id:'2',command:{action:'end_turn'},label:'End turn'}];
  const state=combat().player&&combat();
  const menus=[];
  const fetcher=async(_url,init)=>{
    const body=JSON.parse(init.body);
    menus.push(Object.keys(body.questions.next.criteria));
    // Full menu answers '0' at .3; the narrowed menu answers '1' at .4; the
    // stability probe repeats '1' at .35. Everything stays under the cutoff, so
    // the caller receives a low-confidence answer that it may verify and use.
    const round=menus.length;
    return {ok:true,json:async()=>({model:'jev-latest',usage:{input_tokens:10},
      answers:{next:{choice:round===1?'0':'1',confidence:round===1?.3:round===2?.4:.35}}})};
  };
  const result=await choose(state,options,{apiKey:'test-key',fetcher,shortlist:{options:[options[1]],reason:'5 block against 18 displayed damage'}});
  // Full menu, the narrowed retry, then the stability re-ask on that menu.
  assert.equal(menus.length,3);
  assert.deepEqual(menus[0],['0','1','2']);
  assert.deepEqual(menus[1],['1']);
  assert.deepEqual(menus[2],['1']);
  assert.equal(result.narrowed,true);
  assert.equal(result.retried,true);
  assert.equal(result.stable,true);
  assert.equal(result.second_confidence,.35);
  assert.equal(result.option.id,'1');
  assert.equal(result.answer.confidence,.4);
});

test('a narrowed answer that clears the cutoff is used without a stability probe',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'play_card',card_index:1},label:'防御: 获得5点格挡。'},
    {id:'2',command:{action:'end_turn'},label:'End turn'}];
  const menus=[];
  const fetcher=async(_url,init)=>{
    menus.push(Object.keys(JSON.parse(init.body).questions.next.criteria));
    const round=menus.length;
    return {ok:true,json:async()=>({answers:{next:{choice:round===1?'0':'1',confidence:round===1?.3:.7}}})};
  };
  const result=await choose(combat(),options,{apiKey:'test-key',fetcher,shortlist:{options:[options[1]],reason:'5 block against 18 displayed damage'}});
  assert.equal(menus.length,2);
  assert.equal(result.narrowed,true);
  assert.equal(result.stable,false);
  assert.equal(result.answer.confidence,.7);
});

test('the original cutoff still escalates when no shortlist exists',async()=>{
  const options=[{id:'0',command:{action:'play_card',card_index:0},label:'打击: 造成6点伤害。'},
    {id:'1',command:{action:'end_turn'},label:'End turn'}];
  let calls=0;
  const fetcher=async()=>{calls++;return{ok:true,json:async()=>({answers:{next:{choice:'1',confidence:.4}}})};};
  const result=await choose(combat(),options,{apiKey:'test-key',fetcher});
  // Two asks: the original and the stability check. The cutoff still stands,
  // so the caller receives the low-confidence answer either way.
  assert.equal(calls,2);
  assert.equal(result.stable,true);
  assert.equal(result.narrowed,false);
  assert.equal(result.answer.confidence,.4);
  const quiet=combat({battle:{enemies:[enemy({hp:40,intents:[{type:'Buff',title:'强化',label:''}]})]}});
  assert.equal(localPolicy(quiet,options).kind,'decline');
});

test('choose refuses an empty menu instead of inventing an action',async()=>{
  await assert.rejects(choose(combat(),[],{apiKey:'test-key',fetcher:async()=>{throw Error('must not be called');}}),/No options/);
});


test('an unanswerable fight stops even while a strategy would carry it',()=>temporary(async dir=>{
  // 5 HP, 22 displayed damage, and the best block in hand is 5: the position is
  // lost. A strategy that would otherwise carry the loop must not grind it.
  const start=combat({
    player:{hp:5,block:0,energy:3,max_hp:80,potions:[],
      hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。',{type:'Skill'})]},
    battle:{enemies:[enemy({hp:14,intents:[{type:'Attack',label:'22',title:'攻势'}]})]}});
  await saveStrategy(dir,{strategy_id:'carry',created_floor:4,reason:'chip',
    conditions:[{kind:'same_floor',act:1,floor:4}],expires_on:[],
    order:[{match:'打击'},{match:'End turn'}]});
  let sends=0;
  const game={read:async()=>start,settled:async()=>start,send:async()=>{sends++;return{status:'ok'};}};
  const result=await battle(game,async()=>({option:{id:'0'},answer:{confidence:.9}}),{dir});
  assert.match(result.reason,/exceeds the 5 this hand can cover/);
  assert.equal(sends,0,'nothing is played into a lost position');
  assert.equal(result.attrition.lethal_in_turns,1);
}));
