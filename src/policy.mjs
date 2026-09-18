// Program-side local policy. Arithmetic lives in combat.mjs; this module only
// names the cases that are not a tactical choice: a covering kill line, the
// single block that prevents displayed death, or a confirmed last-enemy lethal.
import {incomingAttacks,optionBlock,optionDamage,optionTarget,cardCost,
  applyDamage,livingEnemies,parseEffect} from './combat.mjs';

export {incomingAttacks,incomingDamage,optionBlock,optionDamage,optionTarget,intentDamage} from './combat.mjs';

const playable=options=>options.filter(option=>option.command?.action==='play_card');
const sideEffectFree=option=>{
  const effect=parseEffect(option?.label);
  return !effect.unbounded&&!effect.random&&!effect.selfDamage&&!effect.exhaust;
};

function lethalOptions(state,options){
  const byTarget=new Map();
  for(const option of playable(options)){
    const damage=optionDamage(option);
    const target=optionTarget(option,state);
    if(!Number.isFinite(damage)||!target)continue;
    if(!applyDamage(target.hp,target.block??0,damage).killed)continue;
    const list=byTarget.get(target.entity_id)??[];
    list.push({option,damage,overkill:damage-((target.hp||0)+(target.block||0)),card_index:option.command?.card_index});
    byTarget.set(target.entity_id,list);
  }
  return byTarget;
}

function cheapest(list){
  return [...list].sort((a,b)=>(Number(a.option.command?.card_index??0)-Number(b.option.command?.card_index??0)))[0]??null;
}

function blockOptions(options){
  return playable(options)
    .map(option=>({option,block:optionBlock(option),damage:optionDamage(option)}))
    .filter(entry=>entry.block>0&&entry.damage===null)
    .sort((a,b)=>b.block-a.block);
}

export function guardOption(state,options,attacks=incomingAttacks(state)){
  if(!attacks.known||attacks.total<=0)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap<hp)return null;
  const covering=blockOptions(options).filter(candidate=>candidate.block>=gap&&sideEffectFree(candidate.option));
  if(covering.length!==1)return null;
  const entry=covering[0];
  return {kind:'play',reason:`Survive ${attacks.total} displayed damage with ${entry.block} block from the only such play`,
    option:entry.option,evidence:{incoming:attacks.total,block,hp,gap}};
}

function affordableKillLine(state,living,lethal){
  const energy=Number(state.player?.energy??0);
  const eligible=living.map(enemy=>({enemy,list:lethal.get(enemy.entity_id)??[]}));
  if(eligible.some(entry=>!entry.list.length))return null;
  eligible.sort((a,b)=>a.list.length-b.list.length);
  const used=new Set(),chosen=[];
  let cost=0;
  for(const {list} of eligible){
    const pick=list.filter(entry=>!used.has(entry.card_index))
      .sort((a,b)=>cardCost(state,a.option)-cardCost(state,b.option)||a.overkill-b.overkill)[0];
    if(!pick)return null;
    used.add(pick.card_index);
    chosen.push(pick);
    cost+=cardCost(state,pick.option);
  }
  return cost>energy?null:{chosen,cost,energy};
}

export function localPolicy(state,options){
  const attacks=incomingAttacks(state);
  const living=livingEnemies(state);
  if(!attacks.known||!living.length)return {kind:'decline',reason:'Combat arithmetic unavailable'};
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  const lethal=lethalOptions(state,options);
  const blockers=blockOptions(options);

  const killLine=affordableKillLine(state,living,lethal);
  if(killLine){
    const order=[...killLine.chosen].sort((a,b)=>a.overkill-b.overkill);
    return {kind:'kill',reason:`Displayed attacks cover all ${living.length} living enemies`,
      options:order.map(entry=>entry.option),
      evidence:{incoming:attacks.total,cost:killLine.cost,energy:killLine.energy}};
  }

  if(gap>=hp){
    const covering=blockers.filter(entry=>entry.block>=gap);
    if(covering.length===1)return {kind:'play',
      reason:`Survive ${attacks.total} displayed damage with ${covering[0].block} block from the only such play`,
      option:covering[0].option,evidence:{incoming:attacks.total,block,hp,gap}};
    if(!covering.length)return {kind:'escalate',reason:`Lethal ${gap} damage cannot be blocked from this hand`,
      evidence:{incoming:attacks.total,block,hp,best_block:blockers[0]?.block??0}};
    return {kind:'shortlist',reason:`${covering.length} plays could survive ${attacks.total} displayed damage`,
      options:covering.slice(0,3).map(entry=>entry.option),
      candidates:covering.slice(0,3).map(entry=>({option:entry.option,why:`${entry.block} block clears the ${gap} gap`})),
      evidence:{incoming:attacks.total,block,hp,gap}};
  }

  if(gap>=Math.max(8,Math.round(hp*.25))&&blockers.length){
    const candidates=blockers.slice(0,3).map(entry=>({option:entry.option,why:`${entry.block} block against ${attacks.total} displayed damage`}));
    return {kind:'shortlist',reason:`Significant ${gap} unblocked damage; keep mitigation in the running`,
      options:candidates.map(candidate=>candidate.option),candidates,evidence:{incoming:attacks.total,block,hp}};
  }

  return {kind:'decline',reason:'No locally decisive line; the fast model decides'};
}

export function prefixPlan(state,options,limit=3){
  const attacks=incomingAttacks(state);
  if(!attacks.known)return null;
  const lethal=lethalOptions(state,options);
  if(!lethal.size)return null;
  const steps=[];
  for(const list of lethal.values()){
    const pick=cheapest(list);
    if(!pick)continue;
    const target=optionTarget(pick.option,state);
    if(!target)continue;
    steps.push({card_index:pick.option.command.card_index,target_combat_id:target.combat_id});
    if(steps.length>=limit)break;
  }
  return steps.length?steps:null;
}

export function attritionRisk(state,options){
  const attacks=incomingAttacks(state);
  if(!attacks.known||!attacks.total)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap<=0)return null;
  const living=livingEnemies(state);
  if(!living.length)return null;
  const cover=playable(options).reduce((best,option)=>Math.max(best,optionBlock(option)),0);
  if([...lethalOptions(state,options).keys()].length)return null;
  if(cover>=gap)return null;
  const lethalIn=Math.ceil(hp/Math.max(1,gap-cover));
  if(lethalIn>1)return null;
  return {kind:'attrition',
    reason:`Displayed ${attacks.total} damage exceeds the ${cover} this hand can cover at ${hp} HP`,
    evidence:{incoming:attacks.total,block,hand_cover:cover,gap,hp,lethal_in_turns:lethalIn}};
}

// Confirmed last-enemy lethal is not a choice. One playable card plus end turn
// is a choice and is left to the fast model or an explicit strategy.
export function nextLocalPlay(state,options){
  const attacks=incomingAttacks(state);
  const living=livingEnemies(state);
  if(!attacks.known||!living.length)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap>=hp)return null;
  if(living.length!==1)return null;
  const cards=playable(options);
  const finisher=cards.find(option=>{
    if(!sideEffectFree(option))return false;
    const damage=optionDamage(option),target=optionTarget(option,state);
    return Number.isFinite(damage)&&damage>0&&target&&applyDamage(target.hp,target.block??0,damage).killed;
  });
  if(finisher)return {kind:'resolve',reason:'Finish the last living enemy with a confirmed lethal play',
    option:finisher,evidence:{incoming:attacks.total,block,hp,damage:optionDamage(finisher)}};
  return null;
}
