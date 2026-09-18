import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planCandidates,chooseCandidate,candidateQuestions} from '../src/planning.mjs';

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

test('survival is enforced without the program overruling a safe model pick',()=>{
  const candidates=[
    {id:'c0',title:'greedy',energy:3,damage:20,block:0,kills:0,survives:false,steps:[{card:{name:'X'}}]},
    {id:'c1',title:'block',energy:1,damage:4,block:9,kills:0,survives:true,steps:[{card:{name:'Defend'}}]},
    {id:'c2',title:'kill',energy:2,damage:8,block:0,kills:1,survives:true,steps:[{card:{name:'Strike'}}]}
  ];
  // Lethal turn: the line that dies is removed, so even the model's pick of it
  // resolves to a surviving line instead.
  const enforced=chooseCandidate(candidates,{choice:'c0'});
  assert.equal(enforced.candidate.survives,true);
  assert.notEqual(enforced.candidate.id,'c0');
  // Quiet turn: every line lives, so a safe model pick is honoured even when
  // another candidate would kill.
  const quiet=candidates.map(c=>({...c,survives:true}));
  assert.equal(chooseCandidate(quiet,{choice:'c1'}).candidate.id,'c1');
  // Nothing survives: the program says so instead of inventing a line.
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

test('speculative per-candidate questions are independent',()=>{
  const questions=candidateQuestions([{id:'c0',title:'x'},{id:'c1',title:'y'}]);
  assert.deepEqual(Object.keys(questions),['safe_c0','safe_c1']);
  for(const question of Object.values(questions)){
    assert.equal(question.type,'noul');
    assert.ok(question.instructions.length>20);
  }
});

test('the adapter asks one batch for the choice plus independent judgments',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const s=state({player:{energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const candidates=planCandidates(s,options);
  assert.ok(candidates.length>=2,'fixture offers at least two candidates');
  let body=null,requests=0;
  const fetcher=async(_url,init)=>{
    requests++;body=JSON.parse(init.body);
    const answers={plan:{type:'choice',choice:candidates[1].id,probabilities:{},confidence:.8}};
    for(const candidate of candidates)answers[`safe_${candidate.id}`]={type:'noul',noul:.9};
    return {ok:true,json:async()=>({answers,usage:{input_tokens:120,output_tokens:12}})};
  };
  const result=await choose(s,options,{apiKey:'test-key',fetcher,candidates});
  assert.equal(requests,1,'a candidate decision is one request');
  const questionIds=Object.keys(body.questions);
  assert.equal(questionIds.length,1+candidates.length);
  assert.equal(body.questions.plan.type,'choice');
  for(const candidate of candidates)assert.equal(body.questions[`safe_${candidate.id}`].type,'noul');
  assert.equal(body.state.options.length,options.length);
  assert.equal(result.planned,true);
  assert.equal(result.candidate.id,candidates[1].id);
  // The chosen step must be one of the advertised options, not a synthesised one.
  assert.ok(options.some(o=>o.id===result.option.id));
  assert.equal(result.usage.input_tokens,120);
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
