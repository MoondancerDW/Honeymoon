import {randomUUID} from 'node:crypto';
import {POSITION_TRAIL_LIMIT} from '../world/player-body.mjs';
import {RequestError} from './errors.mjs';

const maxPending = 4;
const maxGap = maxPending * POSITION_TRAIL_LIMIT;
export const isMovementPage = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);

export function createMovementChannel(positionState) {
  const channels = new Map();

  function reset(channel) {
    Object.assign(channel, {epoch:randomUUID(), accepted:0});
    channel.pending.clear();
    channel.commits.length=0;
  }

  function snapshot(channel, player) {
    return {epoch:channel.epoch, accepted:channel.accepted, ...positionState(player),
      ...(channel.commits.length && {commits:channel.commits.slice()})};
  }

  function get(player, device, page) {
    const channel = channels.get(player);
    return channel?.device === device && channel.page === page ? channel : undefined;
  }

  function open(player, device, page, start) {
    if (!isMovementPage(page)) throw new RequestError(400,'invalid_movement_page');
    let channel = get(player,device,page);
    if (!channel) {
      if (!start && channels.has(player)) throw new RequestError(409,'movement_page_replaced');
      channel = {device,page,pending:new Map(),commits:[]};
      reset(channel);
      channels.set(player,channel);
    }
    return snapshot(channel,player);
  }

  function receive(player, device, input, apply) {
    const channel = get(player,device,input.page);
    if (!channel) throw new RequestError(409,'movement_page_replaced');
    if (input.epoch !== channel.epoch) {
      throw new RequestError(409,'movement_reset',{movement:snapshot(channel,player)});
    }
    const first = input.first, count = Array.isArray(input.trail) ? input.trail.length : 0;
    const last = first + count - 1;
    if (!Number.isSafeInteger(first) || first < 1 || !Number.isSafeInteger(last) ||
        !count || count > POSITION_TRAIL_LIMIT) throw new RequestError(400,'invalid_movement_sequence');
    if (last <= channel.accepted) return snapshot(channel,player);
    if (first <= channel.accepted || last > channel.accepted + maxGap) {
      return snapshot(channel,player);
    }
    if (first > channel.accepted + 1) {
      if (channel.pending.size < maxPending && !channel.pending.has(first)) channel.pending.set(first,input);
      return snapshot(channel,player);
    }

    let packet = input;
    while (packet) {
      const epoch = channel.epoch;
      let result;
      try {
        result = apply(packet);
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        reset(channel);
        throw new RequestError(error.status,error.code,{...error.details,movement:snapshot(channel,player)});
      }
      // A successful step may have changed the player's state, for example by triggering death.
      if (epoch !== channel.epoch) {
        const state = snapshot(channel,player);
        result.deliver?.(state,result);
        return state;
      }
      channel.accepted = packet.first + packet.trail.length - 1;
      if (result.commit) {
        channel.commits.push({through:channel.accepted,...result.commit});
        if (channel.commits.length>16) channel.commits.shift();
      }
      result.deliver?.(snapshot(channel,player),result);
      packet = channel.pending.get(channel.accepted + 1);
      if (packet) channel.pending.delete(packet.first);
      for (const key of channel.pending.keys()) if (key <= channel.accepted) channel.pending.delete(key);
    }
    return snapshot(channel,player);
  }

  return {
    open, receive,
    restart(player, device, page, epoch) {
      open(player,device,page,false);
      const channel=get(player,device,page);
      if (channel.epoch===epoch) {
        channel.retired=snapshot(channel,player);
        reset(channel);
      }
      return {movement:snapshot(channel,player),...(channel.retired?.epoch===epoch && {previousMovement:channel.retired})};
    },
    state(player, device, page) {
      const channel = get(player,device,page);
      return channel && snapshot(channel,player);
    },
    owns: (player,device,page) => Boolean(get(player,device,page)),
    invalidate(player) {
      const channel = channels.get(player);
      if (channel) reset(channel);
    },
    active: player => channels.has(player),
  };
}
