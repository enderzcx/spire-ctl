import {test} from 'node:test';
import assert from 'node:assert/strict';
import {incomingAttacks,incomingDamage,localPolicy,optionBlock,optionDamage,prefixPlan,intentDamage} from '../src/policy.mjs';

const enemy=(overrides={})=>({entity_id:'E_0',combat_id:1,name:'Enemy',hp:20,max_hp:20,block:0,
  intents:[{type:'Attack',label:'6',title:'攻势'}],status:[],...overrides});
const state=(overrides={})=>({state_type:'monster',run:{act:1,floor:4},
  battle:{ready_for_action:true,turn:'player',round:1,enemies:[enemy()],...overrides.battle},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[],potions:[],...overrides.player}});
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
  const s=state({battle:{enemies:[enemy({hp:6})]}});
  const options=[card(0,'打击: 造成6点伤害。 (energy 1) -> Enemy (6 HP)'),card(1,'防御: 获得5点格挡。'),endTurn];
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

test('a lethal incoming turn is survived only by a sufficient block play',()=>{
  const s=state({player:{hp:10,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'12'}]})]}});
  const survival=localPolicy(s,[card(0,'防御: 获得5点格挡。'),card(1,'岿然不动: 获得30点格挡。 消耗。'),endTurn]);
  assert.equal(survival.kind,'play');
  assert.equal(survival.option.command.card_index,1);

  const noBlock=localPolicy(s,[card(0,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]);
  assert.equal(noBlock.kind,'escalate');

  const partial=localPolicy(s,[card(0,'防御: 获得5点格挡。'),endTurn]);
  assert.equal(partial.kind,'escalate');
});

test('significant non-lethal damage yields a mitigation shortlist, not a forced play',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'18'}]})]}});
  const decision=localPolicy(s,[card(0,'防御: 获得5点格挡。'),card(1,'打击: 造成6点伤害。 -> Enemy (20 HP)'),endTurn]);
  assert.equal(decision.kind,'shortlist');
  assert.equal(decision.options[0].command.card_index,0);
  assert.ok(decision.candidates[0].why.includes('block'));
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
  const s=state({battle:{enemies:[enemy({hp:12})]}});
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

test('a fully covering cheap block play is taken by the program as a guard',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  const decision=localPolicy(s,[card(0,'打击: 造成6点伤害。 -> Enemy (20 HP)'),card(1,'究极防御: 获得11点格挡。'),endTurn]);
  assert.equal(decision.kind,'guard');
  assert.equal(decision.option.command.card_index,1);
  assert.match(decision.reason,/Guard 10 displayed damage with 11 block/);
});

test('a guard never consumes a card with a hidden cost',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  const decision=localPolicy(s,[card(0,'坚毅: 获得7点格挡。  随机消耗1张牌。'),card(1,'岿然不动: 获得30点格挡。 消耗。'),endTurn]);
  // Neither play is a program guard, and the attack is not material enough for
  // a mitigation shortlist, so the fast model keeps the choice.
  assert.equal(decision.kind,'decline');
});

test('a guard is not invented when the block play cannot cover the attack',()=>{
  const s=state({player:{hp:60,block:0},battle:{enemies:[enemy({intents:[{type:'Attack',label:'18'}]})]}});
  assert.equal(localPolicy(s,[card(0,'究极防御: 获得11点格挡。'),endTurn]).kind,'shortlist');
});

test('guard arithmetic respects block already carried into the turn',()=>{
  const s=state({player:{hp:60,block:8},battle:{enemies:[enemy({intents:[{type:'Attack',label:'10'}]})]}});
  // Only 2 more block are needed, so a small block card is enough.
  const decision=localPolicy(s,[card(0,'防御: 获得5点格挡。'),endTurn]);
  assert.equal(decision.kind,'guard');
  assert.equal(decision.evidence.gap,2);
});
