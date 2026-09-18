import {createHash} from 'node:crypto';

export const inCombat=s=>['monster','elite','boss'].includes(s.state_type);
export const stateId=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);
export const delay=ms=>new Promise(r=>setTimeout(r,ms));

export function actions(s,{deduplicate=true}={}) {
  const out=[];
  const add=(command,label)=>out.push({id:String(out.length),command,label});
  if (inCombat(s)) {
    if (!s.battle?.ready_for_action || !(s.player?.hp>0)) return out;
    const seen=new Set();
    for(const c of s.player.hand??[]) {
      if(c.can_play!==true)continue;
      const {index,...meaning}=c, key=JSON.stringify(meaning);
      if(deduplicate&&seen.has(key))continue;seen.add(key);
      const base={action:'play_card',card_index:c.index};
      const label=`${c.name}: ${c.description} (energy ${c.cost})`;
      if(c.target_type==='AnyEnemy') {
        for(const e of s.battle.enemies??[])if(e.hp>0)add({...base,target:e.entity_id},`${label} -> ${e.name} (${e.hp} HP)`);
      }else if(['Self','None','AllEnemies','RandomEnemy'].includes(c.target_type))add(base,label);
      else throw Error(`Unsupported card target: ${c.target_type}`);
    }
    // Potions stay with the planner: usage flags are not full legality checks.
    // The bridge performs the final usability check before dispatch.
    for(const p of s.player.potions??[]) {
      if(!p.can_use_in_combat)continue;
      const base={action:'use_potion',slot:p.slot}, label=`Potion ${p.name}: ${p.description}`;
      if(p.target_type==='AnyEnemy') {
        for(const e of s.battle.enemies??[])if(e.hp>0)add({...base,target:e.entity_id},`${label} -> ${e.name}`);
      } else if(['Self','AnyPlayer','AnyAlly','None','AllEnemies','RandomEnemy'].includes(p.target_type))add(base,label);
    }
    add({action:'end_turn'},'End turn');
  } else if(s.state_type==='rewards') {
    for(const r of s.rewards.items??[])add({action:'claim_reward',index:r.index},`${r.type}: ${r.description}`);
    if(s.rewards.can_proceed)add({action:'proceed'},'Proceed');
  } else if(s.state_type==='card_reward') {
    for(const c of s.card_reward.cards??[])add({action:'select_card_reward',card_index:c.index},`${c.name}: ${c.description}`);
    if(s.card_reward.can_skip)add({action:'skip_card_reward'},'Skip card reward');
  } else if(s.state_type==='card_select') {
    const cs=s.card_select;
    if(!cs.preview_showing)for(const c of cs.cards??[])add({action:'select_card',index:c.index},`${c.name}: ${c.description}`);
    if(cs.can_confirm)add({action:'confirm_selection'},'Confirm card selection');
    if(cs.can_cancel||cs.can_skip)add({action:'cancel_selection'},'Cancel / skip card selection');
  } else if(s.state_type==='hand_select') {
    for(const c of s.hand_select.cards??[])add({action:'combat_select_card',card_index:c.index},`${c.name}: ${c.description}`);
    if(s.hand_select.can_confirm)add({action:'combat_confirm_selection'},'Confirm hand selection');
  } else if(s.state_type==='relic_select') {
    for(const r of s.relic_select.relics??[])add({action:'select_relic',index:r.index},`${r.name}: ${r.description}`);
    if(s.relic_select.can_skip)add({action:'skip_relic_selection'},'Skip relic');
  } else if(s.state_type==='treasure') {
    for(const r of s.treasure.relics??[])add({action:'claim_treasure_relic',index:r.index},`${r.name}: ${r.description}`);
    if(s.treasure.can_proceed)add({action:'proceed'},'Proceed');
  } else if(s.state_type==='map') {
    for(const n of s.map?.next_options??[])add({action:'choose_map_node',index:n.index},JSON.stringify(n));
  } else if(s.state_type==='event') {
    if(s.event?.in_dialogue)add({action:'advance_dialogue'},'Advance dialogue');
    for(const o of s.event?.options??[])if(!o.is_locked&&!o.locked)add({action:'choose_event_option',index:o.index},JSON.stringify(o));
  } else if(s.state_type==='rest_site') {
    for(const o of s.rest_site?.options??[])if(o.is_enabled===true)add({action:'choose_rest_option',index:o.index},JSON.stringify(o));
    if(s.rest_site?.can_proceed)add({action:'proceed'},'Proceed');
  } else if(s.state_type==='shop') {
    // Schema-specific purchases are advertised only when explicitly affordable.
    for(const o of s.shop?.items??[])if(o.is_stocked && o.can_afford===true && o.price<=s.player.gold)add({action:'shop_purchase',index:o.index},JSON.stringify(o));
    // The bridge closes the inventory first, then enables and presses Proceed.
    // can_proceed describes the button before that close, not this compound action.
    if(s.shop&&!s.shop.error)add({action:'proceed'},'Close inventory and leave shop');
  } else if(s.state_type==='menu') {
    // No starting/abandoning runs, quitting, profile deletion, or multiplayer.
    for(const o of s.options??[]) {
      const name=typeof o==='string'?o:o.name;
      if(name==='continue' && (typeof o==='string'||o.enabled!==false))add({action:'menu_select',option:name},'Continue existing run');
    }
  }
  return out;
}

