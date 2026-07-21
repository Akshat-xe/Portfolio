// Custom kinematic vehicle solver.
//
// No Ammo/Rapier/Havok — no WASM heap, no cross-boundary marshalling, no GC
// spikes from a foreign allocator, and no generic rigid-body broadphase paying
// for collisions this game never needs.
//
// Structure:
//   * four independent downward raycasts against the heightfield FUNCTION (not
//     triangle soup), each a damped spring:  F = -k*x - c*v
//   * chassis pitch/roll from the normal of the plane through the four contact
//     points — no quaternion integration, no angular-momentum solver
//   * per-wheel angular velocity, so longitudinal force comes from a real slip
//     ratio K = (wR - u)/u and the car can spin up or lock a wheel
//   * a simplified Pacejka saturation curve on both axes, combined through a
//     friction ellipse
//   * a dual-vector momentum model layered on top for controllable drifts
//   * barriers as a 1D lateral test against the road midline, no collision mesh
//
// Integration is a fixed substep, decoupled from the render framerate. The
// whole update runs on module-scope scratch state: zero allocation per frame.

import { WATER_LEVEL } from '../world/heightfield.js';

const GRAVITY = 9.81;
const SUBSTEP = 1 / 180;

export const SURFACE = {
  ROAD:   { grip: 1.00, roll: 0.014, rumble: 0.000 },
  VERGE:  { grip: 0.78, roll: 0.030, rumble: 0.035 },
  DIRT:   { grip: 0.62, roll: 0.055, rumble: 0.075 },
  WATER:  { grip: 0.32, roll: 0.180, rumble: 0.020 },
};

const GEARS = [-3.30, 0, 3.55, 2.16, 1.52, 1.16, 0.94, 0.78];
const FINAL_DRIVE = 3.7;
const IDLE_RPM = 850;
const REDLINE = 7400;

// Wheel index order: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
const FL = 0, FR = 1, RL = 2, RR = 3;

// Scratch — reused every substep, never reallocated.
const _wx = new Float64Array(4);   // wheel world X
const _wz = new Float64Array(4);   // wheel world Z
const _cy = new Float64Array(4);   // contact point Y (ground under the wheel)
const _load = new Float64Array(4); // strut force, N (vertical body force)
const _fz = new Float64Array(4);   // tyre normal load, N (load-transfer model)
const _comp = new Float64Array(4); // spring displacement x, m
const _sat = new Float64Array(4);  // friction-ellipse saturation, 0..1
const _fx = new Float64Array(4);   // longitudinal tyre force, wheel frame
const _nrm = [0, 0, 0];
const _plane = [0, 1, 0];

