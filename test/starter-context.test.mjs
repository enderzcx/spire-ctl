import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectPlay,projectPrefix} from '../src/combat.mjs';
import {buildInput} from '../src/input.mjs';
const blood={id:'BURNING_BLOOD',name:'燃烧之血',description:'在战斗结束时，回复6点生命。'};
const state=()=>({state_type:'monster',player:{hp:38,max_hp:40,energy:3,block:0,status:[],relics:[blood],
 hand:[0,1].map(index=>({id:'STRIKE',index,name:'打击',description:'造成6点伤害。',cost:'1',star_cost:null}))},
 battle:{enemies:[{entity_id:'E',combat_id:1,hp:20,block:0,status:[],intents:[{type:'Attack',label:'6'}]}]}});
const option=index=>({id:String(index),command:{action:'play_card',card_index:index,target:'E'},label:'打击: 造成6点伤害。'});
test('observed starter relic allows modeled prefixes, with its victory heal explicitly projected',()=>{
 const s=state();assert.equal(projectPrefix(s,[option(0),option(1)]).known,true);
 s.battle.enemies[0].hp=6;const result=projectPlay(s,option(0));
 assert.equal(result.known,true);assert.equal(result.next.player.hp,40);assert.equal(result.expect.hp,40);
});
test('changed starter effect, unknown relic, and star cost never borrow exact projection',()=>{
 let s=state();s.player.relics=[{...blood,description:'每次攻击时失去2点生命。'}];assert.equal(projectPlay(s,option(0)).known,false);
 s=state();s.player.relics.push({id:'UNKNOWN_RELIC'});assert.equal(projectPlay(s,option(0)).known,false);
 s=state();s.player.hand[0].star_cost=2;assert.equal(projectPlay(s,option(0)).known,false);
});
test('single-action Jev retains descriptions of unmodeled modifiers instead of names alone',()=>{
 const s=state();s.player.status=[{id:'MYSTERY',name:'未知能力',amount:1,description:'每次出牌失去2点生命。'}];
 const input=buildInput(s,[option(0)]);
 assert.equal(input.options[0].computed,undefined);assert.equal(input.options[0].outcome.verified,false);
 assert.equal(input.state.player_statuses[0].description,s.player.status[0].description);
 assert.equal(input.state.relics[0].description,blood.description);
});

test('unknown intent remains a strategic stop even at low HP',async()=>{
 const {route}=await import('../src/game.mjs');const s=state();s.player.hp=8;
 s.battle.ready_for_action=true;s.battle.enemies[0].intents=[{type:'Unknown',label:'?'}];
 const result=route(s,[option(0)]);assert.equal(result.strategic,true);assert.match(result.reason,/Unrecognized/);
});

test('conditional live text cannot be stripped as a card name or replaced by a simpler label',async()=>{
 const {parseCompleteEffect}=await import('../src/combat.mjs');
 assert.equal(parseCompleteEffect('If injured: Gain 5 Block.').known,false);
 const s=state();s.player.hand[0].description='如果受伤: 造成6点伤害。';
 assert.equal(projectPlay(s,option(0)).known,false);
});
