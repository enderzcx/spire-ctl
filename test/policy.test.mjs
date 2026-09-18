import {test} from 'node:test';
import assert from 'node:assert/strict';
import {incomingAttacks,incomingDamage,localPolicy,nextLocalPlay,optionBlock,optionDamage,prefixPlan,intentDamage,attritionRisk} from '../src/policy.mjs';

const enemy=(overrides={})=>({entity_id:'E_0',combat_id:1,name:'Enemy',hp:20,max_hp:20,block:0,
  intents:[{type:'Attack',label:'6',title:'攻势'}],status:[],...overrides});
const state=(overrides={})=>({state_type:'monster',run:{act:1,floor:4},
  battle:{ready_for_action:true,turn:'player',round:1,enemies:[enemy()],...overrides.battle},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[],potions:[],status:[],relics:[],...overrides.player}});
const card=(index,label,overrides={})=>({id:`CARD_${index}`,...overrides,
  command:{action:'play_card',card_index:index,...overrides.command},label});
const endTurn={id:'end',command:{action:'end_turn'},label:'End turn'};

test('intent parsing distinguishes known, zero and unknown damage',()=>{
  assert.equal(intentDamage({type:'Attack',label:'6'}),6);
  assert.equal(intentDamage({type:'Attack',label:'7×2'}),14);
  assert.equal(intentDamage({type:'Attack',label:'3 x 5'}),15);
  assert.equal(intentDamage({type:'Buff',label:''}),0);
  assert.equal(intentDamage({type:'Attack',label:'?'}),null);
});

test('incomingAttacks separates attacks from buffs and refuses unknown labels',()=>{
  const s=state({battle:{enemies:[enemy({intents:[{type:'Attack',label:'5×2'},{type:'Buff',title:'强化',label:''}]})]}});
  const attacks=incomingAttacks(s);
  assert.equal(attacks.known,true);
  assert.equal(attacks.total,10);
  assert.equal(incomingDamage(s),10);

  const unknown=state({battle:{enemies:[enemy({intents:[{type:'Attack',label:'?'}]})]}});
  assert.equal(incomingAttacks(unknown).known,false);
  assert.equal(incomingDamage(unknown),null);
});

test('option damage and block are read from the advertised label',()=>{
  assert.equal(optionDamage(card(0,'打击: 造成6点伤害。 (energy 1) -> 敌 (12 HP)')),6);
  assert.equal(optionDamage(card(1,'双重打击+: 造成9点伤害两次。 (energy 1)')),18);
  assert.equal(optionDamage(card(2,'完美打击: 造成18点伤害。')),18);
  assert.equal(optionDamage(card(3,'坚毅: 获得7点格挡。')),null);
  assert.equal(optionBlock(card(3,'坚毅: 获得7点格挡。')),7);
  assert.equal(optionDamage({command:{action:'end_turn'},label:'End turn'}),null);
});

test('lethal displayed attacks are preferred over defending',()=>{
  const s=state({player:{hand:[{id:'STRIKE',index:0,cost:'1',description:'造成6点伤害。',can_play:true}]},
    battle:{enemies:[enemy({hp:6})]}});
  const options=[card(0,'打击: 造成6点伤害。 (energy 1) -> Enemy (6 HP)',{command:{target:'E_0'}}),card(1,'防御: 获得5点格挡。'),endTurn];
  const decision=localPolicy(s,options);
  assert.equal(decision.kind,'kill');
  assert.deepEqual(decision.options.map(o=>o.command.card_index),[0]);
  assert.match(decision.reason,/cover all 1 living enemies/);
});

test('all living enemies must be covered for a local kill decision',()=>{
  const two=state({battle:{enemies:[enemy({entity_id:'E_0',hp:6}),enemy({entity_id:'E_1',combat_id:2,hp:20})]}});
  const options=[card(0,'打击: 造成6点伤害。 -> E_0'),{...card(1,'打击: 造成6点伤害。'),command:{action:'play_card',card_index:1,target:'E_1'}},endTurn];
  const decision=localPolicy(two,options);
  assert.notEqual(decision.kind,'kill');
});

