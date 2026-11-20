import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createChat} from './chat.mjs';
import {createWorldTime} from './world-time.mjs';
import {openStore} from './store.mjs';
import {limitChatText} from '../world/chat-text.mjs';
import {formatClock, tickFromTime} from '../world/world-time.mjs';

test('all 1440 clock minutes round trip and the shared clock freezes, resumes and reloads', () => {
  for (let minutes = 0; minutes < 1440; minutes++) {
    const text = [Math.floor(minutes / 60), minutes % 60].map(x => String(x).padStart(2, '0')).join(':');
    assert.equal(formatClock(tickFromTime(text)), text);
  }
  assert.ok(Number.isNaN(tickFromTime('24:00')));
  const store = openStore(':memory:');
  try {
    let now = 1000;
    const clock = createWorldTime(store, () => now);
    assert.equal(clock.snapshot().tick, 6000);
    now += 1999;
    assert.equal(formatClock(clock.snapshot().tick), '12:00');
    now += 1;
    assert.equal(formatClock(clock.snapshot().tick), '12:01');
    assert.deepEqual(clock.set({tick:23999, frozen:true}), {tick:23999, frozen:true});
    now += 105;
    assert.deepEqual(clock.snapshot(), {tick:23999, frozen:true});
    assert.deepEqual(createWorldTime(store, () => now).snapshot(), clock.snapshot());
    clock.set({frozen:false});
    now += 360;
    assert.deepEqual(clock.snapshot(), {tick:2, frozen:false});
    now += 120000;
    assert.equal(formatClock(clock.snapshot().tick), '07:00');
    assert.throws(() => clock.set({tick:24000}), {code:'invalid_world_time'});
  } finally { store.close(); }
});

test('weather fronts advance independently of the game clock, with wet and dry cloud phases', () => {
  const store=openStore(':memory:');
  try {
    let now=12_000;
    const minutes=60_000;
    const wet=createWorldTime(store,()=>now,()=>0);
    const step=()=>{now=wet.weatherSettings().nextChangeAt;return wet.advanceWeather();};
    wet.set({tick:18_000,frozen:true});
    assert.deepEqual(wet.setWeather({dynamic:true}),{mode:'clear',dynamic:true,nextChangeAt:now+15*minutes});
    assert.equal(wet.advanceWeather(),undefined);
    assert.deepEqual(step(),{mode:'cloudy',dynamic:true,nextChangeAt:now+2*minutes});
    assert.deepEqual(step(),{mode:'rain',dynamic:true,nextChangeAt:now+5*minutes});
    assert.deepEqual(step(),{mode:'cloudy',dynamic:true,nextChangeAt:now+minutes});
    assert.deepEqual(step(),{mode:'clear',dynamic:true,nextChangeAt:now+15*minutes});
    assert.equal(wet.snapshot().tick,18_000);

    const dry=createWorldTime(store,()=>now,()=>.9);
    assert.deepEqual(dry.weatherSettings(),wet.weatherSettings());
    now=dry.weatherSettings().nextChangeAt;
    assert.equal(dry.advanceWeather().mode,'cloudy');
    now=dry.weatherSettings().nextChangeAt;
    assert.equal(dry.advanceWeather().mode,'clear');
    assert.deepEqual(dry.setWeather({mode:'snow',dynamic:false}),{mode:'snow',dynamic:false,nextChangeAt:null});
    now+=60*minutes;
    assert.equal(dry.advanceWeather(),undefined);
    assert.equal(createWorldTime(store,()=>now).weather(),'snow');
    assert.throws(()=>dry.setWeather({mode:'wind'}),{code:'invalid_weather'});
    assert.throws(()=>dry.setWeather({dynamic:'false'}),{code:'invalid_weather'});
  } finally { store.close(); }
});

test('chat preserves ordering and four-hour history, announces player status and bounds spam', () => {
  const sent = [];
  let now = 1000;
  const store = openStore(':memory:');
  const chat = createChat({store, publish:entry => sent.push(entry), recipients:() => ['near'], now:() => now});
  const profile = {id:'profile', nickname:'Искра'};
  const point = {x:0,y:0,z:0};
  try {
    assert.throws(() => chat.message(null, {text:'Привет'}, 'sender', point), {code:'not_online'});
    assert.throws(() => chat.message(profile, {text:'Привет'}, 'sender'), {code:'not_online'});
    assert.throws(() => chat.message(profile, {text:'Привет'}, 'sender', {...point,x:NaN}), {code:'not_online'});
    chat.playerStatus(profile, true);
    assert.throws(() => chat.message(profile, {text:'x'.repeat(513)}, 'sender', point), {code:'invalid_chat'});
    assert.throws(() => chat.message(profile, {text:'one\ntwo'}, 'sender', point), {code:'invalid_chat'});
    for (let i = 0; i < 5; i++) chat.message(profile, {text:'  Привет!  '}, 'sender', point);
    assert.throws(() => chat.message(profile, {text:'Снова'}, 'sender', point), {code:'chat_rate_limit'});
    assert.equal(sent[5].text, 'Привет!');
    chat.playerStatus(profile, false);
    assert.deepEqual(sent.at(-1), {id:7, kind:'leave', nickname:'Искра',at:now});
    for (let i = 0; i < 105; i++) {
      now += 1000;
      chat.message(profile, {text:'<img src=x>'}, 'sender', point);
    }
    now += 1000;
    const local = chat.message(profile, {text:'Привет рядом', channel:'local'}, 'sender', {x:0, y:0, z:0});
    assert.ok(chat.history('near').length > 100);
    assert.deepEqual(chat.history('near'), sent);
    assert.deepEqual(chat.history('sender').at(-1), local);
    assert.equal(chat.history('far').at(-1).text, '<img src=x>');
  } finally { chat.close(); store.close(); }
});

test('the shared chat text limiter never splits an emoji at the 512-code-point boundary', () => {
  assert.equal(limitChatText('x'.repeat(513)), 'x'.repeat(512));
  assert.equal(limitChatText('🌙'.repeat(513)), '🌙'.repeat(512));
  const mixed = 'x'.repeat(511) + '🌙';
  assert.equal(limitChatText(mixed + '!'), mixed);
});