export class Vehicle {
  constructor(heightfield, road) {
    this.hf = heightfield;
    this.road = road;

    // --- chassis ---------------------------------------------------------
    this.mass = 1320;
    this.wheelbase = 2.62;
    this.track = 1.58;
    this.cgHeight = 0.50;
    this.cgToFront = 1.18;
    this.cgToRear = this.wheelbase - this.cgToFront;
    this.izz = this.mass * 1.75;
    this.frontalArea = 2.05;
    this.dragCoeff = 0.31;
    this.downforceCoeff = 0.55;

    // --- suspension (Hooke) ----------------------------------------------
    this.wheelRadius = 0.335;
    this.restLength = 0.40;
    this.maxTravel = 0.26;
    this.springK = 42000;      // k, N/m
    this.damperC = 4300;       // c, N/(m/s)

    // --- tyres (simplified Pacejka) --------------------------------------
    this.peakMu = 1.35;        // D
    this.longB = 10.0;
    this.longC = 1.66;
    this.latB = 8.6;
    this.latC = 1.52;
    this.relaxLength = 0.55;   // slip-ratio relaxation length, m
    this.gripScale = 1;

    // --- drivetrain -------------------------------------------------------
    this.wheelInertia = 1.4;   // kg m^2 per corner
    this.brakeTorque = [2000, 2000, 1300, 1300];
    this.handbrakeTorque = 2400;
    this.driveSplit = [0.175, 0.175, 0.325, 0.325]; // rear-biased AWD, sums to 1

    this.wheelLocal = [
      [-this.track / 2, this.cgToFront],
      [this.track / 2, this.cgToFront],
      [-this.track / 2, -this.cgToRear],
      [this.track / 2, -this.cgToRear],
    ];

    // --- state -----------------------------------------------------------
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0;
    this.yawRate = 0;
    this.roll = 0;
    this.pitch = 0;
    this.steer = 0;
    this.gear = 2;
    this.rpm = IDLE_RPM;
    this.grounded = true;
    this.airtime = 0;

    this.wheelOmega = [0, 0, 0, 0];
    this.slipRatio = [0, 0, 0, 0];
    this.slipAngle = [0, 0, 0, 0];
    this.compression = [0, 0, 0, 0];
    this.wheelSpin = [0, 0, 0, 0];

    // Dual-vector momentum state.
    this.momentumX = 0;
    this.momentumZ = 1;
    this.driftAngle = 0;       // signed, radians; + = trajectory right of nose
    this.turnRadius = Infinity;
    this.driftAssist = 0.55;

    // Per-tyre telemetry, filled in place each substep (never reallocated).
    this.tyre = [];
    for (let i = 0; i < 4; i++) {
      this.tyre.push({ fz: 0, mu: 0, fLong: 0, fLat: 0, sat: 0, contact: 0 });
    }

    this.slipAmount = 0;
    this.wheelspin = 0;
    this.surface = SURFACE.ROAD;
    this.roadS = 0;
    this.roadLat = 0;
    this.offRoad = false;
    this.odometer = 0;
    this.assists = true;
    this.barriersEnabled = true;
    this.barrierContact = 0;

    this._shiftCooldown = 0;
    this._prevComp = [0, 0, 0, 0];
    // Last substep's body accelerations, used for load transfer. A one-step
    // lag is standard and avoids an implicit solve.
    this._aFwd = 0;
    this._aRight = 0;

    this.respawn(30);
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get speedKmh() { return this.speed * 3.6; }

  respawn(s = null) {
    const node = this.road.nodeAt(s === null ? this.roadS : s);
    if (!node) return;
    this.px = node.x;
    this.pz = node.z;
    this.py = node.y + this.restLength + this.wheelRadius + 0.1;
    this.vx = this.vy = this.vz = 0;
    this.yaw = Math.atan2(node.tx, node.tz);
    this.yawRate = 0;
    this.roll = this.pitch = 0;
    this.gear = 2;
    this.rpm = IDLE_RPM;
    this.driftAngle = 0;
    this.momentumX = node.tx;
    this.momentumZ = node.tz;
    for (let i = 0; i < 4; i++) {
      this.compression[i] = 0;
      this._prevComp[i] = 0;
      this.wheelOmega[i] = 0;
      this.slipRatio[i] = 0;
      this.slipAngle[i] = 0;
    }
  }

  // ------------------------------------------------------------------ step
  update(dt, input) {
    // Fixed-step integration, capped so a stalled tab cannot tunnel the car
    // through the world when it resumes.
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const step = Math.min(SUBSTEP, remaining);
      this._substep(step, input);
      remaining -= step;
    }
    this._updateGearbox(dt, input);
    for (let i = 0; i < 4; i++) this.wheelSpin[i] += this.wheelOmega[i] * dt;
    if (this.barrierContact > 0) this.barrierContact = Math.max(0, this.barrierContact - dt * 3);
  }

