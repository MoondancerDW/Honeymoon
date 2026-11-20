import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {RequestError} from './errors.mjs';
import {claimLegacyPlayer,hasLegacyPlayer} from './legacy-player.mjs';

export const deviceCookieName='honeymoon_device';
export const legacyCookieName='honeymoon_guest';
const COOKIE_AGE=31_536_000;
const devicePattern=/^[A-Za-z0-9_-]{43}$/;
const invitePattern=/^HN-[A-Za-z0-9_-]{24}$/;
const uidPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const forbidden=/[\p{Cc}\p{Zl}\p{Zp}]/u;
const hash=value=>createHash('sha256').update(value).digest('hex');

export function accessCookie(token,secure,maxAge=COOKIE_AGE) {
  return `${deviceCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
export function legacyClearCookie(secure) {
  return `${legacyCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`;
}
export function readAccessCookie(request,name=deviceCookieName) {
  const match=request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{43})(?=;|$)`));
  return match?.[1];
}

function label(value,cap,error,fallback) {
  if (value===undefined || value==='') return fallback;
  if (typeof value!=='string' || forbidden.test(value)) throw new RequestError(400,error);
  const normalized=value.normalize('NFC').trim();
  if (normalized.length>cap) throw new RequestError(400,error);
  return normalized || fallback;
}

function accountName(value,previous,allowShort) {
  if (previous) return previous;
  const name=label(value,48,'invalid_profile_name',undefined);
  if (!name) throw new RequestError(409,'profile_name_required');
  if ([...name].length<2&&!allowShort?.(name)) throw new RequestError(400,'invalid_profile_name');
  return name;
}

function inviteStatus(row,now) {
  if (row.usedAt!==null) return 'used';
  if (row.revokedAt!==null) return 'revoked';
  if (row.expiresAt!==null && row.expiresAt<=now) return 'expired';
  return 'active';
}

