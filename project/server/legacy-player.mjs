import {rawContainerStack} from './containers.mjs';

const moduleName='legacy-player';
const validUid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validStack=stack=>stack===null || stack && typeof stack.key==='string' && stack.key.length>0 &&
  stack.key.length<=128 && Number.isInteger(stack.count) && stack.count>=1 && stack.count<=127;
const validSlots=(slots,size)=>Array.isArray(slots) && slots.length===size && slots.every(validStack);

export function normalizeLegacyPlayerName(name) {
  if (typeof name!=='string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null;
  const trimmed=name.trim();
  if (!trimmed || trimmed.length>48) return null;
  return trimmed.normalize('NFKC').trim().toLowerCase() || null;
}

function importedPlayer(store,name) {
  const normalized=normalizeLegacyPlayerName(name);
  return normalized?store.getState(moduleName,normalized,'import')?.value:undefined;
}

export const hasLegacyPlayer=(store,name)=>Boolean(importedPlayer(store,name));

// Caller holds the enrollment transaction, including invitation redemption or owner election.
export function claimLegacyPlayer(store,name,hasAccount,at) {
  const imported=importedPlayer(store,name);
  if (!imported) return;
  const {uid,inventory,enderItems}=imported;
  if (typeof uid!=='string' || !validUid.test(uid) || !validSlots(inventory?.slots,36) ||
      !validSlots(inventory?.equipment,4) || !Number.isInteger(inventory.selected) ||
      inventory.selected<0 || inventory.selected>=9 || !validSlots(enderItems,27)) return;
  if (store.getState(moduleName,uid,'claim') || hasAccount(uid) ||
      store.getState('inventory',uid,'slots') || store.getState('container',uid,'ender')) return;

  store.createPlayer(uid);
  store.putState('inventory',uid,'slots',2,inventory);
  const ender=enderItems.flatMap((stack,slot)=>stack?[rawContainerStack(stack,slot)]:[]);
  if (ender.length) store.putState('container',uid,'ender',1,{items:ender,revision:1});
  store.putState(moduleName,uid,'claim',1,{uid,at});
  return uid;
}
