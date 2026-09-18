// Short deterministic prefixes as candidates.
//
// The fast model should choose between a few concrete lines, not author one card
// at a time. This module builds a small, bounded set of candidates from
// mechanisms the program can already verify - a single known play, a confirmed
// lethal, or a two-card prefix whose every step states its damage and target -
// and attaches the numbers the choice depends on. Anything the program cannot
// bound (unknown effects, random targets, card generation) never enters a
// prefix; it either appears as a one-step candidate or is left to the caller.
import {incomingAttacks,optionBlock,optionDamage,optionTarget} from './policy.mjs';

// Effects the program cannot bound. Such a card may still be offered as a
// one-step candidate (the model can judge it), but it never joins a prefix whose
// later steps would be predicted from a made-up outcome.
const UNBOUNDED=/随机|加入.*手牌|加入.*抽牌堆|消耗|失去.*生命/;
import {describeCard} from './effects.mjs';

const MAX_STEPS=2;

function costOf(state,option){
  const card=(state.player?.hand??[]).find(entry=>entry.index===option.command?.card_index);
  const cost=Number(card?.cost);
  return Number.isFinite(cost)?cost:0;
}

function stepOf(state,option){
  const card=(state.player?.hand??[]).find(entry=>entry.index===option.command?.card_index);
  const damage=optionDamage(option);
  const target=optionTarget(option,state);
  const effective=target?Math.max(0,target.hp-(target.block??0)):null;
  return {
    option,
    card_index:option.command?.card_index??null,
    target_entity:target?.entity_id??null,
    target_combat_id:target?.combat_id??null,
    damage:damage??null,
    block:optionBlock(option)||null,
    energy:costOf(state,option),
    kills:damage!==null&&effective!==null&&damage>=effective
  };
}

// Every candidate is a title, an ordered list of steps, and the totals a chooser
// needs. `verified` is true only when each step states its own number and target.
export function planCandidates(state,options,{store={},energy=null,limit=4}={}){
  const budget=Number.isFinite(energy)?energy:Number(state.player?.energy??0);
  const attacks=incomingAttacks(state);
  const playable=options.filter(option=>option.command?.action==='play_card');
  if(!playable.length)return [];

  const candidates=[];
  const seen=new Set();
  const add=(title,candidateSteps)=>{
    const key=candidateSteps.map(step=>step.card_index).join('-');
    if(!candidateSteps.length||seen.has(key))return;
    const cost=candidateSteps.reduce((sum,step)=>sum+step.energy,0);
    if(cost>budget)return;
    seen.add(key);
    candidates.push({
      id:`c${candidates.length}`,
      title,
      steps:candidateSteps,
      energy:cost,
      damage:candidateSteps.reduce((sum,step)=>sum+(step.damage??0),0),
      block:candidateSteps.reduce((sum,step)=>sum+(step.block??0),0),
      kills:candidateSteps.filter(step=>step.kills).length,
      single_target:candidateSteps.length===1,
      verified:candidateSteps.every(step=>step.damage!==null||step.block!==null)
    });
  };

  // One-step candidates first: a confirmable kill, then the cheapest known play.
  const steps=playable.map(option=>stepOf(state,option));
  const bounded=steps.filter(step=>!UNBOUNDED.test(String(step.option?.label??'')));
  const lethal=bounded.filter(step=>step.kills).sort((a,b)=>a.energy-b.energy);
  if(lethal.length)add(`Kill with ${labelOf(lethal[0])}`,[lethal[0]]);
  const known=bounded.filter(step=>step.damage!==null&&!step.kills).sort((a,b)=>a.energy-b.energy);
  if(known.length)add(`Play ${labelOf(known[0])}`,[known[0]]);
  const blocks=bounded.filter(step=>step.block&&step.damage===null).sort((a,b)=>b.block-a.block);
  if(blocks.length)add(`Block ${blocks[0].block} with ${labelOf(blocks[0])}`,[blocks[0]]);

  // One two-step prefix: a lethal followed by another known play, or two known
  // plays inside the budget. Unknown effects never join a prefix.
  const pool=[...lethal,...known.filter(step=>!step.kills)];
  if(pool.length>=2){
    const first=pool[0];
    const second=pool.find(step=>step!==first&&step.card_index!==first.card_index);
    if(second)add(`${labelOf(first)} then ${labelOf(second)}`,[first,second]);
  }else if(lethal.length&&known.length){
    const second=known.find(step=>step.card_index!==lethal[0].card_index);
    if(second)add(`${labelOf(lethal[0])} then ${labelOf(second)}`,[lethal[0],second]);
  }

  return candidates.slice(0,limit).map(candidate=>({
    ...candidate,
    steps:candidate.steps.map(step=>({
      option_id:step.option.id,
      card:describeCard((state.player?.hand??[]).find(entry=>entry.index===step.card_index)??{},store),
      target_entity:step.target_entity,
      target_combat_id:step.target_combat_id,
      damage:step.damage,
      block:step.block,
      energy:step.energy,
      kills:step.kills
    })),
    incoming:attacks.known?attacks.total:null,
    survives:attacks.known?attacks.total-(Number(state.player?.block??0)+candidate.block)<Number(state.player?.hp??0):null
  }));
}

