import { maxSkinBytes, skinSizes } from '../world/pony-skins.mjs';

const sizeLabels = skinSizes.map(size => size.replace('x', '×'));
export const skinDescription = `PNG ${sizeLabels.slice(0, -1).join(', ')} или ${sizeLabels.at(-1)}`;
export const skinTooLarge = `Размер скина превышает ${maxSkinBytes / 1024} КБ`;
const nicknameCharacters = /^[\p{L}\p{M}\p{N}_ -]+$/u;

export class PlayerProfile {
  constructor({nickname, skin, status, clear, label}, notify) {
    this.nickname = nickname;
    this.skin = skin;
    this.status = status;
    this.clear = clear;
    this.label = label;
    this.notify = notify;
    this.skinVersion = 0;
    nickname.title = 'Изменение ника появится в общем чате';
    skin.addEventListener('change', () => this.chooseSkin(skin.files[0]));
    clear.addEventListener('click', () => {
      this.skinVersion++;
      this.pendingSkin = null;
      this.pendingSkinName = '';
      this.reading = false;
      this.skin.value = '';
      this.showSelection();
    });
  }

  initialize(profile) {
    this.confirmed = profile;
    this.nickname.value = profile.nickname;
    this.setSaving(false);
    this.showSelection();
  }

  setSaving(saving) {
    this.nickname.disabled = this.skin.disabled = this.clear.disabled = saving;
  }

  showSelection() {
    const {nickname, skin} = this.confirmed;
    this.label.textContent = nickname;
    this.label.hidden = false;
    if (this.reading) return;
    if (this.pendingSkin === undefined) {
      this.status.textContent = skin ? 'Загружен свой скин' : skinDescription;
      this.clear.hidden = !skin;
    } else {
      this.status.textContent = this.pendingSkinName || 'Выбран стандартный скин';
      this.clear.hidden = !this.pendingSkin;
    }
  }

  async chooseSkin(file) {
    if (!file) return;
    const version = ++this.skinVersion;
    this.reading = true;
    this.status.textContent = 'Проверяем скин…';
    try {
      if (file.size > maxSkinBytes) throw new Error(skinTooLarge);
      if (file.size < 33) throw new Error(skinDescription);
      const bytes = await file.arrayBuffer();
      if (version !== this.skinVersion) return;
      const png = new DataView(bytes);
      const size = `${png.getUint32(16)}x${png.getUint32(20)}`;
      if (png.getUint32(0) !== 0x89504e47 || png.getUint32(4) !== 0x0d0a1a0a ||
          png.getUint32(12) !== 0x49484452 || !skinSizes.includes(size)) throw new Error(skinDescription);
      const chunks = [];
      const pixels = new Uint8Array(bytes);
      for (let offset = 0; offset < pixels.length; offset += 8192) {
        chunks.push(String.fromCharCode(...pixels.subarray(offset, offset + 8192)));
      }
      this.pendingSkin = btoa(chunks.join(''));
      this.pendingSkinName = file.name;
    } catch (error) {
      if (version !== this.skinVersion) return;
      this.skin.value = '';
      this.notify(error.message);
    } finally {
      if (version === this.skinVersion) {
        this.reading = false;
        this.showSelection();
      }
    }
  }

  changes() {
    if (this.reading) throw new Error('Подождите, скин ещё загружается');
    const pending = {};
    const nick = this.nickname.value.trim().normalize('NFC');
    if (!this.confirmed.nicknameChosen || nick !== this.confirmed.nickname) {
      const length = [...nick].length;
      if (length < 2 || length > 24 || !nicknameCharacters.test(nick) || !/[\p{L}\p{N}]/u.test(nick)) {
        this.nickname.focus();
        throw new Error('Ник от 2 до 24 символов. Подойдут буквы, цифры, пробел, тире и подчёркивание');
      }
      pending.nickname = nick;
    }
    if (this.pendingSkin !== undefined) pending.skin = this.pendingSkin;
    return pending;
  }

  saved(profile, changes) {
    this.confirmed = profile;
    this.nickname.value = profile.nickname;
    if (this.pendingSkin === changes.skin) {
      this.pendingSkin = undefined;
      this.skin.value = '';
    }
    this.showSelection();
  }
}
