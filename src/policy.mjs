// Program-side local policy and combat arithmetic.
//
// This is not a game simulator and it does not pretend to be one. It uses only
// what the bridge reports plus simple, checkable arithmetic, so it can:
//   - give the fast model a shortlist instead of the whole hand,
//   - pick a safe fallback when the fast model is not confident,
//   - refuse to decide when the situation needs a real planner.
//
// The caller keeps the authority: a local decision must still pass the normal
// legality and execution path, and every chosen option carries its reason.

const isNum=value=>Number.isFinite(value);
const enemiesOf=state=>(state?.battle?.enemies??[]).filter(enemy=>enemy.hp>0);

// Advertised damage values are absolute: the bridge already folds strength,
// weak and vulnerable into the label. A label that is not a plain number means
// the engine cannot be trusted for arithmetic, so the policy declines.
export function intentDamage(intent){
  const label=String(intent?.label??'').trim();
  if(label==='')return 0;
  const match=label.match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/);
  if(!match)return null;
  return Number(match[1])*Number(match[2]??1);
}

export function incomingAttacks(state){
  const perEnemy=[];let total=0;
  for(const enemy of enemiesOf(state)){
    let damage=0;
    for(const intent of enemy.intents??[]){
      if(!String(intent.type??'').includes('Attack')&&!String(intent.title??'').includes('攻'))continue;
      const value=intentDamage(intent);
      if(value===null)return {known:false,total:null,perEnemy:[]};
      damage+=value;
    }
    total+=damage;
    perEnemy.push({entity_id:enemy.entity_id,combat_id:enemy.combat_id,hp:enemy.hp,block:enemy.block??0,
      incoming:damage,statuses:enemy.status??[]});
  }
  return {known:true,total,perEnemy};
}

export function incomingDamage(state){
  const attacks=incomingAttacks(state);
  return attacks.known?attacks.total:null;
}

// Best-effort damage for one advertised attack option against one enemy. The
// label is authoritative; the comparison is only used to rank candidates.
// "造成9点伤害两次" / "7 ×2" / "造成8点伤害" all describe one play, so the
// repeat count multiplies a single hit.
export function optionDamage(option){
  const label=String(option?.label??'');
  if(!label.includes('伤害')&&!/damage/i.test(label))return null;
  const match=label.match(/(\d+)\s*点伤害(?:\s*(\d+)\s*次|\s*[x×]\s*(\d+)|(两|二|三|四|五)次)?/);
  if(!match)return null;
  const per=Number(match[1]);
  if(!isNum(per))return null;
  const repeated={两:2,二:2,三:3,四:4,五:5}[match[4]];
  const times=Number(match[2]??match[3]??repeated??1);
  return per*(isNum(times)&&times>0?times:1);
}

export function optionBlock(option){
  const label=String(option?.label??'');
  const match=label.match(/(\d+)\s*点格挡/);
  return match?Number(match[1]):0;
}

// The advertised label carries the target entity id for targeted cards. With a
// single living enemy there is only one place damage can land, so an omitted
// target is unambiguous; with several enemies an omitted target stays unknown
// and such an option is never treated as lethal.
export function optionTarget(option,state){
  const living=enemiesOf(state);
  const entityId=option?.command?.target;
  if(entityId)return living.find(enemy=>enemy.entity_id===entityId)??null;
  return living.length===1?living[0]:null;
}

const playable=options=>options.filter(option=>option.command?.action==='play_card');
const endTurnOf=options=>options.find(option=>option.command?.action==='end_turn')??null;

