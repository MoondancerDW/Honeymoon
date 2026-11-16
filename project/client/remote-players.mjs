import * as THREE from '/vendor/three/three.module.js';
import {FLIGHT_SPRINT_SPEED,PLAYER,playerBody} from '../world/player-body.mjs';
import {createPonyAvatar, createPonyFacing} from './pony-avatar.mjs';

const maxVisibleDistance = 96;
const maxNameplateDistance = 64;
const corner = Math.PI * 2;
const angleBetween = (from, to) => ((to - from + Math.PI) % corner + corner) % corner - Math.PI;

function nameTexture(nickname, typing) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = 'bold 18px monospace';
  context.font = font;
  const width = Math.max(30, Math.ceil(context.measureText(nickname).width) + 8);
  const height = typing ? 46 : 24;
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = 'rgba(0, 0, 0, .28)';
  context.fillRect(0, height - 24, width, 24);
  if (typing) {
    const left = Math.round(width / 2) - 12;
    context.fillRect(left - 2, 0, 28, 18);
    context.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) context.fillRect(left + 4 + i * 8, 8, 4, 4);
  }
  context.font = font;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'center';
  context.fillStyle = '#292929';
  context.fillText(nickname, width / 2 + 2, height - 4);
  context.fillStyle = '#fff';
  context.fillText(nickname, width / 2, height - 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  return texture;
}

function setNameplate(player) {
  if (player.labelName === player.nickname && player.labelTyping === player.typing) return;
  const texture = nameTexture(player.nickname, player.typing);
  const {label} = player;
  label.material.map?.dispose();
  label.material.map = texture;
  label.material.needsUpdate = true;
  label.scale.set(texture.image.width / 80, texture.image.height / 80, 1);
  label.center.set(.5,0);
  player.labelName = player.nickname;
  player.labelTyping = player.typing;
}

function setProfile(player,{nickname,skin,size}) {
  player.nickname = nickname;
  player.size = size;
  if (player.skin !== skin) {
    player.skin = skin;
    player.avatar.setSkin(skin);
  }
}

function setPose(player, pose) {
  const {x, y, z} = pose.position;
  const relocated = player.object.position.distanceToSquared(player.target.set(x,y,z)) > 64;
  if (relocated) player.object.position.copy(player.target);
  const grounded = pose.motion === 'idle' || pose.motion === 'walk' || pose.motion === 'run';
  if (pose.motion === 'air') player.airTop = Math.max(y,relocated ? y : player.airTop ?? y);
  else if (player.airTop !== undefined) {
    const fall = player.airTop - y;
    if (!relocated && grounded && fall >= 3) player.landing = Math.min(16,Math.sqrt(40*fall));
    player.airTop = undefined;
  }
  player.yaw = pose.yaw;
  player.lookYaw = pose.lookYaw ?? pose.yaw;
  player.pitch = pose.pitch;
  player.motion = pose.motion;
  player.stance = pose.stance ?? 'stand';
  player.boost = pose.boost === true;
  player.groundSeat = pose.groundSeat === true;
  player.spectator = pose.spectator === true;
  player.typing = pose.typing === true;
  player.swing = pose.swing ?? 0;
  player.held = pose.held;
  player.equipment = pose.equipment;
  player.emote = pose.emote;
  player.death = pose.death;
  setNameplate(player);
}

export class RemotePlayers {
  constructor(scene,camera,itemAssets,isAir,groundDust) {
    this.scene = scene;
    this.camera = camera;
    this.itemAssets = itemAssets;
    this.isAir = isAir;
    this.groundDust = groundDust;
    this.entries = new Map();
    this.projected = new THREE.Vector3();
  }

  replace(profiles) {
    const relevant = new Set(profiles.map(player => player.id));
    for (const [id, player] of this.entries) {
      if (relevant.has(id)) continue;
      player.avatar.dispose();
      player.label.material.map?.dispose();
      player.label.material.dispose();
      this.scene.remove(player.object);
      this.entries.delete(id);
    }
    for (const profile of profiles) {
      if (!this.entries.has(profile.id)) {
        const avatar = createPonyAvatar(this.isAir);
        const object = new THREE.Group();
        const label = new THREE.Sprite(new THREE.SpriteMaterial({transparent:true, depthWrite:false, toneMapped:false}));
        object.add(avatar.object, label);
        const {x, y, z} = profile.position;
        object.position.set(x, y, z);
        object.rotation.y = profile.yaw;
        object.visible = false;
        this.scene.add(object);
        this.entries.set(profile.id, {avatar, object, label, target:object.position.clone(), facing:createPonyFacing(),
          drawnPitch:profile.pitch, drawnLookYaw:profile.lookYaw ?? profile.yaw});
      }
      const player = this.entries.get(profile.id);
      setProfile(player, profile);
      setPose(player, profile);
    }
  }

