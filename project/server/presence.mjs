import { RequestError } from './errors.mjs';
import { publicProfile } from './presence-profile.mjs';
import { isPlayerStance } from '../world/player-body.mjs';
import { isMicroPart, publicMicroPart } from '../world/microblocks.mjs';

const poses = new Set(['idle', 'walk', 'run', 'air', 'fly', 'swim', 'sit']);
const reconnectGrace = 2000;
const fallbackLease = 5000;
const afkReconnectGrace = 10_000;
const activityLease = 45_000;
const maxEntries = 128;
const heldKey = /^[a-z0-9][a-z0-9:_-]{0,95}$/;

export function readEye(eye) {
  if (eye === undefined) return undefined;
  if (!Array.isArray(eye) || eye.length !== 3 || eye.some(value => !Number.isFinite(value)) ||
      Math.hypot(eye[0],eye[2]) > .75 || eye[1] < .05 || eye[1] > 2.1) {
    throw new RequestError(400, 'invalid_pose');
  }
  return eye.slice();
}

export function readPose(body) {
  if (!body || !Number.isFinite(body.yaw) || !Number.isFinite(body.pitch) ||
      Math.abs(body.yaw) > 1e6 || Math.abs(body.pitch) > Math.PI / 2 ||
      body.motion !== undefined && !poses.has(body.motion) ||
      body.stance !== undefined && !isPlayerStance(body.stance) ||
      body.boost !== undefined && typeof body.boost !== 'boolean' ||
      body.seq !== undefined && (!Number.isSafeInteger(body.seq) || body.seq < 0) ||
      body.typing !== undefined && typeof body.typing !== 'boolean' ||
      body.emote != null && (!['wave','dance'].includes(body.emote.id) ||
        !Number.isSafeInteger(body.emote.started) || body.emote.started < 0) ||
      body.swing !== undefined && (!Number.isInteger(body.swing) || body.swing < 0 || body.swing > 2147483647) ||
      body.held != null && (!['block', 'item'].includes(body.held.kind) || typeof body.held.key !== 'string' || !heldKey.test(body.held.key) ||
        body.held.part !== undefined && (!isMicroPart(body.held.part) || body.held.kind !== 'block' ||
          body.held.key !== `cover-material:${body.held.part.material}`))) {
    throw new RequestError(400, 'invalid_pose');
  }
  const yaw = (body.yaw + Math.PI) % (2 * Math.PI);
  return { yaw: (yaw < 0 ? yaw + 2 * Math.PI : yaw) - Math.PI,
    pitch: body.pitch, motion: body.motion, seq: body.seq,
    ...(body.stance !== undefined && {stance:body.stance}),
    ...(body.boost !== undefined && {boost:body.boost}),
    ...(body.eye !== undefined && {eye:readEye(body.eye)}),
    ...(body.typing !== undefined && {typing:body.typing}),
    ...(body.swing !== undefined && {swing:body.swing}),
    ...(body.emote !== undefined && {emote:body.emote === null ? null : {id:body.emote.id,started:body.emote.started}}),
    ...(body.held !== undefined && {held:body.held === null ? null : {kind:body.held.kind, key:body.held.key,
      ...(body.held.part && {part:publicMicroPart(body.held.part)})}}) };
}

function roundPosition({x, y, z}) {
  return {x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, z: Math.round(z * 1000) / 1000};
}

