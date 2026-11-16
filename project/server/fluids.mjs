import {fluidState, flowingCell, plantBlock, plantSubstrate} from '../world/fluid-state.mjs';
import {liquidCavity} from '../world/logged-fluid.mjs';
import {blockState} from '../world/block-interactions.mjs';

const lateral = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
const down = [0,-1,0], up = [0,1,0];
const neighbors = [down,up,...lateral];
const replaceable = new Set([31,32,37,38,39,40,50,51,55,59,75,76,78,93,94,106,111,132,141,142]);
const nativePlants = new Set([...plantBlock.ground,...plantBlock.aquatic]);
const add = (at, side) => at.map((value,index) => value+side[index]);
const address = (x,y,z) => `${x},${y},${z}`;
const ticks = {water:250,lava:1500};
const source = fluid => fluid && !fluid.falling && fluid.level === 0;
const decrement = kind => kind === 'water' ? 1 : 2;
const boxEnds = [['x0','x1'],['y0','y1'],['z0','z1']];
const asCell = cell => cell?.cell && {...cell,key:cell.cell};

export function createFluidSimulation({read,canWrite,clock,model,shape,collision,topSupports}) {
  const scheduled = new Map();
  function schedule(at, delay) {
    if (!canWrite(...at)) return;
    const key = address(...at), due = clock()+delay;
    if (!scheduled.has(key) || scheduled.get(key).due > due) scheduled.set(key,{at,due});
  }
  function ready() {
    const now=clock();
    for (const {due} of scheduled.values()) if (due<=now) return true;
    return false;
  }

  function isPlant(cell, at) {
    const id = blockState(cell)[0];
    return nativePlants.has(id) || id > 255 && shape(asCell(cell),(dx,dy,dz)=>asCell(read(...add(at,[dx,dy,dz]))))
      .some(box=>box.kind === 'cross');
  }

  function changed(changes) {
    for (const {x,y,z} of changes) {
      const at = [x,y,z];
      for (const point of [at,...neighbors.map(side=>add(at,side))]) {
        if (!canWrite(...point)) continue;
        const cell = read(...point), fluid = fluidState(cell);
        if (fluid && !fluid.fake) schedule(point,ticks[fluid.kind]);
        if (isPlant(cell,point)) schedule(point,100);
      }
    }
  }

  function advance() {
    const due = [];
    const now = clock();
    for (const [key,entry] of scheduled) {
      if (entry.due > now) continue;
      scheduled.delete(key);
      due.push(entry.at);
      if (due.length === 96) break;
    }
    if (!due.length) return null;
    const cells = new Map(), detached = [];
    const atCell = (...at) => cells.get(address(...at)) ?? read(...at);
    const local = at => (dx,dy,dz) => asCell(atCell(...add(at,[dx,dy,dz])));
    function set(at, cell, other = {}) {
      if (!canWrite(...at)) return;
      const [x,y,z] = at;
      cells.set(address(...at),{x,y,z,cell,object:null,...other});
    }

    function cavity(at, cell) { return liquidCavity(asCell(cell),local(at),model); }

    function facesConnect(at, other, cell, next, side) {
      if (!cell?.fluid && !next?.fluid && (!next?.cell || fluidState(next) || replaceable.has(blockState(next)[0]))) return true;
      const unit = [{x0:0,y0:0,z0:0,x1:1,y1:1,z1:1}];
      const from = cell?.fluid ? cavity(at,cell) : unit;
      const to = next?.cell && !fluidState(next)?.fake && (!fluidState(next) || next.fluid) ? cavity(other,next) : unit;
      const axis = side.findIndex(Boolean), dir = side[axis] > 0 ? 1 : 0;
      return from.some(a=>a[boxEnds[axis][dir]] === dir && to.some(b=>
        b[boxEnds[axis][1-dir]] === 1-dir && boxEnds.every(([min,max],i)=>i===axis || a[min]<b[max] && b[min]<a[max])));
    }

    function canEnter(at, other, cell, next, side, fluid) {
      if (!canWrite(...other)) return false;
      const water = fluidState(next);
      if (water?.kind === fluid.kind && (water.fake || source(water))) return false;
      if (water && water.kind !== fluid.kind) return facesConnect(at,other,cell,next,side);
      if (water || !next?.cell || replaceable.has(blockState(next)[0])) return facesConnect(at,other,cell,next,side);
      return cavity(other,next).length > 0 && facesConnect(at,other,cell,next,side);
    }

    function setFluid(at, cell, fluid, level, falling = false) {
      const other = fluidState(cell);
      if (other && other.kind !== fluid.kind) {
        if (fluid.kind === 'lava') {
          if (falling && !other.logged) set(at,'legacy:1:0');
        } else if (!other.logged) {
          set(at,source(other) ? 'legacy:49:0' : 'legacy:4:0');
        }
        return;
      }
      if (cell?.cell && (!other || other.logged) && (!replaceable.has(blockState(cell)[0]) || isPlant(cell,at))) {
        if (cavity(at,cell).length && cell.fluid !== fluid.kind) set(at,cell.cell,{object:cell.object,
          parts:cell.parts,voxels:cell.voxels,fluid:fluid.kind,preserveParts:true});
        return;
      }
      const key = flowingCell(fluid.kind,level,falling);
      if (cell?.cell !== key) set(at,key);
    }

    function terrestrialSupport(at, cell) {
      const id = blockState(cell)[0];
      const below = add(at,down), substrate = atCell(...below);
      const belowId = blockState(substrate)[0];
      const allowed = plantSubstrate(id, Boolean(cell.fluid));
      if (!allowed.has(belowId)) return false;
      if (id === 111 || [18,60,243].includes(belowId)) return true;
      return topSupports(...below) || collision(asCell(substrate),local(below)).some(box=>
        box.y1 >= .875 && box.x0 < .35 && box.x1 > .65 && box.z0 < .35 && box.z1 > .65);
    }

    function spread(at) {
      let cell = atCell(...at);
      if (isPlant(cell,at) && !terrestrialSupport(at,cell)) {
        detached.push({at,cell:cell.cell});
        set(at,cell.fluid ? flowingCell(cell.fluid,0) : null);
        cell = atCell(...at);
      }
      let fluid = fluidState(cell);
      if (!fluid || fluid.fake) return;
      const below = add(at,down), support = atCell(...below);
      const sides = lateral.map(side=>{
        const point = add(at,side);
        const adjacent = atCell(...point);
        return {point,side,cell:adjacent,fluid:fluidState(adjacent)};
      });
      if (fluid.kind === 'lava' && !fluid.logged && sides.some(({point,side,cell:next,fluid:water})=>
          water?.kind === 'water' && facesConnect(at,point,cell,next,side))) {
        set(at,source(fluid) ? 'legacy:49:0' : 'legacy:4:0');
        return;
      }
      const horizontalFluid = sides.filter(({point,side,cell:next,fluid:other}) => other?.kind === fluid.kind &&
        !other.fake && facesConnect(at,point,cell,next,side));
      if (!source(fluid)) {
        const over = add(at,up), above = atCell(...over), fromAbove = fluidState(above);
        const spring = fluid.kind === 'water' && horizontalFluid.filter(entry=>source(entry.fluid)).length >= 2 &&
          (source(fluidState(support)) || !canEnter(at,below,cell,support,down,fluid));
        const level = spring ? 0 : Math.min(8,...horizontalFluid.map(({fluid})=>fluid.falling ? 0 : fluid.level)) + decrement(fluid.kind);
        const falling = !spring && fromAbove?.kind === fluid.kind && !fromAbove.fake && facesConnect(at,over,cell,above,up);
        if (!falling && level > 7) { set(at,null); return; }
        setFluid(at,cell,fluid,falling ? 0 : level,falling);
        cell = atCell(...at);
        fluid = fluidState(cell);
      }
      const under = fluidState(support);
      const fall = canEnter(at,below,cell,support,down,fluid);
      if (fall) {
        setFluid(below,support,fluid,0,true);
        if (horizontalFluid.filter(entry=>source(entry.fluid)).length < 3) return;
      } else if (under && under.kind === fluid.kind && !source(under) && !under.fake) return;
      const level = (fluid.falling ? 0 : fluid.level)+decrement(fluid.kind);
      if (level > 7) return;

      function downhill(start, initial) {
        const queue = [{point:start,cell:initial,depth:0}];
        const visited = new Set([address(...at),address(...start)]);
        const limit = fluid.kind === 'water' ? 4 : 2;
        for (const {point,cell:next,depth} of queue) {
          const lower=add(point,down);
          if (canEnter(point,lower,next,atCell(...lower),down,fluid)) return depth;
          if (depth >= limit) continue;
          for (const side of lateral) {
            const other = add(point,side), key = address(...other), target = atCell(...other);
            if (visited.has(key) || !canEnter(point,other,next,target,side,fluid)) continue;
            visited.add(key);
            queue.push({point:other,cell:target,depth:depth+1});
          }
        }
        return Infinity;
      }

      const targets = sides.filter(entry => (!entry.fluid || entry.fluid.kind !== fluid.kind ||
        !entry.fluid.falling && entry.fluid.level > level) && canEnter(at,entry.point,cell,entry.cell,entry.side,fluid));
      const choices = targets.map(entry=>downhill(entry.point,entry.cell));
      const best = Math.min(...choices);
      targets.forEach((entry,i)=>{
        if (choices[i] === best) setFluid(entry.point,entry.cell,fluid,level);
      });
    }

    for (const at of due) spread(at);
    return cells.size ? {cells:[...cells.values()],detached,due} : null;
  }
  return {changed,advance,ready,retry:plan=>plan.due.forEach(point=>schedule(point,50))};
}