test('a lethal incoming turn is survived only by a proven covering play',()=>{
  const s=state({player:{hp:10,block:0,hand:[
    {id:'DEFEND',index:0,cost:'1',description:'获得5点格挡。'},
    {id:'IMPERVIOUS',index:1,cost:'2',description:'获得30点格挡。'}
  ]},battle:{enemies:[enemy({intents:[{type:'Attack',label:'12'}]})]}});
  const survival=localPolicy(s,[card(0,'防御: 获得5点格挡。'),card(1,'岿然不动: 获得30点格挡。'),endTurn]);
  assert.equal(survival.kind,'play');
  assert.equal(survival.option.command.card_index,1);

  const noBlock=localPolicy(s,[card(0,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]);
  assert.equal(noBlock.kind,'escalate');

  const partial=localPolicy(s,[card(0,'防御: 获得5点格挡。'),endTurn]);
  assert.equal(partial.kind,'escalate');
});

test('unproven exhaust cover is not a local survive play',()=>{
  const s=state({player:{hp:10,block:0,hand:[{id:'I',index:0,cost:'2',description:'获得30点格挡。消耗。'}]},
    battle:{enemies:[enemy({intents:[{type:'Attack',label:'12'}]})]}});
  assert.equal(localPolicy(s,[card(0,'岿然不动: 获得30点格挡。 消耗。'),endTurn]).kind,'escalate');
});

test('significant non-lethal damage is not a forced local play',()=>{
  const s=state({player:{hp:60,block:0,hand:[{id:'D',index:0,cost:'1',description:'获得5点格挡。'}]},
    battle:{enemies:[enemy({intents:[{type:'Attack',label:'18'}]})]}});
  const decision=localPolicy(s,[card(0,'防御: 获得5点格挡。'),card(1,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]);
  assert.equal(decision.kind,'decline');
});

test('a quiet turn declines so the fast model keeps ownership',()=>{
  const s=state({player:{hp:70,block:0},battle:{enemies:[enemy({intents:[{type:'Buff',title:'强化',label:''}]})]}});
  assert.equal(localPolicy(s,[card(0,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]).kind,'decline');
});

test('unknown intents always decline instead of guessing',()=>{
  const s=state({battle:{enemies:[enemy({intents:[{type:'Attack',label:'?'}]})]}});
  assert.equal(localPolicy(s,[card(0,'打击: 造成6点伤害。'),endTurn]).kind,'decline');
});

test('a deterministic lethal prefix needs stated damage and a stable combat id',()=>{
  const s=state({player:{hand:[{id:'STRIKE',index:2,cost:'1',description:'造成12点伤害。'}]},
    battle:{enemies:[enemy({hp:12})]}});
  const plan=prefixPlan(s,[card(2,'打击: 造成12点伤害。 -> Enemy (12 HP)',{command:{target:'E_0'}}),endTurn]);
  assert.deepEqual(plan,[{card_index:2,target_combat_id:1}]);

  // A stated number alone is not enough: without a target id and with several
  // living enemies the destination is unknown, so no prefix is proposed.
  const two=state({battle:{enemies:[enemy({entity_id:'E_0',hp:40}),enemy({entity_id:'E_1',combat_id:2,hp:40})]}});
  assert.equal(prefixPlan(two,[card(2,'打击: 造成40点伤害。'),endTurn]),null);

  // Parsing unknown phrasing is not a licence to plan from it: the random
  // multi-hit card still needs a target, and a short-of-lethal hit proposes
  // nothing against a fresh target.
  assert.equal(prefixPlan(state({battle:{enemies:[enemy({hp:20})]}}),[card(0,'飞剑回旋镖: 随机对敌人造成3点伤害3次。'),endTurn]),null);
});

test('a lethal displayed attack is survived by the only covering play',()=>{
  const s=state({player:{hp:10,block:0,hand:[
    {id:'S',index:0,cost:'1',description:'造成6点伤害。'},
    {id:'U',index:1,cost:'1',description:'获得11点格挡。'}
  ]},battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  const decision=localPolicy(s,[card(0,'打击: 造成6点伤害。 -> Enemy (20 HP)'),card(1,'究极防御: 获得11点格挡。'),endTurn]);
  assert.equal(decision.kind,'play');
  assert.equal(decision.option.command.card_index,1);
  assert.match(decision.reason,/only such play/);
});

test('routine mitigation is left to the fast model, not decided by the program',()=>{
  // A moderate attack that several cards could answer is a tactical tradeoff:
  // damage now versus block now. The program declines instead of preferring one.
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  const decision=localPolicy(s,[card(0,'坚毅: 获得7点格挡。  随机消耗1张牌。'),card(1,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]);
  assert.equal(decision.kind,'decline');
});

test('a lethal attack that cannot be covered escalates instead of guessing',()=>{
  const s=state({player:{hp:10,block:0,hand:[{id:'U',index:0,cost:'1',description:'获得11点格挡。'}]},
    battle:{enemies:[enemy({intents:[{type:'Attack',label:'18'}]})]}});
  assert.equal(localPolicy(s,[card(0,'究极防御: 获得11点格挡。'),endTurn]).kind,'escalate');
});

test('survival arithmetic respects block already carried into the turn',()=>{
  const s=state({player:{hp:2,block:8,hand:[{id:'D',index:0,cost:'1',description:'获得5点格挡。'}]},
    battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  // Only 2 more block are needed to live, so a small block card is enough.
  const decision=localPolicy(s,[card(0,'防御: 获得5点格挡。'),endTurn]);
  assert.equal(decision.kind,'play');
  assert.equal(decision.evidence.gap,2);
});

test('several playable cards are a tactical choice and go to the fast model',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'12'}]})]}});
  const options=[card(0,'耸肩无视: 获得8点格挡。 抽1张牌。'),card(1,'战斗专注: 抽3张牌。'),endTurn];
  assert.equal(nextLocalPlay(s,options),null);
});

