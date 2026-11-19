export const JUMP_CHARGE_LIMIT = 2;
export const JUMP_CHARGE_RECHARGE_MS = 6_000;
export const JUMP_CHARGE_BONUS = .5;
export const MAGIC_TELEPORT_COOLDOWN_MS = 20_000;
export const MAGIC_TELEPORT_HORIZONTAL = 50;
export const MAGIC_TELEPORT_VERTICAL = 30;

const abilities = Object.freeze({
  earth: Object.freeze({winged:false, horn:false, chargedJump:true, maxHealth:15, sprintMultiplier:1.3, lowFlightMultiplier:1}),
  pegasus: Object.freeze({winged:true, horn:false, chargedJump:false, maxHealth:10, sprintMultiplier:.7, lowFlightMultiplier:.8}),
  unicorn: Object.freeze({winged:false, horn:true, chargedJump:false, maxHealth:10, sprintMultiplier:.85, lowFlightMultiplier:1}),
  alicorn: Object.freeze({winged:true, horn:true, chargedJump:true, maxHealth:15, sprintMultiplier:1.3, lowFlightMultiplier:1}),
});

export function ponyAbilities(type) {
  return Object.hasOwn(abilities,type) ? abilities[type] : abilities.earth;
}
