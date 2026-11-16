"""Extract original 1.4.7 mob geometry, pose clips and texture resources for Honeymoon."""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path

WORLD = Path(__file__).resolve().parent
EXTRACTOR = WORLD / 'npc-extractor'
NPC_SPEC = [
    ('npcpony', 'Пони', 'ModelPony', '0', 'NPCPony', 'bpony_0.png'),
    ('npchumanmale', 'Человек', 'ModelNPCMale', '0', 'NPCHumanMale', 'humanmale/Steve.png'),
    ('npchumanfemale', 'Человек (женская модель)', 'ModelNPCFemale', '0', 'NPCHumanFemale', 'humanfemale/'),
    ('npcvillager', 'Житель', 'axr', '0', 'NPCVillager', 'villager/villager.png'),
    ('npcdwarfmale', 'Гном', 'ModelDwarfMale', '0', 'NPCDwarfMale', 'dwarfmale/Dwarf.png'),
    ('npcdwarffemale', 'Гном (женская модель)', 'ModelDwarfFemale', '0', 'NPCDwarfFemale', 'dwarffemale/BlondDwarf.png'),
    ('npcfurrymale', 'Фурри', 'ModelFurryMale', '64,64,0', 'NPCFurryMale', 'furrymale/WolfGrey.png'),
    ('npcfurryfemale', 'Фурри (женская модель)', 'ModelFurryFemale', '64,64,0', 'NPCFurryFemale', 'furryfemale/WolfLightGrey.png'),
    ('npczombiemale', 'Монстр', 'ModelZombieMale', '0', 'NpcMonsterMale', 'monstermale/SandMonster.png'),
    ('npczombiefemale', 'Монстр (женская модель)', 'ModelZombieFemale', '0', 'NpcMonsterFemale', 'monsterfemale/'),
    ('npcskeleton', 'Скелет', 'ModelNpcSkeleton', '0', 'NpcSkeleton', 'skeleton.png'),
    ('npcorcfmale', 'Орк', 'ModelOrcMale', '0', 'NPCOrcMale', 'orcmale/'),
    ('npcorcfemale', 'Орк (женская модель)', 'ModelOrcFemale', '0', 'NPCOrcFemale', 'orcfemale/'),
    ('npcelfmale', 'Эльф', 'ModelElfMale', '0', 'NPCElfMale', 'elfmale/'),
    ('npcelffemale', 'Эльф (женская модель)', 'ModelElfFemale', '0', 'NPCElfFemale', 'elffemale/'),
    ('npccrystal', 'Кристалл', 'ModelNpcCrystal', '0', 'NpcCrystal', 'crystal/NatureCrystalFloating.png'),
    ('npcenderchibi', 'Малый странник Края', 'ModelEnderChibi', '0', 'NpcEnderchibi', 'enderchibi/'),
    ('npcnagamale', 'Нага', 'ModelNagaMale', '64,64,0', 'NpcNagaMale', 'nagamale/Naga Blue.png'),
    ('npcnagafemale', 'Нага (женская модель)', 'ModelNagaFemale', '64,64,0', 'NpcNagaFemale', 'nagafemale/'),
    ('NpcSlime', 'Слизень', 'ModelNpcSlime', '16', 'NpcSlime', 'slime.png'),
    ('NpcDragon', 'Дракон', 'ModelNpcDragon', '0', 'NpcDragon', 'dragon/RedDragon.png'),
]
VANILLA_SPEC = [
    ('Spider','Паук','axo','','qp','spider.png'),
    ('CaveSpider','Пещерный паук','axo','','qb','cavespider.png'),
    ('Pig','Свинья','axc','','pd','pig.png'),
    ('Sheep','Овца','axg','','pe','sheep.png'),
    ('Cow','Корова','aws','','oz','cow.png'),
    ('MushroomCow','Грибная корова','aws','','pb','redcow.png'),
    ('Wolf','Волк','axw','','pk','wolf.png'),
    ('Chicken','Курица','awr','','oy','chicken.png'),
    ('Ozelot','Оцелот','axb','','pc','ozelot.png'),
    ('Silverfish','Чешуйница','axi','','qm','silverfish.png'),
    ('Creeper','Крипер','awt','0','qc','creeper.png'),
    ('Enderman','Странник Края','awu','','qd','enderman.png'),
    ('SnowMan','Снежный голем','axn','','pg','snowman.png'),
    ('Skeleton','Скелет','axk','','qn','skeleton.png'),
    ('WitherSkeleton','Визер-скелет','axk','','qn','skeleton_wither.png'),
    ('Witch','Ведьма','axu','0','qq','villager/witch.png'),
    ('Blaze','Ифрит','awn','','qa','fire.png'),
    ('Zombie','Зомби','axx','','qr','zombie.png'),
    ('ZombieVillager','Житель-зомби','axt','','qr','zombie_villager.png'),
    ('Slime','Слизень','axm','16','qo','slime.png'),
    ('LavaSlime','Магмовый куб','awy','','qi','lava.png'),
    ('PigZombie','Зомби-свинья','axx','','qh','pigzombie.png'),
    ('Ghast','Гаст','awv','','qg','ghast.png'),
    ('Squid','Спрут','axp','','ph','squid.png'),
    ('Villager','Житель','axr','0','qu','villager/villager.png'),
    ('VillagerGolem','Железный голем','axs','0','pi','villager_golem.png'),
    ('Giant','Гигант','aww','0','md','zombie.png'),
    ('Bat','Летучая мышь','awm','','ow','bat.png'),
    ('EnderDragon','Дракон Края','axy','0','pp','enderdragon/ender.png'),
    ('WitherBoss','Иссушитель','axv','','pr','wither.png'),
]

