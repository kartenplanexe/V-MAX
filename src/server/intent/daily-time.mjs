// Pure research projection: suggestions never overwrite extracted user fields.
import fs from 'node:fs';
import {reviewDailyResponse} from './daily-postprocessing.mjs';
const policy=JSON.parse(fs.readFileSync(new URL('./time-default-policy.v1.json',import.meta.url),'utf8'));
const minute=text=>typeof text==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(text)?Number(text.slice(0,2))*60+Number(text.slice(3)):null;
const clock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
function validDate(date) {
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const parsed=Date.parse(date+'T12:00:00Z');
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===date;
}
function addDays(date,days) {
  if(!validDate(date)||!Number.isSafeInteger(days))throw new Error('INVALID_DATE');
  const value=new Date(Date.parse(date+'T12:00:00Z')+days*86400000);
  if(!Number.isFinite(value.getTime()))throw new Error('INVALID_DATE');
  const result=value.toISOString().slice(0,10);
  if(!validDate(result))throw new Error('INVALID_DATE');
  return result;
}
function localClock(now,timezone) {
  if(typeof timezone!=='string'||!timezone||typeof now!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(now))throw new Error('TIME_CONTEXT_REQUIRED');
  const instant=new Date(now);
  if(!Number.isFinite(instant.getTime()))throw new Error('TIME_CONTEXT_REQUIRED');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,minutes:Number(parts.hour)*60+Number(parts.minute)+Number(parts.second)/60};
}

export function resolveDateReference(ref,today,anchor=today) {
  if(!validDate(today)||!ref)throw new Error('INVALID_DATE');
  if(ref.kind==='absolute') {if(!validDate(ref.date))throw new Error('INVALID_DATE');return ref.date;}
  if(ref.kind==='relative')return addDays(today,ref.days);
  if(ref.kind==='anchor_offset')return addDays(anchor,ref.days);
  if(ref.kind==='weekday'&&Number.isInteger(ref.weekday)&&ref.weekday>=1&&ref.weekday<=7) {
    const weekday=new Date(today+'T12:00:00Z').getUTCDay()||7;
    if(ref.relation==='this_week')return addDays(today,ref.weekday-weekday);
    if(ref.relation==='next_week')return addDays(today,ref.weekday-weekday+7);
    if(ref.relation==='upcoming')return addDays(today,(ref.weekday-weekday+7)%7);
  }
  throw new Error('INVALID_DATE_REFERENCE');
}

export function suggestDayWindow({date=null,dateOrigin=null,time={},now,timezone}) {
  const result={status:'needs_clarification',policy_version:policy.version,date,window:null,
    origins:{date:dateOrigin??(date?'user':'suggested_today'),start:null,end:null},
    duration_constraint_minutes:time?.duration_minutes??null,issues:[],requires_confirmation:true,ready_for_planning:false};
  let local;
  try{local=localClock(now,timezone);}catch{return {...result,issues:['TIME_CONTEXT_REQUIRED']};}
  result.date??=local.date;
  if(!validDate(result.date))return {...result,issues:['INVALID_DATE']};
  if(!time||typeof time!=='object'||Array.isArray(time)||Object.keys(time).some(key=>!['start','end','duration_minutes','period'].includes(key)))return {...result,issues:['INVALID_TIME']};
  if((time.start!==undefined&&minute(time.start)===null)||(time.end!==undefined&&minute(time.end)===null)||
    (time.duration_minutes!==undefined&&(!Number.isSafeInteger(time.duration_minutes)||time.duration_minutes<=0))||
    (time.period!==undefined&&!['morning','day','evening','night'].includes(time.period)))return {...result,issues:['INVALID_TIME']};
  const duration=time.duration_minutes??policy.duration_minutes;
  let start=minute(time.start),end=minute(time.end);
  if(start!==null)result.origins.start='user';
  if(end!==null)result.origins.end='user';
  if(start!==null&&end===null){end=start+duration;result.origins.end=time.duration_minutes===undefined?'suggested':'derived_from_duration';}
  else if(end!==null&&start===null){start=end-duration;result.origins.start=time.duration_minutes===undefined?'suggested':'derived_from_duration';}
  else if(start===null&&end===null) {
    const template=policy.periods[time.period];
    if(!template)return {...result,issues:[time.period==='night'?'NIGHT_WINDOW_REQUIRED':'START_REQUIRED']};
    start=minute(template.start);end=start+duration;
    result.origins.start='suggested';result.origins.end=time.duration_minutes===undefined?'suggested':'derived_from_duration';
  }
  if(start<0||end>=1440)return {...result,issues:['MIDNIGHT_CROSSING']};
  result.window={start:clock(start),end:clock(end)};
  if(end<=start||(time.duration_minutes!==undefined&&time.duration_minutes>end-start))result.issues.push('TIME_CONFLICT');
  if(result.date<local.date)result.issues.push('DATE_IN_PAST');
  else if(result.date===local.date) {
    if(end<=local.minutes)result.issues.push('WINDOW_EXPIRED');
    else if(start<local.minutes)result.issues.push('WINDOW_ALREADY_STARTED');
  }
  result.status=result.issues.length?'needs_clarification':'proposal';
  return result;
}

export function projectNewDailyIntent(raw,input) {
  const guard=reviewDailyResponse(raw,input);
  const result={status:guard.status,guard,days:[],shared_updates:[],requires_confirmation:true,ready_for_planning:false};
  if(!guard.proposal)return result;
  const p=guard.proposal;
  if(p.action!=='new_request')return {...result,status:'unsupported_projection'};
  const timezone=input.locality_context?.timezone;
  let today,anchor;
  try {
    today=localClock(input.now,timezone).date;
    anchor=p.date_anchor?resolveDateReference(p.date_anchor.value,today):today;
  }catch{return {...result,status:'needs_clarification',issues:['DATE_OR_TIME_CONTEXT_REQUIRED']};}
  const days=[];
  for(const d of p.days) {
    let date;
    try{date=resolveDateReference(d.date,today,anchor);}
    catch{return {...result,status:'needs_clarification',issues:['INVALID_DATE']};}
    const time=Object.fromEntries(d.time_updates.filter(u=>u.op==='set').map(u=>[u.field,u.value]));
    const dateOrigin=d.date.kind==='anchor_offset'&&!p.date_anchor
      ? d.date.days===0?'suggested_today':'derived_from_suggested_today'
      : 'user';
    days.push({day_id:d.day_id,...suggestDayWindow({date,dateOrigin,time,now:input.now,timezone})});
  }
  return {...result,status:days.every(d=>d.status==='proposal')?'proposal':'needs_clarification',
    days,shared_updates:structuredClone(p.shared_updates)};
}
