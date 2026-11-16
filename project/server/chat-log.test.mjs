import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir, rmdir, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createChat} from './chat.mjs';
import {createHoneymoonServer} from './index.mjs';
import {openStore} from './store.mjs';

test('chat logs rotate at local midnight and survive a drained shutdown or restart',async()=>{
  const logDirectory=await mkdtemp(join(tmpdir(),'honeymoon-chat-logs-'));
  const store=openStore(':memory:');
  const errors=[], published=[];
  let now=Date.parse('2026-11-16T21:59:59.995Z');
  const options={store, logDirectory,logTimeZone:'Europe/Sofia',now:()=>now,
    publish:(entry,audience)=>published.push({entry,audience}),recipients:()=>['near'],
    onLogError:error=>errors.push(error)};
  const chat=createChat(options);
  let restarted;
  const profile={id:'pony-one',nickname:'Лунный Ветер'};
  try {
    chat.playerStatus(profile,true);
    chat.message(profile,{channel:'global',text:'Всем привет 🌙'},'sender');
    now+=5;
    chat.message(profile,{channel:'local',text:'Тихо\u2028рядом\u2029на мосту'},'sender',{x:1,y:66,z:2});
    const rename=store.recordChat({kind:'rename',nickname:profile.nickname,newNickname:'Северный Свет',channel:'global'});
    chat.publishRecorded(rename);
    await chat.close();

    restarted=createChat(options);
    restarted.playerDeath({...profile,nickname:rename.newNickname});
    now+=999;
    restarted.playerStatus({...profile,nickname:rename.newNickname},false);
    await restarted.close();

    assert.deepEqual(errors,[]);
    assert.deepEqual((await readdir(logDirectory)).sort(),['2026-11-16.log','2026-11-17.log']);
    const rows=async day=>{
      const body=await readFile(join(logDirectory,day+'.log'),'utf8');
      assert.ok(body.endsWith('\n'));
      assert.doesNotMatch(body,/[\u2028\u2029\r]/u);
      return body.trimEnd().split('\n').map(line=>{
        const [timestamp,channel,kind,nickname,value]=line.split('\t');
        return [timestamp,channel,kind,JSON.parse(nickname),JSON.parse(value)];
      });
    };
    assert.deepEqual(await rows('2026-11-16'),[
      ['2026-11-16T23:59:59.995+02:00','system','join','Лунный Ветер',''],
      ['2026-11-16T23:59:59.995+02:00','global','message','Лунный Ветер','Всем привет 🌙'],
    ]);
    assert.deepEqual(await rows('2026-11-17'),[
      ['2026-11-17T00:00:00.000+02:00','local','message','Лунный Ветер','Тихо\u2028рядом\u2029на мосту'],
      ['2026-11-17T00:00:00.000+02:00','global','rename','Лунный Ветер','Северный Свет'],
      ['2026-11-17T00:00:00.000+02:00','global','death','Северный Свет',''],
      ['2026-11-17T00:00:00.999+02:00','system','leave','Северный Свет',''],
    ]);
    assert.deepEqual(published.find(({entry})=>entry.channel==='local').audience,['sender','near']);
    assert.equal(restarted.history('sender').filter(entry=>entry.kind==='rename').length,1);
    assert.ok(!restarted.history('far').some(entry=>entry.channel==='local'));
  } finally {
    await Promise.all([chat.close(),restarted?.close()]);
    store.close();
    for(const file of await readdir(logDirectory)) await unlink(join(logDirectory,file));
    await rmdir(logDirectory);
  }
});

test('disk-backed server writes private chat logs beside its save and drains them on close',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'honeymoon-chat-server-'));
  const logDirectory=join(directory,'chat-logs');
  const state=join(directory,'world.sqlite');
  const worldClock=Date.parse('2026-11-17T12:00:00.000Z');
  const day=new Date(worldClock);
  const name=[day.getFullYear(),day.getMonth()+1,day.getDate()].map(value=>String(value).padStart(2,'0')).join('-')+'.log';
  const geometry={shapeFor:()=>[],collisionFor:()=>[]};
  const base={hash:'chat-log-test',
    manifest:{spawn:[8.5,1,8.5],bounds:{minX:0,maxX:31,minY:0,maxY:31,minZ:0,maxZ:31},compositions:{}},
    inBounds:(...pos)=>pos.every(value=>value>=0 && value<32),catalog:new Set(['air']),
    getCell:()=>({key:'air',object:null})};
  let app, feed;
  try {
    app=createHoneymoonServer({base,geometry,state,clock:()=>worldClock});
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    const origin='http://127.0.0.1:'+app.server.address().port;
    let cookie;
    const post=async(path,data)=>{
      const response=await fetch(origin+'/api/'+path,{method:'POST',
        headers:{'Content-Type':'application/json',Origin:origin,...(cookie&&{Cookie:cookie})},body:JSON.stringify(data)});
      assert.equal(response.status,200,await response.clone().text());
      cookie=response.headers.get('Set-Cookie')?.split(';')[0]??cookie;
      return response.json();
    };
    await post('session',{});
    await post('profile',{nickname:'Тестовый гость'});
    feed=await fetch(origin+'/api/events?since=0&presence=1&social=1',{headers:{Cookie:cookie}});
    assert.equal(feed.status,200);
    await post('presence',{yaw:0,pitch:0});
    const message=await post('chat',{text:'Ночная проверка журнала',channel:'local'});
    assert.equal(message.nickname,'Тестовый гость');
    await post('profile',{nickname:'Проверка имени'});
    const leaked=await fetch(origin+'/state/chat-logs/'+name,{headers:{Cookie:cookie}});
    assert.equal(leaked.status,404);
    await feed.body.cancel();
    feed=undefined;
    await app.close();
    app=undefined;
    const body=await readFile(join(logDirectory,name),'utf8');
    assert.match(body,/\tlocal\tmessage\t"Тестовый гость"\t"Ночная проверка журнала"/u);
    assert.match(body,/\tglobal\trename\t"Тестовый гость"\t"Проверка имени"/u);
  } finally {
    await feed?.body?.cancel();
    await app?.close();
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if (entry.isDirectory() && ['chat-logs','load-logs'].includes(entry.name)) {
        for (const day of await readdir(path)) await unlink(join(path,day));
        await rmdir(path);
      } else await unlink(path);
    }
    await rmdir(directory);
  }
});
