import assert from 'node:assert/strict';
import {test} from 'node:test';
import {caveMoodSource,WorldAudio} from './audio.mjs';

const listener = {x: -8.5, y: 53.5, z: 7.5};

function source({loaded = true, block = null, light = 0, sample = [10, 7, 53], threshold = 0} = {}) {
  const world = {
    hasChunk: (x, z) => loaded && x === -16 && z === 0,
    cellAt: () => block,
    lightAt: () => light,
  };
  const values = [sample[0] / 16, sample[1] / 16, sample[2] / 128, threshold / 8];
  return caveMoodSource(world, listener, () => values.shift());
}

test('cave mood uses dark air in a loaded chunk and the original block-light threshold', () => {
  assert.deepEqual(source(), [-6, 53, 7]);
  assert.deepEqual(source({light: 5, threshold: 5}), [-6, 53, 7]);
  assert.equal(source({light: 6, threshold: 5}), null);
  assert.equal(source({light: 16, threshold: 7}), null);
  assert.equal(source({block: 'legacy:1:0'}), null);
  assert.equal(source({loaded: false}), null);
});

test('cave mood keeps the original audible distance of greater than two through eight blocks', () => {
  assert.equal(source({sample: [9, 7, 53]}), null);
  assert.deepEqual(source({sample: [7, 7, 61]}), [-9, 61, 7]);
  assert.equal(source({sample: [7, 7, 62]}), null);
});

const overworld = 'a'.repeat(24)+'.ogg';
const disc = 'b'.repeat(24)+'.ogg';
const effect = 'c'.repeat(24)+'.ogg';
const world = {cellAt:()=>null};
const ground = {x:0,y:254,z:0};
const high = {...ground,y:256};

async function audioFixture(t) {
  const players = [];
  let context;
  const node = ()=>({gain:{value:0},connect:other=>other,disconnect(){}});
  class FakeAudio {
    constructor(src) {
      this.src=src;
      this.paused=true;
      this.currentTime=0;
      players.push(this);
    }
    play() {
      if (this.src.endsWith('/unavailable.ogg')) return Promise.reject(new Error('Audio cannot play'));
      this.paused=false;
      return Promise.resolve();
    }
    pause() { this.paused=true; }
    removeAttribute(name) { delete this[name]; }
    load() { this.currentTime=0; }
  }
  class FakeContext {
    constructor() { context=this; this.currentTime=1; this.state='running'; }
    createGain() { return node(); }
    createMediaElementSource(player) {
      return {connect:gain=>{player.gain=gain; return gain;},disconnect(){}};
    }
    createBufferSource() { return {...node(),playbackRate:{},start(){}}; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
  }
  for (const [name,replacement] of [['Audio',FakeAudio],['AudioContext',FakeContext]]) {
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value:replacement,configurable:true});
    t.after(()=>{ if (descriptor) Object.defineProperty(globalThis,name,descriptor); else delete globalThis[name]; });
  }
  t.mock.method(Math,'random',()=>.5);
  t.mock.method(globalThis,'fetch',async url=>({
    ok:true,
    ...(url.endsWith('/sounds.json') ? {json:async()=>({
      version:1,profiles:[],blocks:{},covers:{},sounds:{
        'music.overworld':[overworld],'record.disc':[disc],'door.open':[effect],
      },
    })} : {arrayBuffer:async()=>new ArrayBuffer(1)}),
  }));
  const audio=new WorldAudio();
  audio.setEnvironment({natureVolume:0,animalsFrequency:0,otherFrequency:0});
  await audio.load();
  audio.enable();
  audio.setPlaying(true);
  audio.setMusicVolume(.4);
  return {audio,players,context};
}

