// Candidates: every legal single action+target, plus a bounded set of proven prefixes.
import {incomingAttacks,projectPlay,projectPrefix} from './combat.mjs';
import {describeCard} from './effects.mjs';

const MAX_PREFIX=2;
const MAX_PREFIX_LINES=2;

function labelOf(option){
  if(option?.command?.action==='end_turn')return 'End turn';
  return String(option?.label??'').split(':')[0].slice(0,18)||'card';
}

function optionKey(option){
  return `${option.command?.action}:${option.command?.card_index??''}:${option.command?.target??''}`;
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
    expect:step.expect??null
  };
}

function singleCandidate(state,option,store){
  const projected=option.command?.action==='play_card'?projectPlay(state,option):{known:false};
  const card=(state.player?.hand??[]).find(entry=>entry.index===option.command?.card_index)??{};
  const attacks=incomingAttacks(state);
  // End turn has no card projection, but known displayed lethal damage must
  // still be rejected. This is not a claim to simulate all end-turn triggers.
  const endGap=option.command?.action==='end_turn'&&attacks.known
    &&Number.isFinite(state.player?.hp)&&Number.isFinite(state.player?.block)
    ?Math.max(0,attacks.total-state.player.block):null;
  return {
    id:null,
    kind:'single',
    title:labelOf(option),
    option_id:option.id,
    steps:[{
      option_id:option.id,
      card_index:option.command?.card_index??null,
      card:describeCard(card,store),
      target_entity:option.command?.target??null,
      target_combat_id:projected.known?projected.effect?.target?.combat_id??null:null,
      damage:projected.known?projected.effect.total:null,
      block:projected.known?projected.effect.block:null,
      energy:projected.known?projected.effect.cost:null,
      kills:projected.known?projected.kills:0,
      expect:projected.known?projected.expect:null
    }],
    energy:projected.known?projected.effect.cost:null,
    damage:projected.known?(projected.effect.total??0):null,
    block:projected.known?(projected.effect.block??0):null,
    kills:projected.known?projected.kills:0,
    verified:Boolean(projected.known),
    incoming:attacks.known?attacks.total:null,
    unblocked:projected.known?projected.unblocked:endGap,
    survives:projected.known?projected.survives:(endGap===null?null:endGap<state.player.hp)
  };
}

export function planCandidates(state,options,{store={},maxLength=2,prefixLines=MAX_PREFIX_LINES}={}){
  const attacks=incomingAttacks(state);
  const menu=options.filter(option=>option.command?.action!=='use_potion');
  if(!menu.length)return [];
  const candidates=[];
  const seen=new Set();
  for(const option of menu){
    const key=optionKey(option);
    if(seen.has(key))continue;
    seen.add(key);
    const candidate=singleCandidate(state,option,store);
    candidate.id=`c${candidates.length}`;
    candidates.push(candidate);
  }

  const playable=menu.filter(option=>option.command?.action==='play_card');
  if(maxLength>=2&&playable.length>=2){
    let added=0;
    for(let i=0;i<playable.length&&added<prefixLines;i++){
      for(let j=0;j<playable.length&&added<prefixLines;j++){
        if(i===j)continue;
        if(playable[i].command.card_index===playable[j].command.card_index)continue;
        const projected=projectPrefix(state,[playable[i],playable[j]].slice(0,MAX_PREFIX));
        if(!projected.known||projected.steps.length<2)continue;
        const key=projected.steps.map(step=>`${step.card_index}:${step.target_combat_id??''}`).join('>');
        if(seen.has(key))continue;
        seen.add(key);
        candidates.push({
          id:`c${candidates.length}`,
          kind:'prefix',
          title:`${labelOf(playable[i])} then ${labelOf(playable[j])}`,
          steps:projected.steps.map(step=>compactStep(state,step,store)),
          energy:projected.energy,
          damage:projected.damage,
          block:projected.block,
          kills:projected.kills,
          verified:true,
          incoming:projected.incoming,
          unblocked:projected.unblocked,
          survives:projected.survives
        });
        added+=1;
      }
    }
  }

  return candidates.map(candidate=>({
    ...candidate,
    incoming:candidate.incoming??(attacks.known?attacks.total:null)
  }));
}

export function candidateToPlan(stateId,candidate){
  if(!candidate?.steps?.length||!candidate.steps.every(step=>step.expect))return null;
  return {
    state_id:stateId,
    steps:candidate.steps.map(step=>{
      const out={card_index:step.card_index,expect:step.expect};
      if(Number.isInteger(step.target_combat_id))out.target_combat_id=step.target_combat_id;
      return out;
    })
  };
}

export function validateCandidate(candidates,choice,strategy=null){
  if(!candidates.length||choice==null)return {candidate:null,why:'no usable model choice'};
  const picked=candidates.find(candidate=>candidate.id===choice);
  if(!picked)return {candidate:null,why:'choice is not an offered candidate'};
  const lethalTurn=candidates.some(candidate=>candidate.survives===false);
  if(lethalTurn&&picked.survives===false)return {candidate:null,why:'choice dies to the displayed attack'};
  if(strategy?.order?.length){
    const patternHits=preference=>picked.steps.some(step=>
      String(step.card?.name??'').includes(preference)
      ||String(step.card?.effect??'').includes(preference)
      ||String(step.card?.original_text??'').includes(preference)
      ||(picked.title??'').includes(preference));
    const endTurn=picked.steps.length===1&&!picked.steps[0].card_index&&picked.title==='End turn';
    const matches=strategy.order.some(preference=>patternHits(String(preference.match??'')));
    if(!matches&&!endTurn)return {candidate:null,why:'choice contradicts strategy'};
  }
  return {candidate:picked,why:'model choice'};
}

export function chooseCandidate(candidates,evaluation={},strategy=null){
  return validateCandidate(candidates,evaluation.choice,strategy);
}

export const CANDIDATE_INSTRUCTIONS=[
  'Pick the best candidate line for this Slay the Spire 2 turn.',
  'Single-action candidates include every legal card, target and end turn. Prefix candidates are only listed when the program proved both steps.',
  'Numbers marked verified are exact; unverified candidates have unknown later effects and must not be treated as calculated facts.',
  'If a strategy field is present, follow it while it applies. Do not pick a line that contradicts it.',
  'End turn is a real alternative when it is listed; do not assume a card must be played.'
].join(' ');
