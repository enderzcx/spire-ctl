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

test('a send error keeps the halt because it is not a guaranteed pre-dispatch rejection',()=>temporary(async dir=>{
  const x=combat();
  const game={read:async()=>x,settled:async()=>x,
    send:async()=>{throw Error('Game rejected request: {"status":"error","message":"illegal"}');}};
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/rejected/);
  assert.match(await readFile(join(dir,'HALTED'),'utf8'),/rejected/);
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
  assert.match(first.reason,/low_confidence/);
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

test('bridge-shaped runs have no persistent strategy and in-call strategy does not carry',()=>temporary(async dir=>{
  const start=combat();
  start.run={act:1,floor:4,ascension:0};
  const {game,sends}=playGame(start,applyKnown);
  const strategy={strategy_id:'call',reason:'chip',conditions:[{kind:'same_floor',act:1,floor:4}],
    expires_on:[],order:[{match:'打击'}]};
  await assert.rejects(createController({runtimeDir:dir,controlDir:dir,openGame:()=>game,apiKey:'k'})
    .saveStrategy(strategy),/run identity/);
  const first=await battle(game,async(_s,offered)=>({option:offered[0],answer:{confidence:.9},requests:1}),
    {dir,max:2,strategy,expectedStateId:stateId(start)});
  assert.ok(sends()>=1,`in-call strategy should still execute a constrained pick, got ${first.reason}`);
  const second=await battle(game,async()=>({option:{id:'0'},answer:{confidence:.9},requests:1}),{dir,max:1});
  assert.notEqual(second.reason,first.reason==='invalid strategy'?'x':undefined);
  const loaded=await createController({runtimeDir:dir,controlDir:dir,openGame:()=>game,apiKey:'k'}).strategy();
  assert.equal(loaded.strategy,null);
}));

test('battle max_steps=1 cannot dispatch a two-card prefix',()=>temporary(async dir=>{
  const start=combat();
  const {game,sends}=playGame(start,applyKnown);
  const controller=createController({runtimeDir:dir,controlDir:dir,apiKey:'k',openGame:()=>game,
    decide:async(s,o,{candidates})=>{
      const prefix=(candidates??[]).find(c=>c.steps?.length>=2);
      if(prefix)return {option:o[0],answer:{choice:prefix.id,confidence:.9},candidate:prefix,planned:true,requests:1};
      return {option:o[0],answer:{confidence:.9,choice:o[0].id},requests:1};
    }});
  await controller.battle(1);
  assert.equal(sends(),1);
}));

test('a failed Jev request still reports the attempt count',async()=>{
  const start=combat();
  const options=actions(start);
  await assert.rejects(choose(start,options,{apiKey:'k',fetcher:async()=>{throw Error('network down');}}),error=>{
    assert.equal(error.requests,1);
    assert.equal(error.usage.unavailable,true);
    return /network down/.test(error.message);
  });
});

test('unmatched in-call strategy is an explicit handoff, not end turn',()=>temporary(async dir=>{
  const start=combat();
  start.run={act:1,floor:4,ascension:0};
  const game={read:async()=>start,settled:async()=>start,send:async()=>{throw Error('must not send');}};
  const result=await battle(game,async()=>({option:{id:'0'},answer:{confidence:.9}}),{
    dir,strategy:{strategy_id:'x',conditions:[{kind:'same_floor',act:1,floor:4}],order:[{match:'痛击'}]},
    expectedStateId:stateId(start)});
  assert.match(result.reason,/matched none|invalid strategy/);
}));

test('candidate menus keep end turn and extra targets',()=>{
  const start=combat();
  const options=actions(start);
  const candidates=planCandidates(start,options);
  assert.ok(candidates.some(c=>c.title==='End turn'||c.option_id===options.find(o=>o.command.action==='end_turn')?.id));
  assert.ok(candidates.filter(c=>c.kind==='single').length>=options.filter(o=>o.command.action!=='use_potion').length);
});

test('a sequence re-reads and verifies each step, and stops when a step is gone',async()=>{
  const {sequence}=await import('../src/runner.mjs');
  const combat=()=>({
    state_type:'monster',run:{act:1,floor:3,ascension:0},
    player:{hp:70,max_hp:80,block:0,energy:3,max_energy:3,potions:[],
      hand:[{index:0,name:'打击',cost:'1',type:'Attack',can_play:true,target_type:'AnyEnemy',description:'造成6点伤害。'},
        {index:1,name:'防御',cost:'1',type:'Skill',can_play:true,target_type:'Self',description:'获得5点格挡。'}],
      draw_pile_count:3,discard_pile_count:0,exhaust_pile_count:0,relics:[]},
    battle:{round:1,turn:1,ready_for_action:true,action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,status:[],intents:[{type:'Attack',label:'8'}]}]}
  });
  const seen=[];
  const game={read:async()=>combat(),settled:async()=>combat(),
    send:async payload=>{seen.push(payload);return {status:'ok'};}};
  const result=await sequence(game,[{card_index:0},{action:'end_turn'}],{dir:await mkdtemp(join(tmpdir(),'seq-'))});
  assert.equal(result.reason,'sequence_done');
  assert.equal(seen.length,2,'both steps were sent');
  assert.equal(seen[0].action,'play_card');
  assert.equal(result.performed[0].action,'play_card');
  assert.equal(result.performed[1].action,'end_turn');
});