test('overview replaces ordinary music and resumes its prior playback position',async t=>{
  const {audio,players,context}=await audioFixture(t);
  audio.frame(world,ground);
  const [normal]=players;
  assert.ok(normal.src.endsWith(overworld));
  normal.currentTime=14;

  audio.frame(world,high,{altitudeOverview:true});
  assert.equal(normal.paused,false);
  assert.equal(players.length,1);
  audio.setAltitudeMusic('blob:local-track');
  const [,upper]=players;
  assert.equal(normal.paused,true);
  assert.equal(upper.loop,true);
  assert.equal(upper.paused,false);
  assert.equal(upper.gain.gain.value,.4);
  assert.equal(audio.stats().musicMode,'altitude');
  assert.equal(await audio.play('door.open'),true);
  assert.equal(context.state,'running');

  audio.setMusicVolume(.2);
  assert.equal(upper.gain.gain.value,.2);
  audio.setMusicVolume(0);
  assert.equal(upper.paused,true);
  audio.setMusicVolume(.2);
  assert.equal(upper.paused,false);
  audio.setMuted(true);
  assert.equal(upper.paused,true);
  audio.setMuted(false);
  assert.equal(upper.paused,false);
  audio.setPlaying(false);
  assert.equal(upper.paused,true);
  audio.setPlaying(true);
  assert.equal(upper.paused,false);

  audio.frame(world,ground,{altitudeOverview:false});
  assert.equal(upper.paused,true);
  assert.equal(upper.src,undefined);
  assert.equal(normal.paused,false);
  assert.equal(normal.currentTime,14);
  assert.equal(audio.stats().musicMode,'overworld');
});

test('the NPC track takes priority and departing resumes the applicable music',async t=>{
  const {audio,players}=await audioFixture(t);
  audio.frame(world,ground);
  const bard={health:1,position:ground,bard:{sound:'/generated/npcs/sound/bard.ogg',minRange:2,maxRange:64}};
  const [normal]=players;
  normal.currentTime=23;
  audio.npcMusic([bard],ground,0);
  await Promise.resolve();
  assert.equal(normal.paused,true);
  audio.npcMusic([],ground,100);
  assert.equal(normal.paused,false);
  assert.equal(normal.currentTime,23);
  audio.effects([{sound:'record.disc',position:[0,254,0]}],world);
  audio.npcMusic([bard],ground,200);
  await Promise.resolve();
  const [,,,npc]=players;
  const record=players[2];
  assert.equal(npc.paused,false);
  assert.equal(record.paused,true);
  assert.equal(normal.paused,true);
  assert.equal(audio.stats().musicMode,'npc');
  audio.setAltitudeMusic('blob:one');
  audio.frame(world,high,{altitudeOverview:true});
  assert.equal(npc.paused,false);
  assert.equal(audio.stats().musicMode,'npc');
  audio.npcMusic([bard],{...high,x:128},2100);
  const first=players.at(-1);
  assert.equal(npc.paused,true);
  assert.equal(record.paused,true);
  assert.equal(first.paused,false);
  assert.equal(audio.stats().musicMode,'altitude');
  audio.setAltitudeMusic('blob:two');
  assert.equal(first.src,undefined);
  assert.equal(first.paused,true);
  assert.equal(players.at(-1).src,'blob:two');
  audio.setAltitudeMusic(null);
  assert.equal(audio.stats().altitudeMusicConfigured,false);
  assert.equal(record.paused,false);
  audio.npcMusic([bard],ground,2300);
  await Promise.resolve();
  assert.equal(audio.stats().musicMode,'npc');
  audio.npcMusic([],ground,2400);
  assert.equal(record.paused,false);
});

test('entering an unavailable NPC music zone keeps the background track playing',async t=>{
  const {audio,players}=await audioFixture(t);
  audio.frame(world,ground);
  const bard={health:1,position:ground,bard:{sound:'/generated/npcs/sound/unavailable.ogg',minRange:2,maxRange:64}};
  audio.npcMusic([bard],ground,0);
  await Promise.resolve();
  assert.equal(audio.stats().musicMode,'overworld');
  assert.equal(players[0].paused,false);
});
