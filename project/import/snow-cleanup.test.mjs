import assert from 'node:assert/strict';
import test from 'node:test';
import {findStraySnow} from './snow-cleanup.mjs';

test('cleans isolated snow on roofs and low ground while protecting snowy fields', () => {
  const stray = [{x:0,y:60,z:0,layers:1},{x:12,y:60,z:0,layers:1},{x:20,y:60,z:0,layers:1}];
  const cluster = Array.from({length:12},(_,i) => ({x:40+(i%4),y:60,z:Math.floor(i/4),layers:1}));
  assert.deepEqual(findStraySnow([...stray,...cluster]),stray);
});

test('cleans an isolated eight-cell ring but retains the same ring in a snowy area', () => {
  const ring = x => Array.from({length:9},(_,i) => ({x:x+i%3-1,y:65,z:Math.floor(i/3)-1,layers:1}))
    .filter(point => point.x !== x-1 || point.z !== 0);
  const stray = ring(-105);
  const snowfield = [...ring(20),{x:22,y:65,z:0,layers:1},{x:22,y:65,z:-1,layers:1}];
  assert.deepEqual(findStraySnow([...stray,...snowfield]),stray);
});

test('protects high natural ground, fringe of a snowy slope, thick layers and full snow blocks', () => {
  const slope = Array.from({length:49},(_,i) => ({x:20+i%7,y:86,z:Math.floor(i/7)-3,layers:1}));
  const fringe = {x:10,y:74,z:0,layers:1};
  const mountain = {x:-50,y:112,z:0,layers:1,supportId:1};
  const thick = {x:-40,y:65,z:0,layers:3};
  const full = {x:-20,y:65,z:0,full:true};
  const roof = {x:-80,y:112,z:0,layers:1};
  assert.deepEqual(findStraySnow([...slope,fringe,mountain,thick,full,roof],()=> 'legacy:35:0'),[roof]);
});

test('keeps the edges of narrow continuous snow and snow beside a full snow block', () => {
  const ridge = Array.from({length:12},(_,i) => ({x:i,y:72,z:0,layers:1}));
  const more = {x:30,y:65,z:0,layers:2};
  const full = {x:31,y:65,z:0,full:true};
  assert.deepEqual(findStraySnow([...ridge,more,full]),[]);
});
