// Card identity for the fast model's input.
//
// Seeded ids are known names, not frozen numbers. Live damage, block and
// upgrade values come from the current card text. An unknown card stays
// unknown; names alone are not status or relic knowledge.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {parseEffect} from './combat.mjs';

const SEED={
  STRIKE:{name:'Strike'},
  DEFEND:{name:'Defend'},
  BASH:{name:'Bash'},
  ANGER:{name:'Anger'},
  CLEAVE:{name:'Cleave'},
  POMMEL_STRIKE:{name:'Pommel Strike'},
  TWIN_STRIKE:{name:'Twin Strike'},
  PERFECTED_STRIKE:{name:'Perfected Strike'},
  SHRUG_IT_OFF:{name:'Shrug It Off'},
  TRUE_GRIT:{name:'True Grit'},
  ARMAMENTS:{name:'Armaments'},
  ULTIMATE_DEFEND:{name:'Ultimate Defend'},
  IMPERVIOUS:{name:'Impervious'},
  BATTLE_TRANCE:{name:'Battle Trance'},
  INFLAME:{name:'Inflame'},
  METALLICIZE:{name:'Metallicize'},
  ONE_TWO_PUNCH:{name:'One-Two Punch'},
  RAGE:{name:'Rage'},
  SHOCKWAVE:{name:'Shockwave'},
  CRIMSON_MANTLE:{name:'Crimson Mantle'},
  ROLLING_BOULDER:{name:'Rolling Boulder'},
  JUGGERNAUT:{name:'Juggernaut'},
  FRANTIC_ESCAPE:{name:'Frantic Escape'},
  SLIMED:{name:'Slimed'},
  DAZED:{name:'Dazed'},
  WOUND:{name:'Wound'},
  CLUMSY:{name:'Clumsy'},
  BURN:{name:'Burn'},
  GREED:{name:'Greed'},
  VOID:{name:'Void'}
};

const fileFor=dir=>join(dir,'card-effects.json');

export async function loadEffects(dir){
  try{return {...SEED,...JSON.parse(await readFile(fileFor(dir),'utf8'))};}
  catch(error){if(error.code==='ENOENT')return {...SEED};throw error;}
}

export async function observeCards(dir,cards){
  const path=fileFor(dir);
  let store={};
  try{store=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let changed=false;
  for(const card of cards??[]){
    if(!card?.id)continue;
    const entry=store[card.id]??(SEED[card.id]?{...SEED[card.id]}:{id:card.id,known:false});
    if(entry.seen_text!==card.description){entry.seen_text=card.description;changed=true;}
    if(!SEED[card.id]&&!entry.known)entry.known=false;
    store[card.id]=entry;
  }
  if(changed){await mkdir(dir,{recursive:true});await writeFile(path,JSON.stringify(store,null,2));}
  return store;
}

function englishEffect(parsed,original){
  if(!parsed?.known)return `Unverified effect, original text: ${original??''}`;
  const parts=[];
  if(Number.isFinite(parsed.damage))
    parts.push(parsed.hits>1?`Deal ${parsed.damage} damage ${parsed.hits} times.`:`Deal ${parsed.damage} damage.`);
  if(parsed.allEnemies)parts.push('Hits all enemies.');
  if(Number.isFinite(parsed.block))parts.push(`Gain ${parsed.block} Block.`);
  if(Number.isFinite(parsed.vulnerable))parts.push(`Apply ${parsed.vulnerable} Vulnerable.`);
  if(Number.isFinite(parsed.weak))parts.push(`Apply ${parsed.weak} Weak.`);
  if(parsed.draw)parts.push(`Draw ${parsed.draw} card(s).`);
  if(parsed.exhaust)parts.push('Exhaust.');
  return parts.join(' ')||`Original text: ${original??''}`;
}

export function describeCard(card,store={}){
  const entry=store[card?.id]??SEED[card?.id]??null;
  const identified=Boolean(entry&&(SEED[card?.id]||entry.known));
  const parsed=parseEffect(card?.description??'');
  const description={
    id:card?.id??'UNKNOWN',
    name:identified?entry.name:card?.name??'Unknown card',
    known:identified,
    effect:parsed.known?englishEffect(parsed,card?.description):identified
      ?`Verified card; original text: ${card?.description??''}`
      :`Unverified effect, original text: ${card?.description??''}`,
    original_text:card?.description??'',
    cost:card?.cost??null,
    playable:card?.can_play===true,
    target:card?.target_type??null,
    index:card?.index??null
  };
  if(card?.is_upgraded)description.upgraded=true;
  if(parsed.known)description.modeled={damage:parsed.damage,hits:parsed.hits,block:parsed.block,
    draw:parsed.draw,exhaust:parsed.exhaust,random:parsed.random,unbounded:parsed.unbounded};
  return description;
}

export function unknownCards(cards,store={}){
  return (cards??[]).filter(card=>card?.id&&!SEED[card.id]&&!store[card.id]?.known).map(card=>card.id);
}
