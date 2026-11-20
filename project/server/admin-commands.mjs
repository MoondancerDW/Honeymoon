import {limitChatText} from '../world/chat-text.mjs';
import {tickFromTime} from '../world/world-time.mjs';
import {RequestError} from './errors.mjs';

const commandPattern = /^\/(tp|vanish|creative|time|weather)(?=\s|$)/iu;
const forbiddenText = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const weatherOrder = ['clear','rain','cloudy','snow'];
const weatherNames = {clear:'clear',rain:'rain',cloud:'cloudy',snow:'snow'};

function invalidCommand() {
  throw new RequestError(400,'invalid_admin_command');
}

function parseNames(text) {
  const tokens = [];
  const tokenPattern = /(?:"((?:[^"\\]|\\["\\])*)"|([^\s"]+))(?:\s+|$)/gy;
  let offset = 0;
  while (offset < text.length) {
    const match = tokenPattern.exec(text);
    if (!match) invalidCommand();
    const quoted = match[1] !== undefined;
    const value = quoted ? match[1].replace(/\\(["\\])/gu,'$1') : match[2];
    if (!value.trim()) invalidCommand();
    tokens.push({text:value,quoted});
    offset = tokenPattern.lastIndex;
  }
  return tokens;
}

function groupName(tokens) {
  if (tokens.length > 1 && tokens.some(token => token.quoted)) return '';
  return tokens.map(token => token.text).join(' ');
}

const normalizedName = name => name.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase();

function nameLookup(profiles) {
  const names = new Map();
  for (const {uid,nickname,profileName} of profiles) {
    for (const name of [nickname,profileName]) {
      if (typeof name !== 'string' || !name.trim()) continue;
      const key = normalizedName(name);
      if (!names.has(key)) names.set(key,new Set());
      names.get(key).add(uid);
    }
  }
  return name => [...(names.get(normalizedName(name)) ?? [])];
}

function uniqueTarget(matches) {
  if (!matches.length) throw new RequestError(404,'player_missing');
  if (matches.length > 1) throw new RequestError(409,'player_ambiguous');
  return matches[0];
}

function teleportTargets(tokens, actor, lookup) {
  const matches = [];
  const one = lookup(groupName(tokens));
  if (one.length) matches.push([[actor],one]);
  // For unquoted names with spaces, consider each possible boundary. Quotes
  // constrain the grouping, and ambiguous names never move a guessed player.
  for (let index=1; index<tokens.length; index++) {
    const from = lookup(groupName(tokens.slice(0,index)));
    const to = lookup(groupName(tokens.slice(index)));
    if (from.length && to.length) matches.push([from,to]);
  }
  if (!matches.length) throw new RequestError(404,'player_missing');
  if (matches.length > 1) throw new RequestError(409,'player_ambiguous');
  return matches[0].map(uniqueTarget);
}

function timeSettings(argument) {
  if (argument === 'stop' || argument === 'go') return {frozen:argument === 'stop'};
  const number = /^\d+$/u.test(argument) ? Number(argument) : NaN;
  const hour = number >= 0 && number <= 23 ? number : 12;
  return {tick:tickFromTime(String(hour).padStart(2,'0') + ':00')};
}

export function createAdminCommands({
  isAdmin, profiles, teleport, toggleSpectator, toggleCreative, setTime, getWeather, setWeather,
}) {
  return {
    async execute(actor, message) {
      if (typeof message !== 'string') return null;
      const text = message.trim();
      const match = commandPattern.exec(text);
      if (!match) return null;
      const command = match[1].toLowerCase();
      if (!isAdmin(actor)) return {command};
      if (limitChatText(text) !== text || forbiddenText.test(text)) invalidCommand();
      const argument = text.slice(match[0].length).trim();

      if (command === 'tp') {
        if (!argument) invalidCommand();
        const [from,to] = teleportTargets(parseNames(argument),actor,nameLookup(profiles()));
        const result = await teleport(actor,from,to);
        return {command,feedback:'Телепортация выполнена',result};
      }
      if (command === 'vanish' || command === 'creative') {
        const name = groupName(parseNames(argument));
        if (argument && !name) invalidCommand();
        const target = argument ? uniqueTarget(nameLookup(profiles())(name)) : actor;
        if (command === 'vanish') {
          const result = await toggleSpectator(actor,target);
          return {command,feedback:'Режим наблюдателя переключён',result};
        }
        const result = await toggleCreative(actor,target);
        return {command,feedback:'Игровой режим переключён',result};
      }
      if (command === 'time') {
        const settings = timeSettings(argument.toLowerCase());
        const result = await setTime(settings);
        const feedback = settings.frozen === undefined ? 'Время установлено' :
          settings.frozen ? 'Ход времени остановлен' : 'Ход времени возобновлён';
        return {command,feedback,result};
      }
      const requested = argument.toLowerCase();
      if (requested && !Object.hasOwn(weatherNames,requested)) invalidCommand();
      const mode = requested ? weatherNames[requested] :
        weatherOrder[(weatherOrder.indexOf(getWeather()) + 1) % weatherOrder.length];
      const result = await setWeather({mode,dynamic:false});
      return {command,feedback:'Погода изменена',result};
    },
  };
}
