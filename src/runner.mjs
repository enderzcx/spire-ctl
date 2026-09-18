import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {actions,inCombat,route,stateId} from './game.mjs';

export function envelope(state){const options=actions(state);return {state_id:stateId(state),route:route(state,options),options,state};}

export async function withLock(dir,fn){
  await mkdir(dir,{recursive:true});const lock=join(dir,'execution.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Another controller owns execution; do not run two agents at once');throw e;}
  try{return await fn();}finally{await rm(lock,{recursive:true});}
}

export function recorder(dir){return async data=>{await mkdir(dir,{recursive:true});await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n');};}

export async function execute(game,expectedId,optionId,{dir,control=dir,record=recorder(dir),source='planner'}={}){
  try{await readFile(join(control,'HALTED'));throw Error('Previous action outcome unknown: inspect game and clear the halt explicitly');}catch(e){if(e.code!=='ENOENT')throw e;}
  const before=await game.read();
  if(stateId(before)!==expectedId)throw Error('Stale state: refresh before choosing an action');
  const option=actions(before).find(o=>o.id===String(optionId));
  if(!option)throw Error('Action not advertised by this state');
  await record({event:'dispatch',source,state_id:expectedId,option,before});
  await writeFile(join(control,'HALTED'),JSON.stringify({reason:'in_flight',expectedId,option}),{flag:'wx'});
  const start=performance.now();
  try{
    const receipt=await game.send(option.command);
    const after=await game.settled(expectedId);
    const action_ms=Math.round(performance.now()-start);
    await record({event:'verified',source,option,receipt,after,action_ms});
    await rm(join(control,'HALTED'));
    return {action_ms,...envelope(after)};
  }catch(e){
    await writeFile(join(control,'HALTED'),JSON.stringify({expectedId,option,reason:e.message}));
    await record({event:'halted',source,reason:e.message});throw e;
  }
}

export async function battle(game,decide,{dir,control=dir,max=60,record=recorder(dir)}={}){
  if(!Number.isInteger(max)||max<1||max>100)throw Error('max must be 1..100');
  let s=await game.settled(),tokens=0,steps=0;const room=JSON.stringify(s.run);
  for(;steps<max;steps++){
    const env=envelope(s);
    if(!inCombat(s)||JSON.stringify(s.run)!==room)return {reason:'left_combat',steps,...env};
    if(env.route.kind==='planner')return {reason:env.route.reason,steps,...env};
    if(env.route.kind==='wait')throw Error('Unexpected busy state');
    if(tokens>=100000)return {reason:'token_budget',steps,...env};
    const start=performance.now();let option=env.route.option,source='deterministic';
    if(env.route.kind==='jev'){
      const candidates=env.options.filter(o=>o.command.action!=='use_potion');
      const d=await decide(s,candidates);tokens+=d.usage?.input_tokens??0;
      await record({event:'decision',source:'jev',state_id:env.state_id,...d});
      if(d.answer.confidence<.5)return {reason:'low_confidence',proposal:d,steps,...env};
      option=d.option;source='jev';
    }
    const next=await execute(game,env.state_id,option.id,{dir,control,record,source});
    await record({event:'cycle',source,total_ms:Math.round(performance.now()-start),action_ms:next.action_ms});
    s=next.state;
  }
  return {reason:'step_budget',steps,...envelope(s)};
}
