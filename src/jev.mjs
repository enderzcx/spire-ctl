// Fast tactical model adapter. The program stays in charge of legality and of
// everything that can be computed: this module only turns a state plus the
// advertised options into one of those options.
export async function choose(state,options,{apiKey=process.env.TYPESAFE_API_KEY,fetcher=fetch,signal,
  shortlist=null,criteria:providedCriteria=null}={}) {
  if(!apiKey)throw Error('TYPESAFE_API_KEY is missing');
  if(!options.length)throw Error('No options offered; the caller must not ask for a choice');
  const criteria=providedCriteria??Object.fromEntries(options.map(o=>[o.id,o.label]));
  const p=state.player;
  const input={battle:state.battle,player:{hp:p.hp,max_hp:p.max_hp,block:p.block,energy:p.energy,
    hand:p.hand,status:p.status,orbs:p.orbs,orb_slots:p.orb_slots,relics:p.relics,draw_pile:p.draw_pile,discard_pile:p.discard_pile}};
  const instructions='Choose the best next action to survive and win this Slay the Spire 2 combat. Prioritize guaranteed lethal damage. Account for enemy intents, vulnerable/weak, block, energy, setup and draw. Do not waste energy on redundant defense or end turn with useful cards remaining.';
  const started=performance.now();
  async function ask(menu){
    const res=await fetcher('https://api.typesafe.ai/v1/systemone',{method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'jev-latest',state:input,questions:{next:{type:'choice',instructions,criteria:menu}}}),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    if(!res.ok)throw Error(`Jev returned HTTP ${res.status}; no action sent`);
    const result=await res.json(),answer=result.answers?.next;
    if(!answer||!options.some(o=>o.id===answer.choice)||!Number.isFinite(answer.confidence))throw Error('Invalid Jev decision');
    return {option:options.find(o=>o.id===answer.choice),answer,model:result.model,usage:result.usage};
  }
  const first=await ask(criteria);
  // A low-confidence answer over the whole hand is not evidence that the
  // situation needs a planner. When the program can narrow the choice to a few
  // defensible actions, ask again with that smaller menu instead of lowering
  // the bar or escalating. The cutoff is unchanged.
  if(first.answer.confidence<.5&&shortlist?.options?.length){
    const narrowed=options.filter(option=>shortlist.options.some(o=>o.id===option.id));
    if(narrowed.length&&narrowed.length<options.length){
      const menu=Object.fromEntries(narrowed.map(o=>[o.id,`${o.label} [program: ${shortlist.reason}]`]));
      const retry=await ask(menu);
      if(retry.answer.confidence>=first.answer.confidence)
        return {...retry,narrowed:true,shortlist_reason:shortlist.reason,
          inference_ms:Math.round(performance.now()-started),retried:true};
    }
  }
  return {...first,inference_ms:Math.round(performance.now()-started),retried:false,narrowed:false};
}
