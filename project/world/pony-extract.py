"""Capture Mine Little Pony 1.4.7 model geometry for the browser renderer."""

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


WORLD = Path(__file__).resolve().parent
PROJECT = WORLD.parent


def capture(java_home, source, lwjgl):
    def java_bin(name):
        if not java_home:
            return shutil.which(name) or name
        return str(java_home / 'bin' / (name + '.exe' if os.name == 'nt' else name))

    work = PROJECT / 'work'
    work.mkdir(exist_ok=True)
    libraries = [str(source)]
    if lwjgl:
        libraries.append(str(lwjgl))
    with tempfile.TemporaryDirectory(prefix='pony-extract-', dir=work) as out:
        subprocess.run([java_bin('javac'), '-cp', os.pathsep.join(libraries),
                        '-d', out, str(WORLD / 'pony-extract.java')], check=True)
        result = subprocess.run([java_bin('java'), '-cp', os.pathsep.join([out, *libraries]),
                                 'PonyExtract'], check=True, capture_output=True, text=True)

    models = {}
    for line in result.stdout.splitlines():
        kind, name, *fields = line.split('\t')
        if kind == 'model':
            parts = models[name] = {}
            continue
        values = list(map(float, fields if kind == 'part' else [name, *fields]))
        if kind == 'part' and len(values) == 6:
            part = parts[name] = [values, []]
        elif kind == 'quad' and len(values) == 20:
            quad = [int(v) if v.is_integer() else round(v, 8) for v in values]
            if not all(map(math.isfinite, quad)):
                raise ValueError('Invalid vertex in source model')
            part[1].extend(quad)
        else:
            raise ValueError(f'Invalid capture line {line!r}')
    if models.keys() != {'basic', 'advanced', 'armor'} or any('head' not in model for model in models.values()):
        raise ValueError('Expected both pony renderers and the equipment renderer')
    return models


def write_model_data(output, variable, models):
    with output.open('w', encoding='utf-8', newline='\n') as file:
        file.write('// Mine Little Pony 1.4.7 meshes captured by pony-extract.py.\n')
        file.write('// Per part: [x,y,z,rotationX,rotationY,rotationZ], then quad vertices [x,y,z,u,v].\n')
        file.write(f'export const {variable} = {{\n')
        for name, parts in models.items():
            file.write(f'  {name}: {{\n')
            for key, part in parts.items():
                data = json.dumps(part, separators=(',', ':'))
                file.write(f'    "{key}": {data},\n')
            file.write('  },\n')
        file.write('};\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path,
                        default=PROJECT.parent / 'sources' / 'Honeymoon' / 'minecraft.jar')
    parser.add_argument('--java-home', type=Path)
    parser.add_argument('--lwjgl', type=Path)
    args = parser.parse_args()
    models = capture(args.java_home, args.source, args.lwjgl)
    armor = models.pop('armor')
    write_model_data(WORLD / 'pony-model-data.mjs', 'ponyModels', models)
    write_model_data(WORLD / 'pony-armor-data.mjs', 'ponyArmorModel', {'native': armor})


if __name__ == '__main__':
    main()
