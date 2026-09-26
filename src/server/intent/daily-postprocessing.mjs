// Pure research compatibility/safety layer. Legacy guard, prompts and live reports stay frozen.
import {isDeepStrictEqual as equal} from 'node:util';
import {validateDailyProposal} from './daily-contract.mjs';
export const postprocessingVersion='daily-postprocessing.v1';

export function reviewDailyResponse(raw,input) {
  const original=validateDailyProposal(raw,input);
  let checked=original;
  const repairs=[];
  if(original.errors.includes('ANCHOR_WITHOUT_OFFSETS')&&raw.action==='new_request'&&raw.days.length===1&&
    raw.date_anchor&&raw.days[0].date?.kind!=='anchor_offset'&&equal(raw.date_anchor.value,raw.days[0].date)) {
    const copy=structuredClone(raw);
    repairs.push({kind:'redundant_identical_date_anchor',path:'/date_anchor',from:copy.date_anchor,to:null});
    copy.date_anchor=null;
    checked=validateDailyProposal(copy,input);
  }
  // A single explicit «завтра» has a deterministic date regardless of whether
  // the model redundantly used an anchor and offset=1. Repair only date fields;
  // all category/evidence/intent checks still run on the complete proposal.
  const tomorrow=typeof input.user_text==='string'
    ? /(?<![\p{L}\p{N}])завтра(?![\p{L}\p{N}])/iu.exec(input.user_text)?.[0] : null;
  const dateErrors=['NONCONTIGUOUS_OFFSETS','ANCHOR_WITHOUT_OFFSETS'];
  const safeErrors=checked.errors.every(error=>dateErrors.includes(error)||error==='CATEGORY_ID');
  const otherDate=typeof input.user_text==='string' &&
    /(?<!\p{L})(?:сегодня|послезавтра|после\s+завтра|вчера|не\s+завтра|несколько\s+дней|\d+\s*(?:день|дня|дней))(?!\p{L})/iu.test(input.user_text);
  if(tomorrow&&safeErrors&&checked.errors.some(error=>dateErrors.includes(error))&&
    raw?.action==='new_request'&&raw.days?.length===1&&!otherDate) {
    const copy=structuredClone(raw);
    copy.date_anchor=null;
    copy.days[0].date={kind:'relative',days:1};
    copy.days[0].date_evidence=tomorrow;
    const fixed=validateDailyProposal(copy,input);
    if(fixed.errors.length<checked.errors.length) {
      repairs.push({kind:'explicit_tomorrow_single_day',path:'/days/0/date',from:raw.days[0].date,to:copy.days[0].date});
      checked=fixed;
    }
  }
  const result={...checked,original_status:original.status,original_errors:original.errors,
    postprocessing_version:postprocessingVersion,normalizations:[...repairs,...checked.normalizations],strict_checks:[]};
  if(!result.proposal)return result;
  if(repairs.length)result.status='normalized_proposal';
  const normalize=name=>name.trim().toLocaleLowerCase('ru');
  const leaves=(input.catalog?.rows??[]).filter(row=>(row[3]?.type??'rubric')==='rubric');
  for(const d of result.proposal.days) {
    const activities=result.proposal.action==='map_categories'
      ? input.draft.days.find(day=>day.day_id===d.day_id).activities.map(a=>({...a,activity_id:a.id}))
      : d.activity_edits;
    for(const a of activities) {
      if(a.selection?.category_policy!=='named_types_only')continue;
      const match=d.category_matches.find(c=>c.activity_id===a.activity_id);
      if(match?.state!=='matched')continue;
      const mapped=a.selection.named_types.map(name=>leaves.filter(row=>normalize(row[1])===normalize(name)));
      const resolvable=mapped.length>0&&mapped.every(rows=>rows.length===1);
      const allowed=new Set(mapped.flatMap(rows=>rows.map(row=>row[0])));
      const mismatch=resolvable&&match.include_any.some(id=>!allowed.has(id));
      result.strict_checks.push({day_id:d.day_id,activity_id:a.activity_id,state:!resolvable?'unverified':mismatch?'mismatch':'verified'});
      if(!resolvable)result.reasons.push('STRICT_TYPE_UNVERIFIED');
      if(mismatch)result.errors.push('STRICT_CATEGORY_MISMATCH');
    }
  }
  result.errors=[...new Set(result.errors)];result.reasons=[...new Set(result.reasons)];
  if(result.errors.length){result.status='invalid_response';result.proposal=null;}
  else if(result.reasons.length){result.status='needs_clarification';result.proposal=null;}
  return result;
}

export function assessClarificationAudit(raw,input) {
  const guard=validateDailyProposal(raw,input);
  const pass=guard.status==='needs_clarification'&&guard.errors.length===0&&raw.action==='unclear'&&
    raw.days.length===0&&raw.shared_updates.length===0&&raw.date_anchor===null&&raw.unresolved.length>0&&
    raw.unresolved.every(u=>u.field==='scope'&&u.reason==='ambiguous');
  return {audit_version:'scope-clarification-audit.v2',pass,guard,
    limitation:'Post-hoc semantic audit; candidate day IDs are not a scope grant. The original live evaluation is unchanged.'};
}

export function applyDailyTimePatch(raw,input,currentDraft) {
  const guard=reviewDailyResponse(raw,input);
  const result={status:guard.status,draft:structuredClone(currentDraft),guard,ready_for_planning:false};
  if(!equal(currentDraft,input.draft))return {...result,status:'stale_context'};
  if(!guard.proposal)return result;
  const p=guard.proposal;
  if(p.action!=='update_draft'||p.shared_updates.length||p.days.some(d=>d.date!==null||d.activity_edits.length||d.order_changes.length||d.category_matches.length)) {
    return {...result,status:'unsupported_patch'};
  }
  for(const change of p.days) {
    const day=result.draft.days.find(d=>d.day_id===change.day_id);
    day.time??={};
    for(const update of change.time_updates) {
      if(update.op==='clear')delete day.time[update.field];
      else day.time[update.field]=update.value;
    }
  }
  if(equal(result.draft,currentDraft))return {...result,status:'no_change'};
  result.draft.revision++;
  return {...result,status:'applied'};
}
