import {actions,inCombat,stateId} from './game.mjs';
import {envelope,withLock,recorder,PROTOCOL,CORE_VERSION,execute} from './dispatch.mjs';
import {loadStrategy,seenHandoff,noteHandoff,guardSignature,noteGuard,strategyApplies,handoffKey} from './strategy.mjs';
import {mechanicalPlan} from './mechanical.mjs';
import {decideCombat} from './decision.mjs';
import {runPlan} from './plan.mjs';
import {JEV_MODEL} from './jev.mjs';

export {envelope,withLock,recorder,PROTOCOL,CORE_VERSION,execute};

export async function battle(game,decide,{dir,control=dir,max=60,record=recorder(dir),
  strategy=null,expectedStateId=null}={}){
  if(!Number.isInteger(max)||max<1||max>100)throw Error('max must be 1..100');
  let s=await game.settled(),tokens=0,steps=0;const room=JSON.stringify(s.run);
  const openingId=stateId(s);
  let agreed=null;
  if(strategy){
    if(!expectedStateId)throw Error('In-call strategy requires expectedStateId');
    if(expectedStateId!==openingId)throw Error('Strategy expectedStateId does not match live state');
    agreed={...strategy,in_call:true,expected_state_id:openingId};
    const applied=strategyApplies(agreed,s,{inCall:true});
    if(!applied.ok)return {reason:`invalid strategy: ${applied.reason}`,steps:0,...envelope(s),
      instruction:'Return a decision, or a strategy with explicit conditions and expiry'};
  }else{
    agreed=await loadStrategy(dir,s);
  }
  for(;steps<max;steps++){
    const env=envelope(s);
    if(!inCombat(s)||JSON.stringify(s.run)!==room)return {reason:'left_combat',steps,...env};
    if(env.route.kind==='wait')throw Error('Unexpected busy state');
    if(tokens>=100000)return {reason:'token_budget',steps,...env};
    if(agreed){
      const applied=strategyApplies(agreed,s,{inCall:agreed.in_call===true});
      if(!applied.ok){
        await record({event:'takeover',source:'planner',reason:`invalid strategy: ${applied.reason}`,
          state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}}});
        return {reason:`invalid strategy: ${applied.reason}`,steps,...env,
          instruction:'Return a decision, or a strategy with explicit conditions and expiry'};
      }
    }
    const start=performance.now();
    const key=handoffKey(env.state_id,agreed,{protocol:`${PROTOCOL}:${CORE_VERSION}:${JEV_MODEL}`});
    const prior=await seenHandoff(dir,key);
    let decision;
    try{
      decision=await decideCombat({state:s,options:env.options,route:env.route,strategy:agreed,
        ask:decide,priorHandoff:prior,remainingSteps:max-steps});
    }catch(error){
      const requests=Number(error.requests??1);
      await record({event:'ask',source:'jev',state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},requests,
        usage:error.usage??{unavailable:true},error:error.message});
      throw error;
    }
    if(decision.usage&&!decision.usage.unavailable)tokens+=Number(decision.usage.input_tokens??0);
    if(decision.requests)await record({event:'ask',source:'jev',state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},
      requests:decision.requests,confidence:decision.proposal?.answer?.confidence??null,
      playable_cards:env.options.filter(o=>o.command.action==='play_card').length,
      usage:decision.usage,planned:decision.kind==='execute_prefix'});
    if(decision.proposal)await record({event:'decision',source:'jev',state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},...decision.proposal,
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
      if(decision.requests>0||decision.reason==='low_confidence'||decision.reason==='low_confidence_candidate'||decision.reason==='repeated_state'){
        const noted=await noteHandoff(dir,key,decision.reason);
        await record({event:'takeover',source:'planner',reason:decision.reason,state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},
          repeat_count:noted.count,confidence:decision.proposal?.answer?.confidence??null});
        return {reason:decision.reason,proposal:decision.proposal,steps,...env,repeat_count:noted.count,
          instruction:decision.instruction??'Return a decision, or a strategy with explicit conditions and expiry'};
      }
      await record({event:'takeover',source:'planner',reason:decision.reason,state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},
        confidence:decision.proposal?.answer?.confidence??null});
      return {reason:decision.reason,steps,...env,instruction:decision.instruction,
        guard:decision.guard,attrition:decision.attrition,proposal:decision.proposal,
        local_evidence:decision.local_evidence};
    }
    if(decision.local)await record({event:'local_decision',source:'local',state_id:env.state_id,state:{run:s.run,battle:{round:s.battle?.round}},
      kind:decision.local.kind,reason:decision.reason,evidence:decision.local.evidence,option:decision.option,
      line:decision.local.kind==='kill'?(decision.local.options??[]).map(o=>o.label):undefined});
    if(decision.kind==='execute_prefix'){
      const result=await runPlan(game,decision.plan,{dir,control,record,source:decision.source});
      const dispatched=result.dispatched??result.completed??decision.plan.steps.length;
      const confirmed=result.confirmed??(result.reason==='plan_complete'?dispatched:Math.max(0,(result.completed??1)-1));
      await record({event:'cycle',source:decision.source,total_ms:Math.round(performance.now()-start),
        prefix_steps:decision.plan.steps.length,reason:result.reason,decision_source:decision.source,
        dispatched,confirmed});
      steps+=Math.max(0,dispatched-1);
      if(result.reason!=='plan_complete')
        return {reason:result.reason,steps,completed:result.completed,dispatched,confirmed,
          candidate:decision.candidate,...envelope(result.state??s)};
      s=result.state;continue;
    }
    const next=await execute(game,env.state_id,decision.option.id,{dir,control,record,source:decision.source});
    await record({event:'cycle',source:decision.source,total_ms:Math.round(performance.now()-start),
      action_ms:next.action_ms,decision_source:decision.source});
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

