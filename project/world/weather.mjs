export const weatherModes = Object.freeze(['clear','cloudy','rain']);

export function isWeather(mode) {
  return weatherModes.includes(mode);
}
