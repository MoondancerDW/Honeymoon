import { RequestError } from './errors.mjs';
import { publicProfile } from './presence-profile.mjs';

const poses = new Set(['idle', 'walk', 'air', 'fly', 'swim']);
const reconnectGrace = 2000;
const maxEntries = 128;

export function readPose(body) {
  if (!body || !Number.isFinite(body.yaw) || !Number.isFinite(body.pitch) ||
      Math.abs(body.yaw) > 1e6 || Math.abs(body.pitch) > Math.PI / 2 ||
      body.motion !== undefined && !poses.has(body.motion) ||
      body.seq !== undefined && (!Number.isSafeInteger(body.seq) || body.seq < 0)) {
    throw new RequestError(400, 'invalid_pose');
  }
  const yaw = (body.yaw + Math.PI) % (2 * Math.PI);
  return { yaw: (yaw < 0 ? yaw + 2 * Math.PI : yaw) - Math.PI,
    pitch: body.pitch, motion: body.motion, seq: body.seq };
}

function roundPosition({x, y, z}) {
  return {x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, z: Math.round(z * 1000) / 1000};
}

export function createPresence({ store, send, now = Date.now }) {
  const players = new Map();
  const listeners = new Set();
  const changed = new Set();
  let rosterChanged = false;

  function entryFor(player) {
    if (!players.has(player)) {
      if (players.size >= maxEntries) throw new RequestError(503, 'presence_limit');
      players.set(player, {
        profile: publicProfile(player, store.getProfile(player)), connections: 0, until: now() + reconnectGrace,
      });
    }
    return players.get(player);
  }

  const motionOf = ({profile, position, yaw, pitch, motion}) => ({id:profile.id, position, yaw, pitch, motion});
  const snapshot = except => [...players].flatMap(([player, entry]) => player !== except && entry.visible
    ? [{ ...entry.profile, ...motionOf(entry) }] : []);

  function update(player, position, pose) {
    const entry = players.get(player);
    if (!entry?.position) return;
    const next = roundPosition(position);
    const previous = entry.position;
    let dirty = previous.x !== next.x || previous.y !== next.y || previous.z !== next.z;
    if (dirty) entry.position = next;
    if (pose && (pose.seq === undefined || entry.seq === undefined || pose.seq >= entry.seq)) {
      const motion = pose.motion ?? entry.motion;
      dirty ||= entry.yaw !== pose.yaw || entry.pitch !== pose.pitch || entry.motion !== motion;
      Object.assign(entry, {yaw:pose.yaw, pitch:pose.pitch, motion});
      if (pose.seq !== undefined) entry.seq = pose.seq;
    }
    if (dirty && entry.visible) changed.add(player);
  }

  return {
    prepare: entryFor,
    connect(stream, entry) {
      listeners.add(stream);
      entry.connections++;
      if (entry.position && !entry.visible) {
        entry.visible = true;
        rosterChanged = true;
      }
      send(stream.response, 'presence', {players:snapshot(stream.player)});
    },
    disconnect(stream) {
      if (!listeners.delete(stream)) return;
      const entry = players.get(stream.player);
      if (entry && --entry.connections === 0) entry.until = now() + reconnectGrace;
    },
    profile(player, profile) {
      const entry = players.get(player);
      if (entry) {
        entry.profile = profile;
        if (entry.visible) rosterChanged = true;
      }
    },
    join(player, position, pose) {
      const entry = entryFor(player);
      if (!entry.connections && !entry.visible) entry.until = now() + reconnectGrace;
      if (!entry.position) {
        entry.position = roundPosition(position);
        entry.yaw = 0;
        entry.pitch = 0;
        entry.motion = 'idle';
      }
      if (entry.connections && !entry.visible) {
        entry.visible = true;
        rosterChanged = true;
      }
      update(player, position, pose);
    },
    leave(player) {
      const entry = players.get(player);
      if (!entry) return;
      if (entry.visible) rosterChanged = true;
      entry.visible = false;
      entry.position = undefined;
      entry.seq = undefined;
    },
    update,
    flush() {
      const time = now();
      for (const [player, entry] of players) {
        if (!entry.connections && entry.until <= time) {
          players.delete(player);
          rosterChanged ||= entry.visible;
        }
      }
      if (rosterChanged) {
        for (const {player, response} of listeners) send(response, 'presence', {players:snapshot(player)});
      } else if (changed.size) {
        const motions = [...changed].flatMap(player => {
          const entry = players.get(player);
          return entry?.visible ? [{player, state:motionOf(entry)}] : [];
        });
        for (const {player, response} of listeners) {
          const others = motions.filter(item => item.player !== player).map(item => item.state);
          if (others.length) send(response, 'presence-motion', {players:others});
        }
      }
      rosterChanged = false;
      changed.clear();
    },
  };
}