// A planned sequence of already-decided moves, executed with the same verified
// transaction as `act`.
//
// This is not a model call and not a prediction: the caller states which moves
// it intends, and each one is re-read from a settled state, matched against the
// options the game actually advertises, and only then sent. A step that is no
// longer advertised - because a card left the hand, the target died, or the
// state changed under it - stops the sequence before anything is played. The
// caller keeps the decision; the program keeps the legality check.
export async function sequence(game,steps,{dir,control=dir,max=12,record=recorder(dir),source='caller',
  expectedStateId=null}={}){
  if(!Array.isArray(steps)||!steps.length)throw Error('steps must be a non-empty array');
  if(steps.length>max)throw Error(`steps must be 1..${max}`);
  let s=await game.settled();
  if(expectedStateId&&expectedStateId!==stateId(s))
    throw Error('Sequence expectedStateId does not match the live state');
  const room=JSON.stringify(s.run),performed=[];
  for(const [index,step] of steps.entries()){
    const env=envelope(s);
    if(!inCombat(s)||JSON.stringify(s.run)!==room)
      return {reason:'left_combat',steps:index,performed,...env};
    const options=actions(s);
    // A step is a selector over the command the game advertises, so a shifted
    // hand index or a dead target cannot silently select a different card.
    const option=options.find(candidate=>Object.entries(step).every(([key,value])=>
      key==='id'?candidate.id===value:JSON.stringify(candidate.command?.[key])===JSON.stringify(value)));
    if(!option)
      return {reason:'step_not_advertised',steps:index,performed,...env,
        unmatched:step,
        advertised:options.map(candidate=>({id:candidate.id,command:candidate.command,label:String(candidate.label).slice(0,60)})),
        instruction:'The stated move is not advertised in the settled state; re-read and decide again'};
    const next=await execute(game,stateId(s),option.id,{dir,control,record,source});
    performed.push({step:index,action:option.command.action,label:String(option.label).slice(0,60),
      state_id:stateId(next.state)});
    s=next.state;
  }
  return {reason:'sequence_done',steps:steps.length,performed,...envelope(s)};
}
