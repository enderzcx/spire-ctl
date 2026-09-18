// Short deterministic prefixes as candidates.
//
// Steps are projected sequentially from modeled effects. A later step that
// would require a draw, random outcome, status-modified damage, or a dead
// target is not a plan; the prefix stops before it.
import {incomingAttacks,optionEffect,projectPrefix} from './combat.mjs';
import {describeCard} from './effects.mjs';

const MAX_STEPS=2;

function labelOf(option){
  return String(option?.label??'').split(':')[0].slice(0,18)||'card';
}

function compactStep(state,step,store){
  const card=(state.player?.hand??[]).find(entry=>entry.index===step.card_index)??{};
  return {
    option_id:step.option_id,
    card_index:step.card_index,
    card:describeCard(card,store),
    target_entity:step.target_entity,
    target_combat_id:step.target_combat_id,
    damage:step.damage,
    block:step.block,
    energy:step.energy,
    kills:step.kills,
    expect:step.expect
  };
}

export function planCandidates(state,options,{store={},energy=null,limit=4}={}){
  const budget=Number.isFinite(energy)?energy:Number(state.player?.energy??0);
  const attacks=incomingAttacks(state);
  const playable=options.filter(option=>option.command?.action==='play_card');
  if(!playable.length)return [];

  const candidates=[];
  const seen=new Set();
  const add=(title,optionList)=>{
    const projected=projectPrefix(state,optionList);
    if(!projected.known||!projected.steps.length)return;
    if(projected.energy>budget)return;
    if(projected.steps.some(step=>!step.prefixSafe)&&projected.steps.length>1)return;
    const key=projected.steps.map(step=>step.card_index).join('-');
    if(seen.has(key))return;
    seen.add(key);
    candidates.push({
      id:`c${candidates.length}`,
      title,
      steps:projected.steps,
      energy:projected.energy,
      damage:projected.damage,
      block:projected.block,
      kills:projected.kills,
      single_target:projected.steps.length===1,
      verified:true,
      incoming:projected.incoming,
      unblocked:projected.unblocked,
      survives:projected.survives
    });
  };

  const modeled=playable.filter(option=>optionEffect(option,state).known);
  const prefixable=modeled.filter(option=>optionEffect(option,state).prefixSafe);
  const lethal=prefixable.filter(option=>projectPrefix(state,[option]).kills>0)
    .sort((a,b)=>optionEffect(a,state).cost-optionEffect(b,state).cost);
  const attacksKnown=prefixable.filter(option=>optionEffect(option,state).total&&!lethal.includes(option));
  const blocks=prefixable.filter(option=>optionEffect(option,state).block&&!optionEffect(option,state).total)
    .sort((a,b)=>(optionEffect(b,state).block??0)-(optionEffect(a,state).block??0));

  if(lethal.length)add(`Kill with ${labelOf(lethal[0])}`,[lethal[0]]);
  if(attacksKnown.length)add(`Play ${labelOf(attacksKnown[0])}`,[attacksKnown[0]]);
  if(blocks.length)add(`Block ${optionEffect(blocks[0],state).block} with ${labelOf(blocks[0])}`,[blocks[0]]);
  for(const option of modeled){
    if(prefixable.includes(option))continue;
    add(`Play ${labelOf(option)}`,[option]);
  }

  const pool=[...lethal,...attacksKnown];
  if(pool.length>=2){
    const first=pool[0];
    const second=pool.find(option=>option!==first&&option.command.card_index!==first.command.card_index);
    if(second)add(`${labelOf(first)} then ${labelOf(second)}`,[first,second].slice(0,MAX_STEPS));
  }else if(pool.length&&blocks.length&&blocks[0].command.card_index!==pool[0].command.card_index){
    add(`${labelOf(pool[0])} then ${labelOf(blocks[0])}`,[pool[0],blocks[0]].slice(0,MAX_STEPS));
  }

  for(const option of playable){
    const key=String(option.command?.card_index);
    if(seen.has(key))continue;
    seen.add(key);
    const effect=optionEffect(option,state);
    candidates.push({
      id:`c${candidates.length}`,
      title:`Play ${labelOf(option)}`,
      steps:[{
        option,option_id:option.id,card_index:option.command.card_index,
        target_entity:effect.target?.entity_id??null,target_combat_id:effect.target?.combat_id??null,
        damage:effect.total,block:effect.block,energy:effect.cost,kills:0,expect:null,prefixSafe:false
      }],
      energy:effect.cost,damage:effect.total??0,block:effect.block??0,kills:0,
      single_target:true,verified:false,incoming:attacks.known?attacks.total:null,
      unblocked:null,survives:null
    });
  }

  return candidates.slice(0,limit).map(candidate=>({
    ...candidate,
    steps:candidate.steps.map(step=>compactStep(state,step,store)),
    incoming:candidate.incoming??(attacks.known?attacks.total:null)
  }));
}

export function candidateToPlan(stateId,candidate){
  if(!candidate?.steps?.length)return null;
  return {
    state_id:stateId,
    steps:candidate.steps.map(step=>{
      const out={card_index:step.card_index,expect:step.expect??{}};
      if(Number.isInteger(step.target_combat_id))out.target_combat_id=step.target_combat_id;
      return out;
    })
  };
}

export function chooseCandidate(candidates,evaluation={},strategy=null){
  if(!candidates.length)return null;
  const lethalTurn=candidates.some(candidate=>candidate.survives===false);
  const eligible=lethalTurn?candidates.filter(candidate=>candidate.survives===true):candidates;
  if(!eligible.length)return {candidate:null,why:'every line dies to the displayed attack'};
  if(strategy?.order?.length){
    const constrained=eligible.filter(candidate=>strategy.order.some(preference=>{
      const pattern=String(preference.match??'');
      return pattern&&candidate.steps.some(step=>String(step.card?.name??'').includes(pattern)
        ||JSON.stringify(step.card?.effect??'').includes(pattern)
        ||JSON.stringify(step.card?.original_text??'').includes(pattern));
    }));
    if(constrained.length){
      const preferred=constrained.find(candidate=>candidate.id===evaluation.choice);
      if(preferred)return {candidate:preferred,why:'model choice inside strategy'};
      return {candidate:constrained[0],why:`strategy preference ${strategy.order[0].match}`};
    }
  }
  const preferred=eligible.find(candidate=>candidate.id===evaluation.choice);
  if(preferred)return {candidate:preferred,why:'model choice'};
  return {candidate:null,why:'no usable model choice'};
}

export const CANDIDATE_INSTRUCTIONS=[
  'Pick the best candidate line for this Slay the Spire 2 turn.',
  'Each candidate lists its ordered cards, energy cost, computed damage and block, kills, and whether the program already proved it survives the displayed incoming attack.',
  'Those numbers are computed and exact; do not recalculate or estimate them.',
  'Prefer a line that kills a living enemy. Prefer surviving the displayed attack over taking it.',
  'If a strategy field is present, follow it while it applies. Do not pick a line that contradicts it.',
  'End turn is a real alternative when it is listed; do not assume a card must be played.'
].join(' ');
