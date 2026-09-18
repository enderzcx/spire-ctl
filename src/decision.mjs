// One tactical decision entry. Strategy constrains the menu; it does not pick.
import {stateId} from './game.mjs';
import {localPolicy,nextLocalPlay,attritionRisk} from './policy.mjs';
import {planCandidates,validateCandidate,candidateToPlan} from './planning.mjs';
import {strategyApplies,constrainOptions} from './strategy.mjs';
import {projectPrefix} from './combat.mjs';

const playableOf=options=>options.filter(option=>option.command?.action==='play_card');

export function confidenceGate(raw=process.env.SPIRE_PLAN_MIN_CONFIDENCE){
  const configured=Number(raw);
  if(Number.isFinite(configured)&&configured>=0&&configured<=1)return configured;
  return 0.5;
}

function handoff(reason,extra={}){
  return {kind:'handoff',reason,source:'planner',...extra};
}

function execute(option,source,reason,extra={}){
  return {kind:'execute',option,source,reason,...extra};
}

function prefixFrom(state,options,source,reason,extra={}){
  if(!options?.length)return null;
  if(options.length===1)return execute(options[0],source,reason,extra);
  const projected=projectPrefix(state,options);
  if(!projected.known)return execute(options[0],source,reason,extra);
  return {
    kind:'execute_prefix',
    plan:{state_id:stateId(state),steps:projected.steps.map(step=>{
      const out={card_index:step.card_index,expect:step.expect??{}};
      if(Number.isInteger(step.target_combat_id))out.target_combat_id=step.target_combat_id;
      return out;
    })},
    option:options[0],
    source,reason,...extra
  };
}

export async function decideCombat({state,options,route,strategy=null,ask=null,priorHandoff=null,
  remainingSteps=100}={}){
  if(route?.kind==='wait')return {kind:'wait',reason:route.reason,source:'program'};
  if(route?.kind==='deterministic'&&route.option)
    return execute(route.option,'deterministic',route.reason,{local:{kind:'end_turn',reason:route.reason}});

  const applied=strategy?strategyApplies(strategy,state,{inCall:strategy.in_call===true}):{ok:false};
  const guardKind=route?.kind==='planner'&&route.strategic===false?route.guard:null;

  if(route?.kind==='planner'&&route.strategic===true)
    return handoff(route.reason,{instruction:'Return a decision, or a strategy with explicit conditions and expiry'});

  if(guardKind&&!applied.ok)
    return handoff(route.reason,{guard:guardKind,
      instruction:'Return a decision, or a strategy with explicit conditions and expiry'});

  if(strategy&&!applied.ok)
    return handoff(`invalid strategy: ${applied.reason}`,
      {instruction:'Return a decision, or a strategy with explicit conditions and expiry'});

  const cards=playableOf(options);
  const endTurn=options.find(option=>option.command?.action==='end_turn');
  if(!cards.length&&endTurn)
    return execute(endTurn,'deterministic','No playable cards; no urgent potion decision',
      {local:{kind:'end_turn',reason:'No playable cards; no urgent potion decision'}});

  let menu=options.filter(option=>option.command?.action!=='use_potion');
  if(applied.ok){
    const constrained=constrainOptions(strategy,menu);
    if(!constrained.matched)
      return handoff('strategy matched none of the advertised options',
        {instruction:'Return a decision, or a strategy whose order matches a legal option'});
    menu=constrained.options;
  }

  const attrition=attritionRisk(state,menu);
  if(attrition)return handoff(attrition.reason,{attrition:attrition.evidence,
    instruction:'The displayed attack out-scales this hand; consider a potion, a different line, or accept the loss'});

  const policy=localPolicy(state,menu);
  if(policy.kind==='escalate')return handoff(policy.reason,{local_evidence:policy.evidence});
  if(policy.kind==='kill'&&policy.options.length<=remainingSteps){
    const line=prefixFrom(state,policy.options,'local',policy.reason,{local:policy});
    if(line)return line;
  }
  if(policy.kind==='play'||policy.kind==='guard')
    return execute(policy.option,'local',policy.reason,{local:policy});

  const finisher=nextLocalPlay(state,menu);
  if(finisher)return execute(finisher.option,'local',finisher.reason,{local:finisher});

  if(!ask)return handoff('No tactical adapter available');
  if(priorHandoff)return handoff('repeated_state',{
    instruction:'This exact state was already handed over; return a decision or a strategy',
    repeat_count:priorHandoff.count
  });

  const candidates=planCandidates(state,menu,{maxLength:remainingSteps});
  const useCandidates=candidates.length>=2;
  const gate=confidenceGate();
  let judgment;
  try{
    judgment=await ask(state,menu,policy.kind==='shortlist'?policy:null,
      {candidates:useCandidates?candidates:null,strategy:applied.ok?strategy:null});
  }catch(error){
    error.requests=Number(error.requests??1);
    if(!error.usage||error.usage.unavailable!==true)
      error.usage={unavailable:true};
    throw error;
  }
  const usage=judgment?.usage?.unavailable?{unavailable:true}
    :(judgment?.usage??{input_tokens:0,output_tokens:0});
  const requests=judgment?.requests??1;

  if(useCandidates){
    const choice=(()=>{
      if(judgment?.candidate?.id&&candidates.some(candidate=>candidate.id===judgment.candidate.id))
        return judgment.candidate.id;
      if(candidates.some(candidate=>candidate.id===judgment?.answer?.choice))return judgment.answer.choice;
      const optionId=judgment?.option?.id??judgment?.answer?.choice;
      return candidates.find(candidate=>candidate.option_id===optionId
        ||candidate.steps?.[0]?.option_id===optionId)?.id;
    })();
    const picked=validateCandidate(candidates,choice,applied.ok?strategy:null);
    if(!picked.candidate)
      return handoff(picked.why,{proposal:judgment,usage,requests,
        instruction:'Return a decision, or a strategy with explicit conditions and expiry'});
    const confidence=Number(judgment?.answer?.confidence);
    if(!Number.isFinite(confidence)||confidence<gate)
      return handoff('low_confidence_candidate',{proposal:{...judgment,candidate:picked.candidate,gate},usage,requests,
        instruction:'Return a decision, or a strategy with explicit conditions and expiry'});
    const plan=candidateToPlan(stateId(state),picked.candidate);
    if(picked.candidate.kind==='prefix'&&picked.candidate.steps.length>=2&&plan
      &&picked.candidate.steps.length<=remainingSteps)
      return {kind:'execute_prefix',plan,option:judgment.option,source:'jev',reason:picked.why,
        candidate:picked.candidate,proposal:judgment,usage,requests};
    const option=menu.find(entry=>entry.id===picked.candidate.option_id
      ||entry.id===picked.candidate.steps[0]?.option_id)??judgment.option;
    if(!option)return handoff('choice is not an advertised option',{proposal:judgment,usage,requests});
    return execute(option,'jev',picked.why,{candidate:picked.candidate,proposal:judgment,usage,requests});
  }

  const confidence=Number(judgment?.answer?.confidence);
  if(judgment?.option&&Number.isFinite(confidence)&&confidence>=gate)
    return execute(judgment.option,'jev','Ready combat: choose among legal card actions',
      {proposal:judgment,usage,requests});
  return handoff('low_confidence',{proposal:judgment,usage,requests,
    instruction:'Return a decision, or a strategy with explicit conditions and expiry'});
}
