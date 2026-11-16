const baselineWindow = 30_000;
const backoffDuration = 3_000;

export function createTerrainNetwork() {
  const samples = [];
  let rtt, baseline, backoffUntil = 0;

  return {
    urgent: false,
    sample(ms, now = performance.now()) {
      rtt = ms;
      while (samples.length && samples[0].at < now - baselineWindow) samples.shift();
      if (ms === null) {
        backoffUntil = now + backoffDuration;
        return;
      }
      samples.push({at:now, ms});
      const ordered = samples.map(sample => sample.ms).sort((a,b) => a-b);
      baseline = ordered[Math.floor((ordered.length - 1) / 4)];
      if (ms > baseline + Math.max(35, baseline * .25)) backoffUntil = now + backoffDuration;
    },
    constrained(now = performance.now()) {
      return now < backoffUntil;
    },
    status() {
      return {rtt, baseline, constrained:this.constrained(), urgent:this.urgent};
    },
  };
}