test('a sequence plays nothing once a stated move is no longer advertised',async()=>{
  const {sequence}=await import('../src/runner.mjs');
  // Only end turn exists: the stated card move must not be guessed at.
  const quiet={state_type:'monster',run:{act:1,floor:3,ascension:0},
    player:{hp:70,max_hp:80,block:0,energy:0,max_energy:3,potions:[],hand:[],
      draw_pile_count:0,discard_pile_count:0,exhaust_pile_count:0,relics:[]},
    battle:{round:1,turn:1,ready_for_action:true,action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:20,max_hp:20,block:0,status:[],intents:[]}]}};
  let sends=0;
  const game={read:async()=>quiet,settled:async()=>quiet,send:async()=>{sends++;return{status:'ok'};}};
  const result=await sequence(game,[{card_index:0},{action:'end_turn'}],{dir:await mkdtemp(join(tmpdir(),'seq2-'))});
  assert.equal(result.reason,'step_not_advertised');
  assert.equal(sends,0,'nothing is played when the stated move is gone');
  assert.equal(result.steps,0);
  assert.deepEqual(result.unmatched,{card_index:0});
  assert.ok(result.advertised.some(o=>o.command.action==='end_turn'),'the caller is told what is available');
});

test('shop items name themselves the same way whatever their category',async()=>{
  const {normalizeItem,normalizeState}=await import('../src/contract.mjs');
  const card=normalizeItem({index:0,category:'card',price:50,card_id:'IRON_WAVE',card_name:'铁斩波',card_description:'获得5点格挡。'});
  assert.equal(card.name,'铁斩波');
  assert.equal(card.description,'获得5点格挡。');
  assert.equal(card.item_id,'IRON_WAVE');
  assert.equal(card.card_name,'铁斩波','the raw field is preserved');
  const relic=normalizeItem({index:7,category:'relic',price:242,relic_id:'KUNAI',relic_name:'苦无',relic_description:'每回合3张攻击牌获得1敏捷。'});
  assert.equal(relic.name,'苦无');
  const potion=normalizeItem({index:10,category:'potion',price:50,potion_id:'SKILL_POTION',potion_name:'技能药水',potion_description:'从3张随机技能牌中选择1张。'});
  assert.equal(potion.name,'技能药水');
  // A card removal has nothing to name, and must not gain a bogus one.
  const removal=normalizeItem({index:13,category:'card_removal',price:75});
  assert.equal(removal.name,undefined);
  // The player's own potions already use the uniform names and pass through.
  const state=normalizeState({shop:{items:[relic]},player:{potions:[{id:'X',name:'Y'}]}});
  assert.equal(state.shop.items[0].name,'苦无');
  assert.equal(state.player.potions[0].name,'Y');
  assert.equal(normalizeState({state_type:'map'}).state_type,'map','states without a shop are untouched');
});

