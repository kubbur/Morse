import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../scripts/stage.mjs';
import { practiceWorker } from '../website/lib/offline-worker.mjs';

test('browser offline manifest verifies every practice module and bypasses cloud APIs and transfers',async()=>{
  const origin = 'https://practice.invalid';
  const files = new Map(), assets = new Map(), handlers = new Map();
  async function collect(path) {
    for (const entry of await readdir(join(root,'website/public',path),{withFileTypes:true})) {
      const name=path+'/'+entry.name;
      if (entry.isDirectory()) await collect(name);
      else files.set(name,{content:await readFile(join(root,'website/public',name))});
    }
  }
  await collect('');
  const worker=practiceWorker(files);
  const cache={
    async addAll(requests) {
      for (const req of requests) {
        const name=new URL(req.url).pathname, file=files.get(name);
        assert.equal(req.integrity,'sha256-'+createHash('sha256').update(file.content).digest('base64'));
        assert.equal(req.credentials,'omit');
        assets.set(req.url,new Response(file.content));
      }
    },
    match:async url=>assets.get(url),
  };
  const self={location:{origin},addEventListener:(name,fn)=>handlers.set(name,fn),clients:{claim:async()=>{}}};
  runInNewContext(worker.toString(),{self,caches:{open:async()=>cache,keys:async()=>[]},Request,URL,fetch:()=>{throw Error('offline');}});
  let task;
  handlers.get('install')({waitUntil:p=>{task=p;}});await task;
  handlers.get('activate')({waitUntil:p=>{task=p;}});await task;
  function load(path,method='GET') {
    let result;
    handlers.get('fetch')({request:new Request(origin+path,{method}),respondWith:p=>{result=p;}});
    return result;
  }
  assert.ok((await (await load('/')).text()).includes('play-signal'));
  for (const [path,file] of files) {
    if (!path.endsWith('.mjs') || path.includes('move-progress')) continue;
    for (const [,ref] of file.content.toString().matchAll(/(?:from\s+|new URL\(\s*)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
      const url=new URL(ref,origin+path);
      assert.ok(await load(url.pathname),ref+' imported by '+path);
    }
  }
  for (const path of ['/api/v2/scores/leaderboard','/move-progress','/move-progress.html','/recover-progress','/healthz','/?token=anything'])
    assert.equal(load(path),undefined);
  assert.equal(load('/api/v2/private/push','POST'),undefined);
});
