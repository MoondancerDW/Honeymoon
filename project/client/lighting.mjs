// Overworld light map used by Minecraft 1.4.7 at gamma 0.
// Each byte holds saved sky light in the high nibble and block light in the low nibble.
export const FACE_SHADE = Object.freeze([.6, .6, .5, 1, .8, .8]);

export function contactShade(sideU, sideV, corner) {
  const covered = sideU && sideV ? 3 : Number(sideU) + Number(sideV) + Number(corner);
  return 1 - covered * .105;
}

function level(nibble) {
  const value = nibble / 15;
  return value / (4 - 3 * value);
}

function channel(value) {
  return Math.trunc(255 * (.96 * Math.min(1, .96 * value + .03) + .03));
}

function channels(index, sun) {
  const sky = level(index >> 4) * (.95 * sun + .05);
  const warmSky = sky * (.65 * sun + .35);
  const warm = 1.5 * level(index & 15);
  return [channel(warmSky + warm), channel(warmSky + warm * (.64 + .36 * warm)),
    channel(sky + warm * (.4 + .6 * warm * warm))];
}

const colors = Array.from({length: 256}, (_, index) => channels(index, 1));

export function celestialAngle(tick) {
  const cycle = ((tick % 24000 + 24000) % 24000) / 24000;
  const angle = (cycle + .75) % 1;
  return (2 * angle + 1 - (Math.cos(Math.PI * angle) + 1) / 2) / 3;
}

export function sunlightAt(tick) {
  return .16 + .84 * Math.max(0, Math.min(1, 2 * Math.cos(Math.PI * 2 * celestialAngle(tick)) + .2));
}

export function writeLightmap(target, sun) {
  for (let i = 0; i < 256; i++) {
    const [r,g,b] = channels(i, sun);
    target.set([r,g,b,255], i * 4);
  }
  target.fill(255, 256 * 4);
}

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
