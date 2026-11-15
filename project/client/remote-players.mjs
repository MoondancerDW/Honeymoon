import * as THREE from '/vendor/three/three.module.js';
import {FLIGHT_SPRINT_SPEED, PLAYER} from '../world/player-body.mjs';
import {createPonyAvatar} from './pony-avatar.mjs';

const maxVisibleDistance = 96;
const corner = Math.PI * 2;
const angleBetween = (from, to) => ((to - from + Math.PI) % corner + corner) % corner - Math.PI;

function nameTexture(nickname) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = '600 29px "Segoe UI", sans-serif';
  const width = Math.ceil(context.measureText(nickname).width + 22);
  canvas.width = width;
  canvas.height = 46;
  context.fillStyle = 'rgba(17, 27, 32, 0.87)';
  context.beginPath();
  context.roundRect(0, 1, width, 44, 7);
  context.fill();
  context.font = '600 29px "Segoe UI", sans-serif';
  context.textBaseline = 'middle';
  context.textAlign = 'center';
  context.fillStyle = '#fff8e7';
  context.fillText(nickname, width / 2, 23);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function setProfile(player, {nickname, skin}) {
  if (player.nickname !== nickname) {
    const texture = nameTexture(nickname);
    player.label.material.map?.dispose();
    player.label.material.map = texture;
    player.label.material.needsUpdate = true;
    player.label.scale.set(texture.image.width / 145, texture.image.height / 145, 1);
    player.nickname = nickname;
  }
  if (player.skin !== skin) {
    player.skin = skin;
    player.avatar.setSkin(skin);
  }
}

function setPose(player, pose, now) {
  const {x, y, z} = pose.position;
  const step = Math.hypot(x - player.target.x, z - player.target.z);
  const elapsed = Math.max(.08, (now - player.updated) / 1000);
  if (step > .001) player.speed = Math.min(FLIGHT_SPRINT_SPEED, step / elapsed);
  if (pose.motion === 'idle' || pose.motion === 'sit') player.speed = 0;
  if (player.object.position.distanceToSquared(player.target.set(x, y, z)) > 64) player.object.position.copy(player.target);
  player.yaw = pose.yaw;
  player.lookYaw = pose.lookYaw ?? pose.yaw;
  player.pitch = pose.pitch;
  player.motion = pose.motion;
  player.updated = now;
}

export class RemotePlayers {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
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
    const now = performance.now();
    for (const profile of profiles) {
      if (!this.entries.has(profile.id)) {
        const avatar = createPonyAvatar();
        const object = new THREE.Group();
        const label = new THREE.Sprite(new THREE.SpriteMaterial({transparent:true, depthWrite:false, toneMapped:false}));
        object.add(avatar.object, label);
        const {x, y, z} = profile.position;
        object.position.set(x, y, z);
        object.rotation.y = profile.yaw;
        object.visible = false;
        this.scene.add(object);
        this.entries.set(profile.id, {avatar, object, label, target:object.position.clone(), speed:0,
          drawnPitch:profile.pitch, updated:now});
      }
      const player = this.entries.get(profile.id);
      setProfile(player, profile);
      setPose(player, profile, now);
    }
  }

  update(poses) {
    const now = performance.now();
    for (const pose of poses) {
      const player = this.entries.get(pose.id);
      if (player) setPose(player, pose, now);
    }
  }

  frame(now, dt) {
    const mix = 1 - Math.exp(-dt * 18);
    for (const player of this.entries.values()) {
      const {object, target} = player;
      const eye = this.camera.position;
      const overlapsCamera = Math.abs(eye.y - target.y - PLAYER.eye) < .75 &&
        Math.hypot(target.x - eye.x, target.z - eye.z) < .4;
      const distance = eye.distanceToSquared(target);
      object.visible = distance < maxVisibleDistance ** 2 && !overlapsCamera;
      object.position.lerp(target, mix);
      object.rotation.y += angleBetween(object.rotation.y, player.yaw) * mix;
      if (!object.visible) continue;
      player.label.position.y = player.avatar.labelHeight + .55 * Math.max(0, target.y - eye.y) /
        Math.max(1, Math.sqrt(distance));
      player.drawnPitch += (player.pitch - player.drawnPitch) * mix;
      player.avatar.animate({time: now / 1000, dt, speed: player.speed, pitch: player.drawnPitch,
        yawOffset: angleBetween(player.yaw, player.lookYaw),
        motion: player.motion === 'air' ? 'jump' : player.motion});
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
        yaw:player.yaw, pitch:player.pitch, motion:player.motion, visible:object.visible, meshCount,
        onScreen:object.visible && Math.abs(x) <= 1 && Math.abs(y) <= 1 && z >= -1 && z <= 1};
    });
  }
}
