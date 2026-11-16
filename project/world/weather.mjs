export const weatherModes = Object.freeze(['clear','cloudy','rain','snow']);

export function isWeather(mode) {
  return weatherModes.includes(mode);
}

export function isPrecipitating(mode) {
  return mode === 'rain' || mode === 'snow';
}
