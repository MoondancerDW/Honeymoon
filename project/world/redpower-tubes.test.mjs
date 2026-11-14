import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayObject} from '../server/base.mjs';
import {collisionFor, redPowerTubeMesh, shapeFor} from './geometry.mjs';

const tube = (parts = [], pCol = 0) => ({key:'cover:750:8:tube', parts, object:{type:'RPTube', data:{pCol}}});
const bounds = ({x0, y0, z0, x1, y1, z1}) => [x0, y0, z0, x1, y1, z1];

test('a RedPower tube connects its source side mesh without adding collision to the arm', () => {
  const neighbors = (x, y, z) => z ? tube() : null;
  const [body] = redPowerTubeMesh(tube(), neighbors);
  assert.deepEqual(bounds(body), [.25, .25, 0, .75, .75, 1]);
  assert.deepEqual(body.faces, [576, 576, 576, 576, -1, -1]);
  assert.deepEqual(collisionFor(tube(), neighbors).map(bounds), [[.25, .25, .25, .75, .75, .75]]);
  assert.deepEqual(shapeFor(tube(), neighbors).map(bounds), [[.25, .25, .25, .75, .75, .75]]);
});

test('solid and hollow face covers handle tube openings differently', () => {
  const solid = [{slot: 3, material:0, shape:0}];
  const hollow = [{slot: 3, material:0, shape:3}];
  const neighbors = (x, y, z) => z ? tube() : null;
  assert.deepEqual(redPowerTubeMesh(tube(solid), neighbors)[1].faces, [577, 577, 577, 577, -1, 577]);
  assert.deepEqual(bounds(redPowerTubeMesh(tube(hollow), neighbors).at(-1)), [.25, .25, 0, .75, .75, 1]);
});

test('tube endpoints respect saved machine orientation and transmit only public paint data', () => {
  const transpose = {key:'legacy:763:2', object:{type:'RPTranspose', data:{rot:0}}};
  const buffer = {key:'legacy:751:2', object:{type:'RPBuffer'}};
  const [body, horizontal, vertical] = redPowerTubeMesh(tube(), (x, y) => y > 0 ? transpose : x > 0 ? buffer : x < 0 ? transpose : null);
  assert.deepEqual(body.faces, [577, -1, 577, -1, 577, 577]);
  assert.deepEqual(bounds(horizontal), [.75, .25, .25, 1, .75, .75]);
  assert.deepEqual(bounds(vertical), [.25, .75, .25, .75, 1, .75]);
  assert.deepEqual(displayObject({type:'RPTube', data:{pCol:14, Items:[{}]}}).data, {pCol:14});
});
