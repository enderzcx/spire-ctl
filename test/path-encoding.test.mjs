import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// A checkout under a non-ASCII directory used to fail four tests for the wrong
// reason. `new URL('..', import.meta.url).pathname` keeps percent-escapes, so
// `~/项目/spire-ctl` resolved to `~/%E9%A1%B9%E7%9B%AE/spire-ctl`, a directory that
// does not exist, and the failing assertions blamed the code under test rather
// than the path. The reported symptom is a contributor in a Chinese-named folder
// seeing red on a clean clone. fileURLToPath decodes; .pathname does not.

const root=fileURLToPath(new URL('..',import.meta.url));

test('fileURLToPath decodes a non-ASCII base and .pathname does not',()=>{
  const base=new URL('file:///tmp/%E9%A1%B9%E7%9B%AE/spire-ctl/test/x.test.mjs');
  assert.equal(fileURLToPath(new URL('..',base)),'/tmp/项目/spire-ctl/');
  assert.ok(new URL('..',base).pathname.includes('%E9%A1%B9%E7%9B%AE'),
    'pathname keeps the escapes; that is exactly why it must not build filesystem paths');
});

test('no test builds a filesystem path from URL.pathname',async()=>{
  // This file asserts the difference between the two APIs, so its own body
  // contains the pattern on purpose. Scanning it would only ever find itself.
  const self='path-encoding.test.mjs';
  const files=(await readdir(join(root,'test'))).filter(f=>f.endsWith('.mjs')&&f!==self);
  const offenders=[];
  for(const file of files){
    const text=await readFile(join(root,'test',file),'utf8');
    // Only flag pathname reads that come off a URL. A bare `.pathname` could be
    // legitimate string work elsewhere; this pattern is the one that breaks.
    if(/new URL\([^)]*\)\.pathname|import\.meta\.url\)\.pathname/.test(text))
      offenders.push(file);
  }
  assert.deepEqual(offenders,[],'use fileURLToPath instead of .pathname to build paths');
});

test('the repo root resolves to a directory that exists',async()=>{
  // The regression's real assertion: the derived root must actually be usable.
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'spire-ctl');
});
