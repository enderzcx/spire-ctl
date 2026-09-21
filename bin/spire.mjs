#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createController} from '../src/controller.mjs';
const [command,...args]=process.argv.slice(2),controller=createController();
async function main(){
  if(command==='state')return controller.state();
  if(command==='act'){
    if(args.length!==2)throw Error('Usage: act STATE_ID OPTION_ID (from state)');
    // The label says who decided; the CLI itself is the calling agent.
    return controller.act(args[0],args[1],{source:process.env.SPIRE_ACT_SOURCE??'caller'});
  }
  if(command==='plan'){
    if(args.length!==1)throw Error('Usage: plan PLAN.json');
    return controller.plan(JSON.parse(await readFile(args[0],'utf8')));
  }
  if(command==='battle'){
    const max=Number(args[0]??60);
    if(!args[1])return controller.battle(max);
    const payload=JSON.parse(await readFile(args[1],'utf8'));
    const strategy=payload.strategy??payload;
    return controller.battle(max,{strategy,expectedStateId:payload.expected_state_id??payload.expectedStateId});
  }
  if(command==='seq'){
    // seq STATE_ID STEPS.json - or seq STEPS.json when no state id is given.
    // Each step is a selector over the advertised command, e.g.
    //   {"card_index":2} {"card_index":2,"target":"E_0"} {"action":"end_turn"}
    const [maybeId,maybeFile]=args;
    const file=maybeFile??maybeId;
    const steps=JSON.parse(await readFile(file,'utf8'));
    const payload=Array.isArray(steps)?{steps}:steps;
    return controller.seq(payload.steps,{expectedStateId:payload.expected_state_id??payload.expectedStateId??null,
      source:'caller'});
  }
  if(command==='doctor'){
    // Read-only diagnosis by default; --install-mod --yes writes the two mod
    // files after verifying them against the package's SHA256SUMS.
    const {diagnose,installMod}=await import('../scripts/doctor.mjs');
    const flag=name=>{const i=args.indexOf(name);return i>=0?args[i+1]??true:null;};
    if(args.includes('--install-mod')){
      const packageDir=flag('--install-mod');
      if(typeof packageDir!=='string')throw Error('--install-mod needs a package directory');
      const {execFile}=await import('node:child_process');
      const listProcesses=()=>new Promise(resolve=>execFile('ps',['-ax'],(error,stdout)=>resolve(stdout??'')));
      return installMod(packageDir,{yes:args.includes('--yes'),listProcesses});
    }
    return diagnose({endpoint:process.env.SPIRE_API_URL});
  }
  if(command==='advance')return controller.advance(Number(args[0]??20));
  if(command==='clear-halt'){
    if(args.length!==1)throw Error('Read and inspect state, then clear-halt STATE_ID');
    return controller.clearHalt(args[0]);
  }
  if(command==='save-strategy'){
    if(args.length!==1)throw Error('Usage: save-strategy STRATEGY.json');
    return controller.saveStrategy(JSON.parse(await readFile(args[0],'utf8')));
  }
  if(command==='strategy')return controller.strategy();
  return {usage:['state','act STATE_ID OPTION_ID','seq STEPS.json','plan PLAN.json','battle [MAX_STEPS] [STRATEGY.json]','advance [MAX_STEPS]','clear-halt STATE_ID','save-strategy STRATEGY.json','strategy','doctor [--install-mod DIR --yes]'],
    note:'Read docs/AGENT.md before playing. advance only performs mechanical steps and stops at a decision.'};
}
main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
