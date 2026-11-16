export function windAt(now, weather = 'clear') {
  const phase = now / 1000;
  const wave = .52 + .27 * Math.sin(phase*.73+.35) + .13 * Math.sin(phase*1.61+.85);
  const weatherScale = weather === 'rain' ? 1.08 : weather === 'cloudy' ? .91 : .68;
  const strength = Math.max(0,Math.min(1,wave*weatherScale));
  const direction = .65 + .46 * Math.sin(phase*.137) + .17 * Math.cos(phase*.309);
  return {strength,x:Math.cos(direction)*strength,z:Math.sin(direction)*strength,phase};
}

export function attachFoliageWind(material, direction, phase) {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.defaultAttributeValues = {...material.defaultAttributeValues,foliageWind:[0]};
  material.customProgramCacheKey = () => key + ':foliageWind';
  material.onBeforeCompile = function(shader,renderer) {
    compile.call(this,shader,renderer);
    shader.uniforms.foliageDirection = direction;
    shader.uniforms.foliagePhase = phase;
    shader.vertexShader = shader.vertexShader.replace('#include <common>',`#include <common>
      attribute float foliageWind;
      uniform vec2 foliageDirection;
      uniform float foliagePhase;`).replace('#include <begin_vertex>',`#include <begin_vertex>
      if (foliageWind > 0.0) {
        vec3 foliageWorld = (modelMatrix * vec4(position,1.0)).xyz;
        float ripple = .74 + .26 * sin(foliagePhase * 1.9 + dot(foliageWorld.xz,vec2(.47,.39)));
        transformed.xz += foliageDirection * (.23 / 255.0) * foliageWind * ripple;
      }`);
  };
}
