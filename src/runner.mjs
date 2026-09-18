import {mkdir,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {actions,inCombat,route,stateId,incomingDamage} from './game.mjs';
import {loadStrategy,seenHandoff,noteHandoff,guardSignature,noteGuard} from './strategy.mjs';
import {mechanicalPlan} from './mechanical.mjs';
import {decideCombat} from './decision.mjs';
import {runPlan} from './plan.mjs';

export function envelope(state){
  const options=actions(state),incoming=inCombat(state)?incomingDamage(state):null;
  const attackGap=incoming===null?null:Math.max(0,incoming-(state.player?.block??0));
  return {state_id:stateId(state),route:route(state,options),options,state,
    tactical_facts:inCombat(state)?{displayed_attack_damage:incoming,block_needed_for_displayed_attacks:attackGap,
      note:'Current displayed attacks only; excludes future card effects and end-turn triggers.'}:undefined};
}

export async function withLock(dir,fn){
  await mkdir(dir,{recursive:true});const lock=join(dir,'execution.lock');
  try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw Error('Another controller owns execution; do not run two agents at once');throw e;}
  try{return await fn();}finally{await rm(lock,{recursive:true});}
}

export const PROTOCOL=3;
export function recorder(dir){return async data=>{await mkdir(dir,{recursive:true});await appendFile(join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),protocol:PROTOCOL,...data})+'\n');};}

export function isRejectedReceipt(error){
  return /Game rejected request:/.test(error?.message??'');
}

async function persistHalt(control,payload){
  await writeFile(join(control,'HALTED'),JSON.stringify(payload));
}

export async function execute(game,expectedId,optionId,{dir,control=dir,record=recorder(dir),source='planner'}={}){
  try{await readFile(join(control,'HALTED'));throw Error('Previous action outcome unknown: inspect game and clear the halt explicitly');}catch(e){if(e.code!=='ENOENT')throw e;}
  const before=await game.read();
  if(stateId(before)!==expectedId)throw Error('Stale state: refresh before choosing an action');
  const option=actions(before).find(o=>o.id===String(optionId));
  if(!option)throw Error('Action not advertised by this state');
  await record({event:'dispatch',source,state_id:expectedId,option,before});
  await writeFile(join(control,'HALTED'),JSON.stringify({reason:'in_flight',expectedId,option}),{flag:'wx'});
  const start=performance.now();
  let receipt;
  try{
    receipt=await game.send(option.command);
  }catch(e){
    if(isRejectedReceipt(e)){
      await rm(join(control,'HALTED'));
      await record({event:'rejected',source,option,reason:e.message});
      throw e;
    }
    await persistHalt(control,{expectedId,option,reason:e.message});
    await record({event:'halted',source,reason:e.message});
    throw e;
  }
  try{
    const after=await game.settled(expectedId);
    const action_ms=Math.round(performance.now()-start);
    await record({event:'verified',source,option,receipt,after,action_ms});
    await rm(join(control,'HALTED'));
    return {action_ms,...envelope(after)};
  }catch(e){
    await persistHalt(control,{expectedId,option,reason:e.message});
    await record({event:'halted',source,reason:e.message});
    throw e;
  }
}