export function incomingDamage(s) {
  let total=0;
  for(const e of s.battle?.enemies??[])for(const i of e.intents??[]) {
    if(!i.type?.includes('Attack'))continue;
    const m=String(i.label??'').match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/);
    if(!m)return null;
    total+=Number(m[1])*Number(m[2]??1);
  }
  return total;
}

export function route(s,options=actions(s)) {
  if(!inCombat(s))return {kind:'planner',reason:`${s.state_type}: progression/build decision`};
  if(!s.battle.ready_for_action)return {kind:'wait',reason:'Game busy'};
  if(s.player.hp<=Math.max(15,s.player.max_hp*.3))return {kind:'planner',reason:'Low HP: reassess survival and potions'};
  const incoming=incomingDamage(s);
  if(incoming===null)return {kind:'planner',reason:'Unrecognized attack intent'};
  if(incoming-s.player.block>=s.player.hp)return {kind:'planner',reason:'Potential lethal incoming damage'};
  const cards=options.filter(o=>o.command.action==='play_card');
  if(!cards.length) {
    if(options.some(o=>o.command.action==='use_potion') && incoming-s.player.block>=Math.max(8,s.player.hp*.25))return {kind:'planner',reason:'Assess potion before significant damage'};
    return {kind:'deterministic',reason:'No playable cards; no urgent potion decision',option:options.find(o=>o.command.action==='end_turn')};
  }
  return {kind:'jev',reason:'Ready combat: choose among legal card actions'};
}

export function createGame(endpoint=process.env.SPIRE_API_URL??'http://127.0.0.1:15526/api/v1/singleplayer',fetcher=fetch,signal) {
  const url=new URL(endpoint);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw Error('Game bridge must be loopback HTTP');
  async function request(command) {
    const res=await fetcher(url,{method:command?'POST':'GET',headers:command?{'Content-Type':'application/json'}:undefined,
      body:command?JSON.stringify(command):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    const data=await res.json();
    if(!res.ok||data.status==='error'||data.error)throw Error(`Game rejected request: ${JSON.stringify(data)}`);
    return data;
  }
  async function settled(previous=null,timeout=18000) {
    const deadline=Date.now()+timeout;let last='',count=0;
    while(Date.now()<deadline){
      const s=await request(),id=stateId(s);
      if(s.state_type&&s.state_type!=='unknown'&&id!==previous&&(!inCombat(s)||s.battle?.ready_for_action)){
        count=id===last?count+1:1;if(count>=3)return s;
      }else count=0;
      last=id;await delay(100);
    }
    throw Error('No settled state transition; do not repeat the action');
  }
  return {read:()=>request(),send:command=>request(command),settled};
}
