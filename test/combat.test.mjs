import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyDamage,parseEffect,optionDamage,projectPlay,projectPrefix,incomingAttacks} from '../src/combat.mjs';
import {describeCard} from '../src/effects.mjs';
import {localPolicy} from '../src/policy.mjs';

const enemy=(overrides={})=>({entity_id:'E_0',combat_id:1,name:'Enemy',hp:20,max_hp:20,block:0,
  intents:[{type:'Attack',label:'6',title:'攻势'}],status:[],...overrides});
const state=(overrides={})=>({state_type:'monster',run:{act:1,floor:4,seed:'r1'},
  battle:{ready_for_action:true,turn:'player',round:1,action_running:false,action_queue_empty:true,
    enemies:[enemy()],...overrides.battle},
  player:{hp:40,max_hp:80,block:0,energy:3,hand:[],potions:[],discard_pile_count:0,...overrides.player}});
const option=(index,label,extra={})=>({id:String(index),command:{action:'play_card',card_index:index,...extra},label});
const card=(index,label,overrides={})=>({id:overrides.id??`CARD_${index}`,index,name:label.split(':')[0],
  type:overrides.type??'Attack',cost:overrides.cost??'1',target_type:overrides.target_type??'AnyEnemy',
  can_play:true,description:label,is_upgraded:Boolean(overrides.is_upgraded)});

test('block absorbs damage before hp, so 8 HP + 3 block is not killed by 6',()=>{
  assert.deepEqual(applyDamage(8,3,6),{hp:5,block:0,killed:false});
  assert.deepEqual(applyDamage(6,0,6),{hp:0,block:0,killed:true});
  assert.deepEqual(applyDamage(8,3,11),{hp:0,block:0,killed:true});
});

test('local lethal uses the same block-then-hp rule',()=>{
  const shielded=state({player:{hp:60,energy:3,hand:[card(0,'打击: 造成6点伤害。')]},
    battle:{enemies:[enemy({hp:8,block:3})]}});
  const end={id:'end',command:{action:'end_turn'},label:'End turn'};
  assert.notEqual(localPolicy(shielded,[option(0,'打击: 造成6点伤害。 -> Enemy (8 HP)',{target:'E_0'}),end]).kind,'kill');
  const exact=state({player:{hp:60,energy:3,hand:[card(0,'打击: 造成6点伤害。')]},
    battle:{enemies:[enemy({hp:6,block:0})]}});
  assert.equal(localPolicy(exact,[option(0,'打击: 造成6点伤害。 -> Enemy (6 HP)',{target:'E_0'}),end]).kind,'kill');
});

test('upgraded live Strike 9 is described as Deal 9, not the seed 6',()=>{
  const upgraded=describeCard(card(0,'造成9点伤害。',{id:'STRIKE',is_upgraded:true}));
  assert.equal(upgraded.known,true);
  assert.match(upgraded.effect,/Deal 9 damage/);
  assert.equal(upgraded.effect.includes('Deal 6'),false);
  assert.equal(upgraded.original_text,'造成9点伤害。');
  assert.equal(upgraded.modeled.damage,9);
});

test('unknown modifiers stay unknown instead of fabricating a number',()=>{
  const perfect=describeCard(card(0,'造成伤害，每有一张打击名称的牌多 2 点。',{id:'PERFECTED_STRIKE'}));
  assert.equal(perfect.known,true);
  assert.match(perfect.effect,/original text/);
  assert.equal(perfect.modeled,undefined);
  assert.equal(optionDamage(option(0,'完美打击: 造成伤害，每有一张打击名称的牌多 2 点。')),null);
});

test('a sequential prefix stops on a dead target and does not reuse a card',()=>{
  const s=state({player:{energy:3,hand:[
    card(0,'打击: 造成6点伤害。'),card(1,'打击: 造成6点伤害。')
  ]},battle:{enemies:[enemy({hp:6,block:0})]}});
  const first=option(0,'打击: 造成6点伤害。 -> Enemy (6 HP)',{target:'E_0'});
  const second=option(1,'打击: 造成6点伤害。 -> Enemy (6 HP)',{target:'E_0'});
  const killed=projectPlay(s,first);
  assert.equal(killed.kills,1);
  assert.equal(projectPlay(killed.next,second).known,false);
  const prefix=projectPrefix(s,[first,second]);
  assert.equal(prefix.known,false);
});

test('killing the sole attacker is a surviving line even with no block',()=>{
  const s=state({player:{hp:6,block:0,energy:3,hand:[card(0,'打击: 造成9点伤害。')]},
    battle:{enemies:[enemy({hp:9,block:0,intents:[{type:'Attack',label:'9'}]})]}});
  const play=option(0,'打击: 造成9点伤害。 -> E (9 HP)',{target:'E_0'});
  const projected=projectPlay(s,play);
  assert.equal(projected.kills,1);
  assert.equal(projected.survives,true);
  assert.equal(incomingAttacks(projected.next).total,0);
});
