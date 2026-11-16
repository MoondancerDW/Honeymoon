const tau = Math.PI * 2;
const ease = value => {
  const unit = Math.min(1,Math.max(0,value));
  return unit * unit * (3 - 2 * unit);
};

export const ponyEmoteDuration = {wave:1.8,dance:2.4};

function wave(rig,visual,t,blend) {
  const hoof = rig.legs[0];
  const greeting = Math.sin(t * tau * 1.45);
  hoof.rotation.x += (-1.48 - .20 * greeting - hoof.rotation.x) * blend;
  hoof.rotation.y += (.65 + .17 * greeting - hoof.rotation.y) * blend;
  hoof.rotation.z += (.17 + .08 * greeting - hoof.rotation.z) * blend;
  rig.head.rotation.x += (.2 + .11 * greeting) * blend;
  visual.position.y += .035 * blend;
}

function dance(rig,visual,t,blend) {
  const step = Math.sin(t * tau * 2), lean = Math.sin(t * tau);
  for (const [i,leg] of rig.legs.entries()) {
    const diagonal = i === 0 || i === 3 ? step : -step;
    leg.rotation.x -= (.73 * Math.max(0,diagonal) - .12 * diagonal) * blend;
    leg.rotation.z += .09 * lean * blend;
  }
  rig.head.rotation.y += .24 * lean * blend;
  rig.head.rotation.z -= .13 * lean * blend;
  if (rig.tail) rig.tail.rotation.z += .23 * lean * blend;
  visual.position.y += .065 * (.5 + Math.abs(step)) * blend;
  visual.rotation.z -= .095 * lean * blend;
}

const emotes = {wave,dance};

export function applyPonyEmote(rig,visual,id,elapsed,strength) {
  const duration = ponyEmoteDuration[id];
  const pose = emotes[id];
  if (!duration || !pose || elapsed < 0 || id === 'wave' && elapsed >= duration) return false;
  const blend = ease(elapsed / .22) * (id === 'wave' ? ease((duration-elapsed)/.27) : 1);
  pose(rig,visual,elapsed % duration / duration,blend * strength);
  return true;
}
