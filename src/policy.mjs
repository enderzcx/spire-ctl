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
    list.push({option,damage,overkill:damage-needed});
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
  const gap=Math.max(0,attacks.total-Number(state.player?.block??0));
  if(gap<=0)return null;
  const entry=blockOptions(options).find(candidate=>candidate.block>=gap&&sideEffectFree(candidate.option));
  if(!entry)return null;
  return {kind:'guard',reason:`Guard ${attacks.total} displayed damage with ${entry.block} block`,
    option:entry.option,evidence:{incoming:attacks.total,block:Number(state.player?.block??0),gap}};
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

  const totalLife=living.reduce((sum,enemy)=>sum+enemy.hp+enemy.block,0);
  const killable=[...lethal.values()].reduce((sum,list)=>sum+Math.max(...list.map(entry=>entry.damage)),0);
  const canKillAll=[...lethal.keys()].length===living.length&&killable>=totalLife;
  if(canKillAll){
    const chosen=[];
    for(const entityId of lethal.keys()){
      const pick=cheapest(lethal.get(entityId));
      if(pick)chosen.push(pick);
    }
    if(chosen.length===living.length){
      const order=[...chosen].sort((a,b)=>a.overkill-b.overkill);
      return {kind:'kill',reason:`Displayed attacks cover all ${living.length} living enemies`,
        options:order.map(entry=>entry.option),evidence:{incoming:attacks.total,life:totalLife}};
    }
  }

  if(gap>=hp){
    // Surviving the turn outranks every hidden cost: an exhausting block card is
    // a normal choice when the alternative is death.
    const survival=blockers.filter(entry=>entry.block>=gap);
    if(survival.length)return {kind:'play',reason:`Survive ${attacks.total} displayed damage with ${survival[0].block} block`,
      option:survival[0].option,evidence:{incoming:attacks.total,block,hp}};
    return {kind:'escalate',reason:`Lethal ${gap} damage cannot be blocked from this hand`,
      evidence:{incoming:attacks.total,block,hp,best_block:blockers[0]?.block??0}};
  }

  // Routine defense that is fully determined by the numbers: no lethal line
  // exists, the displayed attack is known, and one play covers it completely.
  const guard=guardOption(state,options,attacks);
  if(guard)return guard;

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

// One locally-chosen next action inside a turn the program is already running.
//
// The intent is to stop asking a model about moves that only need arithmetic:
// a cheap attack whose number and target are both known. The program still
// refuses to be greedy: nothing is played while the displayed attack would be
// lethal, and unknown effects are only risked from a healthy position.
export function nextLocalPlay(state,options){
  const attacks=incomingAttacks(state);
  const living=enemiesOf(state);
  if(!attacks.known||!living.length)return null;
  const hp=Number(state.player?.hp??0),block=Number(state.player?.block??0);
  const gap=Math.max(0,attacks.total-block);
  if(gap>=hp)return null;

  const kills=lethalOptions(state,options);
  const ranked=[];
  for(const option of playable(options)){
    const damage=optionDamage(option);
    if(!isNum(damage)||damage<=0)continue;
    if(!optionTarget(option,state))continue;
    const label=String(option.label??'');
    const risky=unbounded.test(label);
    // A risky card is only acceptable when the account is clearly healthy, or
    // when it is the exact play that removes a living enemy this turn.
    const lethalNow=[...kills.values()].some(list=>list.some(entry=>entry.option===option));
    if(risky&&!lethalNow&&hp<Number(state.player?.max_hp??0)*.5)continue;
    ranked.push({option,damage,risky,cost:Number(option.command?.card_index??0)});
  }
  if(!ranked.length)return null;
  ranked.sort((a,b)=>(a.risky?1:0)-(b.risky?1:0)||b.damage-a.damage||a.cost-b.cost);
  const pick=ranked[0];
  return {kind:'resolve',reason:`Continue the turn with a known ${pick.damage}-damage play`,
    option:pick.option,evidence:{incoming:attacks.total,block,hp,damage:pick.damage}};
}