export async function battle(game,decide,{dir,control=dir,max=60,record=recorder(dir)}={}){
  if(!Number.isInteger(max)||max<1||max>100)throw Error('max must be 1..100');
  let s=await game.settled(),tokens=0,steps=0;const room=JSON.stringify(s.run);
  let round=s.battle?.round??null,actedThisRound=false;
  const agreed=await loadStrategy(dir,s);
  for(;steps<max;steps++){
    const env=envelope(s);
    if(!inCombat(s)||JSON.stringify(s.run)!==room)return {reason:'left_combat',steps,...env};
    if(s.battle?.round!==round){round=s.battle?.round??null;actedThisRound=false;}
    if(env.route.kind==='wait')throw Error('Unexpected busy state');
    if(tokens>=100000)return {reason:'token_budget',steps,...env};
    const start=performance.now();
    const prior=await seenHandoff(dir,env.state_id);
    const decision=await decideCombat({state:s,options:env.options,route:env.route,strategy:agreed,
      ask:decide,priorHandoff:prior,actedThisRound});
    tokens+=Number(decision.usage?.input_tokens??0);
    if(decision.requests)await record({event:'ask',source:'jev',state_id:env.state_id,
      requests:decision.requests,confidence:decision.proposal?.answer?.confidence??null,
      playable_cards:env.options.filter(o=>o.command.action==='play_card').length,
      planned:decision.kind==='execute_prefix'});
    if(decision.proposal)await record({event:'decision',source:'jev',state_id:env.state_id,...decision.proposal,
      playable_cards:env.options.filter(o=>o.command.action==='play_card').length,
      decision_source:decision.source});
    if(decision.kind==='handoff'){
      if(decision.guard){
        const {repeated}=await noteGuard(dir,decision.guard,guardSignature(s));
        if(repeated){
          await record({event:'guard_repeat',source:'program',guard:decision.guard,
            signature:guardSignature(s),state_type:s.state_type});
          return {reason:`${decision.reason} (already reported)`,steps,...env,guard:decision.guard,
            guard_repeated:true,
            instruction:'This guard state was already reported; return a decision or a strategy with explicit conditions and expiry so the loop can continue'};
        }
      }
      if(decision.reason==='low_confidence'||decision.reason==='low_confidence_candidate'||decision.reason==='repeated_state'){
        const noted=await noteHandoff(dir,env.state_id,decision.reason);
        await record({event:'takeover',source:'planner',reason:decision.reason,state_id:env.state_id,
          repeat_count:noted.count,confidence:decision.proposal?.answer?.confidence??null});
        return {reason:decision.reason,proposal:decision.proposal,steps,...env,repeat_count:noted.count,
          instruction:decision.instruction??'Return a decision, or a strategy with explicit conditions and expiry'};
      }
      return {reason:decision.reason,steps,...env,instruction:decision.instruction,
        guard:decision.guard,attrition:decision.attrition,proposal:decision.proposal,
        local_evidence:decision.local_evidence};
    }
    if(decision.local)await record({event:'local_decision',source:'local',state_id:env.state_id,
      kind:decision.local.kind,reason:decision.reason,evidence:decision.local.evidence,option:decision.option,
      line:decision.local.kind==='kill'?(decision.local.options??[]).map(o=>o.label):undefined});
    if(decision.kind==='execute_prefix'){
      const result=await runPlan(game,decision.plan,{dir,control,record});
      await record({event:'cycle',source:decision.source,total_ms:Math.round(performance.now()-start),
        prefix_steps:decision.plan.steps.length,reason:result.reason,decision_source:decision.source});
      steps+=Math.max(0,(result.completed??1)-1);
      if(result.reason!=='plan_complete')
        return {reason:result.reason,steps,completed:result.completed,candidate:decision.candidate,...envelope(result.state??s)};
      s=result.state;actedThisRound=true;continue;
    }
    const next=await execute(game,env.state_id,decision.option.id,{dir,control,record,source:decision.source});
    await record({event:'cycle',source:decision.source,total_ms:Math.round(performance.now()-start),
      action_ms:next.action_ms,decision_source:decision.source});
    actedThisRound=decision.option?.command?.action!=='end_turn';
    s=next.state;
  }
  return {reason:'step_budget',steps,...envelope(s)};
}

export async function advance(game,{dir,control=dir,max=20,record=recorder(dir)}={}){
  if(!Number.isInteger(max)||max<1||max>50)throw Error('max must be 1..50');
  let s=await game.settled(),steps=0;
  for(;steps<max;steps++){
    const options=actions(s),plan=mechanicalPlan(s,options);
    if(!plan)return {reason:'needs_decision',steps,...envelope(s)};
    const option=plan.options[0];
    const next=await execute(game,stateId(s),option.id,{dir,control,record,source:'mechanical'});
    await record({event:'mechanical_step',source:'mechanical',reason:plan.reason,
      action:option.command.action,state_type:s.state_type});
    s=next.state;
    if(inCombat(s))return {reason:'combat_started',steps:steps+1,...envelope(s)};
  }
  return {reason:'step_budget',steps,...envelope(s)};
}
