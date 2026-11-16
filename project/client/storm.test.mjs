import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rainAudioMix} from './audio.mjs';
import {rainRoofKind} from './rain-cover.mjs';
import {rainStrength,stormAt} from './storm.mjs';
import {windAt} from './wind.mjs';

test('a storm flashes briefly, then thunders later during the same weather event',()=>{
  const first=Array.from({length:9600},(_,i)=>i*10).find(epoch=>stormAt(epoch)?.flash>.82);
  assert.ok(first>10_000);
  const strike=stormAt(first);
  assert.ok(strike.soundAt-first>950);
  assert.equal(stormAt(strike.soundAt).id,strike.id);
  assert.equal(stormAt(strike.soundAt).flash,0);
  assert.equal(stormAt(first+4_500),null);
});

test('audio follows rain gusts, stays audible beneath roofs, and changes to a soft bed in snow',()=>{
  const low=rainStrength({strength:.1}), high=rainStrength({strength:.9});
  assert.ok(high>low);
  assert.ok(rainAudioMix('rain',high,.3).open>rainAudioMix('rain',low,.3).open);
  const cover={roof:rainRoofKind('legacy:3250:0'),sheltered:true,roofHeight:3,exposure:.15};
  const under=rainAudioMix('rain',high,.3,cover);
  assert.equal(cover.roof,'foliage');
  assert.equal(rainRoofKind('legacy:2183:0'),'stone');
  assert.equal(under.roof,'foliage');
  assert.ok(under.open>0 && under.impact>under.open);
  assert.ok(under.impact>rainAudioMix('rain',high,.3,{...cover,roofHeight:15}).impact);
  const snow=rainAudioMix('snow',high,.3,cover);
  assert.equal(snow.impact,0);
  assert.equal(snow.open,0);
  assert.ok(snow.snow>0);
  assert.ok(rainAudioMix('snow',high,.3).snow>snow.snow);
  const average=mode=>Array.from({length:64},(_,i)=>windAt(i*413,mode).strength).reduce((a,b)=>a+b)/64;
  assert.ok(average('rain')>average('cloudy') && average('cloudy')>2*average('clear'));
});
