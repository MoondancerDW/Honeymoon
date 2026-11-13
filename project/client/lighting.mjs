// Daytime Overworld light map used by Minecraft 1.4.7 at gamma 0.
// Each byte holds saved sky light in the high nibble and block light in the low nibble.
export const FACE_SHADE = Object.freeze([.6, .6, .5, 1, .8, .8]);

function level(nibble) {
  const value = nibble / 15;
  return value / (4 - 3 * value);
}

function channel(value) {
  return Math.trunc(255 * (.96 * Math.min(1, .96 * value + .03) + .03));
}

const colors = Array.from({length: 256}, (_, index) => {
  const sky = level(index >> 4);
  const warm = 1.5 * level(index & 15);
  return [channel(sky + warm), channel(sky + warm * (.64 + .36 * warm)),
    channel(sky + warm * (.4 + .6 * warm * warm))];
});

export function coverShade(packed) {
  // RedPower flat Covers multiply directional color by adjacent scalar brightness.
  return level(Math.max(packed >> 4, packed & 15));
}

export function legacyLight(packed) {
  return colors[packed ?? 0];
}

const linear = Array.from({length: 256}, (_, byte) => {
  const value = byte / 255;
  return Math.round(255 * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4));
});

export function linearByte(light, shade, tint) {
  return linear[Math.round(light * shade * tint / 255)];
}