  update(poses) {
    for (const pose of poses) {
      const player = this.entries.get(pose.id);
      if (player) setPose(player, pose);
    }
  }

  pick(origin,direction,limit) {
    let selected;
    for (const [id,player] of this.entries) {
      if (player.spectator||player.death) continue;
      const {height,halfWidth}=playerBody(player.size,player.stance);
      const dx=player.target.x-origin[0],dy=player.target.y+height*.56-origin[1],dz=player.target.z-origin[2];
      const range=dx*direction[0]+dy*direction[1]+dz*direction[2];
      if (range<=0||range>=Math.min(limit,selected?.length??Infinity)) continue;
      const radial=((dx-range*direction[0])/Math.max(.35,halfWidth))**2+((dy-range*direction[1])/(height*.55))**2+
        ((dz-range*direction[2])/Math.max(.35,halfWidth))**2;
      if (radial<=1) selected={id,name:player.nickname,length:range};
    }
    return selected;
  }

  frame(now, dt) {
    const mix = 1 - Math.exp(-dt * 18);
    for (const player of this.entries.values()) {
      const {object, target} = player;
      const eye = this.camera.position;
      const overlapsCamera = Math.abs(eye.y - target.y - PLAYER.eye) < .75 &&
        Math.hypot(target.x - eye.x, target.z - eye.z) < .4;
      const distance = eye.distanceToSquared(target);
      object.visible = !player.spectator && distance < maxVisibleDistance ** 2 && !overlapsCamera;
      const {x, z} = object.position;
      object.position.lerp(target, mix);
      player.drawnLookYaw += angleBetween(player.drawnLookYaw, player.lookYaw) * mix;
      const seatYaw = player.motion === 'sit' ? player.yaw : undefined;
      const facing = player.facing(object.position, player.drawnLookYaw, dt, seatYaw, player.motion);
      object.rotation.y = facing.bodyYaw;
      if (!object.visible) {
        player.landing = 0;
        continue;
      }
      player.drawnPitch += (player.pitch - player.drawnPitch) * mix;
      const speed = dt > 0 ? Math.min(FLIGHT_SPRINT_SPEED, Math.hypot(object.position.x - x, object.position.z - z) / dt) : 0;
      if (player.landing) {
        this.groundDust?.(target,playerBody(player.size,player.stance),[0,0],player.landing,now);
        player.landing = 0;
      } else if (player.motion === 'run' && speed > 3 && now >= (player.nextDust ?? 0)) {
        player.nextDust = now + 90;
        this.groundDust?.(object.position,playerBody(player.size,player.stance),
          [(object.position.x-x)/dt,(object.position.z-z)/dt],0,now);
      }
      player.avatar.animate({time: now / 1000, dt, speed, pitch: player.drawnPitch,
        yawOffset:facing.yawOffset, forward:facing.forward, strafe:facing.strafe,
        motion:player.motion, stance:player.stance, boost:player.boost, groundSeat:player.groundSeat,
        position:object.position,
        swing:player.swing, held:player.held, equipment:player.equipment, itemAssets:this.itemAssets?.(), emote:player.emote});
      player.avatar.ragdoll(player.death,dt);
      player.label.visible = !player.death && player.stance === 'stand' && distance < maxNameplateDistance ** 2;
      player.label.position.y = player.avatar.labelHeight - .12;
      object.updateMatrixWorld(true);
    }
  }

  inspect() {
    return [...this.entries].map(([id, player]) => {
      const {object, target} = player;
      this.projected.copy(object.position);
      this.projected.y += .85;
      this.projected.project(this.camera);
      const {x, y, z} = this.projected;
      let meshCount = 0;
      player.avatar.object.traverse(mesh => { if (mesh.isMesh && mesh.visible) meshCount++; });
      return {...player.avatar.inspect(), id, nickname:player.nickname, skin:player.skin, position:{x:target.x, y:target.y, z:target.z},
        yaw:player.yaw, bodyYaw:object.rotation.y, pitch:player.pitch, motion:player.motion, visible:object.visible, meshCount,
        equipment:player.equipment,
        typing:player.typing, nameplate:object.visible && player.label.visible,
        onScreen:object.visible && Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1};
    });
  }
}
