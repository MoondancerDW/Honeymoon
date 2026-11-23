import {staticEmission, staticOpacity} from './block-light-properties.mjs';

const idOf = key => Number(/^\w+:(\d+):/.exec(key ?? '')?.[1] ?? 0);

export function emissionOf(key, data) {
  const id = idOf(key);
  if (id === 768) return Boolean(data?.ps & 1) !== Boolean(data?.ps & 2) ? 15 : 0;
  if (id === 753 && data?.sid === 16 && key === 'legacy:753:1') return 0;
  if (id === 2168 && (data?.jarContent === 'empty' || data?.jarContent === 'cookie')) return 0;
  return staticEmission[id] ?? 0;
}

export function attenuationOf(key, emit = 0) {
  const opacity = key === 'game:door' ? 0 : staticOpacity[idOf(key)] ?? 0;
  return opacity >= 15 && emit ? 1 : Math.max(1, Math.min(15, opacity));
}
