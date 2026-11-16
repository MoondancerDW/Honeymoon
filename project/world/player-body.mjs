const stances = ['stand','crouch','crawl','swim'];
const bodies = {
  normal: [1.5,1,.5,.6],
  small: [1,.5,.25,.6],
  large: [2,1.5,1,.6],
};
for (const [size, heights] of Object.entries(bodies)) {
  bodies[size] = Object.fromEntries(heights.map((height,index) => [stances[index], Object.freeze({
    size, height, halfWidth:.3, eye:1.62, jumpHeight:stances[index] === 'crawl' ? .5 : size === 'large' ? 1.5 : 1,
  })]));
}

export const PLAYER = bodies.normal.stand;

export const isPlayerStance = stance => stances.includes(stance);

export function playerBody(size, stance) {
  const group = size === 'small' ? bodies.small : size === 'large' || size === 'tall' ? bodies.large : bodies.normal;
  return group[isPlayerStance(stance) ? stance : 'stand'];
}

export const WALK_SPEED = 3.8;
export const CRAWL_SPEED = WALK_SPEED * .26;
export const GROUND_SPRINT_SPEED = 5.1 * 1.4;
export const FLIGHT_SPEED = 7.65;
export const FLIGHT_SPRINT_SPEED = FLIGHT_SPEED * 2;
export const FLIGHT_VERTICAL_MULTIPLIER = 1;
export const POSITION_TRAIL_LIMIT = 32;
// Allow the longest 16 ms flight sprint step plus rounding and diagonal collision corrections.
export const POSITION_STEP_LIMIT = .34;
export const POSITION_BATCH_LIMIT = 4.2;

export function positionCost(planar, vertical) {
  return Math.hypot(planar, Math.max(0, vertical));
}
