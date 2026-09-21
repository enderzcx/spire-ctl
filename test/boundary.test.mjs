import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

// The package is both a CLI and a DSH plugin. That only stays honest if the
// runtime path never reaches for the harness: a plain harness that shells out to
// `spirectl` must not need @deepseek-ai/dsh-tools installed, and no core module
// may start importing harness types. The adapter may import the core; never the
// other way around.

const root=new URL('..',import.meta.url).pathname;
const read=path=>readFile(join(root,path),'utf8');

test('no core module imports the DSH adapter',async()=>{
  const files=[...(await readdir(join(root,'src'))).map(f=>`src/${f}`),
    'bin/spire.mjs',...(await readdir(join(root,'scripts'))).map(f=>`scripts/${f}`)];
  const offenders=[];
  for(const file of files){
    const text=await read(file);
    if(/adapters\/dsh|dsh-tools|schemastery/.test(text))offenders.push(file);
  }
  assert.deepEqual(offenders,[],'the runtime path must not depend on the harness');
});

test('the adapter is the only place that needs the harness packages',async()=>{
  const adapter=await read('adapters/dsh.mjs');
  assert.match(adapter,/@deepseek-ai\/dsh-tools/,'the adapter registers DSH tools');
  assert.match(adapter,/\.\.\/src\/controller\.mjs/,'the adapter drives the in-repo core, not a pinned copy');
  const pkg=JSON.parse(await read('package.json'));
  assert.equal(pkg.main,'adapters/dsh.mjs','DSH loads the adapter as the package entry');
  assert.equal(pkg.bin.spirectl,'bin/spire.mjs','the CLI stays a separate entry');
  assert.equal(pkg.dependencies,undefined,'the package still ships no runtime dependencies');
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional,true,
    'a harness without DSH installed must still be able to install and use the CLI');
});
