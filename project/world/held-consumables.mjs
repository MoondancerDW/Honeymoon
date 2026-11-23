const potionEffects=new Map([
  [1,['regeneration','регенерации','Regeneration',45]],
  [2,['speed','скорости','Swiftness',180]],
  [3,['fireResistance','огнестойкости','Fire Resistance',180]],
  [4,['poison','отравления','Poison',45]],
  [5,['healing','лечения','Healing',0]],
  [6,['nightVision','ночного зрения','Night Vision',180]],
  [8,['weakness','слабости','Weakness',90]],
  [9,['strength','силы','Strength',180]],
  [10,['slowness','замедления','Slowness',90]],
  [12,['harming','урона','Harming',0]],
  [14,['invisibility','невидимости','Invisibility',180]],
]);

const bottleKey='creative:374:0';
const amplifiedEffects=new Set([1,2,4,5,9,12]);
const foodHealth={260:4,282:6,297:5,319:3,320:8,322:4,349:2,350:5,357:2,360:2,363:3,364:8,365:2,366:6,
  367:4,375:2,393:1,394:5,396:6,400:8,27986:3,27987:3,27988:3,28011:3,28012:3,28013:6,28014:3};
const ponyFoodHealth=[5,4,3,4,5,2,4,5,3,6,4];
const bowlFood=new Set([15270,15272,15278,15283,15287,15288,15289,15294,15302,15310,15313,15318,15319,15320,15321,
  15462,15486,15511,15514,15563,15615,15637,15638,15687,15688,15689,15690,15691,15711,15712,15713,15714,15737,15763,15813]);
const bottledFood=new Set([15273,15279,15280,15281,15317,15561,15564,15611,15613,15661,15783,15786,15811,15814,15833,15836]);
// Food and plantable food classes from the captured item registry. Seed-only IDs are excluded.
const otherFood=new Set([5586,6229,6251,6252,6253,6254,6255,6256,9065,9066,9093,9094,9100,9101,9107,9108,9109,9148,9149,
  15265,15269,15271,15274,15275,15276,15277,15282,15284,15285,15286,15290,15291,15292,15293,15295,15296,15297,15298,
  15299,15300,15301,15303,15304,15305,15307,15308,15309,15311,15312,15314,15316,15456,15460,15461,15464,15465,
  15482,15487,15488,15489,15490,15491,15492,15493,15507,15512,15513,15515,15532,15536,15537,15539,15540,15541,15542,15543,
  15544,15557,15562,15565,15607,15614,15616,15632,15636,15639,15640,15657,15662,15663,15664,15665,15682,15686,15707,15715,
  15732,15736,15738,15739,15740,15757,15761,15762,15764,15782,15784,15785,15787,15788,15789,15807,15812,15815,15816,
  15832,15834,15835,15837,15838,15857,15897,15907,15917,15927,15937,15947,15956,15957,15958,15959,15960,15961,15962,15963,
  15964,15965,15966,15967,15968,15969,15970,15971,15972,15973,15974,15975,15976,15980,15981,15985,15986,15990,15994,15998,
  16002,16010,16014,16018,16022,16026,16030,16034,16038,16042,16043,16047,16048,16052,16053,16057]);

export function potionProfile(key) {
  const match=/^creative:373:(\d+)$/.exec(key??'');
  if (!match) return null;
  const damage=Number(match[1]);
  if (damage>32767) return null;
  const splash=Boolean(damage&16384);
  const definition=potionEffects.get(damage&15);
  if (!definition) return {kind:'potion',splash,remaining:splash?null:bottleKey,
    name:damage===0?'Бутылочка воды':'Зелье без эффекта',english:damage===0?'Water Bottle':'Potion without an effect'};
  const [effect,label,englishEffect,seconds]=definition;
  const amplifier=Number(Boolean(damage&32) && amplifiedEffects.has(damage&15));
  const factor=(damage&64 ? 8/3 : 1)/(2**amplifier);
  const duration=Math.round(seconds*1000*factor*(splash ? .75 : 1));
  const time=`${Math.floor(duration/60_000)}:${String(Math.floor(duration/1000)%60).padStart(2,'0')}`;
  const suffix=(amplifier?' II':'')+(duration?` (${time})`:'');
  return {kind:'potion',effect,splash,amplifier,duration,remaining:splash?null:bottleKey,
    name:`${splash?'Взрывное зелье':'Зелье'} ${label}${suffix}`,
    english:`${splash?'Splash Potion':'Potion'} of ${englishEffect}${suffix}`};
}

export function consumableName(id,damage) {
  if (id===4999 && damage===1) return {name:'Яблочный сидр',english:'Apple Cider'};
  if (id===373) {
    const potion=potionProfile(`creative:${id}:${damage}`);
    return potion && {name:potion.name,english:potion.english};
  }
}

export function consumableProfile(stack) {
  const key=stack?.key;
  const potion=potionProfile(key);
  if (potion) return potion;
  const match=/^creative:(\d+):(\d+)$/.exec(key??'');
  if (!match) return null;
  const id=Number(match[1]), damage=Number(match[2]);
  if (id===335) return {kind:'milk',heal:2,remaining:'creative:325:0'};
  if (id===4999 && ponyFoodHealth[damage]) return {kind:'food',heal:ponyFoodHealth[damage]};
  if (id===322) return {kind:'food',heal:4,effect:'regeneration',amplifier:1,duration:5000};
  if (id===375 || id===394) return {kind:'food',heal:foodHealth[id],effect:'poison',amplifier:0,duration:4000};
  if (id===282 || id===28013 || bowlFood.has(id)) return {kind:'food',heal:foodHealth[id]??4,remaining:'creative:281:0'};
  if (bottledFood.has(id)) return {kind:'food',heal:3,remaining:bottleKey};
  if (foodHealth[id] || otherFood.has(id) || id>=5556&&id<=5574 || id>=6275&&id<=6285) {
    return {kind:'food',heal:foodHealth[id]??3};
  }
  return null;
}

export const hasEffect=(state,key)=>Boolean(state?.effects?.[key]);

export function movementEffect(effects) {
  const speed=effects?.speed, slowness=effects?.slowness;
  return (1+(speed ? .2*(speed.amplifier+1) : 0))*Math.max(.1,1-(slowness ? .15*(slowness.amplifier+1) : 0));
}
