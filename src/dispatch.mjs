// One send/HALTED transaction. Callers supply a completion observer.
// A thrown send error is not proof of no side effects; the halt stays.
import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {actions,inCombat,route,stateId,incomingDamage} from './game.mjs';
import {normalizeState} from './contract.mjs';

export const PROTOCOL=4;
export const CORE_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

export function envelope(state){
  const options=actions(state),incoming=inCombat(state)?incomingDamage(state):null;
  const attackGap=incoming===null?null:Math.max(0,incoming-(state.player?.block??0));
  // The state id stays a hash of exactly what the game reported; the copy handed
  // to consumers is normalised so every item names itself the same way.
  return {implementation:{core_version:CORE_VERSION,protocol:PROTOCOL},state_id:stateId(state),route:route(state,options),options,state:normalizeState(state),
    tactical_facts:inCombat(state)?{displayed_attack_damage:incoming,block_needed_for_displayed_attacks:attackGap,
      note:'Current displayed attacks only; excludes future card effects and end-turn triggers.'}:undefined};
}

export async function withLock(dir,fn){
  await mkdir(dir,{recursive:true});const lock=join(dir,'execution.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Another controller owns execution; do not run two agents at once');throw e;}
  try{return await fn();}finally{await rm(lock,{recursive:true});}
}

export function recorder(dir){return async data=>{await mkdir(dir,{recursive:true});await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),protocol:PROTOCOL,core_version:CORE_VERSION,...data})+'\n');};}

async function persistHalt(control,payload){
  await writeFile(join(control,'HALTED'),JSON.stringify(payload));
}

export async function assertClear(control){
  try{await readFile(join(control,'HALTED'));throw Error('Previous action outcome unknown: inspect game and clear the halt explicitly');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}

export async function dispatch(game,option,{control,record,source='planner',expectedId,observe,before,event='dispatch',details={}}={}){
  await record({...details,event,source,state_id:expectedId,option,before});
  await writeFile(join(control,'HALTED'),JSON.stringify({reason:'in_flight',expectedId,option}),{flag:'wx'});
  const start=performance.now();
  let receipt;
  try{
    receipt=await game.send(option.command);
  }catch(e){
    await persistHalt(control,{expectedId,option,reason:e.message});
    await record({event:'halted',source,reason:e.message});
    throw e;
  }
  try{
    const observed=await observe({receipt,option,started:start});
    if(observed?.ok){
      await rm(join(control,'HALTED'));
      return {receipt,action_ms:Math.round(performance.now()-start),...observed};
    }
    await persistHalt(control,{expectedId,option,reason:observed?.reason??'unconfirmed result'});
    await record({event:'halted',source,reason:observed?.reason??'unconfirmed result'});
    return {receipt,action_ms:Math.round(performance.now()-start),...observed};
  }catch(e){
    await persistHalt(control,{expectedId,option,reason:e.message});
    await record({event:'halted',source,reason:e.message});
    throw e;
  }
}

export async function execute(game,expectedId,optionId,{dir,control=dir,record=recorder(dir),source='planner'}={}){
  await assertClear(control);
  const before=await game.read();
  if(stateId(before)!==expectedId)throw Error('Stale state: refresh before choosing an action');
  const option=actions(before).find(o=>o.id===String(optionId));
  if(!option)throw Error('Action not advertised by this state');
  const result=await dispatch(game,option,{control,record,source,expectedId,before,observe:async({receipt,started})=>{
    const after=await game.settled(expectedId);
    await record({event:'verified',source,option,receipt,after,action_ms:Math.round(performance.now()-started)});
    return {ok:true,after};
  }});
  return {action_ms:result.action_ms,...envelope(result.after)};
}
