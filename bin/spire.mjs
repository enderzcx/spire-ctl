#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createController} from '../src/controller.mjs';
const [command,...args]=process.argv.slice(2),controller=createController();
async function main(){
  if(command==='state')return controller.state();
  if(command==='act'){
    if(args.length!==2)throw Error('Usage: act STATE_ID OPTION_ID (from state)');
    return controller.act(args[0],args[1]);
  }
  if(command==='plan'){
    if(args.length!==1)throw Error('Usage: plan PLAN.json');
    return controller.plan(JSON.parse(await readFile(args[0],'utf8')));
  }
  if(command==='battle')return controller.battle(Number(args[0]??60));
  if(command==='advance')return controller.advance(Number(args[0]??20));
  if(command==='clear-halt'){
    if(args.length!==1)throw Error('Read and inspect state, then clear-halt STATE_ID');
    return controller.clearHalt(args[0]);
  }
  return {usage:['state','act STATE_ID OPTION_ID','plan PLAN.json','battle [MAX_STEPS]','advance [MAX_STEPS]','clear-halt STATE_ID'],
    note:'Read docs/AGENT.md before playing. advance only performs mechanical steps and stops at a decision.'};
}
main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
