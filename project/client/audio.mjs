import {collisionFor} from '../world/geometry.mjs';
import {extractedModel} from '../world/extracted-models.mjs';
import {PLAYER} from '../world/player-body.mjs';

const ASSETS = '/generated/sounds/';
const STEP_DISTANCE = 1 / .6;
const SFX_VOLUME = .12676056;
const MUSIC_INTERVAL = 600;
const MUSIC_RETRY_MS = 1800;
const CAVE_MOOD = 'ambient.cave.cave';
const TICK_SECONDS = .05;
const SOUND_FILE = /^[a-f0-9]{24}\.(?:ogg|wav)$/;
const DEFAULT_PROFILE = ['step.stone', 'dig.stone', 1, 1];
const effectDefaults = {
  'door.open': {pitch: .9, spread: .1}, 'door.close': {pitch: .9, spread: .1},
  'click.on': {pitch: .6, volume: .3}, 'click.off': {pitch: .5, volume: .3},
  'chest.open': {pitch: .9, spread: .1, volume: .5}, 'chest.close': {pitch: .9, spread: .1, volume: .5},
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const keyOf = cell => typeof cell === 'string' ? cell : cell?.key;
const blockId = cell => {
  const key = keyOf(cell);
  if (key?.startsWith('legacy:') || key?.startsWith('cover:')) return Number.parseInt(key.slice(key.indexOf(':') + 1), 10);
  return 0;
};
const pick = choices => choices?.[Math.floor(Math.random() * choices.length)];
export const audioDefaults = Object.freeze({profile:'biome',natureVolume:.32,natureFrequency:.24,
  animalsVolume:.22,animalsFrequency:.16,otherVolume:.46,otherFrequency:.24});
const audioProfiles = new Set(['biome','minimal','acoustic']);
const taiga = new Set([5,19,30,31,32,33,133,158,160,161]);
const forest = new Set([4,18,27,28,29,132,155,156,157]);

function noise(context, seconds, impulse = false) {
  const size = Math.floor(seconds*context.sampleRate);
  const result = context.createBuffer(1,size,context.sampleRate);
  const data = result.getChannelData(0);
  for (let i=0;i<size;i++) data[i]=(Math.random()*2-1)*(impulse ? (1-i/size)**3 : 1);
  return result;
}

function rainLoop(context,kind) {
  const channels=2, length=Math.floor(context.sampleRate*3.2);
  const buffer=context.createBuffer(channels,length,context.sampleRate);
  const tone={open:1820,wood:720,stone:440,glass:2410,foliage:1060,water:1340,snow:610}[kind];
  const tapCount=kind==='snow' ? 0 : kind==='open' ? 155 : kind==='foliage' ? 130 : 83;
  for (let channel=0;channel<channels;channel++) {
    const data=buffer.getChannelData(channel);
    const smoothing=1-Math.exp(-2*Math.PI*tone/context.sampleRate);
    let filtered=0;
    for (let i=0;i<length;i++) {
      filtered+=smoothing*(Math.random()*2-1-filtered);
      data[i]=filtered*(kind==='open' ? .49 : .17);
    }
    for (let j=0;j<tapCount;j++) {
      const start=Math.floor(Math.random()*length);
      const duration=(kind==='foliage' ? .034 : .024)+Math.random()*.035;
      const amplitude=.10+Math.random()*.19, pitch=tone*(.78+.44*Math.random());
      for (let k=0;k<duration*context.sampleRate;k++) {
        const progress=k/(duration*context.sampleRate);
        const timbre=kind==='wood' || kind==='stone' || kind==='glass'
          ? .75*Math.sin(2*Math.PI*pitch*k/context.sampleRate)+.25*(Math.random()*2-1) : Math.random()*2-1;
        data[(start+k)%length]+=amplitude*timbre*Math.min(1,k/16)*(1-progress)**4;
      }
    }
    // Close the loop without a click from the continuous rain bed.
    for (let k=0;k<256;k++) data[length-256+k]=data[length-256+k]*(1-k/255)+data[0]*k/255;
  }
  return buffer;
}

export function rainAudioMix(kind,strength,volume,cover) {
  const exposure=cover?.exposure ?? 1;
  const power=volume*(.38+.62*clamp(strength,0,1));
  const blocked=cover?.sheltered;
  if (kind==='snow') return {open:0,snow:power*(blocked ? .013+.13*exposure : .44),roof:undefined,impact:0};
  if (kind!=='rain') return {open:0,snow:0,roof:undefined,impact:0};
  return {open:power*(blocked ? .026+.32*exposure : .82+.18*exposure),snow:0,
    roof:blocked ? cover.roof ?? 'stone' : undefined,
    impact:blocked ? power*(.02+.83*Math.exp(-Math.max(0,cover.roofHeight-1)/10))*(1-.65*exposure) : 0};
}

function obstructed(world, listener, destination) {
  const start = [listener.x,listener.y,listener.z];
  const delta = destination.map((value,i)=>value+.5-start[i]);
  const steps = Math.ceil(Math.hypot(...delta)*3);
  for (let i=1;i<steps;i++) {
    const point = start.map((value,axis)=>value+delta[axis]*i/steps);
    const block = point.map(Math.floor), local = point.map((value,axis)=>value-block[axis]);
    if (collisionFor(world.cellAt(...block)).some(box=>local[0]>box.x0 && local[0]<box.x1 &&
        local[1]>box.y0 && local[1]<box.y1 && local[2]>box.z0 && local[2]<box.z1)) return true;
  }
  return false;
}

export function blockSoundProfile(catalog, cell, material) {
  const id = catalog?.covers[material] ?? blockId(cell);
  return catalog?.profiles[catalog.blocks[id]] ?? DEFAULT_PROFILE;
}

export function caveMoodSource(world, player, random = Math.random) {
  const radius = 8;
  const minChunkX = Math.floor((player.x - radius) / 16);
  const maxChunkX = Math.floor((player.x + radius) / 16);
  const minChunkZ = Math.floor((player.z - radius) / 16);
  const maxChunkZ = Math.floor((player.z + radius) / 16);
  // Minecraft 1.4.7 samples one block between Y=0 and Y=127 per active chunk.
  for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ++) {
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
      if (!world.hasChunk(chunkX * 16, chunkZ * 16)) continue;
      const x = chunkX * 16 + Math.floor(random() * 16);
      const z = chunkZ * 16 + Math.floor(random() * 16);
      const y = Math.floor(random() * 128);
      const distance = (x + .5 - player.x) ** 2 + (y + .5 - player.y) ** 2 + (z + .5 - player.z) ** 2;
      if (distance <= 4 || distance > radius ** 2 || world.cellAt(x, y, z)) continue;
      const light = world.lightAt(x, y, z);
      if (!(light >> 4) && (light & 15) <= Math.floor(random() * 8)) return [x, y, z];
    }
  }
  return null;
}

