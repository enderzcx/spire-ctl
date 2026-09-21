import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stateId,stableShape} from '../src/game.mjs';

// The transform screen cycles its "what this card would become" preview on every
// read. Hashing the whole state made the id move while the screen sat idle, so
// the settle check compared two ids that could never match and halted with "no
// settled state transition" - and the halt could not be cleared either, because
// clearing needs an id that matches and the id moved underneath it. Found live on
// a transform event, where it deadlocked the run.

const transform=preview=>({state_type:'card_select',run:{act:2,floor:21,ascension:0},
  player:{hp:74,max_hp:80,gold:200,potions:[],relics:[]},
  card_select:{screen_type:'transform',prompt:'选择1张牌来变化。',can_confirm:true,can_cancel:true,
    selected_count:1,selected_indices:[0],preview_showing:true,
    preview_cards:[{id:preview,name:preview,type:'Attack',cost:'1',description:'x'}],
    cards:[{index:0,id:'STRIKE_IRONCLAD',name:'打击',type:'Attack',cost:'1',description:'造成6点伤害。'}]}});

test('a cycling live preview does not move the state identity',()=>{
  const a=stateId(transform('PILLAGE'));
  const b=stateId(transform('NOT_YET'));
  assert.equal(a,b,'the preview is painting, not state');
});

test('the selection itself still moves the state identity',()=>{
  const before=stateId(transform('PILLAGE'));
  const selected=transform('PILLAGE');
  selected.card_select.selected_indices=[1];
  selected.card_select.selected_count=1;
  assert.notEqual(before,stateId(selected),'picking a different card is a real change');
  const unselected=transform('PILLAGE');
  unselected.card_select.selected_indices=[];
  unselected.card_select.selected_count=0;
  assert.notEqual(before,stateId(unselected),'clearing the selection is a real change');
});

test('the identity is still built from the real game state',()=>{
  const a=transform('PILLAGE');
  const b=transform('PILLAGE');
  b.player.hp=73;
  assert.notEqual(stateId(a),stateId(b),'health is part of the identity');
  const c=transform('PILLAGE');
  c.run.floor=22;
  assert.notEqual(stateId(a),stateId(c),'the floor is part of the identity');
});

test('stripping previews leaves the caller-visible state otherwise intact',()=>{
  const stripped=stableShape(transform('PILLAGE'));
  assert.equal(stripped.card_select.preview_cards,undefined);
  assert.equal(stripped.card_select.preview_showing,undefined);
  assert.deepEqual(stripped.card_select.cards,transform('PILLAGE').card_select.cards);
  assert.equal(stripped.card_select.can_confirm,true);
  // A state without those fields is returned as-is, and never mutated.
  const plain={state_type:'map',run:{act:2,floor:21}};
  assert.equal(stableShape(plain),plain);
});