export function createPresence({store, profileFor = player => publicProfile(player,store.getProfile(player)), send, onVisibility,
                               canSeeSpectators=()=>false, now = Date.now}) {
  const players = new Map();
  const listeners = new Set();
  const changed = new Set();
  let rosterChanged = false;

  function entryFor(player) {
    if (!players.has(player)) {
      if (players.size >= maxEntries) throw new RequestError(503, 'presence_limit');
      players.set(player, {
        profile: profileFor(player), connections: 0, until: now() + reconnectGrace,
      });
    }
    return players.get(player);
  }

  const motionOf = ({profile, position, yaw, pitch, motion, lookYaw, typing, swing, held, offhand, spectator, stance, boost,equipment,groundSeat,emote,death,afk,invisible}) => ({
    id:profile.id, position, yaw, pitch, motion, lookYaw,
    ...(typing !== undefined && {typing}), ...(swing !== undefined && {swing}), ...(held !== undefined && {held}),
    ...(offhand && {offhand}),
    ...(spectator !== undefined && {spectator}), ...(stance !== undefined && {stance}), ...(boost !== undefined && {boost}),
    ...(equipment !== undefined && {equipment}), ...(groundSeat !== undefined && {groundSeat}),
    ...(emote !== undefined && {emote}),...(death !== undefined && {death}),...(afk !== undefined && {afk}),
    ...(invisible !== undefined && {invisible})});
  function snapshot(viewer) {
    const admin=canSeeSpectators(viewer);
    return [...players].flatMap(([player,entry])=>player!==viewer && entry.visible && (admin || !entry.spectator)
      ? [{...entry.profile,...motionOf(entry),...(admin&&{uid:player})}] : []);
  }
  const roster = stream => ({players:snapshot(stream.player),
    ...(stream.social && {selfOnline:Boolean(players.get(stream.player)?.visible)})});

  function visibility(player, entry, visible) {
    if (Boolean(entry.visible) === visible) return;
    entry.visible = visible;
    rosterChanged = true;
    onVisibility?.(entry.profile, visible, player,Boolean(entry.spectator));
  }

  function updateAfk(player, entry, time) {
    const activity=entry.activity;
    if (!activity) return;
    const afk=activity.afk || activity.disconnected || time-activity.seen>=activityLease;
    if (entry.afk===afk) return;
    entry.afk=afk;
    if (entry.visible) changed.add(player);
  }

  function isActivityStream(stream, activity) {
    return stream.deviceId===activity.deviceId && stream.movementPage===activity.page;
  }

  function recordActivity(player, entry, report) {
    const current=entry.activity;
    if (current?.page===report.page && current.deviceId===report.deviceId && current.seq>report.seq) return;
    const time=now();
    entry.activity={...report,seen:time,disconnected:false};
    updateAfk(player,entry,time);
  }

  function update(player, position, pose) {
    const entry = players.get(player);
    if (!entry?.position) return;
    entry.confirmedPosition = position;
    const next = roundPosition(position);
    const previous = entry.position;
    let dirty = previous.x !== next.x || previous.y !== next.y || previous.z !== next.z;
    if (dirty) entry.position = next;
    for (const key of ['spectator','stance','death','invisible']) {
      if (pose?.[key] !== undefined && entry[key] !== pose[key]) {
        if (key==='spectator' && Boolean(entry.spectator)!==pose[key] && entry.visible) rosterChanged=true;
        entry[key] = pose[key];
        dirty = true;
      }
    }
    if (pose && (pose.groundSeat !== undefined || pose.motion !== undefined) &&
        (pose.groundSeat === true) !== (entry.groundSeat === true)) {
      entry.groundSeat = pose.groundSeat === true;
      dirty = true;
    }
    if (pose?.equipment !== undefined && (!entry.equipment ||
        pose.equipment.some((stack,index)=>stack?.key !== entry.equipment[index]?.key))) {
      entry.equipment = pose.equipment.map(stack=>stack ? {key:stack.key} : null);
      dirty = true;
    }
    if (pose?.offhand !== undefined &&
        (entry.offhand?.key !== pose.offhand?.key || entry.offhand?.kind !== pose.offhand?.kind ||
          JSON.stringify(entry.offhand?.part) !== JSON.stringify(pose.offhand?.part))) {
      entry.offhand = pose.offhand;
      dirty = true;
    }
    if (pose && (pose.seq === undefined || entry.seq === undefined || pose.seq >= entry.seq)) {
      const motion = pose.motion ?? entry.motion;
      if (pose.yaw !== undefined) {
        dirty ||= entry.yaw !== pose.yaw || entry.pitch !== pose.pitch || entry.motion !== motion || entry.lookYaw !== pose.lookYaw;
        Object.assign(entry, {yaw:pose.yaw, pitch:pose.pitch, motion, lookYaw:pose.lookYaw});
      }
      for (const key of ['typing','swing','boost']) {
        if (pose[key] === undefined || entry[key] === pose[key]) continue;
        dirty = true;
        entry[key] = pose[key];
      }
      if (pose.held !== undefined && (entry.held === undefined || entry.held?.key !== pose.held?.key || entry.held?.kind !== pose.held?.kind ||
          JSON.stringify(entry.held?.part) !== JSON.stringify(pose.held?.part))) {
        entry.held = pose.held;
        dirty = true;
      }
      if (pose.emote !== undefined && (entry.emote === undefined ||
          entry.emote?.id !== pose.emote?.id || entry.emote?.started !== pose.emote?.started)) {
        entry.emote = pose.emote;
        dirty = true;
      }
      if (pose.seq !== undefined) entry.seq = pose.seq;
    }
    if (dirty && entry.visible) changed.add(player);
  }

  return {
    prepare: entryFor,
    onlineProfile(player) {
      const entry = players.get(player);
      return entry?.visible && entry.profile;
    },
    onlinePosition(player) {
      const entry = players.get(player);
      return entry?.visible ? entry.confirmedPosition : undefined;
    },
    heading(player) {
      const entry = players.get(player);
      return entry?.lookYaw ?? entry?.yaw ?? 0;
    },
    connect(stream, entry) {
      listeners.add(stream);
      entry.connections++;
      if (entry.activity && isActivityStream(stream,entry.activity)) {
        entry.activity.seen=now();
        entry.activity.disconnected=false;
        updateAfk(stream.player,entry,entry.activity.seen);
      }
      if (entry.position) visibility(stream.player, entry, true);
      send(stream.response, 'presence', roster(stream));
    },
    disconnect(stream) {
      if (!listeners.delete(stream)) return;
      const entry = players.get(stream.player);
      if (!entry) return;
      const time=now();
      if (--entry.connections===0) entry.until=time+(entry.visible && entry.activity ? afkReconnectGrace : reconnectGrace);
      if (entry.activity && (!entry.connections || isActivityStream(stream,entry.activity) &&
          ![...listeners].some(other=>other.player===stream.player && isActivityStream(other,entry.activity)))) {
        entry.activity.disconnected=true;
        updateAfk(stream.player,entry,time);
      }
    },
    profile(player, profile) {
      const entry = players.get(player);
      if (entry) {
        entry.profile = profile;
        if (entry.visible) rosterChanged = true;
      }
    },
    join(player, position, pose, {fallback=false,activity} = {}) {
      const entry = entryFor(player);
      if (!entry.connections) {
        if (fallback) entry.until = now() + fallbackLease;
        else if (!entry.visible) entry.until = now() + reconnectGrace;
      }
      if (!entry.position) {
        entry.position = roundPosition(position);
        entry.confirmedPosition = position;
        entry.yaw = 0;
        entry.pitch = 0;
        entry.motion = 'idle';
        entry.typing = entry.swing = entry.held = entry.spectator = entry.stance = entry.boost = entry.equipment = entry.groundSeat = undefined;
        entry.emote = entry.offhand = undefined;
      }
      update(player, position, pose);
      if (activity) recordActivity(player,entry,activity);
      if (entry.connections || fallback) visibility(player, entry, true);
    },
    leave(player) {
      const entry = players.get(player);
      if (!entry) return;
      visibility(player, entry, false);
      entry.position = undefined;
      entry.confirmedPosition = undefined;
      entry.seq = undefined;
      entry.activity = entry.afk = undefined;
    },
    update,
    refreshRoster() { rosterChanged=true; },
    flush() {
      const time = now();
      for (const [player, entry] of players) {
        if (!entry.connections && entry.until <= time) {
          if (entry.visible && entry.activity && !entry.activity.disconnected) {
            entry.activity.disconnected=true;
            entry.until=time+afkReconnectGrace;
          } else {
            players.delete(player);
            visibility(player,entry,false);
            continue;
          }
        }
        updateAfk(player,entry,time);
      }
      if (rosterChanged) {
        for (const stream of listeners) send(stream.response, 'presence', roster(stream));
      } else if (changed.size) {
        const motions = [...changed].flatMap(player => {
          const entry = players.get(player);
          return entry?.visible ? [{player,spectator:entry.spectator,state:motionOf(entry)}] : [];
        });
        for (const {player, response} of listeners) {
          const admin=canSeeSpectators(player);
          const others=motions.filter(item=>item.player!==player && (admin || !item.spectator)).map(item=>item.state);
          if (others.length) send(response, 'presence-motion', {players:others});
        }
      }
      rosterChanged = false;
      changed.clear();
    },
  };
}
