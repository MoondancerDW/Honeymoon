const RAD = Math.PI / 180;

export class ViewBobbing {
  constructor() {
    this.reset();
  }

  reset() {
    this.walk = 0;
    this.sway = 0;
    this.fallPitch = 0;
  }

  step(distance, seconds, grounded, verticalSpeed) {
    this.walk = (this.walk + .6 * distance) % 2;
    const speed = seconds > 0 ? distance / seconds : 0;
    const sway = grounded ? Math.min(.1, speed / 20) : 0;
    const fallPitch = grounded ? 0 : Math.atan(-verticalSpeed * .01) * 15;
    this.sway += (sway - this.sway) * (1 - .6 ** (seconds * 20));
    this.fallPitch += (fallPitch - this.fallPitch) * (1 - .2 ** (seconds * 20));
    if (this.sway < .00001) this.sway = 0;
    if (Math.abs(this.fallPitch) < .00001) this.fallPitch = 0;
  }

  sample() {
    const phase = -this.walk * Math.PI;
    const sideways = Math.sin(phase) * this.sway;
    return {x: -sideways / 2, y: Math.abs(Math.cos(phase) * this.sway), roll: -3 * sideways * RAD,
      pitch: -(Math.abs(Math.cos(phase - .2) * this.sway) * 5 + this.fallPitch) * RAD};
  }
}
