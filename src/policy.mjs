// Program-side local policy. Forced plays use projectPlay proof, not a regex hit.
import {incomingAttacks,livingEnemies,projectPlay} from './combat.mjs';

export {incomingAttacks,incomingDamage,optionBlock,optionDamage,optionTarget,intentDamage} from './combat.mjs';

const playable=options=>options.filter(option=>option.command?.action==='play_card');

function proven(state,option){
  const projected=projectPlay(state,option);
  return projected.known?projected:null;
}

function lethalOptions(state,options){
  const byTarget=new Map();
  for(const option of playable(options)){
    const projected=proven(state,option);
    if(!projected||!projected.kills)continue;
    const target=projected.effect.target;
    if(!target)continue;
    const list=byTarget.get(target.entity_id)??[];
    list.push({option,projected,damage:projected.effect.total,card_index:option.command?.card_index});
    byTarget.set(target.entity_id,list);
  }
  return byTarget;
}

function cheapest(list){
  return [...list].sort((a,b)=>(Number(a.option.command?.card_index??0)-Number(b.option.command?.card_index??0)))[0]??null;
}

export function localPolicy(state,options){
  const attacks=incomingAttacks(state);
  const living=livingEnemies(state);
  if(!attacks.known||!living.length)return {kind:'decline',reason:'Combat arithmetic unavailable'};
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);

  const clearOption=playable(options).find(option=>{
    const projected=proven(state,option);return projected&&projected.kills>=living.length;
  });
  if(clearOption)return {kind:'kill',reason:`Displayed attacks cover all ${living.length} living enemies`,
    options:[clearOption],evidence:{incoming:attacks.total}};

  const lethal=lethalOptions(state,options);
  const energy=Number(state.player?.energy??0);
  if(living.length&&[...lethal.keys()].length===living.length){
    const used=new Set(),chosen=[];
    const eligible=living.map(enemy=>({enemy,list:lethal.get(enemy.entity_id)??[]}))
      .sort((a,b)=>a.list.length-b.list.length);
    let cost=0,ok=true;
    for(const {list} of eligible){
      const pick=list.filter(entry=>!used.has(entry.card_index))
        .sort((a,b)=>(a.projected.effect.cost??0)-(b.projected.effect.cost??0))[0];
      if(!pick){ok=false;break;}
      used.add(pick.card_index);chosen.push(pick);cost+=pick.projected.effect.cost??0;
    }
    if(ok&&cost<=energy&&chosen.length===living.length)
      return {kind:'kill',reason:`Displayed attacks cover all ${living.length} living enemies`,
        options:chosen.map(entry=>entry.option),evidence:{incoming:attacks.total,cost,energy}};
  }

  if(gap>=hp){
    const covering=playable(options).map(option=>{
      const projected=proven(state,option);
      if(!projected||isNum(projected.effect.total))return null;
      return projected.next.player.block>=attacks.total?{option,projected,block:projected.effect.block}:null;
    }).filter(Boolean);
    if(covering.length===1)return {kind:'play',
      reason:`Survive ${attacks.total} displayed damage with ${covering[0].block} block from the only such play`,
      option:covering[0].option,evidence:{incoming:attacks.total,block,hp,gap}};
    if(!covering.length)return {kind:'escalate',reason:`Lethal ${gap} damage cannot be blocked from this hand`,
      evidence:{incoming:attacks.total,block,hp}};
    return {kind:'shortlist',reason:`${covering.length} plays could survive ${attacks.total} displayed damage`,
      options:covering.slice(0,3).map(entry=>entry.option),
      candidates:covering.slice(0,3).map(entry=>({option:entry.option,why:`${entry.block} block clears the ${gap} gap`})),
      evidence:{incoming:attacks.total,block,hp,gap}};
  }

  return {kind:'decline',reason:'No locally decisive line; the fast model decides'};
}

const isNum=value=>Number.isFinite(value);

export function prefixPlan(state,options,limit=3){
  const attacks=incomingAttacks(state);
  if(!attacks.known)return null;
  const lethal=lethalOptions(state,options);
  if(!lethal.size)return null;
  const steps=[];
  for(const list of lethal.values()){
    const pick=cheapest(list);
    if(!pick?.projected.effect.target)continue;
    steps.push({card_index:pick.option.command.card_index,target_combat_id:pick.projected.effect.target.combat_id});
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
  if(playable(options).some(option=>{const p=proven(state,option);return p&&p.kills>=living.length;}))return null;
  if(lethalOptions(state,options).size)return null;
  let cover=0;
  for(const option of playable(options)){
    const projected=proven(state,option);
    if(projected&&isNum(projected.effect.block))cover=Math.max(cover,projected.effect.block);
  }
  if(cover>=gap)return null;
  const lethalIn=Math.ceil(hp/Math.max(1,gap-cover));
  if(lethalIn>1)return null;
  return {kind:'attrition',
    reason:`Displayed ${attacks.total} damage exceeds the ${cover} this hand can cover at ${hp} HP`,
    evidence:{incoming:attacks.total,block,hand_cover:cover,gap,hp,lethal_in_turns:lethalIn}};
}

export function nextLocalPlay(state,options){
  const attacks=incomingAttacks(state);
  const living=livingEnemies(state);
  if(!attacks.known||living.length!==1)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  if(Math.max(0,attacks.total-block)>=hp)return null;
  const finisher=playable(options).find(option=>{
    const projected=proven(state,option);
    return projected&&projected.kills>=1;
  });
  if(finisher)return {kind:'resolve',reason:'Finish the last living enemy with a confirmed lethal play',
    option:finisher,evidence:{incoming:attacks.total,block,hp}};
  return null;
}
