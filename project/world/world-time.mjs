export const dayTicks = 24000;
const minutesPerDay = 1440;
export const tickMilliseconds = minutesPerDay * 1000 / dayTicks;

export function clockTick({tick, frozen}, elapsed) {
  return (tick + (frozen ? 0 : Math.max(0, elapsed) / tickMilliseconds)) % dayTicks;
}

export function formatClock(tick) {
  const minutes = (Math.floor(tick * minutesPerDay / dayTicks) + 360) % minutesPerDay;
  return [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2, '0')).join(':');
}

export function tickFromTime(time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const [hours, minutes] = time.split(':').map(Number);
  return Math.ceil(((hours * 60 + minutes - 360 + minutesPerDay) % minutesPerDay) * dayTicks / minutesPerDay);
}
