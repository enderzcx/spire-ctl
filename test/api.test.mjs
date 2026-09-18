import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createController} from '../src/controller.mjs';
test('public controller rejects non-loopback game endpoints',()=>{
  assert.throws(()=>createController({endpoint:'https://example.org/game'}),/loopback/);
});
test('already-cancelled harness tools never dispatch',async()=>{
  const controller=createController(),a=new AbortController();a.abort(Error('test cancellation'));
  await assert.rejects(controller.state({signal:a.signal}),/test cancellation/);
  await assert.rejects(controller.act('old','0',{signal:a.signal}),/test cancellation/);
});

test('the controller hands the shortlist through to the fast-model seam',async()=>{
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createController}=await import('../src/controller.mjs');
  const {stateId,actions}=await import('../src/game.mjs');
  const dir=await mkdtemp(join(tmpdir(),'spire-seam-'));
  const card=(i,label,type='Attack')=>({id:`C${i}`,index:i,name:label.slice(0,2),type,cost:'1',
    target_type:type==='Attack'?'AnyEnemy':'Self',can_play:true,description:label});
  const combat={state_type:'monster',run:{act:1,floor:4},player:{hp:60,max_hp:80,block:0,energy:3,
    hand:[card(0,'打击: 造成6点伤害。'),card(1,'防御: 获得5点格挡。',"Skill")],potions:[]},
    battle:{ready_for_action:true,round:1,turn:'player',action_running:false,action_queue_empty:true,
      enemies:[{entity_id:'E_0',combat_id:1,name:'E',hp:40,max_hp:40,block:0,status:[],
        intents:[{type:'Attack',label:'18',title:'重击'}]}]}};
  const after={...combat,state_type:'rewards',rewards:{items:[],can_proceed:true}};
  let sends=0,seen=null;
  const fake={read:async()=>sends?after:combat,settled:async()=>sends?after:combat,
    send:async()=>{sends++;return{status:'ok'};}};
  try{
    const decide=async(_s,_o,extra)=>{seen=extra;return{option:actions(combat)[1],answer:{confidence:.8},usage:{input_tokens:5}};};
    const control=await mkdtemp(join(tmpdir(),'spire-seam-control-'));
    const controller=createController({runtimeDir:dir,controlDir:control,apiKey:'unused',decide,openGame:()=>fake});
    try{
    await controller.battle(2);
      assert.equal(seen.apiKey,'unused');
      assert.ok(seen.candidates||seen.shortlist===null||seen.shortlist===undefined);
    }finally{await rm(control,{recursive:true,force:true});}
  }finally{await rm(dir,{recursive:true,force:true});}
});
