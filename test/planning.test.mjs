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
  // A lethal displayed attack, so the per-candidate safety questions are asked.
  // 6 block from the hand cannot cover a 9-damage attack on 5 HP, so the defense
  // line is the only surviving candidate and the safety questions are asked.
  const s=state({player:{hp:5,block:2,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]},
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,intents:[{type:'Attack',label:'9'}]}]});
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

test('an unsure candidate answer is reported instead of acted on',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const s=state({player:{energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const candidates=planCandidates(s,options);
  const fetcher=async()=>({ok:true,json:async()=>({answers:{
    plan:{type:'choice',choice:candidates[0].id,confidence:.01},
    [`safe_${candidates[0].id}`]:{type:'noul',noul:.31},
    [`safe_${candidates[1].id}`]:{type:'noul',noul:.66}
  },usage:{input_tokens:90,output_tokens:9}})}) ;
  const result=await choose(s,options,{apiKey:'test-key',fetcher,candidates});
  assert.equal(result.low_confidence_candidate,true);
  assert.equal(result.option,null,'an unsure line is not dispatched');
  assert.equal(result.answer.confidence,.01);
  assert.equal(result.plan_batch_requests??result.requests,1);
  // The independent judgments travel with the packet so a caller can escalate
  // with evidence rather than a bare number.
  assert.equal(result.answer.nouls[`safe_${candidates[1].id}`],.66);
});

test('the candidate cutoff is configurable for measurement',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const s=state({player:{energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]}});
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const candidates=planCandidates(s,options);
  const fetcher=async()=>({ok:true,json:async()=>({answers:{
    plan:{type:'choice',choice:candidates[1].id,confidence:.2},
    [`safe_${candidates[0].id}`]:{type:'noul',noul:.2},
    [`safe_${candidates[1].id}`]:{type:'noul',noul:.8}
  }})}) ;
  process.env.SPIRE_PLAN_MIN_CONFIDENCE='0.1';
  try{
    const result=await choose(s,options,{apiKey:'test-key',fetcher,candidates});
    assert.equal(result.low_confidence_candidate,undefined);
    assert.equal(result.planned,true);
    assert.ok(result.option,'a lowered gate acts');
  }finally{delete process.env.SPIRE_PLAN_MIN_CONFIDENCE;}
});

test('the candidate threshold scales with the stakes',async()=>{
  const {choose}=await import('../src/jev.mjs');
  const options=[option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'}),option(1,1,'防御: 获得5点格挡。')];
  const quiet=state({player:{hp:70,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]}});
  const quietCandidates=planCandidates(quiet,options);
  assert.ok(quietCandidates.every(candidate=>candidate.survives===true),'quiet board: every line survives');
  const answer=confidence=>({ok:true,json:async()=>({answers:{
    plan:{type:'choice',choice:quietCandidates[1].id,confidence},
    ...Object.fromEntries(quietCandidates.map(c=>[`safe_${c.id}`,{type:'noul',noul:.8}]))
  }})});
  // A low-stakes turn acts on a weaker judgment...
  const low=await choose(quiet,options,{apiKey:'k',fetcher:async()=>answer(.3),candidates:quietCandidates});
  assert.ok(low.option,'a safe, low-stakes line is acted on');
  assert.equal(low.low_confidence_candidate,undefined);
  // ...while a lethal turn demands the full cutoff.
  const lethal=state({player:{hp:5,block:2,energy:3,hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。','1','Skill')]},
    enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,intents:[{type:'Attack',label:'9'}]}]});
  const lethalCandidates=planCandidates(lethal,options.map(o=>o.command.card_index===0
    ?option(0,0,'打击: 造成6点伤害。 -> E (20 HP)',{target:'E_0'})
    :option(1,1,'防御: 获得5点格挡。')));
  const strict=await choose(lethal,options,{apiKey:'k',fetcher:async()=>({ok:true,json:async()=>({answers:{
    plan:{type:'choice',choice:lethalCandidates.find(c=>c.block>0)?.id??lethalCandidates[0].id,confidence:.3},
    ...Object.fromEntries(lethalCandidates.map(c=>[`safe_${c.id}`,{type:'noul',noul:.6}]))
  }})}),candidates:lethalCandidates});
  assert.equal(strict.low_confidence_candidate,true,'a lethal turn keeps the full cutoff');
  assert.equal(strict.option,null);
});