export function groundSurface(world, position, body = PLAYER) {
  const x = Math.floor(position.x), z = Math.floor(position.z);
  const startY = Math.floor(position.y + .001);
  let closest;
  let height = -Infinity;
  for (let y = startY; y >= startY - 2; y--) {
    for (let zz = z - 1; zz <= z + 1; zz++) {
      for (let xx = x - 1; xx <= x + 1; xx++) {
        const cell = world.cellAt(xx, y, zz);
        if (!cell) continue;
        const adjacent = (dx, dy, dz) => world.cellAt(xx + dx, y + dy, zz + dz);
        const boxes = extractedModel(world.models, cell, adjacent)?.collision ?? collisionFor(cell, adjacent);
        for (const box of boxes) {
          const top = y + box.y1;
          if (top > position.y + .0125 || top <= height || top < position.y - .125 ||
              position.x + body.halfWidth <= xx + box.x0 || position.x - body.halfWidth >= xx + box.x1 ||
              position.z + body.halfWidth <= zz + box.z0 || position.z - body.halfWidth >= zz + box.z1) continue;
          height = top;
          closest = {cell, material:box.material, position:[xx,y,zz], height:top};
        }
      }
    }
  }
  const layer = world.cellAt(x, startY, z);
  return blockId(layer) === 78 ? {cell:layer,position:[x,startY,z],height:position.y} : closest;
}

const defaultAltitudeMusic = '/altitude-theme.wav';

