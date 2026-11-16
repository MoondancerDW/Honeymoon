import {blockKey,blockState} from './block-interactions.mjs';

const toolGroups={
  pickaxe:[270,274,257,285,278], axe:[271,275,258,286,279],
  shovel:[269,273,256,284,277], sword:[268,272,267,283,276], shears:[359],
};
const pickRanks=new Map([[270,1],[285,1],[274,2],[257,3],[278,4]]);
const oreRanks={14:3,15:2,16:1,21:2,56:3,73:3,74:3,129:3};
const rock=new Set([1,4,7,14,15,16,21,22,23,24,27,28,41,42,43,44,45,48,49,52,56,57,61,62,66,67,70,71,73,74,79,84,87,89,93,94,98,101,108,109,112,113,114,116,117,118,120,121,128,129,130,133,138,139,145,147,148,152,153,154,155,156]);
const soft=new Set([2,3,6,12,13,18,30,31,32,37,38,39,40,50,51,55,59,60,78,81,82,83,104,105,106,111,115,132,141,142,175,243]);
const indestructible=new Set([7,90,119,120,137]);
export function classifyTool(stack,entry) {
  const id=Number(stack?.key?.split(':')[1]);
  for (const [tool,ids] of Object.entries(toolGroups)) if (ids.includes(id)) return {tool,rank:pickRanks.get(id)??1,id};
  const match=String(entry?.english??entry?.name??'').toLowerCase().match(/hand ?saw|hacksaw|pickaxe|shears|shovel|sword|axe|chisel/);
  return match ? {tool:/(saw|chisel)/.test(match[0])?'saw':match[0],rank:3,id} : {};
}
export function harvestRule(cell,stack,entry) {
  const [id,meta]=blockState(cell);
  const {tool,rank}=classifyTool(stack,entry);
  if (!id||indestructible.has(id)) return null;
  if (id===49 && (tool!=='pickaxe'||rank<4)) return null;
  if ((rock.has(id)||id>=750&&id<=768||id>=2160&&id<=2180&&!soft.has(id)) &&
      (tool!=='pickaxe'||rank<(oreRanks[id]??1))) return null;
  if (id===30 && !['sword','shears'].includes(tool)) return null;
  if ([8,9,10,11,20,51,79,102].includes(id)) return {drops:[]};
  if (id===78 && tool!=='shovel') return {drops:[]};
  const native={1:[4,0],2:[3,0],16:[263,0],21:[351,4],31:[295,0],
    52:[0,0],56:[264,0],59:[296,0],60:[3,0],62:[61,0],63:[323,0],68:[323,0],
    73:[331,0],74:[331,0],78:[332,0],89:[348,0],93:[356,0],94:[356,0],
    124:[123,0],129:[388,0],141:[391,0],142:[392,0],153:[406,0]};
  const mapped=native[id]??[id,[17,18,35,43,44,95,97,98,125,126,159,171,243].includes(id) ? meta & (id===17||id===18?3:15) : id<=158?0:meta];
  const [dropId,damage]=mapped;
  if (!dropId) return {drops:[]};
  const item=dropId>=256&&dropId<512 || [263,264,295,296,323,331,332,348,351,356,388,391,392,406].includes(dropId);
  const key=item?`creative:${dropId}:${damage}`:blockKey(dropId,damage);
  return {drops:[{key,count:1,...(!item&&{cell:key})}]};
}
const recipe=(id,title,ingredients,output,count=1)=>({id,title,ingredients,output,count});
export const basicRecipes=[
  recipe('planks','4 доски',[{name:'Бревно',count:1,block:17}],'legacy:5:0',4),
  recipe('sticks','4 палки',[{name:'Доски',count:2,block:5}],'creative:280:0',4),
  ...[['pickaxe','Кирка',270,274,3],['axe','Топор',271,275,3],['shovel','Лопата',269,273,1],
    ['sword','Меч',268,272,2]].flatMap(([id,title,wood,stone,count])=>[
      recipe('wood-'+id,title+' из дерева',[{name:'Доски',count,block:5},{name:'Палка',count:id==='sword'?1:2,key:'creative:280:0'}],`creative:${wood}:0`),
      recipe('stone-'+id,title+' из камня',[{name:'Булыжник',count,block:4},{name:'Палка',count:id==='sword'?1:2,key:'creative:280:0'}],`creative:${stone}:0`),
    ]),
];
