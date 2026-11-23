const block=(block,count,name,meta)=>({block,count,name,...(meta!==undefined&&{meta})});
const item=(id,count,name,damage=0)=>({key:`creative:${id}:${damage}`,count,name});
const recipe=(id,title,ingredients,output,count=1,returns=[])=>({id,title,ingredients,output,count,returns,station:'workbench'});
const planks=count=>block(5,count,'Доски');
const cobble=count=>block(4,count,'Булыжник');
const sticks=count=>item(280,count,'Палки');
const ingot=count=>item(265,count,'Железный слиток');
const string=count=>item(287,count,'Нить');
const wheat=count=>item(296,count,'Пшеница');

const materials=[
  ['wood','Деревянный',planks,[270,271,269,268,290]],
  ['stone','Каменный',cobble,[274,275,273,272,291]],
  ['iron','Железный',ingot,[257,258,256,267,292]],
  ['gold','Золотой',count=>item(266,count,'Золотой слиток'),[285,286,284,283,294]],
  ['diamond','Алмазный',count=>item(264,count,'Алмаз'),[278,279,277,276,293]],
];
const tools=[['pickaxe','Кирка',3,2],['axe','Топор',3,2],['shovel','Лопата',1,2],['sword','Меч',2,1],['hoe','Мотыга',2,2]];

export const workbenchRecipes=[
  ...materials.flatMap(([material,prefix,ingredient,ids])=>tools.flatMap(([tool,title,parts,handles],index)=>
    material==='wood'&&index<4 || material==='stone'&&index<4 ? [] :
      [recipe(`${material}-${tool}`,`${title} · ${prefix.toLowerCase()} материал`,[ingredient(parts),sticks(handles)],`creative:${ids[index]}:0`)])),
  recipe('chest','Сундук',[planks(8)],'legacy:54:0'),
  recipe('furnace','Печь',[cobble(8)],'legacy:61:0'),
  recipe('bowl','4 миски',[planks(3)],'creative:281:0',4),
  recipe('ladder','3 лестницы',[sticks(7)],'legacy:65:2',3),
  recipe('fence','2 ограды',[sticks(6)],'legacy:85:0',2),
  recipe('gate','Калитка',[planks(2),sticks(4)],'legacy:107:0'),
  recipe('wood-door','Деревянная дверь',[planks(6)],'legacy:64:0'),
  recipe('iron-door','Железная дверь',[ingot(6)],'legacy:71:0'),
  recipe('trapdoor','2 люка',[planks(6)],'legacy:96:0',2),
  recipe('wood-stairs','4 деревянные ступени',[planks(6)],'legacy:53:0',4),
  recipe('stone-stairs','4 каменные ступени',[cobble(6)],'legacy:67:0',4),
  recipe('wood-slabs','6 деревянных плит',[planks(3)],'legacy:126:0',6),
  recipe('stone-slabs','6 каменных плит',[block(1,3,'Камень')],'legacy:44:0',6),
  recipe('glass-panes','16 стеклянных панелей',[block(20,6,'Стекло')],'legacy:102:0',16),
  recipe('bricks','Кирпичный блок',[item(336,4,'Кирпичи')],'legacy:45:0'),
  recipe('bookcase','Книжный шкаф',[planks(6),item(340,3,'Книги')],'legacy:47:0'),
  recipe('paper','3 листа бумаги',[item(338,3,'Тростник')],'creative:339:0',3),
  recipe('book','Книга',[item(339,3,'Бумага'),item(334,1,'Кожа')],'creative:340:0'),
  recipe('sign','3 таблички',[planks(6),sticks(1)],'creative:323:0',3),
  recipe('frame','Рамка',[sticks(8),item(334,1,'Кожа')],'creative:389:0'),
  recipe('painting','Картина',[sticks(8),block(35,1,'Шерсть')],'creative:321:0'),
  recipe('bed','Кровать',[planks(3),block(35,3,'Шерсть')],'legacy:26:0'),
  recipe('flower-pot','Цветочный горшок',[item(336,3,'Кирпичи')],'creative:390:0'),
  recipe('glass-jar','Стеклянная баночка',[block(20,7,'Стекло')],'legacy:2168:0'),
  recipe('cake','Торт',[item(335,3,'Вёдра молока'),item(353,2,'Сахар'),item(344,1,'Яйцо'),wheat(3)],'creative:354:0',1,
    [{key:'creative:325:0',count:3}]),
  recipe('bread','Хлеб',[wheat(3)],'creative:297:0'),
  recipe('cookies','8 печений',[wheat(2),item(351,1,'Какао-бобы',3)],'creative:357:0',8),
  recipe('pumpkin-pie','Тыквенный пирог',[block(86,1,'Тыква'),item(353,1,'Сахар'),item(344,1,'Яйцо')],'creative:400:0'),
  recipe('bow','Лук',[sticks(3),string(3)],'creative:261:0'),
  recipe('arrows','4 стрелы',[item(318,1,'Кремень'),sticks(1),item(288,1,'Перо')],'creative:262:0',4),
  recipe('shears','Ножницы',[ingot(2)],'creative:359:0'),
  recipe('bucket','Ведро',[ingot(3)],'creative:325:0'),
  recipe('flint-and-steel','Огниво',[ingot(1),item(318,1,'Кремень')],'creative:259:0'),
  recipe('boat','Лодка',[planks(5)],'creative:333:0'),
  recipe('minecart','Вагонетка',[ingot(5)],'creative:328:0'),
  recipe('rails','16 рельсов',[ingot(6),sticks(1)],'legacy:66:0',16),
  recipe('compass','Компас',[ingot(4),item(331,1,'Красная пыль')],'creative:345:0'),
  recipe('glass-bottles','3 колбы',[block(20,3,'Стекло')],'creative:374:0',3),
  recipe('dispenser','Раздатчик',[cobble(7),item(261,1,'Лук'),item(331,1,'Красная пыль')],'legacy:23:0'),
  recipe('piston','Поршень',[planks(3),cobble(4),ingot(1),item(331,1,'Красная пыль')],'legacy:33:0'),
  recipe('sticky-piston','Липкий поршень',[block(33,1,'Поршень'),item(341,1,'Слизь')],'legacy:29:0'),
  ...[['leather',count=>item(334,count,'Кожа'),298],['iron',ingot,306],['diamond',count=>item(264,count,'Алмаз'),310],
    ['gold',count=>item(266,count,'Золотой слиток'),314]].flatMap(([material,ingredient,first])=>
    [['helmet','Шлем',5],['chestplate','Нагрудник',8],['leggings','Поножи',7],['boots','Ботинки',4]].map(([id,title,count],offset)=>
      recipe(`${material}-${id}`,`${title} · ${ingredient(count).name.toLowerCase()}`,[ingredient(count)],`creative:${first+offset}:0`))),
];

export const craftingTableRecipe={id:'workbench',title:'Верстак',ingredients:[planks(4)],output:'legacy:58:0',count:1};
