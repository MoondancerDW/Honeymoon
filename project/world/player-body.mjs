// The original stands 0.6 blocks wide and 1.8 blocks tall. Those fields are Java floats.
export const PLAYER = Object.freeze({halfWidth: Math.fround(.6) / 2, height: Math.fround(1.8), eye: 1.62});

export const WALK_SPEED = 3.8;
export const GROUND_SPRINT_SPEED = 5.1 * 1.4;
export const FLIGHT_SPEED = 5.1;
export const FLIGHT_SPRINT_SPEED = FLIGHT_SPEED * 2;
export const FLIGHT_VERTICAL_MULTIPLIER = 2;
export const POSITION_TRAIL_LIMIT = 32;
// Allow the longest 16 ms flight sprint step plus rounding and diagonal collision corrections.
export const POSITION_STEP_LIMIT = .17;
export const POSITION_BATCH_LIMIT = 2.1;

export function positionCost(planar, vertical) {
  // The movement budget operates in input units, before vertical flight scaling.
  return Math.hypot(planar, Math.max(0, vertical) / FLIGHT_VERTICAL_MULTIPLIER);
}
