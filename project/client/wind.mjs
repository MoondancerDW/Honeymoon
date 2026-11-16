export function windAt(now, weather = 'clear') {
  const phase = now / 1000;
  const storm=weather==='rain', cloudy=weather==='cloudy';
  const frequency=storm ? 2.65 : cloudy ? 1.72 : .75;
  const center=storm ? .65 : cloudy ? .45 : .19;
  const gust=.29*Math.sin(phase*.73*frequency+.35)+.12*Math.sin(phase*1.61*frequency+.85);
  const strength=Math.max(.03,Math.min(1,center+gust*(storm ? 1 : cloudy ? .82 : .4)));
  const direction=.65+.53*Math.sin(phase*.137*frequency)+.19*Math.cos(phase*.309*frequency);
  return {strength,x:Math.cos(direction)*strength,z:Math.sin(direction)*strength,phase};
}

export function attachFoliageWind(material, direction, phase,canopyMap) {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.defaultAttributeValues={...material.defaultAttributeValues,foliageWind:[0],foliageLeaf:[0]};
  material.customProgramCacheKey=()=>key+(canopyMap ? ':foliageOrnaments' : ':foliageWind');
  material.onBeforeCompile = function(shader,renderer) {
    compile.call(this,shader,renderer);
    shader.uniforms.foliageDirection = direction;
    shader.uniforms.foliagePhase = phase;
    shader.vertexShader = shader.vertexShader.replace('#include <common>',`#include <common>
      attribute float foliageWind;
      uniform vec2 foliageDirection;
      uniform float foliagePhase;
      ${canopyMap ? 'attribute float foliageLeaf; varying float leafProfile; varying float leafDistance;' : ''}`).replace('#include <begin_vertex>',`#include <begin_vertex>
      vec3 foliageWorld=(modelMatrix*vec4(position,1.0)).xyz;
      if (foliageWind > 0.0) {
        float ripple = .74 + .26 * sin(foliagePhase * 1.9 + dot(foliageWorld.xz,vec2(.47,.39)));
        transformed.xz += foliageDirection * (.23 / 255.0) * foliageWind * ripple;
      }
      ${canopyMap ? `leafDistance=distance(cameraPosition,foliageWorld);
        leafProfile=foliageLeaf;` : ''}`);
    if (canopyMap) {
      shader.uniforms.foliageCanopyMap={value:canopyMap};
      shader.fragmentShader='uniform sampler2D foliageCanopyMap; varying float leafProfile; varying float leafDistance;\n'+
        shader.fragmentShader.replace('vec3 shade = vColor.rgb;',`
          if (leafProfile>.5) {
            vec2 crown=fract(vMapUv*vec2(64.0,terrainRows));
            diffuseColor=texture2D(foliageCanopyMap,crown);
          }
          vec3 shade = vColor.rgb;
        `).replace('#include <alphatest_fragment>',`
          diffuseColor.a*=1.0-smoothstep(36.0,59.0,leafDistance);
          #include <alphatest_fragment>
        `);
    }
  };
}