function lethalOptions(state,options){
  const byTarget=new Map();
  for(const option of playable(options)){
    const damage=optionDamage(option);
    const target=optionTarget(option,state);
    if(!isNum(damage)||!target)continue;
    const needed=Math.max(0,target.hp-target.block);
    if(damage<needed)continue;
    const list=byTarget.get(target.entity_id)??[];
    list.push({option,damage,overkill:damage-needed,card_index:option.command?.card_index});
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

// Cards whose text implies a cost the arithmetic cannot see (self damage,
// exhaust, random discard) are never chosen as a program guard.
const sideEffectFree=option=>!/失去.*生命|消耗|随机/.test(String(option?.label??''));

// A single guard play is only taken when it fully covers the displayed attack
// and carries no hidden cost. This is stricter than "pick a good card": it is
// the case where every reasonable player makes the same move.
export function guardOption(state,options,attacks=incomingAttacks(state)){
  if(!attacks.known||attacks.total<=0)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  // Routine mitigation is a tactical preference and belongs to the fast model.
  // Only an unblockable death is deterministic, and only when exactly one play
  // prevents it: two ways to survive would itself be a choice to weigh.
  if(gap<hp)return null;
  const covering=blockOptions(options).filter(candidate=>candidate.block>=gap&&sideEffectFree(candidate.option));
  if(covering.length!==1)return null;
  const entry=covering[0];
  return {kind:'play',reason:`Survive ${attacks.total} displayed damage with ${entry.block} block from the only such play`,
    option:entry.option,evidence:{incoming:attacks.total,block,hp,gap}};
}

// One distinct card per living enemy, inside the energy budget. Returning null
// is the honest answer when the cards or the energy do not actually cover the
// board; a fake "deterministic" kill would be worse than asking the model.
function affordableKillLine(state,living,lethal){
  const energy=Number(state.player?.energy??0);
  const eligible=living.map(enemy=>({enemy,list:lethal.get(enemy.entity_id)??[]}));
  if(eligible.some(entry=>!entry.list.length))return null;
  // Fewest options first, so a scarce target is not starved by a greedy sibling.
  eligible.sort((a,b)=>a.list.length-b.list.length);
  const used=new Set(),chosen=[];
  let cost=0;
  for(const {list} of eligible){
    const pick=list.filter(entry=>energyOf(state,entry)!==null&&!used.has(entry.card_index))
      .sort((a,b)=>energyOf(state,a)-energyOf(state,b)||a.overkill-b.overkill)[0];
    if(!pick)return null;
    used.add(pick.card_index);
    chosen.push(pick);
    cost+=energyOf(state,pick);
  }
  return cost>energy?null:{chosen,cost,energy};
}

// Advertised options can state a cost; when the label does not, fall back to the
// card's own cost from the state hand.
function energyOf(state,entry){
  const card=(state.player?.hand??[]).find(c=>c.index===entry.card_index);
  const cost=Number(card?.cost);
  return isNum(cost)?cost:0;
}

// Decide locally only when the arithmetic leaves one defensible action:
//   1. finish: the displayed attacks cover every living enemy (a kill needs no
//      defense that turn),
//   2. survive: displayed attacks are lethal and a play prevents it,
//   3. guard: displayed attacks are non-lethal and one clean play covers them,
//   4. mitigate: material damage with only partial answers, offered to the fast
//      model as a shortlist, never forced,
//   5. otherwise: nothing (the fast model or the planner decides).
export function localPolicy(state,options){
  const attacks=incomingAttacks(state);
  const living=enemiesOf(state);
  if(!attacks.known||!living.length)return {kind:'decline',reason:'Combat arithmetic unavailable'};
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  const lethal=lethalOptions(state,options);
  const blockers=blockOptions(options);

  // 1. Finish: displayed attacks cover every living enemy with distinct cards
  //    inside the energy budget. Killing needs no defense that turn, so this is
  //    settled arithmetic rather than a preference. The same original card must
  //    never be counted twice for two targets, and the line must be affordable.
  const killLine=affordableKillLine(state,living,lethal);
  if(killLine){
    const order=[...killLine.chosen].sort((a,b)=>a.overkill-b.overkill);
    return {kind:'kill',reason:`Displayed attacks cover all ${living.length} living enemies`,
      options:order.map(entry=>entry.option),
      evidence:{incoming:attacks.total,cost:killLine.cost,energy:killLine.energy}};
  }

  // 2. Survive: the displayed attack kills us and exactly one play prevents it.
  //    Surviving outranks every hidden cost, but two possible saves would be a
  //    choice, so the fast model takes it.
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

  // 3. Everything else is a tactical preference (which card first, damage versus
  //    block, how to spend limited energy) and belongs to the fast model. The
  //    program only narrows the menu when a mitigation option is clearly
  //    relevant, and never picks between comparable cards itself.
  if(gap>=Math.max(8,Math.round(hp*.25))&&blockers.length){
    const candidates=blockers.slice(0,3).map(entry=>({option:entry.option,why:`${entry.block} block against ${attacks.total} displayed damage`}));
    return {kind:'shortlist',reason:`Significant ${gap} unblocked damage; keep mitigation in the running`,
      options:candidates.map(candidate=>candidate.option),candidates,evidence:{incoming:attacks.total,block,hp}};
  }

  return {kind:'decline',reason:'No locally decisive line; the fast model decides'};
}

// A compact next-action proposal for a deterministic prefix, or null when the
// plan would have to guess. Only attacks with a stated number and a living
// target qualify; unknown effects keep the plan out of the planner's way.
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

// Cards whose text reports an effect the arithmetic cannot bound. They may be
// played when the account is healthy, but never while a single mistake is fatal.
const unbounded=/随机|加入.*手牌|加入.*抽牌堆|消耗|失去.*生命/;

// A single-action continuation that is NOT a tactical choice. Only two shapes
// qualify, because anything else ("hit the biggest number", "block instead of
// An attrition check: the enemy is out-scaling what this hand can answer.
//
// The program owns arithmetic, and one thing arithmetic can see is a fight that
// cannot be won from here: the displayed attack is larger than anything the hand
// can block, and the position is already critical. Reporting that is not a win
// condition - it is a reason to stop grinding and let the planner decide
// (potions, a different line, or accepting the loss). It never overrides a
// lethal line or a full cover.
export function attritionRisk(state,options){
  const attacks=incomingAttacks(state);
  if(!attacks.known||!attacks.total)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap<=0)return null;
  const living=enemiesOf(state);
  if(!living.length)return null;
  // The best this hand can cover by blocking, and whether it can remove an
  // attacker instead (either answer means the position is still playable).
  const cover=playable(options).reduce((best,option)=>Math.max(best,optionBlock(option)),0);
  if([...lethalOptions(state,options).keys()].length)return null;
  if(cover>=gap)return null;
  // Uncovered, and this turn already empties the health bar: two such turns end
  // the run, so grinding teaches nothing.
  const lethalIn=Math.ceil(hp/Math.max(1,gap-cover));
  if(lethalIn>1)return null;
  return {kind:'attrition',
    reason:`Displayed ${attacks.total} damage exceeds the ${cover} this hand can cover at ${hp} HP`,
    evidence:{incoming:attacks.total,block,hand_cover:cover,gap,hp,lethal_in_turns:lethalIn}};
}

// attack") is a tactical preference and belongs to the fast model:
//   - the one and only playable card, so there is no alternative to weigh,
//   - a play that removes the last living enemy this turn.
// When several cards could reasonably be played, this returns null on purpose.
export function nextLocalPlay(state,options){
  const attacks=incomingAttacks(state);
  const living=enemiesOf(state);
  if(!attacks.known||!living.length)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap>=hp)return null;

  const cards=playable(options);

  // A confirmed lethal removes the enemy, so no other card can beat it and the
  // order stops mattering. This is the one play the program may choose from a
  // full hand.
  if(living.length===1){
    const finisher=cards.find(option=>{
      if(!sideEffectFree(option))return false;
      const damage=optionDamage(option),target=optionTarget(option,state);
      return isNum(damage)&&damage>0&&target&&damage>=Math.max(0,target.hp-target.block);
    });
    if(finisher)return {kind:'resolve',reason:`Finish the last living enemy with a confirmed lethal play`,
      option:finisher,evidence:{incoming:attacks.total,block,hp,damage:optionDamage(finisher)}};
  }

  // Otherwise only a hand with a single possible action is free of choice.
  if(cards.length!==1)return null;
  const option=cards[0];
  if(!sideEffectFree(option))return null;
  if(unbounded.test(String(option.label??'')))return null;
  return {kind:'resolve',reason:'Play the only playable card',option,
    evidence:{incoming:attacks.total,block,hp}};
}

