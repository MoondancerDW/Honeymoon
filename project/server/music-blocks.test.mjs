import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayObject} from './base.mjs';
import {musicBlocks, noteSound} from './music-blocks.mjs';

const position = [3, 20, 5];
const context = (cell, data, getCell = () => ({cell: null}), state, now = 1000) => ({
  x: position[0], y: position[1], z: position[2], current: {x: position[0], y: position[1], z: position[2], cell,
    object: {data}}, getCell, readState: () => ({value: state}), now,
});

test('note block tunes and plays the original instrument, pitch and volume', () => {
  const support = (x, y) => ({cell: y < 20 ? 'legacy:5:0' : null});
  const result = musicBlocks.prepareInteraction(context('legacy:25:0', {note: 11}, support));
  assert.deepEqual(result.effects, [{type: 'sound', sound: 'note.bassattack', position, pitch: 1, volume: 3}]);
  assert.equal(displayObject(result.cells[0].object).data.note, 12);
  const blocked = () => ({cell: 'legacy:1:0'});
  const wrap = musicBlocks.prepareInteraction(context('legacy:25:0', {note: 24}, blocked));
  assert.equal(wrap.cells[0].object.data.note, 0);
  assert.deepEqual(wrap.effects, []);
  assert.equal(noteSound(support, ...position, 0).pitch, .5);
});

test('a filled jukebox can stop a disc before its original track ends and restart it afterward', () => {
  const disc = {RecordItem: {id: 2260, Count: 1, tag: {hidden: 'private'}}};
  const use = (state, now) => musicBlocks.prepareInteraction(context('legacy:84:1', disc, undefined, state, now));
  const filled = use({active: true}, 1000);
  assert.equal(filled.effects[0].sound, 'record.far');
  const playing = filled.state[0].value;
  assert.deepEqual(playing, {until: 145900});
  const stopped = use(playing, 145899);
  assert.equal(stopped.effects[0].sound, 'record.stop');
  assert.equal(use(stopped.state[0].value, 145899).effects[0].sound, 'record.far');
  assert.equal(use(playing, 145900).effects[0].sound, 'record.far');
  assert.equal(musicBlocks.prepareInteraction(context('legacy:84:0', {})), null);
  assert.deepEqual(displayObject({type: 'RecordPlayer', data: disc}).data, {Record: 2260});
});