  _substep(dt, input) {
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    // forward = (sinY, 0, cosY);  right = (cosY, 0, -sinY)

    // --- steering: speed-sensitive rack -----------------------------------
    const speed = this.speed;
    const maxSteer = 0.62 / (1 + speed * 0.055);
    const target = input.steer * maxSteer;
    this.steer += (target - this.steer) * Math.min(1, dt * 10);

    // Ackermann turn radius: the centre of rotation is where the line through
    // the rear axle meets the perpendicular through the steered front wheels.
    this.turnRadius = Math.abs(this.steer) > 1e-4
      ? this.wheelbase / Math.tan(Math.abs(this.steer))
      : Infinity;

    // --- suspension: F = -k*x - c*v ---------------------------------------
    let anyGround = false;
    let totalLoad = 0;

    for (let i = 0; i < 4; i++) {
      const lx = this.wheelLocal[i][0];
      const lz = this.wheelLocal[i][1];
      const wx = this.px + cosY * lx + sinY * lz;
      const wz = this.pz - sinY * lx + cosY * lz;
      _wx[i] = wx; _wz[i] = wz;

      const armY = -this.pitch * lz + this.roll * lx;
      const hubY = this.py + armY;

      const ground = this.hf.surface(wx, wz);
      _cy[i] = ground;

      // x = rest length minus the raycast hit distance, clamped to travel.
      const hitDistance = hubY - ground - this.wheelRadius;
      let x = this.restLength - hitDistance;
      if (x < 0) x = 0;
      else if (x > this.maxTravel) x = this.maxTravel;
      _comp[i] = x;

      // v is the compression rate, so the damper opposes strut motion.
      const v = (x - this._prevComp[i]) / dt;
      this._prevComp[i] = x;

      let load = 0;
      if (x > 0) {
        load = this.springK * x + this.damperC * v;
        if (load < 0) load = 0;
        if (x > this.maxTravel - 0.02) load += (x - (this.maxTravel - 0.02)) * 260000;
        anyGround = true;
      }
      _load[i] = load;
      totalLoad += load;
      this.compression[i] = x;
    }

    this.grounded = anyGround;
    this.airtime = anyGround ? 0 : this.airtime + dt;

    // --- surface classification -------------------------------------------
    const q = this.road.query(this.px, this.pz);
    let barrier = 0, bnx = 0, bnz = 0, blat = 0;
    if (q.dist !== Infinity) {
      this.roadS = q.s;
      this.roadLat = q.lat;
      const edge = q.dist - q.width * 0.5;
      this.offRoad = edge > 0;
      this.surface = edge <= 0 ? SURFACE.ROAD : edge < 4 ? SURFACE.VERGE : SURFACE.DIRT;
      barrier = q.barrier; bnx = q.nx; bnz = q.nz; blat = q.lat;
    } else {
      this.offRoad = true;
      this.surface = SURFACE.DIRT;
    }
    // Wading. Tied to the actual water level rather than a magic number, so
    // moving WATER_LEVEL cannot silently leave the car driving on "water"
    // over dry ground.
    if (this.py < WATER_LEVEL + 1.5) this.surface = SURFACE.WATER;

    // --- forces -----------------------------------------------------------
    let fx = 0, fz = 0, fy = 0;
    let torqueA = 0;

    const v2 = this.vx * this.vx + this.vz * this.vz;
    if (v2 > 0.01) {
      const drag = 0.5 * 1.225 * this.dragCoeff * this.frontalArea * v2;
      const inv = 1 / Math.sqrt(v2);
      fx -= drag * this.vx * inv;
      fz -= drag * this.vz * inv;
    }
    const downforce = this.downforceCoeff * v2;

    const driveTorque = this._engineWheelTorque(input);
    const grip = this.surface.grip * this.gripScale;

    // --- normal load for the tyre model -----------------------------------
    // Deliberately NOT the raw strut force. The strut load spikes on dive or
    // squat, and because pitch here is kinematic there is no matching unload
    // at the other axle — so summing strut forces yields more total normal
    // load than the car weighs, and the tyres invent grip that is not there
    // (braking pulled 1.78 g against a 1.35 friction coefficient).
    //
    // Instead: distribute weight + downforce by CG position, apply explicit
    // longitudinal and lateral transfer using last substep's accelerations,
    // and let the struts contribute only a contact factor so bumps and
    // airtime still modulate grip. Total normal load is conserved.
    const totalWeight = this.mass * GRAVITY + downforce;
    const longShift = this.mass * this._aFwd * this.cgHeight / this.wheelbase;
    const frontAxle = Math.max(0, totalWeight * (this.cgToRear / this.wheelbase) - longShift);
    const rearAxle = Math.max(0, totalWeight * (this.cgToFront / this.wheelbase) + longShift);
    const latF = this.mass * this._aRight * this.cgHeight / this.track
      * (frontAxle / Math.max(1, totalWeight));
    const latR = this.mass * this._aRight * this.cgHeight / this.track
      * (rearAxle / Math.max(1, totalWeight));

    _fz[FL] = Math.max(0, frontAxle * 0.5 + latF * 0.5);
    _fz[FR] = Math.max(0, frontAxle * 0.5 - latF * 0.5);
    _fz[RL] = Math.max(0, rearAxle * 0.5 + latR * 0.5);
    _fz[RR] = Math.max(0, rearAxle * 0.5 - latR * 0.5);

    let maxSat = 0;
    let maxSpin = 0;

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const delta = front ? this.steer : 0;
      const sd = Math.sin(delta), cd = Math.cos(delta);

      // Wheel basis in world space.
      const fwx = sinY * cd + cosY * sd;
      const fwz = cosY * cd - sinY * sd;
      const rtx = cosY * cd - sinY * sd;
      const rtz = -sinY * cd - cosY * sd;

      // Contact-patch velocity = body velocity + yawRate x r.
      const rx = _wx[i] - this.px;
      const rz = _wz[i] - this.pz;
      const cvx = this.vx + this.yawRate * rz;
      const cvz = this.vz - this.yawRate * rx;

      const u = cvx * fwx + cvz * fwz;      // longitudinal ground speed
      const vy = cvx * rtx + cvz * rtz;     // lateral ground speed

      // Slip angle: alpha = atan(Vy / |Vx|), softened so it stays finite as
      // the car comes to rest.
      const alpha = Math.atan2(-vy, Math.abs(u) + 1.0);
      this.slipAngle[i] = alpha;

      // Slip ratio K = (wR - u)/u, integrated through a relaxation length
      // instead of evaluated directly. The raw quotient is singular at u = 0
      // and stiff just above it; the relaxation ODE has the same steady state
      // and is unconditionally stable at this timestep.
      //
      // The decay term carries a velocity floor. Without it the decay rate
      // goes to zero along with u, so a wheel that spun up while stationary
      // latches K at its clamp forever and the tyre reports full thrust with
      // nothing actually slipping.
      const omega = this.wheelOmega[i];
      const slipVel = omega * this.wheelRadius - u;
      let K = this.slipRatio[i];
      K += ((slipVel - (Math.abs(u) + 1.0) * K) / this.relaxLength) * dt;
      if (K > 2.5) K = 2.5; else if (K < -2.5) K = -2.5;
      this.slipRatio[i] = K;

      // Contact factor: how firmly this corner is actually on the ground.
      const contact = Math.min(1, _comp[i] / 0.05);
      const muMax = this.peakMu * grip * _fz[i] * contact;

      // Saturation curves.
      let fLong = muMax * Math.sin(this.longC * Math.atan(this.longB * K));
      let fLat = muMax * Math.sin(this.latC * Math.atan(this.latB * alpha));

      const rearHand = input.handbrake && !front;
      if (rearHand) fLat *= 0.32;

      // Friction ellipse: the tyre cannot exceed muMax in any direction.
      const mag = Math.hypot(fLong, fLat);
      if (mag > muMax && mag > 1e-6) {
        const k = muMax / mag;
        fLong *= k;
        fLat *= k;
        _sat[i] = 1;
      } else {
        _sat[i] = muMax > 1e-6 ? mag / muMax : 0;
      }
      if (_comp[i] <= 0) { fLong = 0; fLat = 0; _sat[i] = 0; }
      if (_sat[i] > maxSat) maxSat = _sat[i];
      _fx[i] = fLong;

      const tel = this.tyre[i];
      tel.fz = _fz[i]; tel.mu = muMax; tel.fLong = fLong; tel.fLat = fLat;
      tel.sat = _sat[i]; tel.contact = contact;

      // --- wheel angular dynamics ----------------------------------------
      let torque = driveTorque * this.driveSplit[i];
      torque -= fLong * this.wheelRadius;
      torque -= omega * this.surface.roll * 12;          // rolling resistance

      let brake = input.brake * this.brakeTorque[i];
      if (rearHand) brake += this.handbrakeTorque;

      let newOmega = omega + (torque / this.wheelInertia) * dt;
      if (brake > 0) {
        const dOmega = (brake / this.wheelInertia) * dt;
        if (Math.abs(newOmega) <= dOmega) newOmega = 0;   // do not reverse it
        else newOmega -= Math.sign(newOmega) * dOmega;
      }
      // ABS and traction control both work by nudging wheel speed back toward
      // the free-rolling speed, proportionally to how far past the threshold
      // the slip has gone. A fixed-strength correction parks the slip exactly
      // at the trigger value instead of resolving it.
      if (this.assists) {
        const free = u / this.wheelRadius;
        if (brake > 0 && u > 2 && K < -0.16) {
          newOmega += (free - newOmega) * Math.min(0.5, (-K - 0.16) * 1.6);
        } else if (driveTorque > 0 && K > 0.14 && !input.handbrake) {
          newOmega -= (newOmega - free) * Math.min(0.5, (K - 0.14) * 1.6);
        }
      }
      this.wheelOmega[i] = newOmega;

      const spin = Math.abs(newOmega * this.wheelRadius - u);
      if (spin > maxSpin) maxSpin = spin;

      const wfx = fwx * fLong + rtx * fLat;
      const wfz = fwz * fLong + rtz * fLat;
      fx += wfx;
      fz += wfz;
      torqueA += rz * wfx - rx * wfz;
    }

