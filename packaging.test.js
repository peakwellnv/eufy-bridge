import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Docker includes every runtime module imported by the server',()=>{
 const base=new URL('./',import.meta.url);
 const docker=readFileSync(new URL('Dockerfile',base),'utf8');
 const copied=new Set([...docker.matchAll(/^COPY (.+) \.\/$/gm)].flatMap(match=>match[1].split(' ')));
 const seen=new Set();
 const check=name=>{
  if(seen.has(name))return;seen.add(name);
  assert.ok(copied.has(name),`Docker omits ${name}`);
  const source=readFileSync(new URL(name,base),'utf8');
  for(const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g))check(match[1]);
 };
 check('server.js');
});
