// Conditional continuation after a takeover.
//
// A planner packet is expensive, and re-deciding the same already-assessed risk
// card by card is what makes a run slow. The contract is therefore: a takeover
// may return a strategy with explicit conditions, the local loop applies it
// while those conditions hold, and anything that genuinely changes the picture
// invalidates it.
//
// The program never treats a strategy as permission to skip legality. Every
// preference is re-bound to an option advertised by the live state, and the
// caller executes it through the normal path.
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

export const strategyFile=dir=>join(dir,'strategy.json');
const journalFile=dir=>join(dir,'handoffs.json');

export function conditionHolds(condition,state){
  if(!condition||typeof condition!=='object')return false;
  const hp=Number(state.player?.hp??0);
  const enemies=(state.battle?.enemies??[]).filter(enemy=>enemy.hp>0);
  switch(condition.kind){
    case 'hp_at_least':return hp>=Number(condition.value);
    case 'hp_at_most':return hp<=Number(condition.value);
    case 'same_floor':return state.run?.act===condition.act&&state.run?.floor===condition.floor;
    case 'enemy_count_at_most':return enemies.length<=Number(condition.value);
    case 'same_enemies':{
      const ids=enemies.map(enemy=>enemy.entity_id).sort().join(',');
      return ids===(condition.entity_ids??[]).slice().sort().join(',');
    }
    case 'intents_unchanged':{
      const intents=enemies.map(enemy=>`${enemy.entity_id}:${(enemy.intents??[]).map(i=>i.label).join('+')}`).join('|');
      return intents===condition.signature;
    }
    default:return false;
  }
}

// Every reason a strategy stops applying. An unknown condition kind never
// counts as satisfied, so an unreadable strategy simply does nothing.
export function strategyApplies(strategy,state){
  if(!strategy||!Array.isArray(strategy.conditions)||!strategy.conditions.length)
    return {ok:false,reason:'strategy has no conditions'};
  if(strategy.expires_on?.length)
    for(const condition of strategy.expires_on)
      if(conditionHolds(condition,state))
        return {ok:false,reason:`invalidated by ${condition.kind}`};
  for(const condition of strategy.conditions)
    if(!conditionHolds(condition,state))
      return {ok:false,reason:`condition no longer holds: ${condition.kind}`};
  return {ok:true};
}

// The first advertised option whose label matches a preference. Legality stays
// with the caller's option list; this only orders what is already legal.
export function strategyPreference(strategy,options){
  for(const preference of strategy?.order??[]){
    const pattern=String(preference.match??'');
    if(!pattern)continue;
    const option=options.find(candidate=>String(candidate.label??'').includes(pattern));
    if(option)return {option,preference};
  }
  // Ending the turn is mechanical: nothing about the strategy can make it wrong,
  // and refusing it would stall the loop on an empty hand. It is therefore the
  // implicit last preference, and a strategy never has to spell it out.
  const endTurn=options.find(candidate=>candidate.command?.action==='end_turn');
  if(endTurn)return {option:endTurn,preference:{match:'end turn',why:'nothing else is playable; close the turn'}};
  return null;
}

export async function loadStrategy(dir){
  try{return JSON.parse(await readFile(strategyFile(dir),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export async function saveStrategy(dir,strategy){
  await mkdir(dir,{recursive:true});
  await writeFile(strategyFile(dir),JSON.stringify(strategy,null,2));
}

export async function clearStrategy(dir){
  await rm(strategyFile(dir),{force:true});
}

// One handover per distinct state unless a planner strategy exists for it. This
// is a loop breaker, not a confidence shortcut: it prevents asking the same
// question again and again, and it never substitutes repeated sampling for a
// decision.
export async function noteHandoff(dir,stateId,reason){
  await mkdir(dir,{recursive:true});
  let journal={};
  try{journal=JSON.parse(await readFile(journalFile(dir),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const entry=journal[stateId]??{count:0,first_at:new Date().toISOString()};
  entry.count++;
  entry.last_reason=reason;
  entry.last_at=new Date().toISOString();
  journal[stateId]=entry;
  await writeFile(journalFile(dir),JSON.stringify(journal,null,2));
  return entry;
}

export async function seenHandoff(dir,stateId){
  try{
    const journal=JSON.parse(await readFile(journalFile(dir),'utf8'));
    return journal[stateId]??null;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export async function clearHandoffs(dir){
  await rm(journalFile(dir),{force:true});
}
