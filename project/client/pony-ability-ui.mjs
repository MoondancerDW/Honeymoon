import {JUMP_CHARGE_LIMIT,ponyAbilities} from '../world/pony-abilities.mjs';

export const raceLabels = Object.freeze({earth:'Земной пони',pegasus:'Пегас',unicorn:'Единорог',alicorn:'Аликорн'});
const sizeLabels = {small:'низкий',normal:'обычный',tall:'высокий',large:'крупный'};

export function createPonyAbilityUi(element) {
  const hud = element('pony-abilities');
  const charges = element('jump-charge-status');
  const magic = element('magic-cooldown-status');
  const magicButton = element('touch-magic');
  const label = element('pony-traits-label');
  const dots=Array.from({length:JUMP_CHARGE_LIMIT},()=>{
    const dot=document.createElement('span');
    dot.className='jump-charge-dot';
    dot.setAttribute('aria-hidden','true');
    return dot;
  });
  charges.setAttribute('role','img');
  charges.append(...dots);
  let replenishes = [];
  let magicReadyAt = 0;
  let nextPaint = 0;

  function sync({jumpCharge,magicCooldownMs} = {}) {
    const now = performance.now();
    if (Array.isArray(jumpCharge?.readyInMs)) {
      replenishes = jumpCharge.readyInMs.filter(Number.isFinite).map(ms=>now+Math.max(0,ms)).sort((a,b)=>a-b);
    }
    if (Number.isFinite(magicCooldownMs)) magicReadyAt = now + Math.max(0,magicCooldownMs);
    nextPaint = 0;
  }

  const chargeCount = now => Math.max(0,JUMP_CHARGE_LIMIT-replenishes.filter(at=>at>now).length);
  const cooldown = now => Math.max(0,Math.ceil((magicReadyAt-now)/1000));
  function paint(now) {
    if (now<nextPaint) return;
    nextPaint = now+100;
    const count = chargeCount(now);
    const next = replenishes.find(at=>at>now);
    const seconds = cooldown(now);
    const jumpText = `Прыжок ${count}/${JUMP_CHARGE_LIMIT}${next ? ` · ${Math.ceil((next-now)/1000)} с` : ''}`;
    const magicText = seconds ? `Телепорт · ${seconds} с` : 'Телепорт готов';
    if (charges.getAttribute('aria-label')!==jumpText) {
      charges.setAttribute('aria-label',jumpText);
      dots.forEach((dot,index)=>dot.classList.toggle('ready',index<count));
    }
    if (magic.textContent!==magicText) magic.textContent=magicText;
    magicButton.toggleAttribute('data-cooldown',seconds>0);
    magicButton.title = magicText;
  }

  return {sync,paint,chargeCount,cooldown,
    setTraits(type,size) {
      const race = ponyAbilities(type);
      label.textContent=`${raceLabels[type] ?? raceLabels.earth} · рост ${sizeLabels[size] ?? sizeLabels.normal}`;
      label.hidden=false;
      hud.hidden=!race.chargedJump&&!race.horn;
      charges.hidden=!race.chargedJump;
      magic.hidden=!race.horn;
      magicButton.hidden=!race.horn;
      nextPaint=0;
    },
  };
}
