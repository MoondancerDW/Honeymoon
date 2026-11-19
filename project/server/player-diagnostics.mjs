import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {RequestError} from './errors.mjs';

export const playerDiagnosticsBodyLimit = 16 * 1024;
export const diagnosticPagePattern = /^[a-f0-9]{16}$/;
export const diagnosticTracePattern = /^[a-f0-9]{16}\.[1-9][0-9]{0,9}$/;
const groupPattern = /^[a-f0-9]{12}$/;
const frameReasons = new Set(['queue_full','terrain','menu','paused','teleport','seated','camera','stationary']);
const requestTypes = new Set(['movement','ping','actions','presence']);
const failures = new Set(['timeout','network','http','offline','closed','cancelled']);
const durationFields = new Set(['spanMs','timerLateMs','frameGapMs','sinceFrameMs','inputMs','lastHeartbeatAgoMs',
  'heartbeatTransitMs','positionAckAgoMs','queueAgeMs']);
const countFields = new Set(['frames','longFrames','queued','maxQueued','pending','positionErrors','positionCorrections',
  'positionRequests','chunksMissing','chunksLoading','rttMs','baselineMs','droppedSamples','sseMovementAcks','httpMovementAcks','stateMovementAcks']);
const boolFields = new Set(['visible','focused','online','sse','terrainUrgent','terrainConstrained']);
const sampleFields = new Set(['at','page','streamId','reasons','requests','stalls','network','clockOffsetMs',...durationFields,...countFields,...boolFields]);
const requestFields = new Set(['id','kind','startedAt','durationMs','headersMs','status','error','group']);
const stallFields = new Set(['kind','at','reason','durationMs','outcome']);
const stallOutcomes = new Set(['moved','changed','input_ended']);
const maximumTiming = 86_400_000;
const networkFields = new Set(['kind','state','at','rttMs','baselineMs','status','error','durationMs','missed']);
const networkStates = new Map([
  ['ping',new Set(['ok','spike','lost','recovered'])], ['sse',new Set(['lost','open','recovered'])],
  ['browser',new Set(['offline','online'])],
]);
// A fixed wire value keeps the pending queue of earlier clients valid across reloads.
const continuousUntil = Date.parse('9999-12-31T00:00:00Z');

const plain = value=>value && typeof value==='object' && !Array.isArray(value);
const within = (value,min,max)=>Number.isSafeInteger(value) && value>=min && value<=max;

export function loadPlayerDiagnostics(state,{now=Date.now,onError=error=>console.error('Lilium Moonlight player diagnostics:',error.message)}={}) {
  if (state===':memory:') return;
  try {
    const settings=JSON.parse(readFileSync(join(dirname(state),'player-diagnostics.json'),'utf8'));
    if (settings?.enabled===false) return;
  } catch (error) {
    if (error.code!=='ENOENT') onError(error);
  }
  return {until:continuousUntil,active:player=>Boolean(player),
    session:player=>player ? {until:continuousUntil,serverAt:now()} : undefined};
}

export function parsePlayerDiagnostics(body,now=Date.now()) {
  const validTime=value=>within(value,now-maximumTiming,now+300_000);
  const validRequest=request=>plain(request) && Object.keys(request).every(key=>requestFields.has(key)) &&
    typeof request.id==='string' && diagnosticTracePattern.test(request.id) && requestTypes.has(request.kind) &&
    validTime(request.startedAt) && within(request.durationMs,0,maximumTiming) &&
    (request.group===undefined || typeof request.group==='string' && groupPattern.test(request.group)) &&
    (request.headersMs===undefined || within(request.headersMs,0,request.durationMs)) &&
    (request.status===undefined || within(request.status,100,599)) &&
    (request.error===undefined || failures.has(request.error));
  const validStall=stall=>plain(stall) && Object.keys(stall).every(key=>stallFields.has(key)) &&
    validTime(stall.at) && frameReasons.has(stall.reason) && (stall.kind==='start' && stall.durationMs===undefined && stall.outcome===undefined ||
      stall.kind==='end' && within(stall.durationMs,0,maximumTiming) && stallOutcomes.has(stall.outcome));
  const validNetwork=event=>plain(event) && Object.keys(event).every(key=>networkFields.has(key)) &&
    networkStates.get(event.kind)?.has(event.state) && validTime(event.at) &&
    ['rttMs','baselineMs','durationMs'].every(key=>event[key]===undefined || within(event[key],0,maximumTiming)) &&
    (event.status===undefined || within(event.status,100,599)) &&
    (event.missed===undefined || within(event.missed,0,10_000_000)) &&
    (event.error===undefined || failures.has(event.error));
  const samples=body?.samples;
  if (!plain(body) || Object.keys(body).length!==1 || !Array.isArray(samples) || !samples.length || samples.length>8) {
    throw new RequestError(400,'invalid_player_diagnostics');
  }
  for (const sample of samples) {
    if (!plain(sample) || !Object.keys(sample).every(key=>sampleFields.has(key)) || !validTime(sample.at) ||
        typeof sample.page!=='string' || !diagnosticPagePattern.test(sample.page) ||
        (sample.streamId!==undefined && (typeof sample.streamId!=='string' || !diagnosticPagePattern.test(sample.streamId))) ||
        (sample.clockOffsetMs!==undefined && !within(sample.clockOffsetMs,-maximumTiming,maximumTiming)) ||
        ![...durationFields].every(key=>sample[key]===undefined || within(sample[key],0,maximumTiming)) ||
        ![...countFields].every(key=>sample[key]===undefined || within(sample[key],0,10_000_000)) ||
        ![...boolFields].every(key=>sample[key]===undefined || typeof sample[key]==='boolean') ||
        !plain(sample.reasons) || !Object.entries(sample.reasons).every(([key,value])=>frameReasons.has(key) && within(value,0,maximumTiming)) ||
        (sample.stalls!==undefined && (!Array.isArray(sample.stalls) || sample.stalls.length>8 || !sample.stalls.every(validStall))) ||
        (sample.network!==undefined && (!Array.isArray(sample.network) || sample.network.length>24 || !sample.network.every(validNetwork))) ||
        !Array.isArray(sample.requests) || sample.requests.length>12 || !sample.requests.every(request=>validRequest(request) && request.id.startsWith(sample.page+'.'))) {
      throw new RequestError(400,'invalid_player_diagnostics');
    }
  }
  return samples;
}
