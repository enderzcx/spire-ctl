// Canonical combat facts and a small whitelist of modeled effects.
//
// This is not a game simulator. Damage, block, energy and death are applied
// only for combinations the program can bound from the live advertised text.
// Everything else stays unknown and must not be invented as an exact fact.

const isNum=value=>Number.isFinite(value);
export const livingEnemies=state=>(state?.battle?.enemies??[]).filter(enemy=>enemy.hp>0);

const TIMES={两:2,二:2,三:3,四:4,五:5,twice:2,thrice:3};
const UNBOUNDED=/随机|random|加入.*手牌|加入.*抽牌堆|add .*to (your )?hand|lose \d+ (hp|life)|失去.*生命/i;

export function intentDamage(intent){
  const label=String(intent?.label??'').trim();
  if(label==='')return 0;
  const match=label.match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/);
  if(!match)return null;
  return Number(match[1])*Number(match[2]??1);
}

export function incomingAttacks(state){
  const perEnemy=[];let total=0;
  for(const enemy of livingEnemies(state)){
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

// Block absorbs first, then HP. An 8 HP enemy with 3 block is not killed by 6.
export function applyDamage(hp,block,damage){
  const hit=Math.max(0,Number(damage)||0);
  const currentHp=Math.max(0,Number(hp)||0);
  const currentBlock=Math.max(0,Number(block)||0);
  const through=Math.max(0,hit-currentBlock);
  const nextHp=Math.max(0,currentHp-through);
  return {hp:nextHp,block:Math.max(0,currentBlock-hit),killed:currentHp>0&&nextHp<=0};
}

export function parseEffect(text){
  const raw=String(text??'');
  const effect={known:false,damage:null,hits:1,block:null,draw:0,exhaust:false,random:false,
    selfDamage:false,allEnemies:false,vulnerable:null,weak:null,unbounded:false,original:raw};
  if(!raw)return effect;
  effect.random=UNBOUNDED.test(raw)||/随机/.test(raw);
  effect.selfDamage=/失去.*生命|lose \s*\d+\s*(hp|life)/i.test(raw);
  effect.exhaust=/消耗|exhaust/i.test(raw);
  effect.allEnemies=/所有敌人|全部敌人|all enemies/i.test(raw);
  const draw=raw.match(/抽\s*(\d+)\s*张牌|draw\s+(\d+)/i);
  if(draw)effect.draw=Number(draw[1]??draw[2]);
  const vulnerable=raw.match(/(\d+)\s*层易伤|apply\s+(\d+)\s+vulnerable/i);
  if(vulnerable)effect.vulnerable=Number(vulnerable[1]??vulnerable[2]);
  const weak=raw.match(/(\d+)\s*层虚弱|apply\s+(\d+)\s+weak/i);
  if(weak)effect.weak=Number(weak[1]??weak[2]);
  const block=raw.match(/(\d+)\s*点格挡|gain\s+(\d+)\s+block/i);
  if(block)effect.block=Number(block[1]??block[2]);
  const damage=raw.match(/(\d+)\s*点伤害(?:\s*(\d+)\s*次|\s*[x×]\s*(\d+)|(两|二|三|四|五)次)?/i)
    ??raw.match(/deal\s+(\d+)\s+damage(?:\s+(\d+)\s+times|\s+([x×]\s*\d+)|(\s+twice|\s+thrice))?/i);
  if(damage){
    effect.damage=Number(damage[1]);
    const word=String(damage[4]??'').trim().toLowerCase();
    const times=Number(damage[2]??damage[3]?.replace?.(/[x×]\s*/,'')??TIMES[word]??TIMES[word.replace(' ','')]);
    if(isNum(times)&&times>0)effect.hits=times;
    else if(/twice/i.test(String(damage[4]??'')))effect.hits=2;
    else if(/thrice/i.test(String(damage[4]??'')))effect.hits=3;
  }
  effect.unbounded=effect.random||effect.selfDamage||/加入.*手牌|加入.*抽牌堆|add .*discard|add .*draw/i.test(raw);
  effect.known=isNum(effect.damage)||isNum(effect.block);
  return effect;
}

export function optionDamage(option){
  const effect=parseEffect(option?.label);
  if(!isNum(effect.damage))return null;
  return effect.damage*(effect.hits||1);
}

export function optionBlock(option){
  const effect=parseEffect(option?.label);
  return isNum(effect.block)?effect.block:0;
}

export function optionTarget(option,state){
  const living=livingEnemies(state);
  const entityId=option?.command?.target;
  if(entityId)return living.find(enemy=>enemy.entity_id===entityId)??null;
  if(!Number.isFinite(optionDamage(option))&&!parseEffect(option?.label).allEnemies)return null;
  return living.length===1?living[0]:null;
}

export function cardCost(state,option){
  const index=option?.command?.card_index;
  const card=(state.player?.hand??[]).find(entry=>entry.index===index);
  const cost=Number(card?.cost);
  return isNum(cost)?cost:0;
}

export function optionEffect(option,state){
  const fromLabel=parseEffect(option?.label);
  const card=(state.player?.hand??[]).find(entry=>entry.index===option?.command?.card_index);
  const fromCard=parseEffect(card?.description);
  const effect=fromLabel.known?fromLabel:fromCard;
  const target=optionTarget(option,state);
  const total=isNum(effect.damage)?effect.damage*(effect.hits||1):null;
  const modeled=effect.known&&!effect.unbounded&&!effect.random
    &&(total===null||target||effect.allEnemies||option?.command?.action!=='play_card');
  return {
    ...effect,
    total,
    cost:cardCost(state,option),
    target,
    modeled,
    prefixSafe:Boolean(modeled&&!effect.draw&&!effect.exhaust&&effect.vulnerable==null&&effect.weak==null)
  };
}

function cloneCombat(state){
  return {
    state_type:state.state_type,
    run:state.run,
    player:{
      ...(state.player??{}),
      hand:(state.player?.hand??[]).map(card=>({...card})),
      block:Number(state.player?.block??0),
      hp:Number(state.player?.hp??0),
      energy:Number(state.player?.energy??0),
      discard_pile_count:Number(state.player?.discard_pile_count??0),
      exhaust_pile_count:Number(state.player?.exhaust_pile_count??0)
    },
    battle:{
      ...(state.battle??{}),
      enemies:(state.battle?.enemies??[]).map(enemy=>({...enemy,status:[...(enemy.status??[])]}))
    }
  };
}

function enemiesProjection(state){
  return (state.battle?.enemies??[]).map(({entity_id,...enemy})=>enemy);
}

// Apply one advertised play to a cloned combat snapshot. Unknown mechanics
// return {known:false} instead of a fabricated next state.
export function projectPlay(state,option){
  const effect=optionEffect(option,state);
  if(option?.command?.action!=='play_card')return {known:false,reason:'not a card play'};
  if(!effect.known)return {known:false,reason:'unmodeled effect',effect};
  if(effect.unbounded||effect.random)return {known:false,reason:'unbounded effect',effect};
  if(isNum(effect.total)&&!effect.allEnemies&&!effect.target)
    return {known:false,reason:'unknown target',effect};
  const next=cloneCombat(state);
  const cost=effect.cost;
  if(cost>next.player.energy)return {known:false,reason:'unaffordable',effect};
  next.player.energy-=cost;
  if(isNum(effect.block))next.player.block+=effect.block;
  let kills=0;
  if(isNum(effect.total)){
    const apply=enemy=>{
      const result=applyDamage(enemy.hp,enemy.block??0,effect.total);
      enemy.hp=result.hp;enemy.block=result.block;
      if(result.killed)kills+=1;
    };
    if(effect.allEnemies)livingEnemies(next).forEach(apply);
    else{
      const enemy=livingEnemies(next).find(entry=>entry.entity_id===effect.target.entity_id);
      if(!enemy)return {known:false,reason:'dead target',effect};
      apply(enemy);
    }
  }
  const index=next.player.hand.findIndex(card=>card.index===option.command.card_index);
  if(index<0)return {known:false,reason:'card not in hand',effect};
  next.player.hand.splice(index,1);
  if(effect.exhaust)next.player.exhaust_pile_count+=1;
  else next.player.discard_pile_count+=1;
  const attacks=incomingAttacks(next);
  const unblocked=attacks.known?Math.max(0,attacks.total-next.player.block):null;
  const expect={energy:next.player.energy};
  if(next.player.block!==Number(state.player?.block??0))expect.block=next.player.block;
  if(next.player.hp!==Number(state.player?.hp??0))expect.hp=next.player.hp;
  if(JSON.stringify(enemiesProjection(next))!==JSON.stringify(enemiesProjection(state)))
    expect.enemies=enemiesProjection(next);
  if(effect.exhaust){
    expect.exhaust=next.player.exhaust_pile_count;
    expect.discard=Number(state.player?.discard_pile_count??0);
  }
  return {
    known:true,
    effect,
    next,
    expect,
    kills,
    prefixSafe:effect.prefixSafe&&!effect.draw,
    boundary:effect.draw?'draw':null,
    incoming:attacks.known?attacks.total:null,
    unblocked,
    survives:unblocked===null?null:unblocked<next.player.hp
  };
}

export function projectPrefix(state,options){
  const steps=[];
  let current=state;
  for(const option of options){
    const projected=projectPlay(current,option);
    if(!projected.known)return {known:false,reason:projected.reason,steps};
    if(steps.length&&!projected.prefixSafe)return {known:false,reason:'later step is not deterministic',steps};
    if(projected.boundary==='draw'&&options.length>1)return {known:false,reason:'draw boundary',steps};
    steps.push({
      option,
      option_id:option.id,
      card_index:option.command.card_index,
      target_entity:projected.effect.target?.entity_id??null,
      target_combat_id:projected.effect.target?.combat_id??null,
      damage:projected.effect.total,
      block:projected.effect.block,
      energy:projected.effect.cost,
      kills:projected.kills,
      expect:projected.expect,
      prefixSafe:projected.prefixSafe,
      boundary:projected.boundary
    });
    current=projected.next;
  }
  const attacks=incomingAttacks(current);
  const unblocked=attacks.known?Math.max(0,attacks.total-Number(current.player?.block??0)):null;
  return {
    known:true,
    steps,
    next:current,
    energy:steps.reduce((sum,step)=>sum+step.energy,0),
    damage:steps.reduce((sum,step)=>sum+(step.damage??0),0),
    block:steps.reduce((sum,step)=>sum+(step.block??0),0),
    kills:steps.reduce((sum,step)=>sum+step.kills,0),
    incoming:attacks.known?attacks.total:null,
    unblocked,
    survives:unblocked===null?null:unblocked<Number(current.player?.hp??0)
  };
}
