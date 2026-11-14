import {blockState} from '../world/block-interactions.mjs';
import soundTypes from '../world/block-sound-types.json' with {type: 'json'};

const instruments = new Map(Object.entries(soundTypes.instruments).flatMap(([instrument, ids]) =>
  ids.map(id => [id, instrument])));
// Legacy item IDs start at 2256. Durations are in milliseconds, rounded up
// from the final Vorbis granule and sample rate of the exported Honeymoon tracks.
const records = [
  ['13', 64385],
  ['cat', 231178],
  ['blocks', 197713],
  ['chirp', 244993],
  ['far', 144900],
  ['mall', 266027],
  ['mellohi', 48633],
  ['stal', 204720],
  ['strad', 199633],
  ['ward', 233796],
  ['11', 117839],
  ['wait', 129120],
];
const objectAt = (x, y, z, type, data) => ({key: `tile:${x}:${y}:${z}`, position: [x, y, z], type, data});

export function noteSound(getCell, x, y, z, note) {
  if (getCell(x, y + 1, z).cell) return null;
  const support = getCell(x, y - 1, z).cell;
  const [block] = blockState(support);
  return {type: 'sound', sound: `note.${instruments.get(block) ?? 'harp'}`, position: [x, y, z],
    pitch: 2 ** ((note - 12) / 12), volume: 3};
}

export const musicBlocks = {
  id: 'music-blocks',
  version: 1,
  prepareInteraction({x, y, z, current, getCell, readState, now}) {
    const [id, meta] = blockState(current.cell);
    const data = current.object?.data ?? {};
    if (id === 25) {
      const previous = typeof data.note === 'number' ? Math.min(24, Math.max(0, Math.trunc(data.note))) : 0;
      const note = (previous + 1) % 25;
      const object = objectAt(x, y, z, 'Music', {...data, note});
      const effect = noteSound(getCell, x, y, z, note);
      return {cells: [{...current, object}], effects: effect ? [effect] : []};
    }
    if (id !== 84 || !meta) return null;
    const record = records[(data.RecordItem?.id ?? data.Record ?? 0) - 2256];
    if (!record) return null;
    const [name, duration] = record;
    const key = `disc:${x}:${y}:${z}`;
    const active = (readState('world', key)?.value?.until ?? 0) > now;
    return {
      state: [{owner: 'world', key, value: {until: active ? 0 : now + duration}}],
      effects: [{type: 'sound', sound: active ? 'record.stop' : `record.${name}`, position: [x, y, z]}],
    };
  },
};