// The fast model is asked one step at a time and sometimes answers the same
// option twice with a stable-but-below-cutoff confidence. Handing that back
// forever is worse than acting on it, but only when the program can verify the
// proposal is not a blunder: the play is legal, it is not skipped in a turn
// where standing still loses, and it does not touch unknown effects.
export function verifyStableProposal(state,options,option){
  const attacks=incomingAttacks(state);
  const living=enemiesOf(state);
  if(!attacks.known||!living.length)return {ok:false,reason:'Combat arithmetic unavailable'};
  if(!option||option.command?.action!=='play_card')return {ok:false,reason:'Not a card play'};
  // The proposal must be one of the options the program actually offered, with
  // the label it advertised: a same-id different-text answer is not verifiable.
  const offered=options.find(candidate=>candidate.id===option.id);
  if(!offered||offered.label!==option.label)return {ok:false,reason:'Proposal does not match an advertised option'};
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  const label=String(option.label??'');
  if(gap>=hp){
    // A losing turn must be answered with a play that actually prevents it.
    const covers=blockOptions(options).some(entry=>entry.option===option&&entry.block>=gap);
    if(!covers)return {ok:false,reason:`Losing ${gap} damage standstill; proposal does not prevent it`};
    return {ok:true,reason:'Proposed play prevents the lethal turn'};
  }
  if(unbounded.test(label))return {ok:false,reason:'Proposal uses an effect the arithmetic cannot bound'};
  return {ok:true,reason:'Stable proposal with no unbounded effect'};
}