    fy += totalLoad - this.mass * GRAVITY - downforce;

    // Slope component. The struts only push along Y, so the in-plane part of
    // gravity has to be added explicitly: G - (G.n)n, which reduces to
    // m*g*n_y*(n_x, n_z) for a unit normal.
    if (anyGround) {
      this.hf.normal(this.px, this.pz, _nrm, 1.5);
      const g = this.mass * GRAVITY * _nrm[1];
      fx += _nrm[0] * g;
      fz += _nrm[2] * g;
    }

    // --- integrate --------------------------------------------------------
    const invM = 1 / this.mass;
    this.vx += fx * invM * dt;
    this.vz += fz * invM * dt;
    this.vy += fy * invM * dt;

    this.yawRate += (torqueA / this.izz) * dt;
    this.yawRate *= Math.exp(-1.6 * dt);

    this.px += this.vx * dt;
    this.py += this.vy * dt;
    this.pz += this.vz * dt;
    this.yaw += this.yawRate * dt;

    this.odometer += Math.hypot(this.vx, this.vz) * dt;

    // Audible/visible slip: the tyre has to be both saturated and actually
    // sliding, otherwise a hard but clean corner would squeal.
    const slipping = maxSat > 0.985 ? Math.min(1, maxSpin / 4) : 0;
    this.slipAmount += (slipping - this.slipAmount) * Math.min(1, dt * 14);
    this.wheelspin = Math.min(1, maxSpin / 8);