test('one playable card is not a forced action; end turn still competes',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'12'}]})]}});
  assert.equal(nextLocalPlay(s,[card(0,'耸肩无视: 获得8点格挡。 抽1张牌。'),endTurn]),null);
  assert.equal(nextLocalPlay(s,[card(0,'坚毅: 获得7点格挡。  随机消耗1张牌。'),endTurn]),null);
});

test('a lethal displayed attack blocks the local continuation',()=>{
  const s=state({player:{hp:10,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'30'}]})]}});
  assert.equal(nextLocalPlay(s,[card(0,'耸肩无视: 获得8点格挡。 抽1张牌。'),endTurn]),null);
});

test('a lethal single play is taken even with other cards in hand',()=>{
  const s=state({player:{hp:60,block:0,hand:[
    {id:'S',index:0,cost:'1',description:'获得8点格挡。抽1张牌。'},
    {id:'STRIKE',index:1,cost:'1',description:'造成8点伤害。'}
  ]},battle:{enemies:[enemy({hp:7,intents:[{type:'Attack',label:'12'}]})]}});
  const options=[card(0,'耸肩无视: 获得8点格挡。 抽1张牌。'),card(1,'打击: 造成8点伤害。 -> Enemy (7 HP)',{command:{target:'E_0'}}),endTurn];
  const next=nextLocalPlay(s,options);
  assert.equal(next.option.command.card_index,1);
  assert.match(next.reason,/Finish the last living enemy/);
});

test('a last-enemy lethal still resolves locally when other cards are in hand',()=>{
  const s=state({player:{hp:60,block:0,hand:[
    {id:'S',index:0,cost:'1',description:'获得8点格挡。抽1张牌。'},
    {id:'STRIKE',index:1,cost:'1',description:'造成8点伤害。'}
  ]},battle:{enemies:[enemy({hp:7,intents:[{type:'Attack',label:'12'}]})]}});
  const options=[card(0,'耸肩无视: 获得8点格挡。 抽1张牌。'),card(1,'打击: 造成8点伤害。 -> Enemy (7 HP)',{command:{target:'E_0'}}),endTurn];
  const next=nextLocalPlay(s,options);
  assert.equal(next.option.command.card_index,1);
});

