#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const task=process.argv.slice(2).join(' ');
if(!task){console.error('Usage: node --env-file=.env scripts/dsh.mjs "A bounded game task"');process.exit(1);}
const cwd=fileURLToPath(new URL('../',import.meta.url));
const prompt=`Read docs/AGENT.md and docs/ROUND-PLAN.md in this workspace. Use only the Spire CLI for game interaction. Do not change game files, credentials or account settings. Honor the owner\'s stopping boundary. Task: ${task}`;
const child=spawn('dsh',['--profile','headless',prompt],{cwd,env:process.env,stdio:'inherit'});
child.on('error',e=>{console.error(`Cannot start local DSH: ${e.message}`);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
