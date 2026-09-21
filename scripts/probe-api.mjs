#!/usr/bin/env node
// Bridge interface probe. Read-only: it never sends an action.
//
// Purpose: turn the static audit of the game mod into observed fact. It reads
// the live state, reports which fields each screen actually exposes, and marks
// what a decision needs but the bridge does not provide - so the gap is known
// before a long run depends on it.
//
//   node scripts/probe-api.mjs              # summary for the current state
//   node scripts/probe-api.mjs --full       # also print the raw state
//   node scripts/probe-api.mjs --watch 30   # re-read for 30 seconds
import {createGame} from '../src/game.mjs';

const args=process.argv.slice(2);
const full=args.includes('--full');
const watchIndex=args.indexOf('--watch');
const watch=watchIndex>=0?Number(args[watchIndex+1]??10):0;

const REQUIRED={
  combat:['battle.round','battle.turn','battle.ready_for_action','battle.action_running',
    'battle.action_queue_empty','battle.enemies','player.hp','player.block','player.energy',
    'player.hand','player.draw_pile_count','player.discard_pile_count','player.potions','player.relics'],
  'battle.enemies[]':['entity_id','combat_id','name','hp','max_hp','block','status','intents'],
  'battle.enemies[].intents[]':['type','label','title','description'],
  'player.hand[]':['id','name','cost','type','target_type','can_play','description','keywords'],
  map:['map.nodes','map.current_position','map.next_options','map.visited'],
  rewards:['rewards.items','rewards.can_proceed'],
  card_reward:['card_reward.cards','card_reward.can_skip'],
  card_select:['card_select.cards','card_select.selected_count','card_select.selected_indices','card_select.can_confirm'],
  hand_select:['hand_select.cards','hand_select.can_confirm'],
  shop:['shop.items','shop.items[].price','shop.items[].can_afford','shop.items[].is_stocked'],
  event:['event.event_name','event.options','event.in_dialogue'],
  rest_site:['rest_site.options'],
  treasure:['treasure.relics'],
  relic_select:['relic_select.relics'],
  run:['run.act','run.floor']
};

const get=(object,path)=>{
  const parts=path.replace(/\[\]/g,'').split('.');
  let current=object;
  for(const part of parts){
    if(current===null||current===undefined)return undefined;
    current=Array.isArray(current)?current[0]?.[part]:current[part];
  }
  return current;
};

function report(state){
  const type=state.state_type;
  console.log(`state_type: ${type}`);
  console.log(`run: act ${state.run?.act} floor ${state.run?.floor} ascension ${state.run?.ascension}`);
  console.log(`top-level keys: ${Object.keys(state).join(', ')}`);

  const checks=[];
  if(['monster','elite','boss'].includes(type))checks.push('combat','battle.enemies[]','battle.enemies[].intents[]','player.hand[]');
  if(type==='map')checks.push('map');
  if(type==='rewards')checks.push('rewards');
  if(type==='card_reward')checks.push('card_reward');
  if(type==='card_select')checks.push('card_select');
  if(type==='hand_select')checks.push('hand_select');
  if(type==='shop'||type==='fake_merchant')checks.push('shop');
  if(type==='event')checks.push('event');
  if(type==='rest_site')checks.push('rest_site');
  if(type==='treasure')checks.push('treasure');
  if(type==='relic_select')checks.push('relic_select');
  checks.push('run');

  let missing=0;
  for(const group of checks){
    const rows=REQUIRED[group]??[];
    const absent=rows.filter(path=>get(state,path)===undefined);
    missing+=absent.length;
    console.log(`  [${absent.length?'MISSING':'ok'}] ${group}${absent.length?` -> ${absent.join(', ')}`:''}`);
  }

  // Decision inputs that are frequently empty rather than absent.
  const enemies=state.battle?.enemies??[];
  const noLabel=enemies.filter(enemy=>(enemy.intents??[]).some(intent=>!intent.label&&!intent.description&&!intent.title));
  if(noLabel.length)console.log(`  [note] ${noLabel.length} enemy intent(s) carry no readable label; re-read rather than guess`);
  const unplayable=(state.player?.hand??[]).filter(card=>card.can_play!==true);
  if(unplayable.length)console.log(`  [note] unplayable in hand: ${unplayable.map(card=>`${card.name}(${card.unplayable_reason??'?'})`).join(', ')}`);
  const piles=(state.player?.draw_pile_count??0)+(state.player?.discard_pile_count??0)+(state.player?.exhaust_pile_count??0);
  if(['monster','elite','boss'].includes(type))
    console.log(`  [info] piles draw/discard/exhaust = ${state.player?.draw_pile_count}/${state.player?.discard_pile_count}/${state.player?.exhaust_pile_count} (total ${piles})`);

  console.log(missing?`RESULT: ${missing} required field(s) missing on this screen`:'RESULT: every required field for this screen is present');
  return missing;
}

const game=createGame();
const read=async()=>{
  let state;
  try{
    state=await game.read();
  }catch(error){
    console.error('Cannot read the game bridge:',error.message);
    console.error('Start Slay the Spire 2 with the STS2_MCP mod installed, then check:');
    console.error("  curl --noproxy '*' http://127.0.0.1:15526/");
    process.exitCode=2;
    return null;
  }
  report(state);
  if(full)console.log(JSON.stringify(state,null,2));
  return state;
};
if(await read()===null)process.exit(2);
if(watch>0){
  const until=Date.now()+watch*1000;
  let last='';
  while(Date.now()<until){
    await new Promise(resolve=>setTimeout(resolve,1000));
    const state=await game.read();
    const id=JSON.stringify({t:state.state_type,b:state.battle?.round,e:state.battle?.enemies?.map(x=>x.hp)});
    if(id!==last){last=id;console.log('--- change ---');report(state);}
  }
}
