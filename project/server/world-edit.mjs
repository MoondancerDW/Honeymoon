import {RequestError} from './errors.mjs';
import {blockKey,blockState} from '../world/block-interactions.mjs';

export const worldEditBlockLimit=4096;
const maxClipboardBytes=2*1024*1024;
const axes=['x','y','z'];
const aliases=new Map([
  ['air',0],['stone',1],['grass',2],['dirt',3],['cobblestone',4],['planks',5],['water',9],['lava',11],
  ['sand',12],['gravel',13],['log',17],['glass',20],['wool',35],['torch',50],['brick_block',45],
]);
const blockField=/^(?:legacy:)?(\d{1,4})(?::(\d{1,2}))?$/;
const commandField=/^\/\/(set|replace|copy|paste)(?:\s|$)/i;
const location=point=>Object.fromEntries(axes.map(axis=>[axis,Math.floor(point[axis])]));

function block(value,mode,game) {
  const input=aliases.get(value.replace(/^minecraft:/i,'').toLowerCase()) ?? value;
  const args=blockField.exec(String(input));
  if (!args) throw new RequestError(400,'worldedit_unknown_block');
  const id=Number(args[1]),meta=Number(args[2]??0);
  if (id>4095||meta>15) throw new RequestError(400,'worldedit_unknown_block');
  const key=id===0?null:blockKey(id,meta);
  if (mode==='write' && key!==null && !game.resolve(key)) throw new RequestError(400,'worldedit_unknown_block');
  return {id,...(args[2]!==undefined&&{meta}),key};
}

function cornerBox(corners) {
  if (corners.some(point=>!point)) throw new RequestError(409,'worldedit_selection_required');
  const [a,b]=corners;
  const min=Object.fromEntries(axes.map(axis=>[axis,Math.min(a[axis],b[axis])]));
  const max=Object.fromEntries(axes.map(axis=>[axis,Math.max(a[axis],b[axis])]));
  if (axes.reduce((count,axis)=>count*(max[axis]-min[axis]+1),1)>worldEditBlockLimit)
    throw new RequestError(409,'worldedit_region_limit',{limit:worldEditBlockLimit});
  return {min,max};
}

function* positions({min,max}) {
  for (let y=min.y; y<=max.y; y++) for (let z=min.z; z<=max.z; z++) for (let x=min.x; x<=max.x; x++) yield {x,y,z};
}

function relocatedObject(object,{x,y,z}) {
  if (!object) return null;
  const position=[x,y,z];
  const data=object.data ? {...object.data} : undefined;
  if (data) {
    for (const [index,axis] of axes.entries()) {
      if (Object.hasOwn(data,axis) && typeof data[axis]==='number') data[axis]=position[index];
      const coordinate=axis+'Coord';
      if (Object.hasOwn(data,coordinate) && typeof data[coordinate]==='number') data[coordinate]=position[index];
    }
  }
  return {...object,position,key:`tile:${position.join(':')}`,...(data&&{data})};
}

function translatedData(cell,position) {
  const {cell:key,object,parts,fluid,voxels}=cell;
  return {...position,cell:key,object:relocatedObject(object,position),
    ...(parts&&{parts}),...(fluid&&{fluid}),...(voxels&&{voxels})};
}

const sameData=(a,b)=>JSON.stringify([a.cell,a.object,a.parts,a.fluid,a.voxels])===JSON.stringify([b.cell,b.object,b.parts,b.fluid,b.voxels]);

export function createWorldEdit({game,isAdmin,isCreative}) {
  const sessions=new Map();
  function authorize(player) {
    if (!isAdmin(player)) throw new RequestError(403,'admin_required');
    if (!isCreative(player)) throw new RequestError(403,'worldedit_creative_required');
  }
  function state(player) {
    if (!sessions.has(player)) sessions.set(player,{selection:[null,null],cells:[]});
    return sessions.get(player);
  }
  const summary=({selection,cells})=>({selection,clipboard:cells.length,limit:worldEditBlockLimit,editor:true});
  function currentAt(position) {
    if (!game.inBounds(position)) throw new RequestError(403,'outside_playable_area');
    return game.read(position);
  }
  function apply(player,entries,current) {
    const changes=entries.filter(entry=>!sameData(currentAt(entry),entry));
    const bytes=Buffer.byteLength(JSON.stringify(changes));
    if (bytes>maxClipboardBytes) throw new RequestError(409,'worldedit_data_limit');
    const result=game.write(player,changes);
    return {...summary(current),changed:changes.length,...result};
  }

  return {
    read(player) {
      authorize(player);
      return summary(state(player));
    },
    action(player,body) {
      authorize(player);
      const current=state(player);
      if (body.action==='select'||body.action==='clear') {
        if (!game.heldWoodenAxe(player)) throw new RequestError(403,'worldedit_axe_required');
        if (body.action==='clear') {
          current.selection=[null,null];
          return summary(current);
        }
        const {corner,x,y,z,hit}=body;
        if (![1,2].includes(corner)||![x,y,z].every(Number.isSafeInteger)) throw new RequestError(400,'worldedit_corner');
        const point={x,y,z};
        if (!game.inBounds(point)||!game.canSelect(player,point,hit,body.eye)) throw new RequestError(403,'outside_reach');
        current.selection[corner-1]=point;
        return summary(current);
      }

      const command=typeof body.command==='string'?body.command.trim():'';
      if (body.action!=='command'||command.length>128||!commandField.test(command)) throw new RequestError(400,'worldedit_command');
      const [verb,...args]=command.slice(2).toLowerCase().split(/\s+/);
      if (args.length!==({set:1,replace:2,copy:0,paste:0})[verb]) throw new RequestError(400,'worldedit_command');
      const anchor=location(game.position(player));
      if (verb==='paste') {
        if (!current.cells.length) throw new RequestError(409,'worldedit_clipboard_empty');
        const edits=current.cells.map(({offset,data})=>translatedData(data,Object.fromEntries(axes.map((axis,i)=>[axis,anchor[axis]+offset[i]]))));
        return apply(player,edits,current);
      }

      const bounds=cornerBox(current.selection);
      if (verb==='copy') {
        const cells=[];
        let size=0;
        for (const position of positions(bounds)) {
          const source=currentAt(position);
          const {cell,object,parts,fluid,voxels}=source;
          const data={cell,object,parts,fluid,voxels};
          size+=Buffer.byteLength(JSON.stringify(data));
          if (size>maxClipboardBytes) throw new RequestError(409,'worldedit_data_limit');
          cells.push({offset:axes.map(axis=>position[axis]-anchor[axis]),data});
        }
        current.cells=cells;
        return summary(current);
      }

      const target=block(args.at(-1),'write',game);
      const replaces=verb==='replace'?block(args[0],'match',game):undefined;
      const edits=[];
      for (const position of positions(bounds)) {
        const previous=currentAt(position);
        if (replaces) {
          const [id,meta]=blockState(previous);
          if (replaces.id===0 ? previous.cell!==null : id!==replaces.id ||
              replaces.meta!==undefined&&meta!==replaces.meta) continue;
        }
        if (previous.cell===target.key) continue;
        edits.push({...position,cell:target.key,object:target.key ? game.makeObject(target.key,position) : null});
      }
      return apply(player,edits,current);
    },
  };
}
