import {appendFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {RequestError} from './errors.mjs';

const rateWindow = 5000;

function logField(value) {
  return JSON.stringify(value ?? '').replace(/[\u2028\u2029]/gu, char => '\\u' + char.charCodeAt(0).toString(16));
}

function createLog(directory, timeZone, onError) {
  const format = new Intl.DateTimeFormat('en-GB', {timeZone, hourCycle:'h23',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit',
    fractionalSecondDigits:3, timeZoneName:'longOffset'});
  let pending = Promise.resolve(), initialized = false;
  return {
    record(entry, time) {
      const parts = Object.fromEntries(format.formatToParts(time).map(({type,value})=>[type,value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const offset = parts.timeZoneName.slice(3) || '+00:00';
      const timestamp = `${day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
      const line = [timestamp,entry.channel ?? 'system',entry.kind,logField(entry.nickname),
        logField(entry.kind === 'rename' ? entry.newNickname : entry.text)].join('\t')+'\n';
      pending = pending.then(async()=>{
        if (!initialized) {
          await mkdir(directory,{recursive:true,mode:0o700});
          initialized = true;
        }
        await appendFile(join(directory,day+'.log'),line,{encoding:'utf8',flush:true,mode:0o600});
      }).catch(onError);
    },
    flush:()=>pending,
  };
}

export function createChat({store, publish, recipients, now = Date.now, logDirectory,
                            logTimeZone, onLogError = error=>console.error(error)}) {
  const sent = new Map();
  const log = logDirectory ? createLog(logDirectory,logTimeZone,onLogError) : undefined;
  function publishRecorded(entry, audience = null, time = now()) {
    log?.record(entry,time);
    publish(entry, audience);
    return entry;
  }
  function add(message, audience = null, time) {
    return publishRecorded(store.recordChat(message,audience),audience,time);
  }
  return {
    history: player => store.chatHistory(player),
    publishRecorded,
    close:()=>log?.flush(),
    playerDeath(profile) { return add({kind:'death',nickname:profile.nickname,channel:'global'}); },
    playerStatus(profile, joined) {
      if (!joined) sent.delete(profile.id);
      add({kind:joined ? 'join' : 'leave', nickname:profile.nickname});
    },
    message(profile, body, player, origin) {
      if (!profile) throw new RequestError(409, 'not_online');
      const channel = body.channel ?? 'global';
      if (channel !== 'global' && channel !== 'local') throw new RequestError(400, 'invalid_chat_channel');
      if (channel === 'local' && !origin) throw new RequestError(409, 'not_online');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || [...text].length > 240 || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(text)) {
        throw new RequestError(400, 'invalid_chat');
      }
      const time = now();
      const recent = (sent.get(profile.id) || []).filter(previous => time - previous < rateWindow);
      if (recent.length >= 5) throw new RequestError(429, 'chat_rate_limit');
      const audience = channel === 'local' ? [...new Set([player, ...recipients(origin)])] : null;
      const entry = add({kind:'message', nickname:profile.nickname, text, channel}, audience,time);
      recent.push(time);
      sent.set(profile.id, recent);
      return entry;
    },
  };
}
