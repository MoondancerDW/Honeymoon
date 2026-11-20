import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatClock} from '../world/world-time.mjs';
import {createAdminCommands} from './admin-commands.mjs';

function fixture(extraProfiles = []) {
  const calls = [];
  let weather = 'clear';
  const profiles = [
    {uid:'one',nickname:'Пони',profileName:'Первый игрок'},
    {uid:'two',nickname:'Кот',profileName:'Тест "два"'},
    {uid:'three',nickname:'Йод',profileName:'Йод'},
    ...extraProfiles,
  ];
  const record = action => (...args) => {
    calls.push([action,...args]);
    return {action};
  };
  const {execute} = createAdminCommands({
    isAdmin: actor => actor === 'admin',
    profiles: () => profiles,
    teleport: record('teleport'),
    toggleSpectator: record('spectator'),
    toggleCreative: record('creative'),
    setTime: record('time'),
    getWeather: () => weather,
    setWeather: settings => {
      weather = settings.mode;
      return record('weather')(settings);
    },
  });
  return {calls,execute};
}

test('ordinary chat stays out of the dispatcher and recognized commands from players have no effect',async()=>{
  const {calls,execute}=fixture();
  assert.equal(await execute('admin','Привет, Пони'),null);
  assert.equal(await execute('admin','/tptext оставь в чате'),null);
  assert.equal(await execute('one','/other без изменений'),null);
  for (const command of ['tp','vanish','creative','time','weather']) {
    assert.deepEqual(await execute('one','  /'+command.toUpperCase()+' "с ошибкой'),{command});
  }
  assert.deepEqual(calls,[]);
});

test('teleport resolves exact nicknames and profile names with spaces and quotes',async()=>{
  const {calls,execute}=fixture();
  const reply=await execute('admin',' /TP пЕРВЫЙ   Игрок ');
  assert.deepEqual(reply,{command:'tp',feedback:'Телепортация выполнена',result:{action:'teleport'}});
  await execute('admin','/tp "ПЕРВЫЙ ИГРОК" "Тест \\"два\\""');
  await execute('admin','/tp Пони Кот');
  await execute('admin','/tp И\u0306ОД');
  assert.deepEqual(calls,[
    ['teleport','admin','admin','one'],
    ['teleport','admin','one','two'],
    ['teleport','admin','one','two'],
    ['teleport','admin','admin','three'],
  ]);
  await assert.rejects(execute('admin','/tp пони кота'),{status:404,code:'player_missing'});
  await assert.rejects(execute('admin','/tp "Первый игрок'),{status:400,code:'invalid_admin_command'});
  await assert.rejects(execute('admin','/tp "Пони"Кот'),{status:400,code:'invalid_admin_command'});
  await assert.rejects(execute('admin','/tp'),{status:400,code:'invalid_admin_command'});
  assert.equal(calls.length,4);
});

test('duplicate aliases and equally valid name groupings never guess a player',async()=>{
  const {calls,execute}=fixture([
    {uid:'four',nickname:'Пони Кот',profileName:'Четвёртый'},
    {uid:'five',nickname:'Другой',profileName:'Кот'},
  ]);
  await assert.rejects(execute('admin','/tp Пони Кот'),{status:409,code:'player_ambiguous'});
  await assert.rejects(execute('admin','/tp Кот'),{status:409,code:'player_ambiguous'});
  await execute('admin','/tp "Пони Кот"');
  await execute('admin','/tp Пони Другой');
  assert.deepEqual(calls,[['teleport','admin','admin','four'],['teleport','admin','one','five']]);
});

test('spectator and creative toggles default to the actor and accept one whole profile name',async()=>{
  const {calls,execute}=fixture();
  await execute('admin','/vanish');
  await execute('admin','/vanish Первый игрок');
  await execute('admin','/creative');
  await execute('admin','/creative "Тест \\"два\\""');
  assert.deepEqual(calls,[
    ['spectator','admin','admin'],
    ['spectator','admin','one'],
    ['creative','admin','admin'],
    ['creative','admin','two'],
  ]);
  await assert.rejects(execute('admin','/vanish "Пони" Кот'),{status:400,code:'invalid_admin_command'});
  await assert.rejects(execute('admin','/creative неизвестный'),{status:404,code:'player_missing'});
  assert.equal(calls.length,4);
});

test('time uses game clock hours and only stop/go alter the frozen flag',async()=>{
  const {calls,execute}=fixture();
  for (const [input,clock] of [['0','00:00'],['23','23:00'],['24','12:00'],['-1','12:00'],['','12:00'],['abc','12:00']]) {
    await execute('admin','/time '+input);
    const [,settings]=calls.at(-1);
    assert.equal(formatClock(settings.tick),clock);
    assert.equal(settings.frozen,undefined);
  }
  await execute('admin','/time STOP');
  await execute('admin','/time go');
  assert.deepEqual(calls.slice(-2),[['time',{frozen:true}],['time',{frozen:false}]]);
});

test('weather cycles in command order and explicit settings remain in effect',async()=>{
  const {calls,execute}=fixture();
  for (let index=0; index<4; index++) await execute('admin','/weather');
  for (const name of ['clear','rain','CLOUD','snow']) await execute('admin','/weather '+name);
  assert.deepEqual(calls,['rain','cloudy','snow','clear','clear','rain','cloudy','snow']
    .map(mode=>['weather',{mode,dynamic:false}]));
  await assert.rejects(execute('admin','/weather storm'),{status:400,code:'invalid_admin_command'});
  assert.equal(calls.length,8);
});
