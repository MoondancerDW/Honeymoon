// Custom NPCs 1.4.7 uses constructor ID 26724 and Minecraft adds 256 to item IDs.
export const NPC_EDITOR_WAND_ID=26980;
export const NPC_EDITOR_WAND_KEY=`creative:${NPC_EDITOR_WAND_ID}:0`;

export const isNpcEditorWand=stack=>stack?.key===NPC_EDITOR_WAND_KEY;

export function npcNameVisible(npc,revealHidden=false) {
  return Boolean(npc && (revealHidden || npc.showName!==false || npc.showNameWhenAttacking===true && npc.animation==='attack'));
}
