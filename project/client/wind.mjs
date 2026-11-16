import {foliageAtlasColumns,foliageAtlasRows} from './canopy-card.mjs';

export const foliageDistance = 56;

export function windAt(now, weather = 'clear') {
  const phase = now / 1000;
  const storm=weather==='rain', cloudy=weather==='cloudy'||weather==='snow';
  const frequency=storm ? 2.65 : cloudy ? 1.72 : .75;
  const center=storm ? .65 : cloudy ? .45 : .19;
  const gust=.29*Math.sin(phase*.73*frequency+.35)+.12*Math.sin(phase*1.61*frequency+.85);
  const strength=Math.max(.03,Math.min(1,center+gust*(storm ? 1 : cloudy ? .82 : .4)));
  const direction=.65+.53*Math.sin(phase*.137*frequency)+.19*Math.cos(phase*.309*frequency);
  return {strength,x:Math.cos(direction)*strength,z:Math.sin(direction)*strength,phase};
}

export function attachFoliageWind(material, direction, phase,foliageMap) {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.defaultAttributeValues={...material.defaultAttributeValues,foliageWind:[0],foliageSlot:[0]};
  material.customProgramCacheKey=()=>key+(foliageMap ? ':foliageOrnaments' : ':foliageWind');
  material.onBeforeCompile = function(shader,renderer) {
    compile.call(this,shader,renderer);
    shader.uniforms.foliageDirection = direction;
    shader.uniforms.foliagePhase = phase;
    shader.vertexShader = shader.vertexShader.replace('#include <common>',`#include <common>
      attribute float foliageWind;
      uniform vec2 foliageDirection;
      uniform float foliagePhase;
      ${foliageMap ? 'attribute float foliageSlot; varying float foliageProfile; varying float foliageDepth;' : ''}`).replace('#include <begin_vertex>',`#include <begin_vertex>
      vec3 foliageWorld=(modelMatrix*vec4(position,1.0)).xyz;
      if (foliageWind > 0.0) {
        float ripple = .74 + .26 * sin(foliagePhase * 1.9 + dot(foliageWorld.xz,vec2(.47,.39)));
        transformed.xz += foliageDirection * (.23 / 255.0) * foliageWind * ripple;
      }
      ${foliageMap ? `foliageDepth=distance(cameraPosition,foliageWorld);
        foliageProfile=foliageSlot;` : ''}`);
    if (foliageMap) {
      shader.uniforms.foliageSpriteMap={value:foliageMap};
      shader.fragmentShader='uniform sampler2D foliageSpriteMap; varying float foliageProfile; varying float foliageDepth;\n'+
        shader.fragmentShader.replace('diffuseColor *= terrainSample(map, floor(atlasPosition), fract(atlasPosition), terrainFootprint(atlasPosition));',`
          vec2 foliageGrid=vec2(${foliageAtlasColumns}.0,${foliageAtlasRows}.0);
          vec2 spriteDx=dFdx(atlasPosition)*.5/foliageGrid;
          vec2 spriteDy=dFdy(atlasPosition)*.5/foliageGrid;
          if (foliageProfile>.5) {
            float slot=floor(foliageProfile+.5)-1.0;
            vec2 cell=vec2(mod(slot,foliageGrid.x),foliageGrid.y-1.0-floor(slot/foliageGrid.x));
            vec2 spriteUv=(cell+.25+fract(atlasPosition)*.5)/foliageGrid;
            diffuseColor *= textureGrad(foliageSpriteMap,spriteUv,spriteDx,spriteDy);
          } else {
            diffuseColor *= terrainSample(map,floor(atlasPosition),fract(atlasPosition),terrainFootprint(atlasPosition));
          }
        `).replace('#include <alphatest_fragment>',`
          diffuseColor.a*=1.0-smoothstep(36.0,${foliageDistance}.0,foliageDepth);
          #include <alphatest_fragment>
        `);
    }
  };
}
