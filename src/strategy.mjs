// Conditional continuation after a takeover.
//
// A strategy is an explicit, fail-closed contract: unknown kinds, missing run
// identity and unmatched order do nothing. It never silently ends a turn while
// a playable card remains, and it never carries from one run to another merely
// because the floor number matches.
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

export const strategyFile=dir=>join(dir,'strategy.json');
const journalFile=dir=>join(dir,'handoffs.json');
const CONDITION_KINDS=new Set(['hp_at_least','hp_at_most','same_floor','same_run','enemy_count_at_most','same_enemies','intents_unchanged']);

export function runIdentity(state){
  const run=state?.run;
  if(!run||typeof run!=='object')return null;
  const id=run.run_uuid??run.run_id??run.id??run.seed??run.character_seed;
  const character=run.character??run.player_class??run.character_id??null;
  if(id==null||String(id)==='')return null;
  return JSON.stringify({id:String(id),character:character==null?null:String(character)});
}

export function bindStrategy(strategy,state){
  const identity=runIdentity(state);
  if(!identity)throw Error('Strategy requires a run identity from the live state');
  return {
    ...strategy,
    run_identity:identity,
    created_floor:Number(state.run?.floor),
    created_act:state.run?.act??null
  };
}

export function conditionHolds(condition,state){
  if(!condition||typeof condition!=='object')return false;
  if(!CONDITION_KINDS.has(condition.kind))return false;
  const hp=Number(state.player?.hp??0);
  const enemies=(state.battle?.enemies??[]).filter(enemy=>enemy.hp>0);
  switch(condition.kind){
    case 'hp_at_least':return hp>=Number(condition.value);
    case 'hp_at_most':return hp<=Number(condition.value);
    case 'same_floor':return state.run?.act===condition.act&&state.run?.floor===condition.floor;
    case 'same_run':return runIdentity(state)===String(condition.value??'');
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

function expiryFires(condition,state){
  if(!condition||typeof condition!=='object')return true;
  if(!CONDITION_KINDS.has(condition.kind))return true;
  return conditionHolds(condition,state);
}

export function strategyApplies(strategy,state,{inCall=false}={}){
  if(!strategy||!Array.isArray(strategy.conditions)||!strategy.conditions.length)
    return {ok:false,reason:'strategy has no conditions'};
  const ephemeral=inCall||strategy.in_call===true;
  if(!ephemeral){
    if(!strategy.run_identity)return {ok:false,reason:'strategy is missing run identity'};
    const identity=runIdentity(state);
    if(!identity||identity!==strategy.run_identity)
      return {ok:false,reason:'strategy belongs to a different run'};
  }
  if(strategy.expires_on?.length)
    for(const condition of strategy.expires_on)
      if(expiryFires(condition,state))
        return {ok:false,reason:`invalidated by ${condition.kind??'unreadable expiry'}`};
  for(const condition of strategy.conditions)
    if(!conditionHolds(condition,state))
      return {ok:false,reason:`condition no longer holds: ${condition.kind}`};
  return {ok:true};
}

export function strategyPreference(strategy,options){
  for(const preference of strategy?.order??[]){
    const pattern=String(preference.match??'');
    if(!pattern)continue;
    const option=options.find(candidate=>String(candidate.label??'').includes(pattern));
    if(option)return {option,preference};
  }
  const playable=options.filter(candidate=>candidate.command?.action==='play_card');
  if(playable.length)return null;
  const endTurn=options.find(candidate=>candidate.command?.action==='end_turn');
  if(endTurn)return {option:endTurn,preference:{match:'end turn',why:'no playable card remains; close the turn'}};
  return null;
}

export function constrainOptions(strategy,options){
  if(!strategy?.order?.length)return {options,matched:true};
  const matched=[];
  for(const preference of strategy.order){
    const pattern=String(preference.match??'');
    if(!pattern)continue;
    for(const option of options)
      if(String(option.label??'').includes(pattern)&&!matched.includes(option))matched.push(option);
  }
  if(!matched.length)return {options:[],matched:false};
  const endTurn=options.find(option=>option.command?.action==='end_turn');
  if(endTurn&&!matched.includes(endTurn))matched.push(endTurn);
  return {options:matched,matched:true};
}

export async function loadStrategy(dir,state=null){
  let strategy=null;
  try{strategy=JSON.parse(await readFile(strategyFile(dir),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!state)return strategy;
  if(!strategy?.run_identity||runIdentity(state)!==strategy.run_identity){
    if(Number.isFinite(strategy?.created_floor)&&Number.isFinite(state.run?.floor)
      &&strategy.created_floor>state.run.floor)await clearStrategy(dir);
    return null;
  }
  return strategy;
}

export async function saveStrategy(dir,strategy){
  await mkdir(dir,{recursive:true});
  await writeFile(strategyFile(dir),JSON.stringify(strategy,null,2));
}

export async function clearStrategy(dir){
  await rm(strategyFile(dir),{force:true});
}

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

const guardFile=dir=>join(dir,'guard-state.json');
const bandOf=hp=>Math.floor(Number(hp)/5);

export function guardSignature(state){
  const enemies=(state.battle?.enemies??[]).filter(enemy=>enemy.hp>0)
    .map(enemy=>enemy.entity_id).sort().join(',');
  const identity=runIdentity(state)??`${state.run?.act??'?'}:${state.run?.floor??'?'}`;
  return `${bandOf(state.player?.hp??0)}|${identity}|${enemies}`;
}

export async function noteGuard(dir,guard,signature){
  await mkdir(dir,{recursive:true});
  let store={};
  try{store=JSON.parse(await readFile(guardFile(dir),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const seen=store[guard]===signature;
  store[guard]=signature;
  await writeFile(guardFile(dir),JSON.stringify(store,null,2));
  return {repeated:seen};
}

export async function clearGuards(dir){
  await rm(guardFile(dir),{force:true});
}