function invitationDevice(headers={}) {
  const agent=headers['user-agent']??'';
  const brands=headers['sec-ch-ua']??'';
  let browser=null;
  if (/\b(?:Edg|EdgA|EdgiOS|Edge)\//i.test(agent) || /"Microsoft Edge"/i.test(brands)) browser='Microsoft Edge';
  else if (/\b(?:OPR|OPiOS|OPT|Opera)\//i.test(agent) || /"Opera(?: GX)?"/i.test(brands)) browser='Opera';
  else if (/\bSamsungBrowser\//i.test(agent) || /"Samsung Internet"/i.test(brands)) browser='Samsung Internet';
  else if (/\bYaBrowser\//i.test(agent) || /"Yandex(?: Browser)?"/i.test(brands)) browser='Яндекс Браузер';
  else if (/\bVivaldi\//i.test(agent) || /"Vivaldi"/i.test(brands)) browser='Vivaldi';
  else if (/\b(?:Firefox|FxiOS)\//i.test(agent)) browser='Firefox';
  else if (/"Google Chrome"/i.test(brands) || /\bCriOS\//i.test(agent)) browser='Google Chrome';
  else if (/\bChromium\//i.test(agent) || /"Chromium"/i.test(brands)) browser='Chromium';
  else if (/\bChrome\//i.test(agent)) browser='Google Chrome';
  else if (/\bVersion\/[^ ]+.*\bSafari\//i.test(agent)) browser='Safari';

  const form=headers['sec-ch-ua-form-factors']??'';
  const platform=headers['sec-ch-ua-platform']??'';
  let deviceType=null;
  if (/"Tablet"/i.test(form) || /\b(?:iPad|Tablet|Kindle|Silk|PlayBook)\b/i.test(agent)) deviceType='tablet';
  else if (/"Mobile"/i.test(form) || headers['sec-ch-ua-mobile']==='?1' ||
    /\b(?:iPhone|iPod|Windows Phone|Mobi(?:le)?)\b/i.test(agent)) deviceType='mobile';
  else if (/"Desktop"/i.test(form)) deviceType='desktop';
  else if (/"Android"/i.test(platform) || /\bAndroid\b/i.test(agent)) deviceType='tablet';
  else if (/"(?:Windows|macOS|Linux|Chrome OS)"/i.test(platform) ||
    /\b(?:Windows NT|Macintosh|X11|CrOS|Linux x86)\b/i.test(agent)) deviceType='desktop';
  return {browser,deviceType};
}

export function createAccess(store,{inviteRequired=false,singlePlayer=false,ownerKey,publicOrigin,now=Date.now,revokeStream=()=>{},
  disconnectProfile=()=>{}}={}) {
  const prepare=sql=>store.db.prepare(sql);
  const findDevice=prepare(`SELECT devices.id AS deviceId,devices.player AS uid,devices.last_seen AS lastSeen,
    players.profile_name AS profileName,players.access_role AS role
    FROM access_devices devices JOIN players ON players.id=devices.player
    WHERE devices.token_hash=? AND devices.revoked_at IS NULL`);
  const addDevice=prepare('INSERT INTO access_devices (id,player,token_hash,label,created_at,last_seen) VALUES (?,?,?,?,?,?)');
  const touchDevice=prepare('UPDATE access_devices SET last_seen=? WHERE id=? AND revoked_at IS NULL');
  const disableDevice=prepare('UPDATE access_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL');
  const byDeviceId=prepare('SELECT id,player AS uid,revoked_at AS revokedAt FROM access_devices WHERE id=?');
  const deviceList=prepare(`SELECT id,label,created_at AS createdAt,last_seen AS lastSeen,revoked_at AS revokedAt
    FROM access_devices WHERE player=? ORDER BY created_at DESC,id`);
  const account=prepare('SELECT id AS uid,profile_name AS profileName,access_role AS role FROM players WHERE id=?');
  const profileList=prepare(`SELECT players.id AS uid, players.profile_name AS profileName,players.access_role AS role,
    player_profiles.nickname FROM players LEFT JOIN player_profiles ON player_profiles.player=players.id
    ORDER BY players.profile_name COLLATE NOCASE, player_profiles.nickname COLLATE NOCASE, players.id`);
  const originalProfiles=prepare(`SELECT json_extract(imported.value,'$.uid') AS uid,
    COALESCE(json_extract(imported.value,'$.nickname'),imported.owner) AS nickname,
    claimed.owner IS NOT NULL AS claimed
    FROM module_state imported LEFT JOIN module_state claimed ON claimed.module='legacy-player' AND claimed.key='claim'
      AND claimed.owner=json_extract(imported.value,'$.uid')
    WHERE imported.module='legacy-player' AND imported.key='import'`);
  const updateAccount=prepare('UPDATE players SET profile_name=COALESCE(profile_name,?),access_role=? WHERE id=?');
  const updateRole=prepare('UPDATE players SET access_role=? WHERE id=? AND access_role<>?');
  const updateInitialNick=prepare(`INSERT INTO player_profiles(player,nickname) VALUES (?,?)
    ON CONFLICT(player) DO UPDATE SET nickname=COALESCE(player_profiles.nickname,excluded.nickname)`);
  const inviteColumns=`id,kind,player AS profileUid,issuer,label,created_at AS createdAt,
    expires_at AS expiresAt,used_at AS usedAt,revoked_at AS revokedAt,
    used_by AS usedByUid,used_browser AS browser,used_device_type AS deviceType`;
  const findInvite=prepare('SELECT '+inviteColumns+' FROM access_invites WHERE code_hash=?');
  const inviteList=prepare('SELECT '+inviteColumns+' FROM access_invites ORDER BY created_at DESC,id');
  const inviteById=prepare('SELECT '+inviteColumns+' FROM access_invites WHERE id=?');
  const addInvite=prepare(`INSERT INTO access_invites(id,code_hash,kind,player,issuer,label,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const useInvite=prepare(`UPDATE access_invites SET used_at=?,used_by=?,used_browser=?,used_device_type=?
    WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`);
  const disableInvite=prepare('UPDATE access_invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL');
  const expected=!singlePlayer && typeof ownerKey==='string' && ownerKey.length ? Buffer.from(hash(ownerKey),'hex') : undefined;
  const originalName=name=>hasLegacyPlayer(store,name);
  const failedOwner=new Map();
  const bans=new Map(prepare("SELECT owner,value FROM module_state WHERE module='access' AND key='ban' AND value<>'null'")
    .all().map(({owner,value})=>[owner,JSON.parse(value)]));
  const localPlayer=singlePlayer ? store.atomic(()=>{
    const saved=store.getState('single-player','','profile')?.value;
    const profile=typeof saved==='string' ? account.get(saved) : undefined;
    if (profile) return {...profile,role:'admin',deviceId:'local'};
    const {id}=store.createPlayer();
    updateAccount.run('Игрок','admin',id);
    initialNick(id,'Игрок');
    store.putState('single-player','','profile',1,id);
    return {...account.get(id),deviceId:'local'};
  }) : undefined;
  const owner=()=>localPlayer?.uid ?? store.getState('access','','owner')?.value ?? null;
  const isAdmin=uid=>localPlayer ? uid===localPlayer.uid :
    typeof uid==='string' && !bans.has(uid) && account.get(uid)?.role==='admin';

  function requireUnbanned(uid) {
    if (localPlayer && uid===localPlayer.uid) return;
    const ban=bans.get(uid);
    if (ban) throw new RequestError(403,'profile_banned',{reason:ban.reason});
  }

  function authorize(uid) {
    if (!isAdmin(uid)) throw new RequestError(403,'admin_required');
  }

  function manageProfile(actor,target) {
    if (actor!==target && actor!==owner() && account.get(target)?.role==='admin') {
      throw new RequestError(403,'owner_required');
    }
  }

  function adminTarget(actor,target,control) {
    authorize(actor);
    if (typeof target!=='string'||!uidPattern.test(target)||!account.get(target)) throw new RequestError(404,'player_missing');
    if (target===actor) throw new RequestError(400,'admin_target_self');
    if (control) manageProfile(actor,target);
    return target;
  }

  function setRole(actor,uid,role) {
    authorize(actor);
    if (actor!==owner()) throw new RequestError(403,'owner_required');
    if (role!=='admin' && role!=='player') throw new RequestError(400,'invalid_profile_role');
    if (typeof uid!=='string' || !uidPattern.test(uid) || !account.get(uid)) {
      throw new RequestError(404,'player_missing');
    }
    if (uid===owner() && role!=='admin') throw new RequestError(403,'owner_role_protected');
    const changed=updateRole.run(role,uid,role).changes===1;
    return {uid,role,changed};
  }

  function setBan(actor,uid,reason,banned) {
    authorize(actor);
    if (uid===owner()) throw new RequestError(403,'owner_protected');
    adminTarget(actor,uid,true);
    const previous=bans.get(uid)??null;
    const ban=banned ? {reason:label(reason,240,'invalid_ban_reason',''),at:previous?.at??Math.trunc(now())} : null;
    store.putState('access',uid,'ban',1,ban);
    if (ban) {
      bans.set(uid,ban);
      disconnectProfile(uid,ban);
    } else bans.delete(uid);
    return {uid,ban};
  }

  function initialNick(uid,name) {
    const candidate=Array.from(name.replace(/[^\p{L}\p{M}\p{N} _-]/gu,'')).slice(0,24).join('').trim();
    if (candidate.length>=2 && candidate.length<=24 && /[\p{L}\p{N}]/u.test(candidate)) updateInitialNick.run(uid,candidate);
  }

  function authenticate(token) {
    if (localPlayer) return localPlayer;
    if (typeof token!=='string' || !devicePattern.test(token)) return undefined;
    const credential=findDevice.get(hash(token));
    if (credential && !bans.has(credential.uid) && now()-credential.lastSeen>=60_000) touchDevice.run(Math.trunc(now()),credential.deviceId);
    return credential;
  }

  function mint(uid,deviceName) {
    const token=randomBytes(32).toString('base64url');
    const deviceId=randomUUID();
    const time=Math.trunc(now());
    addDevice.run(deviceId,uid,hash(token),deviceName,time,time);
    return {credential:{...account.get(uid),deviceId,lastSeen:time},token};
  }

  function invited(value,body,headers) {
    if (typeof value!=='string' || !invitePattern.test(value.trim())) throw new RequestError(400,'invalid_invite');
    const deviceName=label(body.deviceName,80,'invalid_device_name',undefined);
    const {browser,deviceType}=invitationDevice(headers);
    return store.atomic(()=>{
      const time=Math.trunc(now());
      const row=findInvite.get(hash(value.trim()));
      if (!row) throw new RequestError(400,'invalid_invite');
      const status=inviteStatus(row,time);
      if (status!=='active') throw new RequestError(409,'invite_'+status);
      let uid=row.profileUid;
      if (row.kind==='device') {
        const profile=account.get(uid);
        if (!profile) throw new RequestError(404,'profile_missing');
        requireUnbanned(uid);
        if (!profile.profileName) {
          const name=accountName(body.profileName??body.nickname,store.getProfile(uid)?.nickname);
          updateAccount.run(name,profile.role,uid);
          initialNick(uid,name);
        }
      } else {
        const name=accountName(body.profileName??body.nickname,undefined,originalName);
        uid=claimLegacyPlayer(store,name,id=>account.get(id),time)??store.createPlayer().id;
        updateAccount.run(name,row.kind,uid);
        initialNick(uid,name);
      }
      if (useInvite.run(time,uid,browser,deviceType,row.id,time).changes!==1) throw new RequestError(409,'invite_used');
      return mint(uid,deviceName??(row.kind==='device' && row.label ? row.label : 'Браузер'));
    });
  }

  function signIn(body,{credential,legacy,ownerBootstrap,headers}={}) {
    if (localPlayer) return {credential:localPlayer};
    requireUnbanned(credential?.uid);
    if (credential && body.invite===undefined) return {credential};
    if (credential) throw new RequestError(409,'already_authenticated');
    if (body.invite!==undefined) return invited(body.invite,body,headers);
    if (inviteRequired) throw new RequestError(401,'invite_required',{ownerBootstrap});
    const deviceName=label(body.deviceName,80,'invalid_device_name','Локальный браузер');
    return store.atomic(()=>{
      const uid=legacy ? store.playerFromToken(legacy) : null;
      requireUnbanned(uid);
      return mint(uid??store.createPlayer().id,deviceName);
    });
  }

  function checkOwnerKey(value,source) {
    if (!expected) throw new RequestError(403,'owner_unavailable');
    const time=Math.trunc(now());
    let attempt=failedOwner.get(source);
    if (!attempt || time-attempt.start>=60_000) {
      if (failedOwner.size>=32) failedOwner.delete(failedOwner.keys().next().value);
      failedOwner.set(source,attempt={start:time,count:0});
    }
    if (attempt.count>=8) throw new RequestError(429,'owner_rate_limit');
    if (typeof value!=='string' || value.length>1024 || !timingSafeEqual(Buffer.from(hash(value),'hex'),expected)) {
      attempt.count++;
      throw new RequestError(403,'owner_key');
    }
    failedOwner.delete(source);
  }

  function bootstrap(body,{credential,legacy,source,legacyRoute=false}={}) {
    checkOwnerKey(body.key,source);
    const deviceName=label(body.deviceName,80,'invalid_device_name','Браузер владельца');
    return store.atomic(()=>{
      const savedOwner=owner();
      if (savedOwner) {
        if (credential?.uid===savedOwner) return {credential};
        return mint(savedOwner,deviceName);
      }
      const previous=credential?.uid??(legacy?store.playerFromToken(legacy):null);
      requireUnbanned(previous);
      const previousAccount=previous?account.get(previous):undefined;
      const requestedName=body.profileName??body.nickname;
      const name=accountName(requestedName,
        previousAccount?.profileName ?? (previous ? store.getProfile(previous)?.nickname : null) ??
        (!inviteRequired&&legacyRoute?'Владелец':null),previous?undefined:originalName);
      const imported=previous||requestedName===undefined?undefined:
        claimLegacyPlayer(store,name,id=>account.get(id),Math.trunc(now()));
      const uid=previous??imported??store.createPlayer().id;
      updateAccount.run(name,'admin',uid);
      initialNick(uid,name);
      store.putState('access','','owner',1,uid);
      if (credential?.uid===uid) return {credential:{...credential,uid,profileName:name,role:'admin'}};
      return mint(uid,deviceName);
    });
  }

  function view(credential,ownerListener) {
    return {authenticated:Boolean(credential),inviteRequired,ownerBootstrap:Boolean(ownerListener&&expected),
      ...(singlePlayer&&{singlePlayer:true}),
      ...(credential&&{uid:credential.uid,deviceId:credential.deviceId,role:credential.role,profileName:credential.profileName,
        ...(credential.uid===owner()&&{owner:true})})};
  }

  function publicInvite(row,time) {
    const {issuer:_,usedByUid,browser,deviceType,...fields}=row;
    const status=inviteStatus(row,time);
    const target=row.kind==='device' ? account.get(row.profileUid) : undefined;
    const uid=usedByUid??target?.uid;
    const profile=uid===target?.uid ? target : uid ? account.get(uid) : undefined;
    return {...fields,status,role:row.kind==='device'?target?.role:row.kind,
      ...(status==='used' && uid && {usedBy:{uid,profileName:profile?.profileName,browser,deviceType}})};
  }

  function listAdmin(credential,online) {
    authorize(credential.uid);
    const currentOwner=owner(),time=Math.trunc(now());
    return {
      profiles:profileList.all().map(profile=>({...profile,owner:profile.uid===currentOwner,
        ban:bans.get(profile.uid)??null,online:!bans.has(profile.uid)&&Boolean(online(profile.uid)),
        devices:deviceList.all(profile.uid).map(device=>({...device,current:device.id===credential.deviceId}))})),
      invites:inviteList.all().map(row=>publicInvite(row,time)),
    };
  }

  function listUids(actor) {
    authorize(actor);
    const rows=new Map();
    function add(uid,source,claimed,names) {
      const row=rows.get(uid)??{uid,source,claimed,names:new Set()};
      for (const name of names) if (typeof name==='string'&&name) row.names.add(name);
      rows.set(uid,row);
    }
    for (const profile of originalProfiles.all()) {
      if (typeof profile.uid==='string'&&uidPattern.test(profile.uid)) {
        add(profile.uid,'original',Boolean(profile.claimed),[profile.nickname]);
      }
    }
    for (const {uid,profileName,nickname} of profileList.all()) add(uid,'profile',true,[profileName,nickname]);
    const sorted=[...rows.values()].map(row=>({...row,names:[...row.names].sort()}));
    sorted.sort((a,b)=>(a.names[0]??'').localeCompare(b.names[0]??'','ru')||a.uid.localeCompare(b.uid));
    return {rows:sorted};
  }

  function issue(uid,body) {
    authorize(uid);
    const {kind,profileUid,ttlHours}=body;
    if (!['admin','player','device'].includes(kind)) throw new RequestError(400,'invalid_invite_kind');
    if (kind==='admin' && uid!==owner()) throw new RequestError(403,'owner_required');
    if (ttlHours!=null && (!Number.isSafeInteger(ttlHours) || ttlHours<1 || ttlHours>8760)) throw new RequestError(400,'invalid_invite_expiry');
    let target=null;
    if (kind==='device') {
      if (typeof profileUid!=='string' || !uidPattern.test(profileUid) || !account.get(profileUid)) throw new RequestError(404,'profile_missing');
      manageProfile(uid,profileUid);
      requireUnbanned(profileUid);
      target=profileUid;
    }
    const title=label(body.label,80,'invalid_invite_label','');
    const id=randomUUID();
    const code='HN-'+randomBytes(18).toString('base64url');
    const time=Math.trunc(now());
    addInvite.run(id,hash(code),kind,target,uid,title,time,ttlHours==null?null:time+ttlHours*3_600_000);
    const result={invite:publicInvite(inviteById.get(id),time),code};
    const origin=typeof publicOrigin==='function'?publicOrigin():publicOrigin;
    const url=typeof origin==='string'&&URL.canParse(origin)?new URL(origin):null;
    if (url && ['https:','http:'].includes(url.protocol)) {
      url.hash=`invite=${encodeURIComponent(code)}`;
      result.url=url.toString();
    }
    return result;
  }

  function revokeInvite(uid,id) {
    authorize(uid);
    const invite=typeof id==='string'&&uidPattern.test(id)?inviteById.get(id):undefined;
    if (!invite) throw new RequestError(404,'invite_missing');
    if (invite.kind==='admin' && uid!==owner()) throw new RequestError(403,'owner_required');
    if (invite.kind==='device') manageProfile(uid,invite.profileUid);
    disableInvite.run(Math.trunc(now()),id);
    return {ok:true};
  }

  function revokeDevice(credential,id=credential.deviceId,own=true) {
    if (!own) authorize(credential.uid);
    if (typeof id!=='string' || !uidPattern.test(id)) throw new RequestError(404,'device_missing');
    const device=byDeviceId.get(id);
    if (!device || own&&device.uid!==credential.uid) throw new RequestError(404,'device_missing');
    if (!own) manageProfile(credential.uid,device.uid);
    if (disableDevice.run(Math.trunc(now()),id).changes) revokeStream(id);
    return {ok:true};
  }

  return {authenticate,signIn,bootstrap,view,isAdmin,requireUnbanned,adminTarget,setRole,setBan,listAdmin,listUids,issue,revokeInvite,revokeDevice,profiles:()=>profileList.all(),account:uid=>
    typeof uid==='string'&&uidPattern.test(uid)?account.get(uid):undefined,
  npcEditor:{available:singlePlayer||Boolean(expected),isAdmin,require(uid) {
    if (!isAdmin(uid)) throw new RequestError(403,'npc_editor_required');
  }}};
}