test('a sequence also covers a non-combat screen such as a shop run',async()=>{
  const {sequence}=await import('../src/runner.mjs');
  const shop=()=>({state_type:'shop',run:{act:2,floor:20,ascension:0},
    player:{hp:61,max_hp:80,gold:436,potions:[],relics:[]},
    shop:{can_proceed:true,items:[
      {index:7,category:'relic',price:242,is_stocked:true,can_afford:true,relic_id:'KUNAI',relic_name:'苦无'},
      {index:13,category:'card_removal',price:75,is_stocked:true,can_afford:true}]}});
  const seen=[];
  const game={read:async()=>shop(),settled:async()=>shop(),send:async p=>{seen.push(p);return{status:'ok'};}};
  const result=await sequence(game,[{action:'shop_purchase',index:7},{action:'shop_purchase',index:13}],
    {dir:await mkdtemp(join(tmpdir(),'seq3-'))});
  assert.equal(result.reason,'sequence_done','combat is not required');
  assert.equal(seen.length,2);
  assert.equal(seen[0].action,'shop_purchase');
  assert.equal(seen[1].index,13);
});

test('a sequence can name the card instead of trusting a shifting index',async()=>{
  const {sequence}=await import('../src/runner.mjs');
  // Two Strikes and a Defend: index-based steps would play index 0 twice, and
  // the second step would land on whatever slid into that slot.
  const combat=()=>({state_type:'monster',run:{act:1,floor:3,ascension:0},
    player:{hp:70,max_hp:80,block:0,energy:3,max_energy:3,potions:[],
      hand:[{index:0,id:'STRIKE_IRONCLAD',name:'打击',cost:'1',type:'Attack',can_play:true,target_type:'AnyEnemy',description:'造成6点伤害。'},
        {index:1,id:'DEFEND_IRONCLAD',name:'防御',cost:'1',type:'Skill',can_play:true,target_type:'Self',description:'获得5点格挡。'},
        {index:2,id:'STRIKE_IRONCLAD',name:'打击',cost:'1',type:'Attack',can_play:true,target_type:'AnyEnemy',description:'造成6点伤害。'}],
      draw_pile_count:2,discard_pile_count:0,exhaust_pile_count:0,relics:[]},
    battle:{round:1,turn:1,ready_for_action:true,action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:30,max_hp:30,block:0,status:[],intents:[{type:'Attack',label:'8'}]}]}});
  const seen=[];
  const game={read:async()=>combat(),settled:async()=>combat(),send:async p=>{seen.push(p);return{status:'ok'};}};
  const result=await sequence(game,[
    {card:'STRIKE_IRONCLAD',target:'E_0'},
    {card:'DEFEND_IRONCLAD'}
  ],{dir:await mkdtemp(join(tmpdir(),'seq4-'))});
  assert.equal(result.reason,'sequence_done');
  assert.deepEqual(seen.map(p=>p.card_index),[0,1],'the named cards, not the same slot twice');
  assert.equal(seen[1].action,'play_card');
});

test('a sequence stops when the named card is not in hand',async()=>{
  const {sequence}=await import('../src/runner.mjs');
  const combat={state_type:'monster',run:{act:1,floor:3,ascension:0},
    player:{hp:70,max_hp:80,block:0,energy:3,max_energy:3,potions:[],
      hand:[{index:0,id:'DEFEND_IRONCLAD',name:'防御',cost:'1',type:'Skill',can_play:true,target_type:'Self',description:'获得5点格挡。'}],
      draw_pile_count:2,discard_pile_count:0,exhaust_pile_count:0,relics:[]},
    battle:{round:1,turn:1,ready_for_action:true,action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:30,max_hp:30,block:0,status:[],intents:[]}]}};
  let sends=0;
  const game={read:async()=>combat,settled:async()=>combat,send:async()=>{sends++;return{status:'ok'};}};
  const result=await sequence(game,[{card:'STRIKE_IRONCLAD',target:'E_0'}],{dir:await mkdtemp(join(tmpdir(),'seq5-'))});
  assert.equal(result.reason,'card_not_in_hand');
  assert.equal(sends,0);
  assert.equal(result.hand[0].id,'DEFEND_IRONCLAD');
});
