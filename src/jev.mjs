export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch}={}) {
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  const criteria=Object.fromEntries(options.map(o=>[o.id,o.label]));
  const p=state.player;
  const input={battle:state.battle,player:{hp:p.hp,max_hp:p.max_hp,block:p.block,energy:p.energy,
    hand:p.hand,status:p.status,orbs:p.orbs,orb_slots:p.orb_slots,relics:p.relics,draw_pile:p.draw_pile,discard_pile:p.discard_pile}};
  const started=performance.now();
  const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'jev-latest',state:input,questions:{next:{type:'choice',
      instructions:'Choose the best next action to survive and win this Slay the Spire 2 combat. Prioritize guaranteed lethal damage. Account for enemy intents, vulnerable/weak, block, energy, setup and draw. Do not waste energy on redundant defense or end turn with useful cards remaining.',criteria}}}),
    signal:AbortSignal.timeout(8000)});
  if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
  const result=await res.json(),answer=result.answers?.next;
  if(!answer||!options.some(o=>o.id===answer.choice)||!Number.isFinite(answer.confidence))throw Error('Invalid Jev decision');
  return {option:options.find(o=>o.id===answer.choice),answer,model:result.model,usage:result.usage,
    inference_ms:Math.round(performance.now()-started)};
}