test('a kill line needs one distinct card per enemy and enough energy',()=>{
  const hand=[{index:0,cost:'1',description:'造成6点伤害。'},{index:1,cost:'1',description:'造成6点伤害。'},{index:2,cost:'2',description:'造成6点伤害。'}];
  const two=state({player:{hp:60,block:0,energy:1,hand},
    battle:{enemies:[enemy({entity_id:'E_0',hp:6}),enemy({entity_id:'E_1',combat_id:2,hp:6})]}});
  const strike=(card_index,target)=>card(card_index,'打击: 造成6点伤害。',{command:{target}});
  // Two enemies, one energy: the same card cannot be spent twice, so this is not
  // a deterministic kill and the program must not claim one.
  const starved=localPolicy(two,[strike(0,'E_0'),strike(0,'E_1'),strike(1,'E_1'),endTurn]);
  assert.notEqual(starved.kind,'kill');
  // Two energy and two distinct cards: the arithmetic is settled.
  const funded=state({player:{hp:60,block:0,energy:2,hand},
    battle:{enemies:[enemy({entity_id:'E_0',hp:6}),enemy({entity_id:'E_1',combat_id:2,hp:6})]}});
  const decided=localPolicy(funded,[strike(0,'E_0'),strike(1,'E_1'),endTurn]);
  assert.equal(decided.kind,'kill');
  assert.deepEqual(decided.options.map(o=>o.command.card_index).sort(),[0,1]);
  assert.equal(decided.evidence.cost,2);
  assert.equal(decided.evidence.energy,2);
});

test('needed damage covers block then hp, so 6 damage does not kill 6 HP + 4 block',()=>{
  const shielded=()=>state({player:{hp:60,block:0,energy:3,hand:[{index:0,cost:'1',description:'造成6点伤害。'}]},
    battle:{enemies:[enemy({hp:6,block:4})]}});
  assert.notEqual(localPolicy(shielded(),[card(0,'打击: 造成6点伤害。'),endTurn]).kind,'kill');
  assert.notEqual(localPolicy(shielded(),[card(0,'戳刺: 造成1点伤害。'),endTurn]).kind,'kill');
  assert.equal(localPolicy(state({player:{hp:60,block:0,energy:3,hand:[{index:0,cost:'1',description:'造成10点伤害。'}]},
    battle:{enemies:[enemy({hp:6,block:4})]}}),[card(0,'打击: 造成10点伤害。'),endTurn]).kind,'kill');
});

test('a fight the hand cannot answer stops instead of grinding',()=>{
  // 20 HP, 25 displayed damage, and the best block in hand is 5: this turn
  // already empties the bar, so the program reports instead of looping.
  const doomed=state({player:{hp:20,block:0,energy:3,hand:[{index:0,cost:'1',description:'获得5点格挡。'}]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'25'}]})]}});
  const options=[card(0,'防御: 获得5点格挡。'),endTurn];
  const risk=attritionRisk(doomed,options);
  assert.equal(risk.kind,'attrition');
  assert.equal(risk.evidence.hand_cover,5);
  assert.equal(risk.evidence.lethal_in_turns,1);
  assert.equal(attritionRisk(state({player:{hp:20,block:0,energy:3,hand:[{index:0,cost:'2',description:'获得30点格挡。'}]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'25'}]})]}}),[card(0,'岿然不动: 获得30点格挡。'),endTurn]),null);
  const killable=state({player:{hp:20,energy:3,hand:[{index:0,cost:'1',description:'造成6点伤害。'}]},
    battle:{enemies:[enemy({hp:6,intents:[{type:'Attack',label:'25'}]})]}});
  assert.equal(attritionRisk(killable,[card(0,'打击: 造成6点伤害。 -> E (6 HP)',{command:{target:'E_0'}}),endTurn]),null);
  // Survivable for more than one turn is still a fight, not a report.
  const survivable=state({player:{hp:40,block:0,energy:3,hand:[{index:0,cost:'1'}]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'18'}]})]}});
  assert.equal(attritionRisk(survivable,[card(0,'防御: 获得5点格挡。'),endTurn]),null);
  // Already fully blocked: nothing to report.
  const safe=state({player:{hp:20,block:30,energy:3,hand:[{index:0,cost:'1'}]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'25'}]})]}});
  assert.equal(attritionRisk(safe,[card(0,'防御: 获得5点格挡。'),endTurn]),null);
});

test('the model input states how long the position lasts',async()=>{
  const {buildInput}=await import('../src/input.mjs');
  const s=state({player:{hp:20,block:0,energy:3,hand:[{index:0,cost:'1'}]},
    battle:{enemies:[enemy({hp:40,intents:[{type:'Attack',label:'10'}]})]}});
  const input=buildInput(s,[card(0,'防御: 获得5点格挡。'),endTurn]);
  assert.equal(input.state.computed.turns_survivable,2,'20 HP against 10 survives two turns');
  assert.equal(input.state.computed.incoming_attack_total,10);
  assert.ok('best_hand_block' in input.state.computed);
});
