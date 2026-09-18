import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planCandidates,chooseCandidate} from '../src/planning.mjs';

const card=(index,label,cost='1',type='Attack')=>({id:`CARD_${index}`,index,name:label.split(':')[0],type,cost,
  target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,unplayable_reason:null,description:label,
  keywords:[],is_upgraded:false,rarity:'Common',star_cost:null});
const option=(id,index,label,extra={})=>({id:String(id),command:{action:'play_card',card_index:index,...extra},label});
const state=(overrides={})=>({state_type:'monster',run:{act:1,floor:9},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[],potions:[],...overrides.player},
  battle:{enemies:overrides.enemies??[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,intents:[{type:'Attack',label:'8'}]}]}});

test('candidates carry computed energy, damage, kills and survival',()=>{
  const s=state({player:{energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const candidates=planCandidates(s,options);
  assert.ok(candidates.length>=2);
  for(const candidate of candidates){
    assert.equal(typeof candidate.energy,'number');
    assert.equal(typeof candidate.damage,'number');
    assert.equal(typeof candidate.survives,'boolean');
  }
  const blockLine=candidates.find(c=>c.block>0);
  assert.ok(blockLine,'a block candidate exists');
  assert.equal(blockLine.incoming,8);
});

test('a confirmable kill is offered as its own candidate',()=>{
  const s=state({player:{energy:2,hand:[card(0,'打击: 造成6点伤害。')]},
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:6,max_hp:6,block:0,intents:[{type:'Attack',label:'4'}]}]});
  const candidates=planCandidates(s,[option(0,0,'打击: 造成6点伤害。 -> E (6 HP)',{target:'E_0'})]);
  assert.equal(candidates[0].kills,1);
  assert.match(candidates[0].title,/Kill/);
});

test('a prefix never exceeds the energy budget and never repeats a card',()=>{
  const s=state({player:{energy:1,hand:[card(0,'打击: 造成6点伤害。'),card(1,'打击: 造成6点伤害。')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),
    option(1,1,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'})];
  for(const candidate of planCandidates(s,options)){
    assert.ok(candidate.energy<=1,`cost ${candidate.energy} within budget`);
    const indices=candidate.steps.map(step=>step.card.card_index??step.card.index);
    for(const index of indices)assert.ok(Number.isInteger(index)||index===null);
    assert.equal(new Set(candidate.steps.map(step=>step.option_id)).size,candidate.steps.length);
  }
});

test('an unbounded effect stays a one-step candidate and never joins a prefix',()=>{
  const s=state({player:{energy:3,hand:[card(0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),card(1,'打击: 造成6点伤害。')]}});
  const options=[option(0,0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),option(1,1,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'})];
  const candidates=planCandidates(s,options);
  for(const candidate of candidates)
    if(candidate.steps.length>1)
      assert.equal(candidate.steps.some(step=>step.card.id==='CARD_0'),false,'random card not in a prefix');
});

test('survival is enforced without the program silently picking another card',()=>{
  const candidates=[
    {id:'c0',title:'greedy',energy:3,damage:20,block:0,kills:0,survives:false,steps:[{card:{name:'X'}}]},
    {id:'c1',title:'block',energy:1,damage:4,block:9,kills:0,survives:true,steps:[{card:{name:'Defend'}}]},
    {id:'c2',title:'kill',energy:2,damage:8,block:0,kills:1,survives:true,steps:[{card:{name:'Strike'}}]}
  ];
  const enforced=chooseCandidate(candidates,{choice:'c0'});
  assert.equal(enforced.candidate,null);
  const quiet=candidates.map(c=>({...c,survives:true}));
  assert.equal(chooseCandidate(quiet,{choice:'c1'}).candidate.id,'c1');
  const doomed=candidates.map(c=>({...c,survives:false}));
  assert.equal(chooseCandidate(doomed,{choice:'c0'}).candidate,null);
});

test('a strategy preference outranks the model ranking',()=>{
  const candidates=[
    {id:'c0',title:'a',energy:1,damage:9,block:0,kills:0,survives:true,steps:[{card:{name:'愤怒',effect:'Deal 6 damage.'}}]},
    {id:'c1',title:'b',energy:1,damage:6,block:0,kills:0,survives:true,steps:[{card:{name:'痛击',effect:'Apply Vulnerable.'}}]}
  ];
  const chosen=chooseCandidate(candidates,{choice:'c0'},{order:[{match:'痛击'}]});
  assert.equal(chosen.candidate.id,'c1');
  assert.match(chosen.why,/strategy preference/);
});

test('the adapter asks one candidate choice and no decorative survival questions',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const s=state({player:{hp:5,block:2,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]},
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,intents:[{type:'Attack',label:'9'}]}]});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const candidates=planCandidates(s,options);
  assert.ok(candidates.length>=2,'fixture offers at least two candidates');
  let body=null,requests=0;
  const fetcher=async(_url,init)=>{
    requests++;body=JSON.parse(init.body);
    return {ok:true,json:async()=>({answers:{plan:{type:'choice',choice:candidates[1].id,confidence:.8}},
      usage:{input_tokens:120,output_tokens:12}})};
  };
  const result=await choose(s,options,{apiKey:'test-key',fetcher,candidates});
  assert.equal(requests,1,'a candidate decision is one request');
  assert.deepEqual(Object.keys(body.questions),['plan']);
  assert.equal(result.planned,true);
  assert.equal(result.candidate.id,candidates[1].id);
  assert.ok(options.some(o=>o.id===result.option.id));
  assert.equal(result.usage.input_tokens,120);
  assert.equal(result.requests,1);
});

test('an unused candidate path never asks a model',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const s=state({player:{energy:1,hand:[card(0,'打击: 造成6点伤害。')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'})];
  const candidates=planCandidates(s,options);
  let requests=0;
  const fetcher=async()=>{requests++;return{ok:true,json:async()=>({answers:{next:{choice:'0',confidence:.9}}})};};
  await choose(s,options,{apiKey:'test-key',fetcher,candidates});
  assert.equal(requests,1,'a single candidate falls back to the plain choice path');
});

test('low-confidence candidate answers are handed over by the decision entry',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const {decideCombat}=await import('../src/decision.mjs');
  const {actions,route}=await import('../src/game.mjs');
  const s={state_type:'monster',run:{act:1,floor:9,seed:'r'},player:{hp:70,max_hp:80,block:0,energy:3,
    hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')],potions:[]},
    battle:{ready_for_action:true,enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,
      intents:[{type:'Attack',label:'8'}]}]}};
  const options=actions(s);
  const candidates=planCandidates(s,options);
  const fetcher=async()=>({ok:true,json:async()=>({answers:{plan:{choice:candidates[0].id,confidence:.01}},
    usage:{input_tokens:90,output_tokens:9}})});
  const ask=(state,menu,shortlist,extra)=>choose(state,menu,{apiKey:'k',fetcher,shortlist,...extra});
  const decision=await decideCombat({state:s,options,route:route(s,options),ask});
  assert.equal(decision.kind,'handoff');
  assert.equal(decision.reason,'low_confidence_candidate');
  assert.equal(decision.requests,1);
});

test('the candidate cutoff is configurable for measurement',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const {decideCombat}=await import('../src/decision.mjs');
  const {actions,route}=await import('../src/game.mjs');
  const s={state_type:'monster',run:{act:1,floor:9,seed:'r'},player:{hp:70,max_hp:80,block:0,energy:3,
    hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')],potions:[]},
    battle:{ready_for_action:true,enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,
      intents:[{type:'Attack',label:'8'}]}]}};
  const options=actions(s);
  const candidates=planCandidates(s,options);
  const fetcher=async()=>({ok:true,json:async()=>({answers:{plan:{choice:candidates[0].id,confidence:.2}}})});
  process.env.SPIRE_PLAN_MIN_CONFIDENCE='0.1';
  try{
    const decision=await decideCombat({state:s,options,route:route(s,options),
      ask:(st,menu,shortlist,extra)=>choose(st,menu,{apiKey:'k',fetcher,shortlist,...extra})});
    assert.equal(decision.kind==='execute'||decision.kind==='execute_prefix',true);
  }finally{delete process.env.SPIRE_PLAN_MIN_CONFIDENCE;}
});

test('a line that kills the attacker survives without blocking',()=>{
  const s=state({player:{hp:6,block:0,energy:3,hand:[card(0,'打击: 造成9点伤害。')]},
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:9,max_hp:9,block:0,intents:[{type:'Attack',label:'9'}]}]});
  const [candidate]=planCandidates(s,[option(0,0,'打击: 造成9点伤害。 -> E (9 HP)',{target:'E_0'})]);
  assert.equal(candidate.kills,1);
  assert.equal(candidate.survives,true);
  assert.equal(candidate.unblocked,0);
});
