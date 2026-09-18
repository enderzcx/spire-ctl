import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMechanical,mechanicalPlan} from '../src/mechanical.mjs';

const rewards=(items,player={})=>({state_type:'rewards',run:{act:1,floor:1},
  player:{hp:70,max_hp:80,gold:0,potions:[],max_potion_slots:3,...player},
  rewards:{items,can_proceed:true}});
const option=(action,extra={})=>({id:String(Math.random()),command:{action,...extra},label:action});

test('claiming gold and moving on is mechanical',()=>{
  const s=rewards([{index:0,type:'gold',description:'17 gold'}]);
  const plan=mechanicalPlan(s,[option('claim_reward',{index:0}),option('proceed')]);
  assert.ok(plan);
  assert.equal(plan.options[0].command.action,'claim_reward','claims come first');
});

test('a card reward is a decision, not a mechanical claim',()=>{
  const s=rewards([{index:0,type:'gold',description:'17 gold'},{index:1,type:'card',description:'add a card'}]);
  assert.equal(isMechanical(s,[option('claim_reward',{index:0}),option('proceed')]).mechanical,false);
});

test('a potion reward with a full belt needs a decision',()=>{
  const full={potions:[{name:'a',slot:0},{name:'b',slot:1},{name:'c',slot:2}],max_potion_slots:3};
  const s=rewards([{index:0,type:'potion',description:'Weak Potion'}],full);
  const verdict=isMechanical(s,[option('claim_reward',{index:0}),option('proceed')]);
  assert.equal(verdict.mechanical,false);
  assert.match(verdict.reason,/belt is full/);
});

test('a chest relic and an event trade both require decisions',()=>{
  const chest={state_type:'treasure',run:{act:1,floor:1},player:{hp:70,potions:[],max_potion_slots:3},
    treasure:{relics:[{index:0,name:'Orichalcum'}],can_proceed:false}};
  assert.equal(mechanicalPlan(chest,[option('claim_treasure_relic',{index:0})]),null);
  const event={state_type:'event',run:{act:1,floor:9},player:{hp:56,max_hp:80,potions:[],max_potion_slots:3},
    event:{in_dialogue:false,options:[{index:0,title:'eat'},{index:1,title:'search'}]}};
  const verdict=isMechanical(event,[option('choose_event_option',{index:0}),option('choose_event_option',{index:1})]);
  assert.equal(verdict.mechanical,false,'an event trade is a strategic choice');
});

test('map routing, card picks and shop purchases are decisions',()=>{
  assert.equal(isMechanical({state_type:'map',map:{next_options:[]}},[option('choose_map_node',{index:0})]).mechanical,false);
  assert.equal(isMechanical({state_type:'card_reward',card_reward:{cards:[]}},[option('select_card_reward',{card_index:0})]).mechanical,false);
  assert.equal(isMechanical({state_type:'shop',player:{gold:100},shop:{items:[]}},[option('shop_purchase',{index:0})]).mechanical,false);
  assert.equal(isMechanical({state_type:'rest_site',rest_site:{options:[]}},[option('choose_rest_option',{index:0})]).mechanical,false);
});

test('dialogue and menu plumbing are mechanical',()=>{
  const dialogue={state_type:'event',run:{act:1,floor:2},player:{hp:70,potions:[],max_potion_slots:3},event:{in_dialogue:true,options:[]}};
  assert.equal(mechanicalPlan(dialogue,[option('advance_dialogue')]).steps,1);
  const menu={state_type:'menu',menu_screen:'main',options:['continue']};
  assert.equal(mechanicalPlan(menu,[{id:'0',command:{action:'menu_select',option:'continue'},label:'Continue'}]).steps,1);
});

test('mechanical advance cannot embark into a new run or pick a dialogue option',()=>{
  assert.equal(mechanicalPlan({state_type:'menu'},[{id:'0',command:{action:'menu_select',option:'embark'}}]),null);
  assert.equal(mechanicalPlan({state_type:'event',event:{in_dialogue:true}},[option('advance_dialogue'),option('choose_event_option',{index:0})]),null);
});