    // --- dual-vector momentum --------------------------------------------
    this._applyDrift(dt, input, sinY, cosY, _sat[RL], _sat[RR]);

    // --- barrier constraint ------------------------------------------------
    if (this.barriersEnabled && barrier > 0 && Math.abs(blat) > barrier) {
      this._applyBarrier(barrier, blat, bnx, bnz, dt);
    }

    // Hard floor so a bad landing cannot sink the car through the world.
    let highest = -Infinity;
    for (let i = 0; i < 4; i++) if (_cy[i] > highest) highest = _cy[i];
    const floor = highest + this.wheelRadius - this.maxTravel + 0.02;
    if (this.py < floor) { this.py = floor; if (this.vy < 0) this.vy = 0; }

    // --- attitude from the contact plane ----------------------------------
    this._updateAttitude(dt, sinY, cosY, fx, fz, invM);
  }

  // Chassis orientation from the normal of the plane through the four contact
  // points. Taking the cross product of the two diagonals is the cheap
  // best-fit for four near-coplanar points and needs no matrix work.
  //
  // Deliberately NOT derived from strut compression: feeding compression back
  // into the hub heights that produce it is a positive feedback loop, and any
  // asymmetry amplifies until one side of the car rides its bump stops.
  _updateAttitude(dt, sinY, cosY, fx, fz, invM) {
    const ax = (_wx[RR] - _wx[FL]), ay = (_cy[RR] - _cy[FL]), az = (_wz[RR] - _wz[FL]);
    const bx = (_wx[RL] - _wx[FR]), by = (_cy[RL] - _cy[FR]), bz = (_wz[RL] - _wz[FR]);

    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    _plane[0] = nx; _plane[1] = ny; _plane[2] = nz;

    // Project the normal onto the body axes. forward = (sinY,0,cosY),
    // right = (cosY,0,-sinY); for small angles the dot products are the
    // pitch and roll of the ground plane in the car's own frame.
    const groundPitch = nx * sinY + nz * cosY;
    const groundRoll = -(nx * cosY - nz * sinY);

    // Body accelerations — also fed forward to next substep's load transfer.
    const accelFwd = (fx * sinY + fz * cosY) * invM;
    const accelRight = (fx * cosY - fz * sinY) * invM;
    this._aFwd = accelFwd;
    this._aRight = accelRight;

    let targetPitch = groundPitch - accelFwd * 0.008;
    let targetRoll = groundRoll + accelRight * 0.010;
    targetPitch = Math.max(-0.16, Math.min(0.16, targetPitch));
    targetRoll = Math.max(-0.20, Math.min(0.20, targetRoll));

    const k = Math.min(1, dt * 11);
    this.roll += (targetRoll - this.roll) * k;
    this.pitch += (targetPitch - this.pitch) * k;
  }

  // Dual-vector momentum.
  //
  // The car carries a steering vector (where the nose points) and a momentum
  // vector (where it is actually travelling). While the rear tyres are inside
  // their friction limit the two stay locked together and this does nothing.
  // Once the rears saturate, a percentage of longitudinal velocity is
  // deliberately converted into lateral slip: the velocity vector is rotated
  // away from the heading, preserving speed, so the car slides radially
  // outward from the Ackermann centre. Counter-steering interpolates the
  // momentum vector back toward the steering vector.
  _applyDrift(dt, input, sinY, cosY, satRL, satRR) {
    const speed = Math.hypot(this.vx, this.vz);
    this.momentumX = speed > 0.5 ? this.vx / speed : sinY;
    this.momentumZ = speed > 0.5 ? this.vz / speed : cosY;

    // Signed angle from the nose to the trajectory. Cross product of the two
    // planar unit vectors gives the sine; positive means the car is travelling
    // to the right of where it is pointing.
    const cross = sinY * this.momentumZ - cosY * this.momentumX;
    const dot = sinY * this.momentumX + cosY * this.momentumZ;
    this.driftAngle = Math.atan2(-cross, dot);

    if (this.driftAssist <= 0 || speed < 7 || !this.grounded) return;

    const drift = this.driftAngle;
    const MAX_DRIFT = 0.95;      // ~54 deg; past this the slide is a spin
    const DEAD_ZONE = 0.12;      // ~7 deg of ordinary cornering slip, untouched
    let rotate = 0;

    // Sign convention, since getting this backwards spins the car:
    // `rotate` advances the velocity vector's angle measured from +X toward
    // +Z, while driftAngle is defined as (heading angle - momentum angle) in
    // that same frame. So a POSITIVE rotate reduces a positive driftAngle.
    //
    // Break-away: the rears are at the friction limit, so let the trajectory
    // lag behind the yaw instead of following it — longitudinal velocity is
    // converted into lateral slip. Yaw-rate sign carries the turn direction,
    // so this pushes |driftAngle| up on either lock.
    const rearSat = Math.max(satRL, satRR);
    if (rearSat > 0.96 && Math.abs(drift) < MAX_DRIFT) {
      const excess = Math.min(1, (rearSat - 0.96) / 0.04);
      rotate += this.yawRate * excess * this.driftAssist * 0.45 * dt;
    }

    // Recovery pulls the momentum vector back toward the nose. Only acts on a
    // genuine slide — inside the dead zone the tyre model owns the slip angle
    // and this must not touch it, or the car loses its understeer and feels
    // like it is on rails.
    if (Math.abs(drift) > DEAD_ZONE) {
      const counter = input.steer !== 0 && Math.sign(input.steer) === -Math.sign(drift);
      const rate = counter ? 3.4 * (0.4 + Math.abs(input.steer) * 0.6) : 1.1;
      const excess = drift - Math.sign(drift) * DEAD_ZONE;
      rotate += excess * Math.min(1, rate * dt);
    }

    if (rotate === 0) return;

    // Rotate the velocity vector in place: speed is conserved, only the split
    // between longitudinal and lateral changes.
    const c = Math.cos(rotate), s = Math.sin(rotate);
    const nvx = this.vx * c - this.vz * s;
    const nvz = this.vx * s + this.vz * c;
    this.vx = nvx;
    this.vz = nvz;
  }

  // Barriers are not collision meshes. They are a scalar annotation on the
  // road midline, so keeping the car on the road is a 1D comparison of lateral
  // offset against the barrier offset for this section.
  _applyBarrier(barrier, lat, nx, nz, dt) {
    const side = Math.sign(lat);
    const overshoot = Math.abs(lat) - barrier;

    // Rigid constraint: push the chassis back to the barrier line.
    this.px -= nx * overshoot * side;
    this.pz -= nz * overshoot * side;

    // Nullify velocity into the barrier; leave the along-road component alone
    // so the car scrubs along it rather than stopping dead.
    const vn = this.vx * nx + this.vz * nz;
    if (vn * side > 0) {
      this.vx -= nx * vn;
      this.vz -= nz * vn;

      // Scrub is a per-SECOND rate. Applying a flat per-substep factor here
      // compounds 180 times a second — a graze bled away 93 % of road speed
      // per second and pinned the car against the barrier at walking pace.
      const scrub = Math.exp(-0.8 * dt);
      this.vx *= scrub;
      this.vz *= scrub;
      this.barrierContact = Math.min(1, Math.abs(vn) / 12);
    }

    // Gentle restoring push toward the carriageway. Without it the constraint
    // is a perfect one-way wall: a car that arrives outside the line (or slides
    // in nose-out) simply rides it forever, because cancelling the inward
    // normal velocity alone never returns any lateral position.
    const restore = 2.5;
    this.vx -= nx * side * restore * dt;
    this.vz -= nz * side * restore * dt;
  }

  // ------------------------------------------------------------ drivetrain
  _engineWheelTorque(input) {
    if (this.gear === 1 || !this.grounded) return 0;
    const ratio = GEARS[this.gear] * FINAL_DRIVE;
    const torque = this._engineTorque(this.rpm) * input.throttle;
    // Engine braking off-throttle.
    const brakeTorque = (1 - input.throttle) * (this.rpm / REDLINE) * 42;
    return (torque - brakeTorque) * ratio * 0.88;
  }

  _engineTorque(rpm) {
    const x = rpm / REDLINE;
    const t = 175 + 330 * Math.sin(Math.min(1, Math.max(0, (x - 0.05) / 0.72)) * Math.PI * 0.86);
    return Math.max(0, t);
  }

  _updateGearbox(dt, input) {
    const fwd = this.vx * Math.sin(this.yaw) + this.vz * Math.cos(this.yaw);

    if (this.gear === 0) {
      if (fwd > 1.0 && input.throttle < 0.05) this.gear = 2;
    } else if (input.brake > 0.6 && fwd < 0.6 && input.throttle < 0.05) {
      this.gear = 0;
    }

    // Engine speed now follows the driven wheels rather than road speed, so
    // wheelspin shows up on the tacho the way it should.
    const avgOmega = (this.wheelOmega[0] + this.wheelOmega[1]
      + this.wheelOmega[2] + this.wheelOmega[3]) * 0.25;
    const ratio = Math.abs(GEARS[this.gear] || GEARS[2]) * FINAL_DRIVE;
    let target = Math.abs(avgOmega) * ratio * (60 / (2 * Math.PI));

    // Clutch slip at very low speed keeps the engine off its idle stop.
    const launch = Math.max(0, 1 - Math.abs(fwd) / 7);
    target = target * (1 - launch) + (IDLE_RPM + input.throttle * 3400) * launch;
    target = Math.min(REDLINE, Math.max(IDLE_RPM, target));
    this.rpm += (target - this.rpm) * Math.min(1, dt * 9);

    this._shiftCooldown -= dt;
    if (this._shiftCooldown <= 0 && this.gear >= 2) {
      if (this.rpm > REDLINE * 0.93 && this.gear < GEARS.length - 1) {
        this.gear++;
        this._shiftCooldown = 0.45;
        this.rpm *= 0.72;
      } else if (this.rpm < 2350 && this.gear > 2) {
        this.gear--;
        this._shiftCooldown = 0.35;
        this.rpm *= 1.32;
      }
    }
  }

  // ---------------------------------------------------------------- queries
  wheelWorld(i, out) {
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const lx = this.wheelLocal[i][0], lz = this.wheelLocal[i][1];
    out.set(
      this.px + cosY * lx + sinY * lz,
      this.py - this.pitch * lz + this.roll * lx - this.restLength + this.compression[i],
      this.pz - sinY * lx + cosY * lz
    );
    return out;
  }

  // World-space centre of rotation, or null when travelling straight.
  cornerCentre(out) {
    if (!Number.isFinite(this.turnRadius)) return null;
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const side = Math.sign(this.steer) || 1;
    out.set(
      this.px + cosY * this.turnRadius * side,
      this.py,
      this.pz - sinY * this.turnRadius * side
    );
    return out;
  }

  contactPlane() { return _plane; }

  gearLabel() {
    if (this.gear === 0) return 'R';
    if (this.gear === 1) return 'N';
    return String(this.gear - 1);
  }
}

export { REDLINE, IDLE_RPM };
