import {POSITION_BATCH_LIMIT, POSITION_TRAIL_LIMIT, positionCost} from '../world/player-body.mjs';

export function positionBatch(confirmed, pending, lastStep) {
  const trail = [];
  let distance = 0, drop = 0;
  let from = confirmed;
  // Leave room in the server's wall-clock speed budget, and split long
  // vertical falls before they exceed its six-block downward limit.
  for (const step of pending) {
    const deltaY = step[1] - from[1];
    distance += positionCost(Math.hypot(step[0] - from[0],step[2] - from[2]),deltaY);
    drop += Math.max(0, -deltaY);
    if (trail.length && (trail.length >= POSITION_TRAIL_LIMIT || distance > POSITION_BATCH_LIMIT || drop > 6)) break;
    trail.push(step);
    from = step;
    if (step === lastStep) break;
  }
  return {target:from, trail};
}
