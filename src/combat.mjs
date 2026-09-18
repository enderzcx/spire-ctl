// Canonical combat facts. Exact projections exist only for a small whitelist
// of complete card texts with known numeric costs and no unmodeled modifiers.
// A numeric regex hit is not a complete effect.

const isNum=value=>Number.isFinite(value);
export const livingEnemies=state=>(state?.battle?.enemies??[]).filter(enemy=>enemy.hp>0);
const TIMES={两:2,二:2,三:3,四:4,五:5};

export function intentDamage(intent){
  const label=String(intent?.label??'').trim();
  const isAttack=String(intent?.type??'').includes('Attack')||String(intent?.title??'').includes('攻');
  if(isAttack){
    if(label==='')return null;
    const match=label.match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/);
    if(!match)return null;
    return Number(match[1])*Number(match[2]??1);
  }
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
      if(/unknown|未知|[?？]/i.test(`${intent.type??''} ${intent.title??''} ${intent.label??''}`))
        return {known:false,total:null,perEnemy:[]};
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

export function applyDamage(hp,block,damage){
  const hit=Math.max(0,Number(damage)||0);
  const currentHp=Math.max(0,Number(hp)||0);
  const currentBlock=Math.max(0,Number(block)||0);
  const through=Math.max(0,hit-currentBlock);
  const nextHp=Math.max(0,currentHp-through);
  return {hp:nextHp,block:Math.max(0,currentBlock-hit),killed:currentHp>0&&nextHp<=0};
}

export function parseCost(raw){
  if(raw==null||raw==='')return {known:false,value:null,reason:'missing cost'};
  const text=String(raw).trim();
  if(!/^\d+$/.test(text))return {known:false,value:null,reason:'unsupported cost'};
  return {known:true,value:Number(text)};
}

function effectText(text,{label=false}={}){
  let raw=String(text??'');
  if(label)raw=raw.replace(/\s*->\s*.*$/,'')
    .replace(/\(\s*energy\s+[^)]+\)/ig,'').replace(/^[^:]+:\s*/,'');
  return raw.replace(/[。.\s]+$/u,'').trim();
}

// Exact templates only. Leftover clauses, conditionals and triggers are unknown.
export function parseCompleteEffect(text,options={}){
  const body=effectText(text,options);
  const unknown={known:false,complete:false,damage:null,hits:1,block:null,allEnemies:false,original:String(text??'')};
  if(!body)return unknown;
  let match=body.match(/^造成(\d+)点伤害(?:(\d+)次|(两|二|三|四|五)次)?(?:对(?:所有|全部)敌人)?$/);
  if(match){
    const hits=match[2]?Number(match[2]):(TIMES[match[3]]??1);
    return {known:true,complete:true,damage:Number(match[1]),hits,block:null,
      allEnemies:/所有敌人|全部敌人/.test(body),original:String(text??'')};
  }
  match=body.match(/^deal\s+(\d+)\s+damage(?:\s+(\d+)\s+times|\s+twice)?(?:\s+to\s+all\s+enemies)?$/i);
  if(match){
    const hits=match[2]?Number(match[2]):(/twice/i.test(body)?2:1);
    return {known:true,complete:true,damage:Number(match[1]),hits,block:null,
      allEnemies:/all enemies/i.test(body),original:String(text??'')};
  }
  match=body.match(/^获得(\d+)点格挡$/);
  if(match)return {known:true,complete:true,damage:null,hits:1,block:Number(match[1]),allEnemies:false,original:String(text??'')};
  match=body.match(/^gain\s+(\d+)\s+block$/i);
  if(match)return {known:true,complete:true,damage:null,hits:1,block:Number(match[1]),allEnemies:false,original:String(text??'')};
  return unknown;
}

export function parseEffect(text){
  const complete=parseCompleteEffect(text);
  if(complete.complete)return {...complete,draw:0,exhaust:false,random:false,selfDamage:false,
    unbounded:false,vulnerable:null,weak:null};
  const raw=String(text??'');
  return {known:false,complete:false,damage:null,hits:1,block:null,draw:0,exhaust:/消耗|exhaust/i.test(raw),
    random:/随机|random/i.test(raw),selfDamage:/失去.*生命|lose \s*\d+\s*(hp|life)/i.test(raw),
    allEnemies:/所有敌人|全部敌人|all enemies/i.test(raw),vulnerable:null,weak:null,
    unbounded:true,original:raw};
}

export function optionDamage(option){
  const effect=parseCompleteEffect(option?.label,{label:true});
  if(!effect.complete||!isNum(effect.damage))return null;
  return effect.damage*(effect.hits||1);
}

export function optionBlock(option){
  const effect=parseCompleteEffect(option?.label,{label:true});
  return effect.complete&&isNum(effect.block)?effect.block:0;
}