function labelOf(step){
  const card=step.option?.label??'';
  return card.split(':')[0].slice(0,18)||'card';
}

// Program-side combination of the model's independent judgments. A lethal turn
// is a hard constraint, never something a model score may override; the
// strategy order breaks ties before raw damage does.
export function chooseCandidate(candidates,evaluation={},strategy=null){
  if(!candidates.length)return null;
  // 1. Survival is a hard constraint and the program owns it: if the displayed
  //    attack would kill us, a line that does not prevent it is not a candidate,
  //    and no model preference may resurrect it.
  const lethalTurn=candidates.some(candidate=>candidate.survives===false);
  const eligible=lethalTurn?candidates.filter(candidate=>candidate.survives===true):candidates;
  if(!eligible.length)return {candidate:null,why:'every line dies to the displayed attack'};
  // 2. An agreed strategy outranks the model's own ranking.
  if(strategy?.order?.length){
    for(const preference of strategy.order){
      const pattern=String(preference.match??'');
      if(!pattern)continue;
      const hit=eligible.find(candidate=>candidate.steps.some(step=>String(step.card?.name??'').includes(pattern)
        ||JSON.stringify(step.card?.effect??'').includes(pattern)));
      if(hit)return {candidate:hit,why:`strategy preference ${pattern}`};
    }
  }
  // 3. The model's choice among the offered, surviving lines. Kills and damage
  //    are inputs it was shown, not something the program overrides it on. The
  //    exact single-play kill is already settled by the program's arithmetic
  //    before this point, so nothing left here is a correctness question.
  const preferred=eligible.find(candidate=>candidate.id===evaluation.choice);
  if(preferred)return {candidate:preferred,why:'model choice'};
  // 4. No usable model choice: fall back to the most damage inside the budget.
  const best=[...eligible].sort((a,b)=>b.damage-a.damage||a.energy-b.energy)[0];
  return best?{candidate:best,why:'highest verified damage'}:null;
}

export const CANDIDATE_INSTRUCTIONS=[
  'Pick the best candidate line for this Slay the Spire 2 turn.',
  'Each candidate lists the energy it costs, the total damage and block it produces, how many enemies it kills, and whether it survives the displayed incoming attack.',
  'Those numbers are computed and exact; do not recalculate or estimate them.',
  'Prefer a line that kills a living enemy. Prefer surviving the displayed attack over taking it.',
  'If a strategy field is present, follow it while it applies.'
].join(' ');

// Independent yes/no questions about the same candidates, sent in the same
// request as the choice. Each question stands alone: none depends on another
// answer, per the fan-out guidance.
export function candidateQuestions(candidates){
  const questions={};
  for(const candidate of candidates){
    questions[`safe_${candidate.id}`]={type:'noul',
      instructions:`Does candidate ${candidate.id} ("${candidate.title}") leave the player able to survive the enemies' displayed attack this turn? Answer yes only when the listed block and the candidates' own effects cover the displayed incoming damage.`,
      criteria:{yes:'the line covers the displayed attack',no:'the line leaves part of the displayed attack unblocked'}};
  }
  return questions;
}
