import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSectionVisibility, isOcclusionBlock, markOcclusionBlock, SectionVisibility, visibleSections} from './section-visibility.mjs';
import {shapeFor} from '../world/geometry.mjs';

function section(blocks) {
  const cells = new Uint8Array(4096);
  let count = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    if (!blocks(x,y,z)) continue;
    markOcclusionBlock(cells,x,y,z);
    count++;
  }
  return buildSectionVisibility(cells,count);
}

test('only solid opaque full cubes can seal a view', () => {
  const stone = shapeFor('legacy:1:0')[0];
  assert.ok(isOcclusionBlock(stone));
  for (const blocks of ['legacy:20:0', 'legacy:102:0', 'legacy:9:7', 'legacy:44:0', 'legacy:999:0']) {
    assert.equal(isOcclusionBlock(shapeFor(blocks)[0]), false, blocks);
  }
  assert.equal(isOcclusionBlock({...stone,faces:[1,1,-1,1,1,1]}), false);
  assert.equal(isOcclusionBlock({...stone,angle:Math.PI / 4}), false);
});

test('a separating wall seals opposite faces and one missing block connects them', () => {
  const west = 1, east = 2;
  const sealed = section(x => x === 7);
  const open = section((x,y,z) => x === 7 && !(y === 8 && z === 8));
  assert.ok(sealed.links[0] & west);
  assert.equal(sealed.links[0] & east, 0);
  assert.equal(sealed.links[1] & west, 0);
  assert.equal(open, null, 'all six faces belong to one connected component');
});

test('graph keeps the visible wall and can see through a missing section', () => {
  const wall = new Map();
  const opaque = section(() => true);
  for (let y = 0; y < 16; y++) for (let z = -4; z <= 4; z++) wall.set(`1,${y},${z}`, opaque);
  let view = visibleSections(wall,0,2,0,4,63);
  assert.equal(view.seen(1,2,0), true);
  assert.equal(view.seen(2,2,0), false);
  assert.equal(view.seen(-2,2,0), true);
  wall.delete('1,2,0');
  view = visibleSections(wall,0,2,0,4,63);
  assert.equal(view.seen(2,2,0), true);
});

test('aperture around the far side of a wall cannot turn a line toward the viewer', () => {
  const wall = new Map();
  const opaque = section(() => true);
  for (let y = 0; y < 16; y++) for (let z = -4; z <= 4; z++) wall.set(`1,${y},${z}`, opaque);
  wall.delete('1,2,4');
  const view = visibleSections(wall,0,2,0,4,63);
  assert.equal(view.seen(2,2,3), false);
  assert.equal(view.seen(2,2,4), true);
});

test('camera starts in its own room, preserves neighboring walls and reveals an edited opening', () => {
  const visibility = new SectionVisibility();
  const room = (x,y,z) => x >= 4 && x <= 10 && y >= 4 && y <= 10 && z >= 4 && z <= 10 &&
    (x === 4 || x === 10 || y === 4 || y === 10 || z === 4 || z === 10);
  visibility.setEnabled(true);
  visibility.install('0,0,0', section(room));
  const eye = {x:6.5,y:6.5,z:5.5};
  visibility.update(eye, 4, 1000);
  assert.equal(visibility.visible(0,0,0), true);
  assert.equal(visibility.visible(1,0,0), true);
  assert.equal(visibility.visible(2,0,0), false);
  assert.equal(visibility.update(eye,4,1010), false);
  visibility.invalidate('0,0,0');
  assert.equal(visibility.update(eye,4,1020), true);
  assert.equal(visibility.visible(2,0,0), true);
  visibility.install('0,0,0', section((x,y,z) => room(x,y,z) && !(x === 4 && y === 6 && z === 5)));
  visibility.update(eye,4,1030);
  assert.equal(visibility.visible(2,0,0), true);
});

test('switching the experiment off resets blockers and permits the normal render state', () => {
  const visibility = new SectionVisibility();
  const eye = {x:1.5,y:1.5,z:1.5};
  assert.equal(visibility.statistics().enabled,false);
  assert.equal(visibility.update(eye,4,1000),false);
  assert.equal(visibility.setEnabled(true),true);
  visibility.install('0,0,0',null);
  visibility.install('1,0,0',section(() => true));
  visibility.update(eye,4,1010);
  assert.equal(visibility.statistics().classifiedSections,2);
  assert.equal(visibility.statistics().obstructingSections,1);
  visibility.invalidate('0,0,0');
  assert.equal(visibility.last,null);
  assert.equal(visibility.statistics().classifiedSections,1);
  assert.equal(visibility.update(eye,4,1015),true);
  assert.equal(visibility.setEnabled(false),true);
  assert.equal(visibility.update(eye,4,1020),true);
  assert.equal(visibility.statistics().classifiedSections,0);
  assert.equal(visibility.visible(2,0,0),true);
  assert.equal(visibility.update(eye,4,1030),false);
});
