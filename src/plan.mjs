import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {actions,inCombat,stateId,delay} from './game.mjs';
import {envelope,recorder,isRejectedReceipt} from './runner.mjs';

// A plan predicts all strategically relevant fields. `expect` patches this
// projection after each step; unspecified fields must remain unchanged.
export function projection(s) {
  const p=s.player??{};
  return {type:s.state_type,run:s.run,round:s.battle?.round,turn:s.battle?.turn,
    hp:p.hp,max_hp:p.max_hp,energy:p.energy,max_energy:p.max_energy,stars:p.stars,
    block:p.block,status:p.status??[],orbs:p.orbs??[],orb_slots:p.orb_slots,pets:p.pets??[],
    relics:p.relics??[],potions:p.potions??[],
    hand:(p.hand??[]).map(({id,cost,star_cost,is_upgraded,description})=>({id,cost,star_cost,is_upgraded,description})),
    draw:p.draw_pile_count,discard:p.discard_pile_count,exhaust:p.exhaust_pile_count,
    enemies:(s.battle?.enemies??[]).map(({entity_id,...enemy})=>enemy)};
}

const queueIdle=s=>s.battle?.action_running===false&&s.battle?.action_queue_empty===true;

export function validatePlan(plan,initial) {
  if(plan.state_id!==stateId(initial))throw Error('Plan is stale');
  if(!inCombat(initial)||!initial.battle?.ready_for_action)throw Error('Plan requires ready combat');
  if(!queueIdle(initial))throw Error('Plan requires the queue-aware bridge; restart after installing the current patch');
  if(!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>10)throw Error('Plan requires 1..10 steps');
  const indexes=new Set(),allowed=new Set(Object.keys(projection(initial)));
  for(const step of plan.steps){
    if(!Number.isInteger(step.card_index)||!initial.player.hand.some(c=>c.index===step.card_index))throw Error('Plan card must come from the initial hand');
    if(indexes.has(step.card_index))throw Error('Cannot play the same original hand card twice');indexes.add(step.card_index);
    if(!step.expect||typeof step.expect!=='object'||Array.isArray(step.expect))throw Error('Each step needs an expect patch');
    for(const key of Object.keys(step.expect))if(!allowed.has(key))throw Error(`Unknown expected field: ${key}`);
    // Never predict unseen draws/random effects. Stop this prefix before them.
    if('draw' in step.expect || 'run' in step.expect || 'round' in step.expect || 'turn' in step.expect || 'type' in step.expect)throw Error('Plan cannot cross draws, rooms or turns');
  }
}

export async function runPlan(game,plan,{dir,control=dir,record=recorder(dir),timeout=8000}={}) {
  try{await readFile(join(control,'HALTED'));throw Error('Previous action outcome unknown');}catch(e){if(e.code!=='ENOENT')throw e;}
  let state=await game.read();validatePlan(plan,state);
  const original=state.player.hand.map(c=>({...c,original_index:c.index}));
  let remaining=[...original],predicted=projection(state);
  for(let n=0;n<plan.steps.length;n++){
    const step=plan.steps[n],live=await game.read();
    if(!isDeepStrictEqual(projection(live),predicted)||!live.battle?.ready_for_action||!queueIdle(live))return {reason:'plan_invalidated_before_action',completed:n,...envelope(live)};
    const index=remaining.findIndex(c=>c.original_index===step.card_index);
    if(index<0)throw Error('Original card no longer in hand');
    const card=live.player.hand[index];
    const target=step.target_combat_id===undefined?undefined:live.battle.enemies.find(e=>e.combat_id===step.target_combat_id);
    if(step.target_combat_id!==undefined&&!target)return {reason:'target_no_longer_alive',completed:n,...envelope(live)};
    const option=actions(live,{deduplicate:false}).find(o=>o.command.action==='play_card'&&o.command.card_index===card.index&&o.command.target===target?.entity_id);
    if(!option)return {reason:'planned_card_not_legal',completed:n,...envelope(live)};
    const nextHand=predicted.hand.filter((_,i)=>i!==index);
    const expected={...predicted,hand:nextHand,discard:predicted.discard+1,...step.expect};
    if(expected.hand.length!==nextHand.length||expected.hand.some((c,i)=>c.id!==nextHand[i].id))throw Error('Plan may not draw, generate, reorder or replace cards');
    await record({event:'plan_dispatch',step:n,option,before:live,expected});
    await writeFile(join(control,'HALTED'),JSON.stringify({reason:'in_flight',step:n,option,expectedId:stateId(live)}),{flag:'wx'});
    const started=performance.now();let last,confirmed=false;
    try{
      const receipt=await game.send(option.command);
      const deadline=Date.now()+timeout;let matches=0;
      while(Date.now()<deadline){
        last=await game.read();
        if(!last.state_type||last.state_type==='unknown'){matches=0;await delay(100);continue;}
        if(!inCombat(last)){
          await record({event:'plan_boundary',step:n,receipt,state:last});
          await rm(join(control,'HALTED'));
          return {reason:'combat_or_selection_boundary',completed:last.state_type==='rewards'?n+1:n,dispatched:n+1,...envelope(last)};
        }
        matches=last.battle?.ready_for_action&&queueIdle(last)&&isDeepStrictEqual(projection(last),expected)?matches+1:0;
        if(matches>=3){confirmed=true;break;}await delay(100);
      }
      if(!confirmed){
        await writeFile(join(control,'HALTED'),JSON.stringify({reason:'Plan result deviated or not settled',step:n,option}));
        await record({event:'plan_deviation',step:n,expected,state:last});
        return {reason:'plan_deviation_no_replay',completed:n+1,...envelope(last)};
      }
      await record({event:'plan_verified',step:n,option,after:last,action_ms:Math.round(performance.now()-started)});
      await rm(join(control,'HALTED'));
      remaining.splice(index,1);predicted=projection(last);state=last;
    }catch(e){
      if(isRejectedReceipt(e)){
        await rm(join(control,'HALTED'));
        await record({event:'plan_rejected',step:n,option,reason:e.message});
        throw e;
      }
      await writeFile(join(control,'HALTED'),JSON.stringify({reason:e.message,step:n,option}));
      throw e;
    }
  }
  return {reason:'plan_complete',completed:plan.steps.length,...envelope(state)};
}
