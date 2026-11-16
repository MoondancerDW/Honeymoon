import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createChat} from './chat.mjs';
import {createWorldTime} from './world-time.mjs';
import {openStore} from './store.mjs';
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
    assert.deepEqual(clock.set({tick:23999, frozen:true}), {tick:23999, frozen:true});
    now += 105;
    assert.deepEqual(clock.snapshot(), {tick:23999, frozen:true});
    assert.deepEqual(createWorldTime(store, () => now).snapshot(), clock.snapshot());
    clock.set({frozen:false});
    now += 180;
    assert.deepEqual(clock.snapshot(), {tick:2, frozen:false});
    now += 60000;
    assert.equal(formatClock(clock.snapshot().tick), '07:00');
    assert.throws(() => clock.set({tick:24000}), {code:'invalid_world_time'});
  } finally { store.close(); }
});

test('chat preserves ordering, sends join and leave with the nickname and bounds spam and history', () => {
  const sent = [];
  let now = 1000;
  const store = openStore(':memory:');
  const chat = createChat({store, publish:entry => sent.push(entry), recipients:() => ['near'], now:() => now});
  const profile = {id:'profile', nickname:'Искра'};
  try {
    assert.throws(() => chat.message(null, {text:'Привет'}), {code:'not_online'});
    chat.playerStatus(profile, true);
    assert.throws(() => chat.message(profile, {text:'x'.repeat(241)}), {code:'invalid_chat'});
    assert.throws(() => chat.message(profile, {text:'one\ntwo'}), {code:'invalid_chat'});
    for (let i = 0; i < 5; i++) chat.message(profile, {text:'  Привет!  '});
    assert.throws(() => chat.message(profile, {text:'Снова'}), {code:'chat_rate_limit'});
    assert.equal(sent[5].text, 'Привет!');
    chat.playerStatus(profile, false);
    assert.deepEqual(sent.at(-1), {id:7, kind:'leave', nickname:'Искра'});
    for (let i = 0; i < 105; i++) {
      now += 1000;
      chat.message(profile, {text:'<img src=x>'});
    }
    now += 1000;
    const local = chat.message(profile, {text:'Привет рядом', channel:'local'}, 'sender', {x:0, y:0, z:0});
    assert.equal(chat.history('near').length, 100);
    assert.deepEqual(chat.history('near'), sent.slice(-100));
    assert.deepEqual(chat.history('sender').at(-1), local);
    assert.equal(chat.history('far').at(-1).text, '<img src=x>');
  } finally { store.close(); }
});
