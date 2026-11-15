import {RequestError} from './errors.mjs';

const rateWindow = 5000;

export function createChat({store, publish, recipients, now = Date.now}) {
  const sent = new Map();
  function add(message, audience = null) {
    const entry = store.recordChat(message, audience);
    publish(entry, audience);
    return entry;
  }
  return {
    history: player => store.chatHistory(player),
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
      const entry = add({kind:'message', nickname:profile.nickname, text, channel}, audience);
      recent.push(time);
      sent.set(profile.id, recent);
      return entry;
    },
  };
}
