// Mechanical progress versus a real strategic choice.
//
// The planner should not be paid for clicking "claim 17 gold" or "proceed". But
// a route, a card pick or a shop purchase IS a choice, and the program must
// never present one as mechanical. This module owns that line.
//
// A screen is mechanical only when every advertised action is one of:
//   - claim_reward for gold or a potion,
//   - claim_treasure_relic when the belt/relic set has room,
//   - proceed / advance_dialogue,
//   - confirm_selection for an already-selected, owner-approved pick,
//   - a menu `continue` or the new-run confirm chain,
//   - end_turn while a strategy is in force (handled by the battle loop).
// Anything else - map routing, card rewards, relic picks, shop purchases, event
// options, rest-site choices, potion use - is a decision.

const MECHANICAL_ACTIONS=new Set(['proceed','advance_dialogue','claim_reward','claim_treasure_relic']);
const RISKY_KEYWORDS=/curse|诅咒|笨拙|clumsy|pain|regret|eternal|永恒/i;

function rewardIsMechanical(reward){
  if(!reward)return false;
  if(reward.type==='gold')return true;
  if(reward.type==='potion')return true;
  return false;
}

function potionBeltHasRoom(state){
  const slots=Number(state.player?.max_potion_slots??0);
  const used=(state.player?.potions??[]).length;
  return used<slots;
}

function relicClaimIsMechanical(state){
  // A relic in a chest is free; a relic that costs a card or gold is not, and
  // an event that trades health for a relic is definitely not mechanical.
  return state.state_type==='treasure';
}

export function isMechanical(state,options){
  if(!options?.length)return {mechanical:false,reason:'no advertised actions'};
  if(state.state_type==='rewards'){
    const claimable=(state.rewards?.items??[]).filter(item=>rewardIsMechanical(item));
    const decorative=(state.rewards?.items??[]).filter(item=>!rewardIsMechanical(item));
    const actions=options.map(option=>option.command.action);
    if(decorative.length&&actions.every(action=>MECHANICAL_ACTIONS.has(action)))
      return {mechanical:false,reason:'a card reward is still on the table'};
    if(!claimable.length&&!actions.includes('proceed'))
      return {mechanical:false,reason:'nothing mechanical to claim'};
    if(!potionBeltHasRoom(state)&&(state.rewards?.items??[]).some(item=>item.type==='potion'))
      return {mechanical:false,reason:'potion belt is full, so a potion claim needs a decision'};
    return {mechanical:true,reason:'claim spoils and move on'};
  }
  if(state.state_type==='treasure'){
    return relicClaimIsMechanical(state)
      ?{mechanical:true,reason:'a chest relic is free'}
      :{mechanical:false,reason:'treasure needs a decision'};
  }
  if(state.state_type==='event'&&state.event?.in_dialogue)
    return {mechanical:true,reason:'advance dialogue only'};
  if(state.state_type==='menu'){
    const actions=options.map(option=>option.command.option);
    if(actions.every(option=>['continue','confirm','embark','standard','back'].includes(option)))
      return {mechanical:true,reason:'menu plumbing'};
    return {mechanical:false,reason:'menu choice'};
  }
  return {mechanical:false,reason:`${state.state_type} is a decision`};
}

export function mechanicalPlan(state,options){
  const verdict=isMechanical(state,options);
  if(!verdict.mechanical)return null;
  // Claims first so nothing is left behind, then the exit.
  const ordered=[...options].sort((a,b)=>{
    const rank=action=>action==='claim_reward'||action==='claim_treasure_relic'?0:
      action==='proceed'||action==='advance_dialogue'?1:2;
    return rank(a.command.action)-rank(b.command.action);
  });
  return {reason:verdict.reason,steps:ordered.length,options:ordered};
}
