import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actions} from '../src/game.mjs';

// A potion reward cannot be claimed into a full belt, and the rewards screen
// offers nothing else that frees a slot, so the run stops there with a reward it
// can neither take nor decline. The bridge can discard a potion anywhere - it is
// a plain PotionCmd.Discard with no combat requirement - so the only missing
// piece was advertising it. Found by walking into exactly that dead end.

const rewards=(potions,max)=>({state_type:'rewards',run:{act:1,floor:11,ascension:0},
  player:{hp:62,max_hp:80,gold:69,potions,max_potion_slots:max,relics:[]},
  rewards:{items:[{index:0,type:'potion',description:'痊愈药水'}],can_proceed:true}});
const potion=slot=>({id:'P',name:`Potion ${slot}`,description:'x',slot,can_use_in_combat:true,target_type:'AnyPlayer'});

test('a full belt is escapable outside combat',()=>{
  const options=actions(rewards([potion(0),potion(1),potion(2)],3));
  const discards=options.filter(o=>o.command.action==='discard_potion');
  assert.equal(discards.length,3,'every slot is offered');
  assert.deepEqual(discards.map(o=>o.command.slot),[0,1,2]);
  assert.match(discards[0].label,/free a slot/,'the label says why the option exists');
  assert.ok(options.some(o=>o.command.action==='claim_reward'),'the reward is still offered');
  assert.ok(options.some(o=>o.command.action==='proceed'),'leaving is still offered');
});

test('a belt with room keeps other screens clean',()=>{
  const options=actions(rewards([potion(0)],3));
  assert.equal(options.filter(o=>o.command.action==='discard_potion').length,0,
    'discarding is only advertised when it is the thing standing in the way');
});

test('the map screen offers no potion options until the belt is full',()=>{
  const map={state_type:'map',run:{act:1,floor:11,ascension:0},
    player:{hp:62,max_hp:80,potions:[potion(0)],max_potion_slots:3,relics:[]},
    map:{nodes:[],current_position:{col:0,row:11},next_options:[{index:0,col:0,row:12,type:'RestSite'}]}};
  assert.equal(actions(map).filter(o=>o.command.action.includes('potion')).length,0);
  const full=actions({...map,player:{...map.player,potions:[potion(0),potion(1),potion(2)]}});
  assert.equal(full.filter(o=>o.command.action==='discard_potion').length,3);
});

test('in combat the potion options stay the usable ones',()=>{
  const combat={state_type:'monster',run:{act:1,floor:11,ascension:0},
    player:{hp:62,max_hp:80,potions:[potion(0),potion(1),potion(2)],max_potion_slots:3,
      hand:[],energy:3,max_energy:3,block:0,relics:[]},
    battle:{round:1,turn:1,ready_for_action:true,action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:10,max_hp:10,block:0,status:[],intents:[{type:'Attack',label:'5'}]}]}};
  const options=actions(combat);
  assert.equal(options.filter(o=>o.command.action==='discard_potion').length,0,
    'in combat you use a potion, you do not throw it away');
  assert.equal(options.filter(o=>o.command.action==='use_potion').length,3);
});