MOC_NAMES = {
    'BigCat1':'BigCat','BigCat2':'BigCat','NewHorse':'Horse','NewHorseMob':'HorseMob',
    'Ogre1':'Ogre','Ogre2':'Ogre','Were':'Werewolf','WereHuman':'Werewolf','Wolf':'WWolf',
}
TF_NAMES = {'Ghast':'TowerGhast','LichMinion':'LichMinion','SwarmSpider':'SwarmSpider'}
MOC_SKINS = {
    'Bear':'bearblack','Bee':'bee','BigCat1':'lionb','BigCat2':'tiger','Bird':'bird',
    'Dolphin':'dolphin','Fishy':'fishy','NewHorse':'horsebrown','NewHorseMob':'horsebrown',
    'Were':'werewolf','WereHuman':'werehuman','Wolf':'wolf','Ogre1':'ogre','Ogre2':'ogre',
}
TF_SKINS = {'Ghast':'towerghast','TinyBird':'tinybird','Bunny':'bunnybrown','QuestRam':'questram',
            'HydraNeck':'hydra4','HydraHead':'hydra4','BighornFur':'bighorn','LichMinion':'twilightlich64'}
MOC_EXCLUDED = {'Egg','FishBowl','KittyBed','KittyBed2','LitterBox'}
TF_EXCLUDED = {'Cicada','Firefly','Moonworm','HydraMortar','TinyFirefly'}

def identify_skin(preferred, paths):
    match = next((p for p in paths if p.casefold() == preferred.casefold()), None)
    if match:
        return match
    if preferred.endswith('/'):
        match = next((p for p in paths if p.casefold().startswith(preferred.casefold())), None)
        if match:
            return match
    directory, filename = preferred.rsplit('/', 1)
    stem = filename.removesuffix('.png').casefold()
    matches = [p for p in paths if p.casefold().startswith(directory.casefold() + '/')
               and p.rsplit('/',1)[-1].casefold().startswith(stem)]
    return min(matches,key=len,default=None)

def source_texture(entry):
    file = entry.strip('/')
    return file.lower().endswith('.png') and (
        file.startswith('mob/') or
        file == 'item/book.png' or
        file.startswith('mods/mocreatures/textures/mob/') or
        file.startswith('mods/mocreatures/textures/models/') or
        file.startswith('mods/mocreatures/textures/entity/') or
        file.startswith('twilightforest/') and '/' not in file.removeprefix('twilightforest/'))

def specifications(archives, skinpaths):
    for id, label, model, args, entity, tex in NPC_SPEC:
        model = 'noppes.npcs.entity.model.'+model if model.startswith('Model') else model
        yield [id, label, 'Custom NPCs', model, args, 'noppes.npcs.entity.Entity'+entity, '/mob/'+tex]
    for id, label, model, args, entity, tex in VANILLA_SPEC:
        yield [id, label, 'Minecraft 1.4.7', model, args, entity, '/mob/'+tex]
    for package, key, pattern, excluded, names, defaults, textures in (
        ('Mo’ Creatures', 'MoC', r'drzhark/mocreatures/client/model/MoCModel(\w+)\.class', MOC_EXCLUDED,
            MOC_NAMES, MOC_SKINS, '/mods/mocreatures/textures/models/'),
        ('Twilight Forest', 'TF', r'twilightforest/client/model/ModelTF(\w+)\.class', TF_EXCLUDED,
            TF_NAMES, TF_SKINS, '/twilightforest/')):
        source = archives[key]
        entries = source.namelist()
        for file in entries:
            match = re.fullmatch(pattern, file)
            if not match or match[1] in excluded:
                continue
            model = match[1]
            cls = ('MoCEntity' if key == 'MoC' else 'EntityTF') + names.get(model, model) + '.class'
            entity = next((p.removesuffix('.class').replace('/','.') for p in entries if p.endswith('/'+cls)), '')
            if not entity and model not in {'BighornFur','WereHuman','HydraNeck','HydraHead'}:
                continue
            stem = defaults.get(model, model.lower())
            texture = identify_skin(textures+stem+'.png',skinpaths)
            if not texture:
                # Read the original model's entity texture basename how the native package stores it.
                source_entity = entity.replace('.','/')+'.class'
                strings = re.findall(rb'[A-Za-z0-9_/]+\.png',source.read(source_entity)) if entity else []
                texture = next((hit for t in strings
                                if (hit:=identify_skin('/'+t.decode().lstrip('/'),skinpaths))), None)
            if key == 'MoC' and texture is None:
                texture = identify_skin('/mods/mocreatures/textures/entity/'+stem+'.png',skinpaths)
            if texture is None:
                texture = '/mob/char.png'
            label = re.sub(r'(?<=[a-z])(?=[A-Z0-9])',' ',model)
            yield [key+model,label,package,file.removesuffix('.class').replace('/','.'),'?',entity,texture]

