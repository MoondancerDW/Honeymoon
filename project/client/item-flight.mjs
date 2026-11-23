import * as THREE from '/vendor/three/three.module.js';

const up=new THREE.Vector3(0,1,0);

export function createItemFlights(scene) {
  const flights=[];
  const shaft=new THREE.CylinderGeometry(.016,.016,.42,6);
  shaft.translate(0,-.17,0);
  const tip=new THREE.ConeGeometry(.035,.11,6);
  tip.translate(0,.055,0);
  const flask=new THREE.SphereGeometry(.085,8,6);
  const wood=new THREE.MeshBasicMaterial({color:0xb09361});
  const steel=new THREE.MeshBasicMaterial({color:0xcbd6df});
  const glass=new THREE.MeshBasicMaterial({color:0x9b75ec});
  const position=new THREE.Vector3(), ending=new THREE.Vector3();

  function add({kind,points}) {
    if (points.length<2) return;
    if (flights.length===24) flights.shift().model.removeFromParent();
    const model=kind==='arrow'?new THREE.Group():new THREE.Mesh(flask,glass);
    if (kind==='arrow') model.add(new THREE.Mesh(shaft,wood),new THREE.Mesh(tip,steel));
    model.position.fromArray(points[0]);
    scene.add(model);
    flights.push({model,points,kind,start:performance.now()});
  }

  function update(now) {
    for (let i=flights.length-1;i>=0;i--) {
      const {model,points,kind,start}=flights[i];
      const end=points.length-1,time=Math.max(0,(now-start)/50);
      if (time>=end+(kind==='arrow'?18:0)) {
        model.removeFromParent();
        flights.splice(i,1);
        continue;
      }
      const segment=Math.min(Math.floor(time),end-1);
      position.fromArray(points[segment]);
      ending.fromArray(points[segment+1]);
      model.position.copy(position).lerp(ending,Math.min(1,time-segment));
      const direction=ending.sub(position);
      if (kind==='arrow'&&direction.lengthSq()>0) model.quaternion.setFromUnitVectors(up,direction.normalize());
    }
  }

  return {add,update};
}
