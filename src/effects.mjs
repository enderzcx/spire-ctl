// Card and relic identity for the fast model's input.
//
// TypeSafe documents that jev-1.13 reads numeric and Chinese text less reliably
// than plain English semantics, and that irrelevant detail in a state hurts.
// The game UI stays Chinese; this module gives the model a stable identifier
// plus a short English effect so the same judgment does not depend on the UI
// language, and it never invents a mechanic it has not observed: an unknown card
// is reported as unknown so the caller can hand the decision over.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// Hand-checked entries. Keys are the bridge card ids observed in this project's
// runs; the effect text is the corrected English wording, not a translation of
// the UI string.
const SEED={
  STRIKE:{name:'Strike',effect:'Deal 6 damage.'},
  DEFEND:{name:'Defend',effect:'Gain 5 Block.'},
  BASH:{name:'Bash',effect:'Deal 8 damage. Apply 2 Vulnerable.'},
  ANGER:{name:'Anger',effect:'Deal 6 damage. Add a copy of this card into your discard pile.'},
  CLEAVE:{name:'Cleave',effect:'Deal 8 damage to ALL enemies.'},
  POMMEL_STRIKE:{name:'Pommel Strike',effect:'Deal 9 damage. Draw 1 card.'},
  TWIN_STRIKE:{name:'Twin Strike',effect:'Deal 5 damage twice.'},
  PERFECTED_STRIKE:{name:'Perfected Strike',effect:'Deal 6 damage plus 2 per card with Strike in its name.'},
  SHRUG_IT_OFF:{name:'Shrug It Off',effect:'Gain 8 Block. Draw 1 card.'},
  TRUE_GRIT:{name:'True Grit',effect:'Gain 7 Block. Exhaust a random card.'},
  ARMAMENTS:{name:'Armaments',effect:'Gain 5 Block. Upgrade a card in your hand.'},
  ULTIMATE_DEFEND:{name:'Ultimate Defend',effect:'Gain 11 Block.'},
  IMPERVIOUS:{name:'Impervious',effect:'Gain 30 Block. Exhaust.'},
  BATTLE_TRANCE:{name:'Battle Trance',effect:'Draw 3 cards. You cannot draw more this turn.'},
  INFLAME:{name:'Inflame',effect:'Gain 2 Strength.'},
  METALLICIZE:{name:'Metallicize',effect:'At end of turn gain 3 Block.'},
  ONE_TWO_PUNCH:{name:'One-Two Punch',effect:'This turn the next Attack you play is played twice.'},
  RAGE:{name:'Rage',effect:'This turn whenever you play an Attack, gain 3 Block.'},
  SHOCKWAVE:{name:'Shockwave',effect:'Apply 3 Weak and Vulnerable to ALL enemies. Exhaust.'},
  CRIMSON_MANTLE:{name:'Crimson Mantle',effect:'At the start of your turn lose 1 HP and gain 8 Block.'},
  ROLLING_BOULDER:{name:'Rolling Boulder',effect:'At the start of your turn deal 10 damage to ALL enemies, then increase by 5.'},
  JUGGERNAUT:{name:'Juggernaut',effect:'Whenever you gain Block, deal 6 damage to a random enemy.'},
  FRANTIC_ESCAPE:{name:'Frantic Escape',effect:'Escape. Increase the Sandpit counter by 1. This card costs 1 more this combat.'},
  SLIMED:{name:'Slimed',effect:'Draw 1 card. Exhaust.'},
  DAZED:{name:'Dazed',effect:'Unplayable. Ethereal.'},
  WOUND:{name:'Wound',effect:'Unplayable.'},
  CLUMSY:{name:'Clumsy',effect:'Unplayable. Ethereal.'},
  BURN:{name:'Burn',effect:'Unplayable. At end of turn take 2 damage.'},
  GREED:{name:'Greed',effect:'Unplayable. Eternal.'},
  VOID:{name:'Void',effect:'Unplayable. Whenever drawn, lose 1 Energy.'}
};

const fileFor=dir=>join(dir,'card-effects.json');

export async function loadEffects(dir){
  try{return {...SEED,...JSON.parse(await readFile(fileFor(dir),'utf8'))};}
  catch(error){if(error.code==='ENOENT')return {...SEED};throw error;}
}

// Record the observed Chinese text for a known English entry, or the raw id and
// description for an unknown one. The store is evidence, not a claim: an unknown
// card stays `known:false` until someone checks it.
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

// The compact card view handed to the model: stable id, English effect, and the
// numbers the program already computed. Unknown cards say so instead of guessing.
export function describeCard(card,store={}){
  const entry=store[card?.id]??SEED[card?.id]??null;
  const known=Boolean(entry&&(SEED[card?.id]||entry.known));
  const description={
    id:card?.id??'UNKNOWN',
    name:known?entry.name:card?.name??'Unknown card',
    known,
    effect:known?entry.effect:`Unverified effect, original text: ${card?.description??''}`,
    cost:card?.cost??null,
    playable:card?.can_play===true,
    target:card?.target_type??null,
    index:card?.index??null
  };
  if(card?.is_upgraded)description.upgraded=true;
  return description;
}

// A list of ids the program could not verify. An empty list means the fast
// model's input is fully grounded and a low-confidence answer is about tactics.
export function unknownCards(cards,store={}){
  return (cards??[]).filter(card=>card?.id&&!SEED[card.id]&&!store[card.id]?.known).map(card=>card.id);
}
