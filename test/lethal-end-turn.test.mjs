import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createController} from '../src/controller.mjs';

test('a high-confidence lethal end-turn proposal is rejected and not sampled again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spire-end-turn-'));let asks=0,sends=0;
 const state={state_type:'monster',run:{act:1,floor:3,ascension:0},
 player:{hp:4,max_hp:80,energy:2,block:0,status:[],relics:[],potions:[],
 hand:[15,16].map((block,index)=>({id:`BLOCK_${index}`,index,name:`防御${index}`,type:'Skill',cost:'1',can_play:true,target_type:'Self',description:`获得${block}点格挡。`}))},
 battle:{round:1,turn:'player',ready_for_action:true,action_running:false,action_queue_empty:true,
 enemies:[{entity_id:'E',combat_id:1,hp:40,block:0,status:[],intents:[{type:'Attack',label:'8'}]}]}};
 const game={read:async()=>structuredClone(state),settled:async()=>structuredClone(state),send:async()=>{sends++;throw Error('must not send');}};
 const controller=createController({runtimeDir:dir,controlDir:join(dir,'control'),openGame:()=>game,
 decide:async(s,options,extra)=>{asks++;const option=options.find(o=>o.command.action==='end_turn');
 const candidate=extra.candidates.find(c=>c.option_id===option.id);
 assert.equal(candidate.survives,false);
 return{option,candidate,answer:{choice:candidate.id,confidence:.99},requests:1,usage:{input_tokens:1,output_tokens:1}};}});
 try{
 const initial=await controller.state();
 const config={expectedStateId:initial.state_id,strategy:{conditions:[{kind:'hp_at_least',value:4}],order:[{match:'防御'}]}};
 assert.match((await controller.battle(1,config)).reason,/dies/);
 assert.equal((await controller.battle(1,config)).reason,'repeated_state');
 assert.equal(asks,1);assert.equal(sends,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
