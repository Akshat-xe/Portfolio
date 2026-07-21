// Procedural vehicle mesh. No glTF, no external asset fetch — the whole car is
// primitives with a few vertices nudged for taper. Local axes match the solver:
// +Z forward, +X right, +Y up.

import * as THREE from 'three';

const _v = new THREE.Vector3();

function taperedBody() {
  const g = new THREE.BoxGeometry(1.86, 0.66, 4.35, 3, 2, 6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = z / 2.175;               // -1 rear .. +1 front
    x *= 1 - Math.max(0, t) * 0.16 - Math.max(0, -t) * 0.06;
    if (y > 0) y -= Math.max(0, t) * 0.12;
    y += Math.abs(x) > 0.8 ? -0.03 : 0;
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function cabin() {
  const g = new THREE.BoxGeometry(1.5, 0.56, 2.05, 2, 2, 3);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y > 0) { x *= 0.74; z *= 0.78; }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export class CarModel {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    scene.add(this.group);

    this.paint = new THREE.MeshStandardMaterial({
      color: 0xc2222c, metalness: 0.45, roughness: 0.33,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x101820, metalness: 0.8, roughness: 0.12,
      transparent: true, opacity: 0.82,
    });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.3, roughness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.92 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, metalness: 0.9, roughness: 0.28 });

    this.headMat = new THREE.MeshStandardMaterial({
      color: 0xfff3d0, emissive: 0xfff0c8, emissiveIntensity: 2.2,
    });
    this.tailMat = new THREE.MeshStandardMaterial({
      color: 0x6a0d12, emissive: 0xff1a22, emissiveIntensity: 0.6,
    });

    this.body = new THREE.Group();
    this.group.add(this.body);

    const shell = new THREE.Mesh(taperedBody(), this.paint);
    shell.position.y = 0.60;
    shell.castShadow = true;
    this.body.add(shell);

    const roof = new THREE.Mesh(cabin(), glass);
    roof.position.set(0, 1.06, -0.22);
    roof.castShadow = true;
    this.body.add(roof);

    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.09, 0.5), trim);
    splitter.position.set(0, 0.33, 2.14);
    this.body.add(splitter);

    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.42), trim);
    diffuser.position.set(0, 0.34, -2.06);
    this.body.add(diffuser);

    const wingBlade = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.06, 0.34), trim);
    wingBlade.position.set(0, 1.10, -2.02);
    wingBlade.rotation.x = 0.12;
    wingBlade.castShadow = true;
    this.body.add(wingBlade);
    for (const sx of [-0.62, 0.62]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.28, 0.1), trim);
      stay.position.set(sx, 0.96, -2.0);
      this.body.add(stay);
    }

    for (const sx of [-0.98, 0.98]) {
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.12), trim);
      mirror.position.set(sx, 0.98, 0.55);
      this.body.add(mirror);
    }

    for (const sx of [-0.6, 0.6]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.13, 0.08), this.headMat);
      hl.position.set(sx, 0.72, 2.15);
      this.body.add(hl);

      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.07), this.tailMat);
      tl.position.set(sx, 0.78, -2.16);
      this.body.add(tl);
    }

    // Wheels ---------------------------------------------------------------
    const tyre = new THREE.CylinderGeometry(0.335, 0.335, 0.27, 18, 1);
    tyre.rotateZ(Math.PI / 2);
    const disc = new THREE.CylinderGeometry(0.225, 0.225, 0.29, 14, 1);
    disc.rotateZ(Math.PI / 2);

    this.wheels = [];
    this.hubs = [];
    for (let i = 0; i < 4; i++) {
      const hub = new THREE.Group();          // steering
      const spin = new THREE.Group();         // rolling
      const t = new THREE.Mesh(tyre, rubber);
      const d = new THREE.Mesh(disc, rim);
      t.castShadow = true;
      spin.add(t, d);
      hub.add(spin);
      this.group.add(hub);
      this.hubs.push(hub);
      this.wheels.push(spin);
    }

    // Headlamp beams. Intensity is luminous intensity in candela and falls off
    // with 1/d^2, so the useful number here is in the thousands, not the tens.
    this.beams = [];
    for (const sx of [-0.6, 0.6]) {
      const spot = new THREE.SpotLight(0xfff0cc, 0, 110, 0.44, 0.5, 2);
      spot.position.set(sx, 0.72, 2.1);
      spot.target.position.set(sx * 0.5, -0.4, 30);
      this.body.add(spot);
      this.body.add(spot.target);
      this.beams.push(spot);
    }
    this.headlightsOn = false;
  }

  setColor(hex) { this.paint.color.setHex(hex); }

  setHeadlights(on, intensity = 3400) {
    this.headlightsOn = on;
    for (const b of this.beams) b.intensity = on ? intensity : 0;
    this.headMat.emissiveIntensity = on ? 3.4 : 1.0;
  }

  setShadows(on) {
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = on; });
  }

  update(vehicle, input) {
    this.group.position.set(vehicle.px, vehicle.py - vehicle.restLength, vehicle.pz);
    this.group.rotation.set(0, vehicle.yaw, 0);

    this.body.rotation.x = vehicle.pitch;
    this.body.rotation.z = vehicle.roll;

    // Hub offsets are derived analytically from the solver's local wheel
    // coordinates. Going through worldToLocal would allocate and would read a
    // matrixWorld that three.js has not refreshed yet this frame.
    for (let i = 0; i < 4; i++) {
      const lx = vehicle.wheelLocal[i][0];
      const lz = vehicle.wheelLocal[i][1];
      const hub = this.hubs[i];
      hub.position.set(lx, -vehicle.pitch * lz + vehicle.roll * lx + vehicle.compression[i], lz);
      hub.rotation.y = i < 2 ? vehicle.steer : 0;
      this.wheels[i].rotation.x = vehicle.wheelSpin[i];
    }
    void _v;

    const braking = input.brake > 0.05 || input.handbrake;
    this.tailMat.emissiveIntensity += ((braking ? 3.6 : 0.55) - this.tailMat.emissiveIntensity) * 0.35;
  }
}