export function optionTarget(option,state){
  const living=livingEnemies(state);
  const entityId=option?.command?.target;
  if(entityId)return living.find(enemy=>enemy.entity_id===entityId)??null;
  if(!Number.isFinite(optionDamage(option))&&!parseCompleteEffect(option?.label,{label:true}).allEnemies)return null;
  return living.length===1?living[0]:null;
}

export function cardCost(state,option){
  const index=option?.command?.card_index;
  const card=(state.player?.hand??[]).find(entry=>entry.index===index);
  return parseCost(card?.cost);
}

// Observed on the supported bridge: Burning Blood has no in-combat card
// trigger; its sole effect is six HP at victory. Any changed/missing wording
// stays unknown, as do all other relics. Never generalize from the name alone.
function knownBurningBlood(relic){
  return relic?.id==='BURNING_BLOOD'&&[
    '在战斗结束时，回复6点生命。',
    'At the end of combat, heal 6 HP.'
  ].includes(String(relic.description??'').trim());
}

export function combatContext(state){
  const playerStatus=state.player?.status??[];
  const relics=state.player?.relics??[];
  const enemyStatus=(state.battle?.enemies??[]).flatMap(enemy=>enemy.status??[]);
  const unknownPlayer=playerStatus.filter(Boolean);
  const bloodOnly=relics.length===1&&knownBurningBlood(relics[0])&&Number.isFinite(state.player?.max_hp);
  const unknownRelics=bloodOnly?[]:relics.filter(Boolean);
  const unknownEnemy=enemyStatus.filter(Boolean);
  return {
    known:!unknownPlayer.length&&!unknownRelics.length&&!unknownEnemy.length,
    unknownPlayer,unknownRelics,unknownEnemy
  };
}

export function optionEffect(option,state){
  const parsed=parseCompleteEffect(option?.label,{label:true});
  const card=(state.player?.hand??[]).find(entry=>entry.index===option?.command?.card_index);
  let liveText=card?.description;
  // Some adapters prefix a description with the card name. Only strip that
  // exact name, never an arbitrary condition such as "If injured: ...".
  if(typeof liveText==='string'&&card?.name&&liveText.startsWith(`${card.name}:`))
    liveText=liveText.slice(card.name.length+1).trim();
  const fromCard=parseCompleteEffect(liveText);
  const effect=typeof liveText==='string'&&liveText.trim()?fromCard:parsed;
  const cost=cardCost(state,option);
  const noExtraCost=card?.star_cost==null||String(card.star_cost).trim()==='0';
  const target=optionTarget(option,state);
  const total=effect.complete&&isNum(effect.damage)?effect.damage*(effect.hits||1):null;
  const context=combatContext(state);
  const modeled=Boolean(effect.complete&&cost.known&&noExtraCost&&context.known
    &&(total===null||target||effect.allEnemies||option?.command?.action!=='play_card'));
  return {
    ...effect,
    known:modeled,
    total,
    cost:cost.known?cost.value:null,
    costKnown:cost.known&&noExtraCost,
    contextKnown:context.known,
    target,
    modeled,
    prefixSafe:modeled
  };
}

function cloneCombat(state){
  return {
    state_type:state.state_type,
    run:state.run,
    player:{
      ...(state.player??{}),
      status:[...(state.player?.status??[])],
      relics:[...(state.player?.relics??[])],
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

export function projectPlay(state,option){
  if(option?.command?.action!=='play_card')return {known:false,reason:'not a card play'};
  const context=combatContext(state);
  if(!context.known)return {known:false,reason:'unmodeled active modifier'};
  const effect=optionEffect(option,state);
  if(!effect.costKnown)return {known:false,reason:'unsupported cost',effect};
  if(!effect.complete||!effect.modeled)return {known:false,reason:'unmodeled effect',effect};
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
  if(kills>0&&livingEnemies(next).length===0&&(next.player.relics??[]).some(knownBurningBlood))
    next.player.hp=Math.min(next.player.max_hp,next.player.hp+6);
  const index=next.player.hand.findIndex(card=>card.index===option.command.card_index);
  if(index<0)return {known:false,reason:'card not in hand',effect};
  next.player.hand.splice(index,1);
  next.player.discard_pile_count+=1;
  const attacks=incomingAttacks(next);
  const unblocked=attacks.known?Math.max(0,attacks.total-next.player.block):null;
  const expect={energy:next.player.energy};
  if(next.player.block!==Number(state.player?.block??0))expect.block=next.player.block;
  if(next.player.hp!==Number(state.player?.hp??0))expect.hp=next.player.hp;
  if(JSON.stringify(enemiesProjection(next))!==JSON.stringify(enemiesProjection(state)))
    expect.enemies=enemiesProjection(next);
  return {
    known:true,
    effect,
    next,
    expect,
    kills,
    prefixSafe:true,
    boundary:null,
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
      prefixSafe:true,
      boundary:null
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
