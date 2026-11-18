import {FLIGHT_SPRINT_SPEED, POSITION_BATCH_LIMIT, POSITION_TRAIL_LIMIT, flightPositionCost} from '../world/player-body.mjs';

const stepCost = (from, step, flying) =>
  flightPositionCost(Math.hypot(step[0] - from[0], step[2] - from[2]),from[1],step[1],flying);

export function positionBatch(confirmed, pending, lastStep, flying = false) {
  const trail = [];
  let distance = 0, drop = 0;
  let from = confirmed;
  // Leave room in the server's wall-clock speed budget, and split long
  // vertical falls before they exceed its six-block downward limit.
  for (const step of pending) {
    const deltaY = step[1] - from[1];
    distance += stepCost(from, step, flying);
    drop += Math.max(0, -deltaY);
    if (trail.length && (trail.length >= POSITION_TRAIL_LIMIT || distance > POSITION_BATCH_LIMIT || drop > 6)) break;
    trail.push(step);
    from = step;
    if (step === lastStep) break;
  }
  return {target:from, trail};
}

export function positionSendInterval(confirmed, trail, normalIntervalMs, flying = false) {
  let cost = 0;
  let from = confirmed;
  for (const step of trail) {
    cost += stepCost(from, step, flying);
    from = step;
  }
  // Queued movement can fill an entire packet. Give the server time to accrue its next movement budget.
  return Math.max(normalIntervalMs, Math.ceil(cost * 1000 / (FLIGHT_SPRINT_SPEED + 1)));
}
