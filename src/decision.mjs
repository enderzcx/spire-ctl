// One tactical decision entry for ready combat.
//
// Returns execute / execute_prefix / handoff. Strategy constrains what may be
// played; it does not invent an end-turn when a card is still legal. Jev is
// asked at most once per distinct state.
import {stateId} from './game.mjs';
import {localPolicy,nextLocalPlay,attritionRisk} from './policy.mjs';
import {planCandidates,chooseCandidate,candidateToPlan} from './planning.mjs';
import {strategyApplies,strategyPreference} from './strategy.mjs';
import {projectPrefix} from './combat.mjs';

const playableOf=options=>options.filter(option=>option.command?.action==='play_card');

export function confidenceGate({lethal=false,unknown=false,lowHp=false}={}){
  if(lethal||unknown||lowHp)return 0.5;
  const configured=Number(process.env.SPIRE_PLAN_MIN_CONFIDENCE);
  if(Number.isFinite(configured))return configured;
  return 0.25;
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
  if(!projected.known||projected.steps.some(step=>!step.prefixSafe))
    return execute(options[0],source,reason,extra);
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

export async function decideCombat({state,options,route,strategy=null,ask=null,priorHandoff=null,actedThisRound=false}={}){
  if(route?.kind==='wait')return {kind:'wait',reason:route.reason,source:'program'};
  if(route?.kind==='deterministic'&&route.option)
    return execute(route.option,'deterministic',route.reason,{local:{kind:'end_turn',reason:route.reason}});

  const applied=strategy?strategyApplies(strategy,state):{ok:false};
  const preference=applied.ok?strategyPreference(strategy,options):null;
  const guardKind=route?.kind==='planner'&&route.strategic===false?route.guard:null;

  if(route?.kind==='planner'&&route.strategic===true)
    return handoff(route.reason,{instruction:'Return a decision, or a strategy with explicit conditions and expiry'});

  if(guardKind&&!preference)
    return handoff(route.reason,{guard:guardKind,
      instruction:'Return a decision, or a strategy with explicit conditions and expiry'});

  const attrition=attritionRisk(state,options);
  if(attrition)return handoff(attrition.reason,{attrition:attrition.evidence,
    instruction:'The displayed attack out-scales this hand; consider a potion, a different line, or accept the loss'});

  const policy=localPolicy(state,options);
  if(policy.kind==='escalate')return handoff(policy.reason,{local_evidence:policy.evidence});
  if(policy.kind==='kill'){
    const line=prefixFrom(state,policy.options,'local',policy.reason,{local:policy});
    if(line)return line;
  }
  if(policy.kind==='play'||policy.kind==='guard')
    return execute(policy.option,'local',policy.reason,{local:policy});

  const finisher=nextLocalPlay(state,options);
  if(finisher)return execute(finisher.option,'local',finisher.reason,{local:finisher});

  if(preference)
    return execute(preference.option,'local',`Strategy ${strategy.strategy_id}: ${preference.preference.why??preference.preference.match}`,
      {local:{kind:'strategy',reason:`Strategy ${strategy.strategy_id}: ${preference.preference.why??preference.preference.match}`,
        evidence:{strategy_id:strategy.strategy_id,conditions:strategy.conditions.length,
          expiry:strategy.expires_on?.length??0}}});

  const cards=playableOf(options);
  const endTurn=options.find(option=>option.command?.action==='end_turn');
  if(!cards.length&&endTurn)
    return execute(endTurn,'deterministic','No playable cards; no urgent potion decision',
      {local:{kind:'end_turn',reason:'No playable cards; no urgent potion decision'}});

  if(!ask)return handoff('No tactical adapter available');
  if(priorHandoff)return handoff('repeated_state',{
    instruction:'This exact state was already handed over; return a decision or a strategy',
    repeat_count:priorHandoff.count
  });

  const menu=options.filter(option=>option.command?.action!=='use_potion');
  const candidates=planCandidates(state,menu);
  const useCandidates=process.env.SPIRE_CANDIDATES!=='0'&&candidates.length>=2;
  const offered=useCandidates?candidates:null;
  const judgment=await ask(state,menu,policy.kind==='shortlist'?policy:null,{candidates:offered,strategy});
  const usage=judgment?.usage??{input_tokens:0,output_tokens:0};
  const requests=judgment?.requests??1;
  const lethal=candidates.some(candidate=>candidate.survives===false)||policy.kind==='escalate';
  const gate=confidenceGate({lethal,unknown:Boolean((state.player?.hand??[]).some(card=>card?.id&&!card?.description)),
    lowHp:guardKind==='low_hp'});

  if(judgment?.no_surviving_candidate)
    return handoff('Potential lethal incoming damage',{proposal:judgment,usage,requests});

  const confidence=Number(judgment?.answer?.confidence);
  const plannedChoice=useCandidates&&(judgment?.candidate?.id
    ||candidates.some(candidate=>candidate.id===judgment?.answer?.choice));
  if(plannedChoice){
    const picked=judgment?.candidate?.id
      ?{candidate:candidates.find(candidate=>candidate.id===judgment.candidate.id),why:judgment.candidate.why??'model choice'}
      :chooseCandidate(candidates,{choice:judgment.answer.choice},strategy);
    if(picked?.candidate&&Number.isFinite(confidence)&&confidence>=gate){
      const plan=candidateToPlan(stateId(state),picked.candidate);
      if(picked.candidate.steps.length>=2&&plan&&picked.candidate.steps.every(step=>step.expect))
        return {kind:'execute_prefix',plan,option:judgment.option,source:'jev',reason:picked.why,
          candidate:picked.candidate,proposal:judgment,usage,requests};
      const option=menu.find(entry=>entry.id===picked.candidate.steps[0].option_id)??judgment.option;
      if(option)return execute(option,'jev',picked.why,{candidate:picked.candidate,proposal:judgment,usage,requests});
    }
    return handoff('low_confidence_candidate',{proposal:{...judgment,candidate:picked?.candidate,gate},usage,requests,
      instruction:'Return a decision, or a strategy with explicit conditions and expiry'});
  }
  if(judgment?.option&&Number.isFinite(confidence)&&confidence>=0.5)
    return execute(judgment.option,'jev','Ready combat: choose among legal card actions',
      {proposal:judgment,usage,requests});
  return handoff('low_confidence',{proposal:judgment,usage,requests,
    instruction:'Return a decision, or a strategy with explicit conditions and expiry'});
}
