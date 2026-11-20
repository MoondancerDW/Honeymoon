import {appendFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {CHAT_RETENTION_MS, limitChatText} from '../world/chat-text.mjs';
import {RequestError} from './errors.mjs';

const rateWindow = 5000;
const dayMs = 24 * 60 * 60 * 1000;
const moscowClock = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Moscow', hourCycle:'h23',
  year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit',
  fractionalSecondDigits:3, timeZoneName:'longOffset'});

function logField(value) {
  return JSON.stringify(value ?? '').replace(/[\u2028\u2029]/gu, char => '\\u' + char.charCodeAt(0).toString(16));
}

function confirmedPosition(origin) {
  if (!origin || ![origin.x,origin.y,origin.z].every(Number.isFinite)) return null;
  return {x:origin.x,y:origin.y,z:origin.z};
}

function moscowDate(time) {
  const parts = Object.fromEntries(moscowClock.formatToParts(time).map(({type,value})=>[type,value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const offset = parts.timeZoneName.slice(3) || '+00:00';
  return {
    day,
    timestamp:`${day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`,
    midnight:Date.parse(`${day}T00:00:00${offset}`) + dayMs,
  };
}

function createLog(directory, onError) {
  let pending = Promise.resolve(), initialized = false;
  function append(day, line) {
    pending = pending.then(async()=>{
      if (!initialized) {
        await mkdir(directory,{recursive:true,mode:0o700});
        initialized = true;
      }
      await appendFile(join(directory,day+'.log'),line,{encoding:'utf8',flush:true,mode:0o600});
    }).catch(onError);
  }
  return {
    openDay: day => append(day,''),
    record(entry, {logDay,timestamp}, origin) {
      const position = confirmedPosition(origin);
      const line = [timestamp,entry.channel ?? 'system',entry.kind,logField(entry.nickname),
        logField(entry.kind === 'rename' ? entry.newNickname : entry.text),JSON.stringify(position)].join('\t')+'\n';
      append(logDay,line);
    },
    flush:()=>pending,
  };
}

export function createChat({store, publish, recipients, now = Date.now, logDirectory,
                            isAdmin = () => false, onLogError = error=>console.error(error)}) {
  const sent = new Map();
  const log = logDirectory ? createLog(logDirectory,onLogError) : undefined;
  let logDay, midnightTimer;
  const cutoff = at => at - CHAT_RETENTION_MS;
  store.pruneChat(cutoff(now()));
  const pruneTimer = setInterval(() => {
    try { store.pruneChat(cutoff(now())); }
    catch (error) { console.error(error); }
  },60_000);
  pruneTimer.unref();
  function schedule(delay) {
    clearTimeout(midnightTimer);
    midnightTimer = setTimeout(() => {
      midnightTimer = undefined;
      try {
        stamp();
      } catch (error) {
        onLogError(error);
        schedule(1000);
      }
    },delay);
    midnightTimer.unref();
  }
  function stamp(at = now()) {
    if (!log) return {at};
    const date = moscowDate(at);
    // Recheck periodically so wall-clock adjustments do not move midnight by hours.
    if (!midnightTimer || date.day !== logDay) schedule(Math.min(60_000,Math.max(1,date.midnight - at)));
    if (date.day !== logDay) {
      logDay = date.day;
      log.openDay(logDay);
    }
    return {at,timestamp:date.timestamp,logDay};
  }
  stamp();
  function publishRecorded(entry, audience = null, date = stamp(), origin) {
    log?.record(entry,date,origin);
    publish(entry, audience);
    return entry;
  }
  function add(message, audience = null, date = stamp(), origin) {
    return publishRecorded(store.recordChat({...message,at:date.at},audience),audience,date,origin);
  }
  function snapshot(player, page) {
    const serverAt = now();
    return {entries:store.chatHistory(player,cutoff(serverAt),page),serverAt};
  }
  const author = (profile, player) => ({nickname:profile.nickname,...(isAdmin(player) && {admin:true})});
  return {
    history: player => snapshot(player).entries,
    latestId: store.latestChatId,
    snapshot,
    stamp,
    publishRecorded,
    close() {
      clearTimeout(midnightTimer);
      clearInterval(pruneTimer);
      return log?.flush();
    },
    playerDeath(profile,cause,player) {
      return add({kind:'death',...author(profile,player),channel:'global',...(cause==='lava'&&{cause,text:'Сгорел'})});
    },
    playerStatus(profile, joined, player) {
      if (!joined) sent.delete(profile.id);
      add({kind:joined ? 'join' : 'leave',...author(profile,player)});
    },
    message(profile, body, player, origin) {
      const position = confirmedPosition(origin);
      if (!profile || !position) throw new RequestError(409, 'not_online');
      const channel = body.channel ?? 'global';
      if (channel !== 'global' && channel !== 'local') throw new RequestError(400, 'invalid_chat_channel');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || limitChatText(text) !== text || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(text)) {
        throw new RequestError(400, 'invalid_chat');
      }
      const time = now();
      const recent = (sent.get(profile.id) || []).filter(previous => time - previous < rateWindow);
      if (recent.length >= 5) throw new RequestError(429, 'chat_rate_limit');
      const audience = channel === 'local' ? [...new Set([player, ...recipients(position)])] : null;
      const entry = add({kind:'message',...author(profile,player),text,channel},audience,stamp(time),position);
      recent.push(time);
      sent.set(profile.id, recent);
      return entry;
    },
  };
}
