import {blockKey,blockState,signalSides} from '../world/block-interactions.mjs';

export const isPiston = id => id === 29 || id === 33;

const axes = ['x','y','z'];
const position = cell => axes.map(axis => cell[axis]);
const target = (cell,step,distance = 1) => position(cell).map((value,index) => value + distance * step[index]);
const blockedIds = new Set([7,26,29,33,34,36,49,52,54,63,64,68,71,90,116,119,120,130,137,138]);
const clearing = cell => ({...cell,cell:null,object:null});

export function pistonHead(cell,getCell) {
  const [id,meta] = blockState(cell);
  const side = signalSides[meta & 7];
  if (!isPiston(id) || !(meta & 8) || !side) return null;
  const head = getCell(...target(cell,side));
  const [headId,headMeta] = blockState(head);
  return headId === 34 && (headMeta & 7) === (meta & 7) ? head : null;
}

export function movePiston(cell, powered, getCell, context) {
  const [id,meta] = blockState(cell);
  const direction = meta & 7, step = signalSides[direction];
  if (!step || powered === Boolean(meta & 8)) return null;
  const front = getCell(...target(cell,step));
  const changes = [{...cell,cell:blockKey(id,direction | (powered ? 8 : 0))}];
  const movable = source => {
    const [id] = blockState(source);
    return id && !blockedIds.has(id) && !source.object && !source.parts && !source.voxels && context.pistonMovable(source);
  };
  const moving = (source,destination) => ({...destination,cell:source.cell,object:null,moveOwner:context.ownerAt(source)});
  if (powered) {
    if (!context.pistonDestination(front)) return null;
    const chain = [front];
    while (chain.at(-1).cell !== null) {
      if (chain.length > 12 || !movable(chain.at(-1))) return null;
      const next = getCell(...target(cell,step,chain.length + 1));
      if (!context.pistonDestination(next)) return null;
      chain.push(next);
    }
    for (let i = chain.length - 1; i > 0; i--) changes.push(moving(chain[i - 1],chain[i]));
    changes.push({...front,cell:blockKey(34,direction | (id === 29 ? 8 : 0)),object:null});
  } else {
    const head = pistonHead(cell,getCell);
    if (head) {
      const beyond = id === 29 ? getCell(...target(cell,step,2)) : null;
      if (beyond && movable(beyond) && !context.playerOverlaps(head.x,head.y,head.z,beyond.cell)) {
        changes.push(moving(beyond,head),clearing(beyond));
      } else changes.push(clearing(head));
    }
  }
  if (changes.some(change => change.cell !== null && context.playerOverlaps(change.x,change.y,change.z,change.cell))) {
    return {blocked:true};
  }
  return {cells:changes,effects:[{type:'sound',sound:powered ? 'piston.extend' : 'piston.retract',position:position(cell)}]};
}