export class WorldAudio {
  #catalog;
  #loadPromise;
  #context;
  #master;
  #volume = SFX_VOLUME;
  #musicVolume = 0;
  #muted = false;
  #playing = false;
  #buffers = new Map();
  #voices = new Set();
  #listener;
  #right = [1, 0];
  #nextAmbience = 0;
  #nextCave;
  #nextAnimal = 0;
  #environment = {...audioDefaults};
  #air;
  #airFilter;
  #airGain;
  #weatherLoops = new Map();
  #weatherGains;
  #lastThunder;
  #indoor = false;
  #skySampleAt = 0;
  #windSampleAt = 0;
  #echo;
  #previous;
  #moved = 0;
  #airborne = 0;
  #music;
  #nextMusic = 0;
  #altitudeActive = false;
  #altitudeSource;
  #altitudeSourceFailed = false;
  #altitudeMusic;
  #altitudeAttempt;
  #nextAltitudeAttempt = 0;
  #records = new Map();
  #bard;
  #bardRetryAt = 0;
  #requested = 0;
  #played = 0;

  load() {
    this.#loadPromise ??= fetch(`${ASSETS}sounds.json`).then(async response => {
      if (!response.ok) return false;
      const {version, profiles, blocks, covers, sounds} = await response.json();
      if (![1, 2, 3].includes(version) || !Array.isArray(profiles) || !blocks || !covers || !sounds) return false;
      this.#catalog = {profiles, blocks, covers, sounds};
      return true;
    }).catch(() => false);
    return this.#loadPromise;
  }

  enable() {
    const AudioContextType = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextType) return;
    try {
      if (!this.#context) {
        this.#context = new AudioContextType();
        this.#master = this.#context.createGain();
        this.#master.connect(this.#context.destination);
        this.#updateGain();
      }
      this.#context.resume().catch(() => {});
      if (this.#altitudeActive) {
        this.#nextAltitudeAttempt = 0;
        this.#playAltitudeMusic();
      }
    } catch {
      this.#context = undefined;
    }
  }

  setPlaying(active) {
    this.#playing = Boolean(active);
    this.#previous = undefined;
    this.#moved = 0;
    this.#airborne = 0;
    if (!this.#playing) {
      this.#pauseGroundMusic();
      this.#pauseAltitudeMusic();
      if (this.#bard) {
        this.#bard.attempt=undefined;
        this.#bard.player.pause();
      }
    } else {
      this.#bardRetryAt=0;
      if (this.#altitudeActive) {
        this.#nextAltitudeAttempt = 0;
        this.#playAltitudeMusic();
      } else this.#resumeGroundMusic();
    }
    this.#updateGain();
  }

  setMuted(muted) {
    this.#muted = Boolean(muted);
    this.#updateGain();
    if (this.#music) this.#music.muted = this.#muted;
    if (this.#altitudeActive) {
      if (this.#muted) this.#pauseAltitudeMusic();
      else {
        this.#nextAltitudeAttempt = 0;
        this.#playAltitudeMusic();
      }
    } else if (!this.#muted) this.#resumeGroundMusic();
    if (this.#bard) this.#bard.player.muted = this.#muted;
    for (const {player} of this.#records.values()) player.muted = this.#muted;
  }

  npcMusic(npcs,position,now) {
    if (!this.#playing) return;
    if (this.#muted || !globalThis.Audio || !this.#environment.otherVolume || !this.#volume) {
      this.#stopBard();
      return;
    }
    let speaker, nearest=Infinity;
    for (const npc of npcs) {
      if (npc.health<=0 || !/^\/generated\/npcs\/sound\/[^/?#]+\.ogg$/i.test(npc.bard?.sound??'')) continue;
      const {x,y,z}=npc.position;
      const distance=Math.hypot(x-position.x,y-position.y,z-position.z);
      if (distance<npc.bard.maxRange && distance<nearest) {
        speaker=npc;
        nearest=distance;
      }
    }
    if (!speaker) {
      this.#stopBard(true);
      return;
    }
    const {sound,minRange,maxRange}=speaker.bard;
    if (this.#bard?.sound!==sound) {
      this.#stopBard(true);
      const player=new Audio(sound);
      player.loop=true;
      player.preload='none';
      const bard=this.#bard={sound,player,audible:false};
      player.onerror=()=>{if (this.#bard===bard) this.#stopBard();};
      this.#bardRetryAt=0;
    }
    const bard=this.#bard;
    const {player}=bard;
    player.muted=false;
    player.volume=.68*this.#volume*this.#environment.otherVolume*clamp((maxRange-nearest)/Math.max(1,maxRange-minRange),0,1);
    if (player.paused && !player.error && !bard.attempt && now>=this.#bardRetryAt) {
      this.#bardRetryAt=now+2000;
      const attempt=bard.attempt=player.play();
      void attempt.then(()=>{
        if (this.#bard!==bard || bard.attempt!==attempt || !this.#playing || this.#muted || player.paused) return;
        bard.audible=true;
        this.#pauseGroundMusic();
        this.#pauseAltitudeMusic();
      },()=>{
        if (this.#bard===bard && bard.attempt===attempt) this.#stopBard();
      }).finally(()=>{ if (bard.attempt===attempt) bard.attempt=undefined; });
    }
  }

  #stopBard(clear=false) {
    const bard=this.#bard;
    if (!bard) return;
    const wasAudible=bard.audible;
    bard.audible=false;
    bard.attempt=undefined;
    bard.player.pause();
    if (clear) this.#bard=undefined;
    if (!wasAudible) return;
    if (this.#altitudeActive) this.#playAltitudeMusic();
    else this.#resumeGroundMusic();
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) return;
    this.#volume = clamp(volume, 0, 1);
    this.#updateGain();
  }

  setMusicVolume(volume) {
    if (!Number.isFinite(volume)) return;
    const enabled = this.#musicVolume > 0;
    this.#musicVolume = clamp(volume, 0, 1);
    if (!enabled && this.#musicVolume) this.#nextMusic = -1;
    if (this.#music) {
      this.#music.volume = this.#musicVolume;
      if (!this.#musicVolume) this.#music.pause();
    }
    if (this.#altitudeMusic) {
      const {player,gain} = this.#altitudeMusic;
      if (gain) gain.gain.value = this.#musicVolume;
      else player.volume = this.#musicVolume;
      if (!this.#musicVolume) this.#pauseAltitudeMusic();
    }
    if (this.#altitudeActive) {
      if (!enabled) this.#nextAltitudeAttempt = 0;
      this.#playAltitudeMusic();
    } else this.#resumeGroundMusic();
  }

  setAltitudeMusic(source) {
    const next = typeof source === 'string' && source.startsWith('blob:') ? source : undefined;
    if (next === this.#altitudeSource) return;
    this.#releaseAltitudeMusic();
    this.#altitudeSource = next;
    this.#altitudeSourceFailed = false;
    if (this.#altitudeActive) this.#playAltitudeMusic();
  }

  #setOverview(active) {
    if (this.#altitudeActive === active) return;
    this.#altitudeActive = active;
    if (active) {
      this.#pauseGroundMusic();
      this.#playAltitudeMusic();
    } else {
      this.#releaseAltitudeMusic();
      this.#bardRetryAt = 0;
      this.#resumeGroundMusic();
    }
  }

  #pauseGroundMusic() {
    this.#music?.pause();
    for (const {player} of this.#records.values()) player.pause();
  }

  #resumeGroundMusic() {
    if (!this.#playing || this.#muted || this.#altitudeActive || this.#bard?.audible) return;
    for (const {player} of this.#records.values()) {
      if (player.paused && !player.ended) player.play().catch(() => {});
    }
    if (!this.#records.size && this.#musicVolume && this.#music?.paused) this.#music.play().catch(() => {});
  }

  #playAltitudeMusic() {
    if (!this.#playing || !this.#altitudeActive || this.#bard?.audible || !this.#musicVolume || this.#muted ||
        !this.#context || !globalThis.Audio || this.#altitudeAttempt) return;
    const now = performance.now();
    if (now < this.#nextAltitudeAttempt) return;
    if (!this.#altitudeMusic) {
      const player = new Audio();
      const custom = Boolean(this.#altitudeSource && !this.#altitudeSourceFailed);
      player.preload = 'none';
      player.loop = true;
      let output, gain;
      if (this.#context.createMediaElementSource) {
        output = this.#context.createMediaElementSource(player);
        gain = this.#context.createGain();
        gain.gain.value = this.#musicVolume;
        output.connect(gain);
        gain.connect(this.#context.destination);
      } else player.volume = this.#musicVolume;
      this.#altitudeMusic = {player,output,gain,custom};
      if (custom) player.onerror = () => {
        if (this.#altitudeMusic?.player !== player) return;
        this.#altitudeSourceFailed = true;
        this.#releaseAltitudeMusic();
        this.#playAltitudeMusic();
      };
      player.src = custom ? this.#altitudeSource : defaultAltitudeMusic;
    }
    const {player} = this.#altitudeMusic;
    if (!player.paused || player.error) return;
    this.#nextAltitudeAttempt = now + MUSIC_RETRY_MS;
    const attempt = player.play().catch(() => {});
    this.#altitudeAttempt = attempt;
    void attempt.finally(() => {
      if (this.#altitudeAttempt === attempt) this.#altitudeAttempt = undefined;
    });
  }

  #pauseAltitudeMusic() {
    this.#altitudeAttempt = undefined;
    this.#nextAltitudeAttempt = 0;
    this.#altitudeMusic?.player.pause();
  }

  #releaseAltitudeMusic() {
    const track = this.#altitudeMusic;
    this.#pauseAltitudeMusic();
    this.#altitudeMusic = undefined;
    if (!track) return;
    track.output?.disconnect();
    track.gain?.disconnect();
    track.player.onerror = null;
    track.player.removeAttribute('src');
    track.player.load();
  }

  setEnvironment(settings) {
    if (audioProfiles.has(settings.profile)) this.#environment.profile = settings.profile;
    for (const key of Object.keys(audioDefaults).filter(key=>key!=='profile')) {
      if (Number.isFinite(settings[key])) this.#environment[key]=clamp(settings[key],0,1);
    }
  }

  #updateGain() {
    if (this.#master) this.#master.gain.value = this.#playing && !this.#muted ? this.#volume : 0;
  }

  #distance(position) {
    if (!this.#listener || !position) return 0;
    const {x, y, z} = this.#listener;
    return Math.hypot(position[0] + .5 - x, position[1] + .5 - y, position[2] + .5 - z);
  }

  #buffer(file) {
    if (!this.#buffers.has(file)) {
      const buffer = fetch(ASSETS + file).then(response => {
        if (!response.ok) throw new Error('Original sound asset missing');
        return response.arrayBuffer();
      }).then(bytes => this.#context.decodeAudioData(bytes)).catch(() => {
        this.#buffers.delete(file);
        return null;
      });
      this.#buffers.set(file, buffer);
    }
    return this.#buffers.get(file);
  }

  async play(id, position, options = {}) {
    if (!this.#playing || this.#muted || this.#context?.state !== 'running') return false;
    const file = pick(this.#catalog?.sounds[id]);
    if (!SOUND_FILE.test(file ?? '')) return false;
    const defaults = effectDefaults[id] ?? {};
    const volume = Number.isFinite(options.volume) ? options.volume : defaults.volume ?? 1;
    const speed = Number.isFinite(options.pitch) ? options.pitch : (defaults.pitch ?? 1) + Math.random() * (defaults.spread ?? 0);
    const range = 16 * Math.max(1, volume);
    if (this.#distance(position) >= range || volume <= 0) return false;
    this.#requested++;
    const buffer = await this.#buffer(file);
    if (!buffer || !this.#playing || this.#muted || this.#voices.size >= 24) return false;
    const gain = this.#context.createGain();
    const distance = this.#distance(position);
    gain.gain.value = Math.min(1, volume) * Math.max(0, 1 - distance / range);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(speed, .25, 4);
    gain.gain.value *= options.occluded ? .4 : 1;
    const context = this.#context;
    let occlusion;
    if (options.occluded) {
      occlusion=context.createBiquadFilter();
      occlusion.type='lowpass';
      occlusion.frequency.value=740;
      source.connect(occlusion).connect(gain);
    } else source.connect(gain);
    if (options.echo) {
      if (!this.#echo) {
        this.#echo=context.createConvolver();
        this.#echo.buffer=noise(context,.68,true);
        const wet=context.createGain();
        wet.gain.value=.16;
        this.#echo.connect(wet).connect(this.#master);
      }
      gain.connect(this.#echo);
    }
    let pan;
    if (position && this.#listener && this.#context.createStereoPanner) {
      const dx = position[0] + .5 - this.#listener.x, dz = position[2] + .5 - this.#listener.z;
      pan = this.#context.createStereoPanner();
      pan.pan.value = clamp((dx * this.#right[0] + dz * this.#right[1]) / Math.max(2, distance), -1, 1);
      gain.connect(pan).connect(this.#master);
    } else gain.connect(this.#master);
    this.#voices.add(source);
    source.onended = () => {
      this.#voices.delete(source);
      source.disconnect();
      gain.disconnect();
      pan?.disconnect();
      occlusion?.disconnect();
    };
    source.start();
    this.#played++;
    return true;
  }

  effects(effects = [], world) {
    for (const effect of effects) {
      if (!effect.sound) continue;
      if (effect.sound === 'block.place') {
        this.placed(world, effect);
      } else if (effect.sound === 'block.break') {
        const [,event,volume,pitch] = blockSoundProfile(this.#catalog,effect.voxelMaterial ?? effect.cell,effect.material);
        void this.play(event,effect.position,{volume:(volume + 1) / 2,pitch:pitch * .8});
      } else if (effect.sound.startsWith('record.')) {
        this.#record(effect.sound, effect.position);
      } else {
        void this.play(effect.sound, effect.position, effect);
      }
    }
  }

  placed(world, {cell, position, material, voxelMaterial}) {
    if (!Array.isArray(position)) return;
    const placed = world?.cellAt(...position) ?? cell;
    const [, event, volume, pitch] = blockSoundProfile(this.#catalog, voxelMaterial ?? placed, material ?? placed?.parts?.[0]?.material);
    void this.play(event, position, {volume: (volume + 1) / 2, pitch: pitch * .8});
  }

  frame(world, position, {grounded = false, swimming = false, climbing = false, yaw = 0, body = PLAYER,
    precipitation = null, sheltered = false, weatherAudio, biome, night = false, windStrength = .3,
    altitudeOverview = false} = {}) {
    this.#setOverview(Boolean(altitudeOverview));
    if (!this.#playing) return;
    if (this.#altitudeActive) this.#playAltitudeMusic();
    if (!this.#catalog) return;
    this.#listener = {x: position.x, y: position.y + 1.62, z: position.z};
    this.#right = [Math.cos(yaw), -Math.sin(yaw)];
    if (this.#context?.state === 'running') {
      this.#playMusic();
      this.#atmosphere(world,precipitation,sheltered,biome,night,windStrength,weatherAudio);
      this.#ambience(world, position);
      this.#caveMood(world);
    }
    for (const {player, position: sourcePosition} of this.#records.values()) {
      player.volume = this.#volume * Math.max(0, 1 - this.#distance(sourcePosition) / 64);
    }
    const previous = this.#previous;
    this.#previous = {...position, grounded, swimming};
    if (!previous) return;
    const dx = position.x - previous.x, dy = position.y - previous.y, dz = position.z - previous.z;
    const distance = Math.hypot(dx, climbing || swimming ? dy : 0, dz);
    // An authoritative correction or respawn must not count as travelled distance.
    if (Math.hypot(dx, dy, dz) > 1.25) {
      this.#moved = 0;
      this.#airborne = 0;
      return;
    }
    if (!grounded && dy < 0) this.#airborne -= dy;
    if (swimming && !previous.swimming) void this.play('liquid.splash', undefined, {volume: .4});
    if (grounded || swimming || climbing) {
      this.#moved += distance;
      if (this.#moved >= STEP_DISTANCE || (grounded && !previous.grounded && this.#airborne > .65)) {
        this.#moved %= STEP_DISTANCE;
        if (swimming) {
          void this.play('liquid.swim', undefined, {volume: .2, pitch: .8 + Math.random() * .4});
        } else {
          const surface = climbing ? {cell:'legacy:65:0'} : groundSurface(world,position,body);
          if (surface) {
            const [event, , volume, pitch] = blockSoundProfile(this.#catalog, surface.cell, surface.material);
            void this.play(event, undefined, {volume: volume * .15, pitch});
          }
        }
      }
      this.#airborne = 0;
    }
  }

  #updateRain(precipitation,weather,volume,now) {
    const mix=rainAudioMix(precipitation,weather?.strength ?? .8,volume,weather?.cover);
    for (const [kind,gain] of [['open',mix.open],['snow',mix.snow],[mix.roof,mix.impact]]) {
      if (!kind || gain<=.001 || this.#weatherLoops.has(kind)) continue;
      const source=this.#context.createBufferSource(), level=this.#context.createGain();
      level.gain.value=0;
      source.buffer=rainLoop(this.#context,kind);
      source.loop=true;
      source.connect(level).connect(this.#master);
      source.start();
      this.#weatherLoops.set(kind,level);
    }
    for (const [kind,level] of this.#weatherLoops) {
      level.gain.setTargetAtTime(mix[kind] ?? (kind===mix.roof ? mix.impact : 0),now,.19);
    }
    this.#weatherGains=mix;
    const strike=weather?.strike;
    if (precipitation==='rain' && strike && strike.id!==this.#lastThunder &&
      weather.epoch>=strike.soundAt && weather.epoch<strike.soundAt+650) {
      this.#lastThunder=strike.id;
      const underRoof=weather.cover?.sheltered;
      void this.play('ambient.weather.thunder',undefined,{volume:volume*(underRoof ? .68 : 1.45),
        pitch:.87,occluded:underRoof});
    }
  }

  #atmosphere(world, precipitation, sheltered, biome, night, windStrength, weatherAudio) {
    const settings=this.#environment, now=this.#context.currentTime;
    if (now >= this.#skySampleAt) {
      this.#skySampleAt=now+.35;
      const {x,y,z}=this.#listener;
      this.#indoor=((world.lightAt?.(Math.floor(x),Math.floor(y),Math.floor(z)) ?? 240)>>4)<5;
    }
    if (this.#muted) return;
    if (!this.#air && settings.natureVolume) {
      this.#air=this.#context.createBufferSource();
      this.#air.loop=true;
      this.#air.buffer=noise(this.#context,3);
      this.#airFilter=this.#context.createBiquadFilter();
      this.#airFilter.type='lowpass';
      this.#airGain=this.#context.createGain();
      this.#airGain.gain.value=0;
      this.#air.connect(this.#airFilter).connect(this.#airGain).connect(this.#master);
      this.#air.start();
    }
    if (now>=this.#windSampleAt) {
      this.#windSampleAt=now+.075;
      const roof = weatherAudio?.cover?.sheltered ?? (sheltered || this.#indoor);
      const snow = precipitation === 'snow';
      const breeze = taiga.has(biome) ? 1 : forest.has(biome) ? .82 : .61;
      const gust = .42+.58*clamp(windStrength,0,1)**(2.6-2*settings.natureFrequency);
      const volume = settings.natureVolume*(snow ? .22 : .13*breeze)*gust*(roof ? .22 : 1);
      this.#airGain?.gain.setTargetAtTime(volume,now,.12);
      this.#airFilter?.frequency.setTargetAtTime(roof ? 270 : snow ? 520 : 410,now,.3);
      this.#updateRain(precipitation,weatherAudio,settings.natureVolume,now);
    }
    if (!settings.animalsFrequency || !settings.animalsVolume || this.#indoor && settings.profile === 'minimal' || now<this.#nextAnimal) return;
    if (!this.#nextAnimal) {
      this.#nextAnimal=now+24+Math.random()*25;
      return;
    }
    this.#nextAnimal=now+(18+Math.random()*25)/settings.animalsFrequency;
    const sound=this.#indoor ? 'mob.bat.idle' : night && (taiga.has(biome) || forest.has(biome)) ? 'mob.wolf.howl' :
      night ? null : settings.profile==='minimal' ? 'mob.chicken.say' : pick(['mob.chicken.say','mob.sheep.say','mob.cow.say']);
    if (!sound) return;
    const direction=Math.random()*2*Math.PI, radius=8+Math.random()*4;
    const {x,y,z}=this.#listener;
    const point=[x+Math.sin(direction)*radius,y-1,z+Math.cos(direction)*radius];
    void this.play(sound,point,{volume:settings.animalsVolume*.47,pitch:.92+Math.random()*.14,
      occluded:settings.profile==='acoustic' && obstructed(world,this.#listener,point),echo:settings.profile==='acoustic' && this.#indoor});
  }

  #ambience(world, position) {
    const settings=this.#environment;
    if (this.#muted || !settings.otherFrequency || !settings.otherVolume || this.#context.currentTime < this.#nextAmbience) return;
    this.#nextAmbience = this.#context.currentTime + (2.5 + Math.random()*3)/settings.otherFrequency;
    const cx = Math.floor(position.x), cy = Math.floor(position.y + 1.62), cz = Math.floor(position.z);
    const nearest = new Map();
    for (let y = cy - 4; y <= cy + 4; y++) {
      for (let z = cz - 8; z <= cz + 8; z++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          const distance = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
          if (distance > 64) continue;
          const cell = world.cellAt(x, y, z);
          const id = blockId(cell);
          let sound;
          if ((id === 8 || id === 9) && /:[1-7]$/.test(keyOf(cell))) sound = 'liquid.water';
          else if (id === 10 || id === 11) sound = 'liquid.lava';
          else if (id === 51 || id === 3000) sound = 'fire.fire';
          else if (id === 90) sound = 'portal.portal';
          if (settings.profile === 'minimal' && sound !== 'liquid.water') continue;
          if (sound && distance < (nearest.get(sound)?.distance ?? Infinity)) {
            nearest.set(sound, {position: [x, y, z], distance});
          }
        }
      }
    }
    for (const [sound, source] of nearest) {
      const volume = sound === 'liquid.water' ? .75 + Math.random() * .25 : .3;
      const acoustic=settings.profile==='acoustic';
      void this.play(sound, source.position, {volume:volume*settings.otherVolume,pitch:.9+Math.random()*.15,
        occluded:acoustic && obstructed(world,this.#listener,source.position),echo:acoustic && this.#indoor});
    }
  }

  #caveMood(world) {
    if (!this.#catalog.sounds[CAVE_MOOD] || !this.#environment.otherVolume || !this.#environment.otherFrequency ||
        this.#environment.profile==='minimal') return;
    const now = this.#context.currentTime;
    this.#nextCave ??= now + Math.floor(Math.random() * 12000) * TICK_SECONDS;
    if (now < this.#nextCave) return;
    this.#nextCave = now + TICK_SECONDS;
    const source = caveMoodSource(world, this.#listener);
    if (!source) return;
    this.#nextCave = now + (6000 + Math.floor(Math.random() * 12000))*TICK_SECONDS/this.#environment.otherFrequency;
    void this.play(CAVE_MOOD, source, {volume:.7*this.#environment.otherVolume,pitch:.8+Math.random()*.2,
      echo:this.#environment.profile==='acoustic'});
  }

  #playMusic() {
    if (this.#altitudeActive || this.#bard?.audible || !this.#musicVolume || this.#muted || this.#music || !globalThis.Audio) return;
    const now = this.#context?.currentTime ?? 0;
    this.#nextMusic ||= now + Math.random() * MUSIC_INTERVAL;
    if (now < this.#nextMusic || [...this.#records.values()].some(({player}) => !player.ended)) return;
    const file = pick(this.#catalog.sounds['music.overworld']);
    if (!SOUND_FILE.test(file ?? '')) return;
    const player = new Audio(ASSETS + file);
    this.#music = player;
    player.volume = this.#musicVolume;
    const finish = () => {
      if (this.#music !== player) return;
      this.#music = undefined;
      this.#nextMusic = this.#context.currentTime + (1 + Math.random()) * MUSIC_INTERVAL;
    };
    player.onended = finish;
    player.play().catch(error=>{ if (error?.name!=='AbortError') finish(); });
  }

  #record(event, position) {
    if (!Array.isArray(position)) return;
    const key = position.join(',');
    this.#records.get(key)?.player.pause();
    this.#records.delete(key);
    const file = pick(this.#catalog?.sounds[event]);
    if (!this.#playing || this.#distance(position) >= 64 || !globalThis.Audio || !SOUND_FILE.test(file ?? '')) return;
    const player = new Audio(ASSETS + file);
    this.#records.set(key, {player, position});
    player.muted = this.#muted;
    player.volume = this.#volume * Math.max(0, 1 - this.#distance(position) / 64);
    const finish = () => {
      if (this.#records.get(key)?.player !== player) return;
      this.#records.delete(key);
      if (!this.#records.size) this.#resumeGroundMusic();
    };
    player.onended = finish;
    if (this.#altitudeActive || this.#bard?.audible) return;
    this.#music?.pause();
    this.#music = undefined;
    this.#nextMusic = (this.#context?.currentTime ?? 0) + MUSIC_INTERVAL;
    player.play().catch(error=>{ if (error?.name!=='AbortError') finish(); });
  }

  stats() {
    const musicMode=this.#bard?.audible ? 'npc' : this.#altitudeActive ? 'altitude' : 'overworld';
    const music = musicMode==='npc' ? this.#bard.player : this.#altitudeActive ? this.#altitudeMusic?.player : this.#music;
    return {loaded: Boolean(this.#catalog), state: this.#context?.state ?? 'disabled', muted: this.#muted,
      requested: this.#requested, played: this.#played, rain:this.#weatherGains,
      musicMode, musicTime: music?.currentTime,
      altitudeMusicConfigured: Boolean(this.#altitudeSource), musicVolume: this.#musicVolume,
      altitudeMusicSource: this.#altitudeMusic?.custom ? 'custom' : this.#altitudeMusic ? 'default' : undefined,
      altitudeMusicError: this.#altitudeMusic?.player.error?.code,
      musicPlaying: Boolean(music && !music.paused && !music.ended &&
        (musicMode!=='altitude' || !this.#altitudeMusic?.gain || this.#context?.state === 'running'))};
  }
}
