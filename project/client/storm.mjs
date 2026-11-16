const period=96000;
const random=(sequence,salt)=>(Math.imul(sequence^salt,17372087)>>>0)/4294967296;
const pulse=(value,start,width)=>Math.max(0,1-Math.abs(value-start)/width);

export function stormAt(epoch) {
  const id=Math.floor(epoch/period);
  const strike=id*period+10000+random(id,93117)*42000;
  const age=epoch-strike;
  if (age<0 || age>=4500) return null;
  const flash=Math.max(pulse(age,38,39),.63*pulse(age,136,48),.36*pulse(age,226,45));
  return {id,flash,angle:Math.PI*2*random(id,137),
    soundAt:strike+1000+random(id,66427)*1850,age};
}

export function rainStrength(wind) { return .69+.31*wind.strength; }
