import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {actions,route,stateId,incomingDamage,createGame} from '../src/game.mjs';
import {execute,battle,withLock,envelope} from '../src/runner.mjs';
import {choose} from '../src/jev.mjs';

const s=()=>({state_type:'monster',run:{act:1,floor:4},battle:{ready_for_action:true,enemies:[{hp:12,entity_id:'E_0',name:'Enemy',intents:[{type:'Attack',label:'5'}]}]},player:{hp:40,max_hp:80,block:0,energy:3,hand:[{id:'STRIKE',index:0,can_play:true,target_type:'AnyEnemy',name:'Strike',description:'Deal 6 damage',cost:'1'}],potions:[]}});
const temporary=async fn=>{const dir=await mkdtemp(join(tmpdir(),'spire-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};

test('identical cards deduplicate without merging cost variants or dead targets',()=>{
  const x=s();x.player.hand.push({...x.player.hand[0],index:1});x.battle.enemies.push({hp:0,entity_id:'dead'});
  assert.equal(actions(x).length,2);x.player.hand[1].cost='0';assert.equal(actions(x).length,3);
});
test('busy states, curses and unfamiliar targeting cannot silently execute',()=>{
  const x=s();x.battle.ready_for_action=false;assert.deepEqual(actions(x),[]);
  x.battle.ready_for_action=true;x.player.hand[0].can_play=false;assert.equal(actions(x).length,1);
  x.player.hand[0].can_play=true;x.player.hand[0].target_type='AnyAlly';assert.throws(()=>actions(x),/Unsupported/);
});
test('all-enemy and single-enemy potions are both correctly advertised',()=>{
  const x=s();x.player.potions=[{slot:0,name:'Shackles',can_use_in_combat:true,target_type:'AllEnemies'},{slot:1,name:'Fire',can_use_in_combat:true,target_type:'AnyEnemy'},{slot:2,name:'Strength',can_use_in_combat:true,target_type:'AnyPlayer'}];
  assert.equal(actions(x).filter(a=>a.command.action==='use_potion').length,3);
});
test('routing covers normal, deterministic, low HP, unknown intent and lethal',()=>{
  const x=s();assert.equal(route(x).kind,'jev');x.player.hand=[];assert.equal(route(x).kind,'deterministic');
  x.player.hp=10;assert.equal(route(x).kind,'planner');x.player.hp=40;x.battle.enemies[0].intents[0].label='?';assert.equal(route(x).kind,'planner');
  x.battle.enemies[0].intents[0].label='21×2';assert.equal(incomingDamage(x),42);assert.equal(route(x).kind,'planner');
});
test('planner facts distinguish a numeric block gap from unknown damage',()=>{
  const x=s();x.battle.enemies[0].intents[0].label='15';x.player.block=10;
  assert.equal(envelope(x).tactical_facts.block_needed_for_displayed_attacks,5);
  x.battle.enemies[0].intents[0].label='?';assert.equal(envelope(x).tactical_facts.block_needed_for_displayed_attacks,null);
});
test('potion review is requested before significant unblocked end-turn damage',()=>{
  const x=s();x.player.hand=[];x.battle.enemies[0].intents[0].label='11';x.player.potions=[{slot:0,can_use_in_combat:true,target_type:'AllEnemies'}];
  assert.equal(route(x).kind,'planner');x.player.block=11;assert.equal(route(x).kind,'deterministic');
});
test('new rewards and hand shifts invalidate old state identifiers',()=>{
  const x=s(),before=stateId(x);x.player.hand[0].index=2;assert.notEqual(stateId(x),before);
  const r={state_type:'rewards',rewards:{items:[]}},id=stateId(r);r.rewards.items.push({index:0,type:'gold'});assert.notEqual(stateId(r),id);
});
test('card-selection overlays expose picks and only valid confirmation actions',()=>{
  const x={state_type:'card_select',card_select:{cards:[{index:2,name:'Headbutt',description:'Deal 9'}],can_confirm:false,can_skip:true}};
  assert.deepEqual(actions(x).map(a=>a.command.action),['select_card','cancel_selection']);
  x.card_select.preview_showing=true;x.card_select.can_confirm=true;
  assert.deepEqual(actions(x).map(a=>a.command.action),['confirm_selection','cancel_selection']);
});
test('disabled rest and unaffordable purchases are omitted; shop exit closes inventory',()=>{
  assert.deepEqual(actions({state_type:'rest_site',rest_site:{options:[{index:0,is_enabled:false},{index:1,is_enabled:true}]}}).map(o=>o.command.index),[1]);
  const x={state_type:'shop',player:{gold:100},shop:{items:[{index:0,price:50,is_stocked:true,can_afford:false}],can_proceed:false}};
  assert.deepEqual(actions(x).map(a=>a.command.action),['proceed']);x.shop.items[0].can_afford=true;assert.equal(actions(x).length,2);
});
test('stale planner action never reaches the game',()=>temporary(async dir=>{
  let sent=0;await assert.rejects(execute({read:async()=>s(),send:async()=>sent++},'old','0',{dir}),/Stale/);assert.equal(sent,0);
}));
test('lost acknowledgement halts persistently and never retries',()=>temporary(async dir=>{
  let sent=0;const x=s(),game={read:async()=>x,send:async()=>{sent++;throw Error('timeout');}};
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/timeout/);
  assert.match(await readFile(join(dir,'HALTED'),'utf8'),/timeout/);
  await assert.rejects(execute(game,stateId(x),'0',{dir}),/Previous action/);assert.equal(sent,1);
}));
test('in-flight record exists before dispatch and clears only after readback',()=>temporary(async dir=>{
  const x=s(),after=s();after.player.energy=2;
  let inspected=false;
  const game={read:async()=>x,send:async()=>{const mark=JSON.parse(await readFile(join(dir,'HALTED'),'utf8'));assert.equal(mark.reason,'in_flight');inspected=true;return{status:'ok'};},settled:async()=>after};
  await execute(game,stateId(x),'0',{dir});assert.equal(inspected,true);await assert.rejects(readFile(join(dir,'HALTED')),{code:'ENOENT'});
}));
test('second writer cannot take the game lock',()=>temporary(async dir=>{
  await withLock(dir,async()=>{await assert.rejects(withLock(dir,async()=>{}),/Another controller/);});
  await withLock(dir,async()=>{});
}));
test('one playable card still competes with end turn, so the adapter is asked',()=>temporary(async dir=>{
  let sent=0,sends=0,decideCalls=0;const x=s(),after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:x.run,player:x.player};
  const game={read:async()=>sends?after:x,settled:async()=>sends?after:x,send:async()=>{sends++;sent++;return{status:'ok'};}};
  const r=await battle(game,async(_st,offered)=>{decideCalls++;return{option:offered[0],answer:{confidence:.9},requests:1};},{dir,max:2});
  assert.equal(decideCalls,1);assert.equal(sent,1);assert.equal(r.reason,'left_combat');
}));

test('low confidence over a real choice returns a planner packet',()=>temporary(async dir=>{
  // Two playable cards and 30 incoming damage that neither can cover: there is
  // a genuine choice the program refuses to make, so the planner gets it.
  let sent=0;const x=s();
  x.battle.enemies[0].hp=20;x.battle.enemies[0].intents[0].label='30';
  x.player.hand=[{...x.player.hand[0],index:0},{...x.player.hand[0],index:1,id:'STRIKE2'}];
  const game={settled:async()=>x,send:async()=>sent++};
  const r=await battle(game,async()=>({option:actions(x)[0],answer:{confidence:.2},usage:{input_tokens:10}}),{dir});
  assert.equal(r.reason,'low_confidence');assert.equal(sent,0);
}));
test('battle stops on rewards instead of entering the next room',()=>temporary(async dir=>{
  const x=s(),after={state_type:'rewards',rewards:{items:[],can_proceed:true},run:x.run,player:x.player};let sent=0,reads=0;
  const game={read:async()=>x,settled:async()=>reads++?after:x,send:async()=>{sent++;return{status:'ok'};}};
  const r=await battle(game,async()=>({option:actions(x)[0],answer:{confidence:.9}}),{dir});assert.equal(r.reason,'left_combat');assert.equal(sent,1);
}));
test('remote bridge and game-level errors fail closed',async()=>{
  assert.throws(()=>createGame('https://example.org'),/loopback/);
  const game=createGame(undefined,async()=>({ok:true,json:async()=>({status:'error',message:'illegal'})}));await assert.rejects(game.send({action:'end_turn'}),/illegal/);
});
test('provider cannot inject commands and receives only explicit state/options',async()=>{
  let body;const options=actions(s());
  const fake=async(_url,init)=>{body=JSON.parse(init.body);return{ok:true,json:async()=>({answers:{next:{choice:'not-an-option',confidence:1}}})};};
  await assert.rejects(choose(s(),options,{apiKey:'fake-test-key',fetcher:fake}),/Invalid/);
  // body.state is the whole projection: a nested `state` plus the advertised
  // options and, when one is in force, the agreed strategy.
  const payload=body.state;
  assert.ok(payload?.state,'request must carry a state projection');
  // The model sees a filtered projection with the program's computed numbers and
  // the advertised options, never a raw game payload, never a command, never the
  // credential.
  assert.equal(payload.state.computed.hp,40);
  assert.equal(payload.state.computed.energy,3);
  assert.equal(payload.state.computed.incoming_attack_total,5);
  assert.equal(payload.state.enemies[0].id,'E_0');
  assert.equal(payload.state.hand[0].id,'STRIKE');
  assert.equal(payload.state.hand[0].known,true);
  assert.equal(payload.options[0].action,'play_card');
  assert.equal(payload.options.some(option=>option.command!==undefined),false);
  assert.equal(JSON.stringify(body).includes('fake-test-key'),false);
  assert.equal(JSON.stringify(body).includes('"command"'),false);
  assert.equal(body.questions.next.type,'choice');
});

test('menu options expose the supported new-run path and refuse destructive ones',()=>{
  const main={state_type:'menu',menu_screen:'main',options:['continue','abandon_run','singleplayer','multiplayer','compendium','timeline','settings','quit']};
  assert.deepEqual(actions(main).map(a=>a.command.option),['continue','singleplayer','compendium','settings']);
  const mode={state_type:'menu',menu_screen:'singleplayer',options:[{name:'standard',enabled:true},{name:'daily',enabled:false},{name:'custom',enabled:false},{name:'back',enabled:true}]};
  assert.deepEqual(actions(mode).map(a=>a.command.option),['standard','back']);
  const pick={state_type:'menu',menu_screen:'character_select',options:[
    {name:'IRONCLAD',enabled:true},{name:'SILENT',enabled:true},{name:'REGENT',enabled:false},
    {name:'confirm',enabled:true},{name:'embark',enabled:true},{name:'back',enabled:true}]};
  assert.deepEqual(actions(pick).map(a=>a.command.option),['IRONCLAD','SILENT','confirm','embark','back']);
  // A disabled character is never advertised.
  assert.ok(!actions(pick).some(a=>a.command.option==='REGENT'));
});
test('rewards advertise claims first and mark an unclaimed exit',()=>{
  const r={state_type:'rewards',run:{act:1,floor:1},player:{hp:70,gold:0},rewards:{items:[
    {index:0,type:'gold',description:'14 gold'},{index:1,type:'card',description:'add a card'}],can_proceed:true}};
  const list=actions(r);
  assert.deepEqual(list.map(a=>a.command.action),['claim_reward','claim_reward','proceed']);
  assert.match(list.at(-1).label,/without claiming/);
  const empty={...r,rewards:{items:[],can_proceed:true}};
  assert.deepEqual(actions(empty).map(a=>a.command.action),['proceed']);
  assert.equal(actions(empty)[0].label,'Proceed');
});
test('a finished run offers only the return to the main menu',()=>{
  const over={state_type:'game_over',run:{act:1,floor:11},player:{hp:0,max_hp:80},
    game_over:{message:'Run ended.',options:['main_menu']}};
  const list=actions(over);
  assert.deepEqual(list.map(a=>a.command.action),['menu_select']);
  assert.equal(list[0].command.option,'main_menu');
  assert.equal(actions({...over,game_over:{options:[]}}).length,0);
});
test('an unchanged visible state after dispatch is unknown and cannot be resent',()=>temporary(async dir=>{
  const control=await mkdtemp(join(tmpdir(),'spire-control-'));
  const x=s();
  let sent=0;
  const game={read:async()=>x,settled:async()=>{throw Error('No settled state transition; do not repeat the action');},
    send:async()=>{sent++;return{status:'ok'};}};
  try{
    await assert.rejects(execute(game,stateId(x),'0',{dir,control}),/No settled state transition/);
    await assert.rejects(execute(game,stateId(x),'0',{dir,control}),/outcome unknown/);
    assert.equal(sent,1);
  }finally{await rm(control,{recursive:true,force:true});}
}));

test('an unverifiable failure still halts and refuses the next action',()=>temporary(async dir=>{
  const control=await mkdtemp(join(tmpdir(),'spire-control-'));
  const x=s();
  const game={read:async()=>x,settled:async()=>{throw Error('timeout');},send:async()=>({status:'ok'})};
  try{
    await assert.rejects(execute(game,stateId(x),'0',{dir,control}),/timeout/);
    await assert.rejects(execute({...game,settled:async()=>x},stateId(x),'0',{dir,control}),/outcome unknown/);
  }finally{await rm(control,{recursive:true,force:true});}
}));

test('an action records who decided it, so agent moves are not counted as takeovers',()=>temporary(async dir=>{
  const x=s();
  const game={read:async()=>x,settled:async()=>x,send:async()=>({status:'ok'})};
  await execute(game,stateId(x),'0',{dir,source:'agent'});
  const rows=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(rows.find(row=>row.event==='dispatch').source,'agent');
  assert.equal(rows.find(row=>row.event==='verified').source,'agent');
}));
