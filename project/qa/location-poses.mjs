import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const [surveyFile, output, extraFile] = process.argv.slice(2);
assert.ok(surveyFile && output, 'Usage: node qa/location-poses.mjs SURVEY_JSON POSES_TXT [EXTRA_POSES_TXT]');
const survey = JSON.parse(readFileSync(surveyFile, 'utf8'));
const partsOf = pose => pose.id.split('-');
const roomId = pose => partsOf(pose).slice(0, 2).join('-');
const sectorId = pose => partsOf(pose).slice(1, 3).join(',');
const coordinateId = value => String(value).replace('-', 'n');
const roomViews = Map.groupBy(survey.route.checkpoints.filter(p => p.kind === 'interior'), roomId);
const sectorViews = Map.groupBy(survey.route.checkpoints.filter(p => p.kind === 'exterior'), sectorId);
const chosen = new Map();
const add = pose => chosen.set(pose.id, pose);
const nearest = (poses, target) => {
  const distance = pose => pose.feet.reduce((sum, value, i) => sum + (value - target[i]) ** 2, 0);
  return poses.reduce((best, pose) => distance(pose) < distance(best) ? pose : best);
};
for (const room of survey.rooms.filter(room => room.spawnReachable)) {
  const poses = roomViews.get(room.id);
  assert.ok(poses?.length, `Missing reachable interior ${room.id}`);
  add(nearest(poses, room.representative));
}
for (const sector of survey.exterior) {
  const poses = sectorViews.get(sector.sector.map(coordinateId).join(','));
  assert.ok(poses?.length, `Missing outdoor sector ${sector.sector}`);
  add(nearest(poses, sector.station));
}
const catalogViews = survey.route.checkpoints.filter(p => p.kind === 'object' && p.objectType);
for (const group of Map.groupBy(catalogViews, pose => pose.objectType).values()) add(group[0]);
for (const pose of survey.route.checkpoints.filter(p => ['model', 'canopy', 'spawn'].includes(p.kind))) add(pose);

if (extraFile) {
  for (const line of readFileSync(extraFile, 'utf8').trim().split(/\r?\n/)) {
    const [id, x, y, z, yaw, pitch] = line.trim().split(/\s+/);
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok([x, y, z, yaw, pitch].map(Number).every(Number.isFinite), line);
    add({ id, feet: [x, y, z].map(Number), yaw: Number(yaw), pitch: Number(pitch) });
  }
}

// Visit nearby camera positions in succession so the original client can reuse loaded chunks.
const poses = [...chosen.values()].sort((a, b) => {
  const band = pose => Math.floor(pose.feet[2] / 16);
  const direction = band(a) & 1 ? -1 : 1;
  return band(a) - band(b) || direction * (a.feet[0] - b.feet[0]) || a.feet[2] - b.feet[2] || a.feet[1] - b.feet[1];
});
writeFileSync(output, poses.map(p => [p.id, ...p.feet, p.yaw, p.pitch].join(' ')).join('\n') + '\n');
console.log(JSON.stringify({ poses: poses.length, interiors: roomViews.size, exteriorSectors: sectorViews.size }));
