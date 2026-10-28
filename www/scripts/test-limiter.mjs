// Offline regression test for api/security.js rateLimit() against a mock Upstash REST server.
//   node scripts/test-limiter.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
const store=new Map(); let mode='ok';
const srv=http.createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{
  if(mode==='down'){r.statusCode=500;return r.end('x');}
  if(q.headers.authorization!=='Bearer tok'){r.statusCode=401;return r.end('no');}
  const cmds=JSON.parse(b);const out=cmds.map(([c,k,v,nx])=>{
    if(c==='INCR'){const e=store.get(k)||{n:0,exp:null};e.n++;store.set(k,e);return{result:e.n};}
    if(c==='EXPIRE'){const e=store.get(k);if(e.exp==null){e.exp=Date.now()+v*1000;return{result:1};}return{result:0};}
    if(c==='PTTL'){const e=store.get(k);return{result:e.exp?e.exp-Date.now():-1};}
    if(c==='PEXPIRE'){store.get(k).exp=Date.now()+v;return{result:1};}
  });r.setHeader('content-type','application/json');r.end(JSON.stringify(out));});});
await new Promise(r=>srv.listen(0,r));
process.env.UPSTASH_REDIS_REST_URL='http://127.0.0.1:'+srv.address().port;process.env.UPSTASH_REDIS_REST_TOKEN='tok';
const {rateLimit}=await import(new URL('../api/security.js', import.meta.url));
const req={headers:{'x-real-ip':'1.2.3.4'}};
const run=async(r,o)=>{const a=[];for(let i=0;i<r;i++)a.push(await rateLimit(req,o));return a;};

// 1. Allows up to the limit, then blocks, using the shared store.
let a=await run(5,{name:'t',limit:3,windowMs:60000});
assert.deepEqual(a.map(x=>x.ok),[true,true,true,false,false]);
assert.ok(a.every(x=>x.backend==='redis'));
assert.ok(a[4].retryAfter>=1 && a[4].retryAfter<=60);
// 2. Buckets are isolated by route name, client IP and explicit key.
assert.equal((await rateLimit({headers:{'x-real-ip':'9.9.9.9'}},{name:'t',limit:3})).ok,true);
assert.equal((await rateLimit(req,{name:'u',limit:3})).ok,true);
assert.equal((await rateLimit(req,{name:'t',limit:3,key:'user-1'})).ok,true);
// 3. Two "instances" (fresh module copies) share one global count.
const m2=await import(new URL('../api/security.js?instance=2', import.meta.url));
assert.equal((await m2.rateLimit(req,{name:'t',limit:3})).ok,false, 'second instance must see the first instance\'s count');
// 4. Store outage degrades to the per-instance limiter (still limits, never throws).
mode='down';
a=await run(4,{name:'f',limit:2,windowMs:60000});
assert.deepEqual(a.map(x=>x.ok),[true,true,false,false]);
assert.ok(a.every(x=>x.backend==='memory'));
// 5. Bad credentials are treated as an outage (degrade, not crash).
mode='ok'; process.env.UPSTASH_REDIS_REST_TOKEN='wrong';
a=await run(3,{name:'g',limit:1,windowMs:60000});
assert.deepEqual(a.map(x=>x.ok),[true,false,false]);
// 6. Unconfigured store: pure in-memory.
delete process.env.UPSTASH_REDIS_REST_URL;
assert.equal((await rateLimit(req,{name:'h',limit:1})).backend,'memory');
console.log('Distributed limiter tests passed.');
srv.close();
