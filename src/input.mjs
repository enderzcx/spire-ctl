// The compact state handed to the fast model.
//
// TypeSafe's guidance for jev-1.13 is explicit: filter first and send only what
// the question needs, keep arithmetic in code, avoid indirection, and prefer
// plain semantic English over dense numeric text. The game UI stays Chinese;
// this projection carries stable card ids with verified English effects and the
// numbers the program already computed, plus the exact condition the program
// wants judged.
import {describeCard,unknownCards} from './effects.mjs';
import {incomingAttacks,optionBlock,optionDamage,optionTarget} from './combat.mjs';

const enemyView=enemy=>({
  id:enemy.entity_id,
  name:enemy.name,
  hp:enemy.hp,
  max_hp:enemy.max_hp,
  block:enemy.block??0,
  incoming:incomingAttacks({battle:{enemies:[enemy]}}).total,
  intents:(enemy.intents??[]).map(intent=>({type:intent.type,title:intent.title,value:intent.label})),
  statuses:(enemy.status??[]).map(status=>`${status.name} ${status.amount}`),
  keywords:(enemy.keywords??[]).map(keyword=>keyword.name)
});

// `options` are the advertised actions; each one is described with the numbers
// the program can prove, so the model judges tactics rather than arithmetic.
export function optionView(option,state,store={}){
  const command=option.command??{};
  const target=optionTarget(option,state);
  const view={id:option.id,action:command.action,label:option.label};
  if(command.action==='play_card'){
    const card=(state.player?.hand??[]).find(entry=>entry.index===command.card_index);
    view.card=card?describeCard(card,store):{id:'UNKNOWN',known:false,index:command.card_index};
    const damage=optionDamage(option);
    const block=optionBlock(option);
    if(damage!==null)view.computed={damage};
    if(block)view.computed={...(view.computed??{}),block};
    if(target)view.targets={id:target.entity_id,name:target.name,hp:target.hp,block:target.block??0};
  }
  return view;
}

export function buildInput(state,options,{store={},policy=null}={}){
  const player=state.player??{};
  const attacks=incomingAttacks(state);
  const hand=(player.hand??[]).map(card=>describeCard(card,store));
  return {
    state:{
      screen:state.state_type,
      floor:state.run?.floor,
      act:state.run?.act,
      turn:state.battle?.round,
      // Facts the program computed. The model is told these are settled.
      computed:{
        hp:player.hp,max_hp:player.max_hp,block:player.block??0,
        energy:player.energy,max_energy:player.max_energy,
        incoming_attack_total:attacks.known?attacks.total:null,
        unblocked_after_current_block:attacks.known?Math.max(0,attacks.total-(player.block??0)):null,
        // How many more turns this position lasts if nothing changes. A long
        // fight is exactly when a regeneration or block potion matters, and the
        // arithmetic belongs here rather than in the model's head.
        turns_survivable:attacks.known&&attacks.total>0
          ?Math.ceil((player.hp??0)/Math.max(1,attacks.total-(player.block??0)))
          :null,
        // What the hand can cover by blocking alone, so a potion that only adds
        // block is not proposed when block is already sufficient.
        best_hand_block:(player.hand??[]).reduce((best,card)=>{
          const match=String(card.description??'').match(/(\d+)\s*点格挡/);
          return match?Math.max(best,Number(match[1])):best;
        },0),
        draw_pile:player.draw_pile_count,discard_pile:player.discard_pile_count,
        exhaust_pile:player.exhaust_pile_count
      },
      hand,
      enemies:(state.battle?.enemies??[]).filter(enemy=>enemy.hp>0).map(enemyView),
      player_statuses:(player.status??[]).map(status=>`${status.name} ${status.amount}`),
      relics:(player.relics??[]).map(relic=>relic.name),
      potions:(player.potions??[]).map(potion=>({name:potion.name,usable:potion.can_use_in_combat===true,effect:potion.description}))
    },
    options:options.map(option=>optionView(option,state,store)),
    // An agreed strategy is part of the state the model reasons about.
    strategy:policy??null,
    unverified_cards:unknownCards(state.player?.hand??[],store)
  };
}

// The one literal condition the program wants judged, with the exact boundary
// cases in the criteria so a literal reading is still a correct reading.
export const NEXT_ACTION_INSTRUCTIONS=[
  'Pick the single best next action for this Slay the Spire 2 combat turn.',
  'The state lists the enemies\' displayed attack damage per turn; "computed" values are exact and must not be recalculated.',
  'Prefer an action that removes a living enemy when the listed damage is enough to do it.',
  'Prefer covering the displayed incoming attack over taking it, unless the incoming damage is already fully blocked.',
  'Do not spend energy on an effect that is already satisfied this turn.',
  'End turn is a real alternative when it is listed; one playable card is not an automatic play.',
  'If the strategy field is present, follow it while it applies; ignore options that contradict it.'
].join(' ');