def read_capture(capture):
    result = {}
    for line in capture.splitlines():
        token,*fields = line.split('\t')
        if token=='model':
            model=result[fields[0]]={'capture':fields[1], 'meshes':[], 'clips':{}}
        elif token=='frame':
            frame=[]
            model['clips'].setdefault(fields[0],[]).append(frame)
        elif token=='part':
            frame.append([int(fields[0]), *map(float,fields[1:])])
        elif token=='mesh':
            geometry=[]
            model['meshes'].append([fields[1], geometry])
        elif token=='quad':
            geometry.extend(map(float,fields))
    return {key:data for key,data in result.items() if data['meshes'] and data['clips'].get('idle')}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--java-home', required=True,type=Path)
    parser.add_argument('--runtime-java',type=Path)
    parser.add_argument('--work', required=True,type=Path)
    args=parser.parse_args()
    args.work.mkdir(parents=True,exist_ok=True)
    args.output.mkdir(parents=True,exist_ok=True)
    mods=args.source/'mods'
    sourcefiles={
        'vanilla':args.source/'minecraft.jar',
        'npc':next(mods.glob('CustomNPCs*.zip')),
        'TF':next(mods.glob('twilightforest*.jar')),
        'MoC':next(mods.glob('DrZharks MoCreatures*.zip')),
        'texturepack':next((args.source/'texturepacks').glob('My-Little-Ponyach*.zip')),
    }
    archives={key:zipfile.ZipFile(value) for key,value in sourcefiles.items()}
    textures={}
    for key,archive in archives.items():
        for entry in archive.namelist():
            if source_texture(entry):
                textures['/'+entry.lstrip('/').replace('\\','/')]=(archive,entry)
    skinpaths=sorted(textures)
    specs=list(specifications(archives,skinpaths))
    spec_file=args.work/'models.tsv'
    spec_file.write_text('\n'.join('\t'.join((id,model,ctor,entity))
                        for id,_,_,model,ctor,entity,_ in specs),encoding='utf-8')
    library=[*sourcefiles.values(),*(args.source/'libraries').rglob('*.jar')]
    executable=lambda name: str(args.java_home/'bin'/(name+('.exe' if os.name=='nt' else '')))
    logfile=args.work/'capture.log'
    with logfile.open('w',encoding='utf-8') as log:
        build=[executable('javac'),'--release','8','-encoding','UTF-8','-cp',os.pathsep.join(map(str,library)),'-d',str(args.work),
                *map(str,EXTRACTOR.rglob('*.java'))]
        subprocess.run(build,check=True,stdout=log,stderr=log)
        outcome=subprocess.run([str(args.runtime_java or executable('java')),'-cp',os.pathsep.join(map(str,[args.work,*library])),
                                'NpcModelCapture',str(spec_file)],check=True,capture_output=True,text=True,encoding='utf-8')
        log.write(outcome.stderr)
    models=read_capture(outcome.stdout)
    for file,(archive,entry) in textures.items():
        destination=args.output/'skins'/file.lstrip('/')
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_bytes(archive.read(entry))
    catalog=[]
    for id,label,category,_,_,_,texture in specs:
        data=models.get(id)
        if not data:
            continue
        default=identify_skin(texture,skinpaths) or '/mob/char.png'
        (args.output/(id+'.json')).write_text(json.dumps(data,separators=(',',':')),encoding='utf-8')
        catalog.append({'id':id,'label':label,'category':category,'defaultTexture':default,'capture':data['capture']})
    manifest={'catalog':catalog,'textures':skinpaths}
    (args.output/'models.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    (args.work/'report.json').write_text(json.dumps({'models':len(models),'skins':len(textures),
        'missing':[model[0] for model in specs if model[0] not in models]},indent=2),encoding='utf-8')
    for archive in archives.values():
        archive.close()

if __name__=='__main__':
    main()
