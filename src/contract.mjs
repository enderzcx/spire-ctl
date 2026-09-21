// A stable read contract over the live state.
//
// The bridge is a faithful dump of the game's own objects, which means the shop
// array mixes four categories that each name their own fields differently:
// a card carries card_id/card_name/card_description, a relic relic_id/...,
// a potion potion_id/..., and a card removal carries none of them. A consumer
// that reads `name` therefore sees null for every shop entry and has to special
// case each category - exactly the kind of accidental coupling this layer
// exists to remove. Potions and relics on the player already use id/name/
// description, so the shop is the only place that needs normalising.
//
// The original prefixed fields are kept, so nothing that already worked breaks;
// this only adds the uniform ones.
const PREFIX={card:'card',relic:'relic',potion:'potion'};

const first=(item,keys)=>{
  for(const key of keys)if(item[key]!==undefined&&item[key]!==null)return item[key];
  return null;
};

export function normalizeItem(item){
  if(!item||typeof item!=='object')return item;
  const prefix=PREFIX[item.category];
  if(!prefix)return item;
  return {
    ...item,
    item_id:item.item_id??first(item,[`${prefix}_id`,'id']),
    name:item.name??first(item,[`${prefix}_name`,'name']),
    description:item.description??first(item,[`${prefix}_description`,'description'])
  };
}

export function normalizeShop(shop){
  if(!shop||!Array.isArray(shop.items))return shop;
  return {...shop,items:shop.items.map(normalizeItem)};
}

// Returns a copy for consumers; the raw state keeps its own shape so the state
// id stays a hash of exactly what the game reported.
export function normalizeState(state){
  if(!state||typeof state!=='object')return state;
  if(!state.shop)return state;
  return {...state,shop:normalizeShop(state.shop)};
}
