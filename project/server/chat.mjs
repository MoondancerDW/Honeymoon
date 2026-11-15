import {RequestError} from './errors.mjs';

const historyLimit = 60;
const rateWindow = 5000;

export function createChat(publish, now = Date.now) {
  const history = [];
  const sent = new Map();
  let id = 0;
  function add(message, origin) {
    const entry = {id:++id, ...message};
    if (message.channel !== 'local') {
      if (history.length === historyLimit) history.shift();
      history.push(entry);
    }
    publish(entry, origin);
    return entry;
  }
  return {
    history: () => history,
    playerStatus(profile, joined) {
      if (!joined) sent.delete(profile.id);
      add({kind:joined ? 'join' : 'leave', nickname:profile.nickname});
    },
    message(profile, body, origin) {
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
      recent.push(time);
      sent.set(profile.id, recent);
      return add({kind:'message', nickname:profile.nickname, text, channel}, origin);
    },
  };
}
