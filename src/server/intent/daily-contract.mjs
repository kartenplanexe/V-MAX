// Frozen v0.8 contract port. Pure validation: no network, credentials or draft writes.
import fs from 'node:fs';
import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
const Ajv = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;
export const schema = JSON.parse(fs.readFileSync(new URL('./intent-parser-response-v0.2.schema.json',import.meta.url),'utf8'));
const ajv = new Ajv({strict:true,allErrors:true}); addFormats(ajv);
const shape = ajv.compile(schema);
// All unions already consist of closed objects, so no v0.1 branch distribution.
export const wireSchema = structuredClone(schema);
function adapt(node) {
  if (!node || typeof node!=='object') return;
  if (!Array.isArray(node)) {
    delete node.uniqueItems;
    if(node.oneOf) {node.anyOf=node.oneOf;delete node.oneOf;}
  }
  Object.values(node).forEach(adapt);
}
adapt(wireSchema);

export function buildDailyRequest(input) {
  // Allowlist: never include evaluation expectations or guard authorization.
  const {mode,now,locality_context,draft,pending_question,catalog,user_text}=input;
  return {model:'gpt://<folder-id>/aliceai-llm-flash',temperature:0,max_tokens:4096,stream:false,
    messages:[{role:'system',content:fs.readFileSync(new URL('./intent-parser-system-v0.8.md',import.meta.url),'utf8')},
      {role:'user',content:JSON.stringify({mode,now,locality_context,draft,pending_question,catalog,user_text})}],
    response_format:{type:'json_schema',json_schema:{name:'leisure_intent_parser_v02',schema:wireSchema}}};
}

export function validateDailyProposal(raw,input) {
  const result={status:'invalid_response',errors:[],reasons:[],normalizations:[],proposal:null,
    context_binding:{input_id:input?.input_id??null,base_revision:input?.draft?.revision??null,catalog_version:input?.catalog?.version??null},
    semantic_guarantee:false,ready_for_planning:false};
  const err=new Set(),reason=new Set();
  const check=(condition,code)=>{if(!condition)err.add(code);};
  if(!input || typeof input.user_text!=='string' || !['parse','map_categories'].includes(input.mode) ||
    (input.draft!==null && (!Array.isArray(input.draft?.days)||!Number.isSafeInteger(input.draft?.revision)))) {
    return {...result,status:'invalid_context',errors:['INPUT_CONTEXT']};
  }
  const draftDays=input.draft?.days??[],catalogRows=input.catalog?.rows??[];
  if(!Array.isArray(catalogRows)||catalogRows.some(r=>!Array.isArray(r)||![3,4].includes(r.length)||
    typeof r[0]!=='string'||typeof r[1]!=='string'||!Array.isArray(r[2])||r[2].some(id=>typeof id!=='string')||
    (r.length===4 && (!r[3]||typeof r[3]!=='object'||Array.isArray(r[3])||!['rubric','general_rubric'].includes(r[3].type??'rubric'))))||
    new Set(catalogRows.map(r=>r[0])).size!==catalogRows.length||
    draftDays.some(d=>!d||typeof d.day_id!=='string'||!Array.isArray(d.activities)||!Array.isArray(d.order)||
      d.activities.some(a=>!a||typeof a.id!=='string')||new Set(d.activities.map(a=>a.id)).size!==d.activities.length||
      d.order.some(e=>!Array.isArray(e)||e.length!==2||e.some(id=>typeof id!=='string')))) {
    return {...result,status:'invalid_context',errors:['INPUT_CONTEXT']};
  }
  if(!shape(raw)) return {...result,errors:['SCHEMA'],schema_errors:structuredClone(shape.errors)};
  const p=structuredClone(raw);
  function quote(holder,key,source,location) {
    const q=holder[key];if(q===null || q===undefined)return;
    if(source.includes(q))return;
    const folded=source.toLocaleLowerCase('ru'),needle=q.toLocaleLowerCase('ru');
    const first=folded.indexOf(needle);
    if(first>=0 && folded.indexOf(needle,first+1)<0 && source.slice(first,first+q.length).toLocaleLowerCase('ru')===needle) {
      holder[key]=source.slice(first,first+q.length);
      result.normalizations.push({kind:'quote_case_only',path:location,from:q,to:holder[key]});
    } else err.add('UNSUPPORTED_EVIDENCE');
  }
  function quotes(node,source,location='') {
    if(!node || typeof node!=='object')return;
    for(const [key,value] of Object.entries(node)) {
      const loc=`${location}/${key}`;
      if(['evidence','date_evidence','scope_evidence'].includes(key))quote(node,key,source,loc);
      else if(value && typeof value==='object')quotes(value,source,loc);
    }
  }
  const noMutation=p.days.length===0 && p.shared_updates.length===0 && p.date_anchor===null;
  if(['off_topic','unclear'].includes(p.action)) check(noMutation,'NON_PLANNING_MUTATION');
  if(p.action==='off_topic')check(p.unresolved.length===0,'OFF_TOPIC_UNRESOLVED');
  if(p.action==='unclear')check(p.unresolved.length>0,'UNCLEAR_WITHOUT_REASON');
  if(p.action==='new_request')check(p.days.length>0,'EMPTY_NEW_REQUEST');
  if(p.action==='update_draft') {check(input.draft!==null,'DRAFT_REQUIRED');check(!noMutation,'EMPTY_UPDATE');}
  if(p.action!=='new_request')check(p.date_anchor===null,'ANCHOR_ON_UPDATE');
  check((p.action==='map_categories')===(input.mode==='map_categories'),'MODE_MISMATCH');
  if(p.action==='map_categories')check(input.draft!==null && p.shared_updates.length===0 && p.unresolved.length===0,'ENRICHMENT_MUTATION');
  quotes(p.date_anchor,input.user_text,'/date_anchor');quotes(p.shared_updates,input.user_text,'/shared_updates');
  const unique=(arr,code)=>check(new Set(arr).size===arr.length,code);
  unique(p.shared_updates.map(u=>u.field),'DUPLICATE_FIELD');
  if(p.action==='new_request')check(p.shared_updates.every(u=>u.op!=='clear'),'CLEAR_WITHOUT_DRAFT');
  for(const u of p.shared_updates)if(u.field==='mobility' && u.op==='set')unique(u.value,'DUPLICATE_VALUE');
  const previous=new Map((input.draft?.days??[]).map(d=>[d.day_id,d]));
  if(previous.size!==(input.draft?.days.length??0))return {...result,status:'invalid_context',errors:['DUPLICATE_DRAFT_DAY']};
  const dayIds=p.days.map(d=>d.day_id);unique(dayIds,'DAY_ID');
  const grant=input.scope_grant;
  const granted=grant && grant.input_id===input.input_id && grant.base_revision===input.draft?.revision &&
    Array.isArray(grant.day_ids) && grant.day_ids.every(id=>previous.has(id)) ? grant.day_ids : [];
  const rows=input.catalog?.rows??[];
  const leaves=new Set(rows.filter(r=>Array.isArray(r) && (r[3]?.type??'rubric')==='rubric').map(r=>r[0]));
  const available=input.catalog?.complete===true && typeof input.catalog?.version==='string' &&
    typeof input.catalog?.region_id==='string' && input.catalog.region_id===input.locality_context?.region_id &&
    !p.shared_updates.some(u=>u.field==='locality_text' && (u.op!=='set' || typeof u.value!=='string' ||
      u.value.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu,'е') !== input.locality_context?.name?.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu,'е')));
  const offsets=[],dates=[];
  for(const [di,d] of p.days.entries()) {
    const loc=`/days/${di}`,old=previous.get(d.day_id);
    if(p.action==='new_request') {
      check(d.day_id===`new:${di+1}`,'DAY_ID');check(d.date!==null,'MISSING_NEW_DATE');
      if(d.date?.kind==='anchor_offset')offsets.push(d.date.days);
      if(d.date!==null)dates.push(JSON.stringify([d.date.kind,d.date.days,d.date.date,d.date.weekday,d.date.relation]));
    } else {
      check(Boolean(old),'UNKNOWN_DAY');check(d.date?.kind!=='anchor_offset','OFFSET_ON_UPDATE');
      const changed=d.date!==null||d.time_updates.length||d.activity_edits.length||d.order_changes.length;
      if(changed && previous.size>1 && input.draft.active_day_id!==d.day_id && !granted.includes(d.day_id))reason.add('UNCONFIRMED_DAY_SCOPE');
      if(p.action==='update_draft')check(Boolean(changed),'EMPTY_DAY_PATCH');
    }
    if(d.date && d.date.kind!=='anchor_offset')check(d.date_evidence!==null,'DATE_WITHOUT_EVIDENCE');
    quote(d,'date_evidence',input.user_text,`${loc}/date_evidence`);quote(d,'scope_evidence',input.user_text,`${loc}/scope_evidence`);
    quotes(d.time_updates,input.user_text,`${loc}/time_updates`);quotes(d.activity_edits,input.user_text,`${loc}/activity_edits`);quotes(d.order_changes,input.user_text,`${loc}/order_changes`);
    unique(d.time_updates.map(u=>u.field),'DUPLICATE_FIELD');
    if(p.action==='new_request')check(d.time_updates.every(u=>u.op!=='clear'),'CLEAR_WITHOUT_DRAFT');
    const effective={...(p.action==='new_request'?{}:old?.time??{})};
    for(const u of d.time_updates)if(u.op==='clear')delete effective[u.field];else effective[u.field]=u.value;
    const minutes=s=>typeof s==='string'&&/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s)?Number(s.slice(0,2))*60+Number(s.slice(3)):null;
    const start=minutes(effective.start),end=minutes(effective.end);
    if(start!==null&&end!==null&&(end<=start||effective.duration_minutes>end-start))reason.add('TIME_CONFLICT');
    if(p.action==='map_categories')check(d.date===null && !d.time_updates.length && !d.activity_edits.length && !d.order_changes.length,'ENRICHMENT_MUTATION');
    const existing=new Map((p.action==='new_request'?[]:old?.activities??[]).map(a=>[a.id,a]));
    const active=new Map(existing),touched=[];
    let next=1;
    for(const a of d.activity_edits) {
      touched.push(a.activity_id);
      if(a.op==='add') {check(a.activity_id===`new:${next++}` && !active.has(a.activity_id),'ACTIVITY_ID');active.set(a.activity_id,a);}
      else {check(existing.has(a.activity_id),'ACTIVITY_REFERENCE');if(a.op==='remove')active.delete(a.activity_id);else active.set(a.activity_id,a);}
      if(a.op!=='remove') {
        check(a.selection.category_policy!=='named_types_only'||a.selection.named_types.length>0,'STRICT_WITHOUT_TYPES');
        unique(a.selection.named_types,'DUPLICATE_VALUE');
      }
    }
    unique(touched,'DUPLICATE_ACTIVITY_EDIT');
    const expected=p.action==='map_categories'?[...active.keys()]:d.activity_edits.filter(a=>a.op!=='remove').map(a=>a.activity_id);
    unique(d.category_matches.map(c=>c.activity_id),'DUPLICATE_CATEGORY_MATCH');
    check(expected.length===d.category_matches.length && expected.every(id=>d.category_matches.some(c=>c.activity_id===id)),'CATEGORY_COVERAGE');
    for(const c of d.category_matches) {
      check(active.has(c.activity_id),'ACTIVITY_REFERENCE');
      const source=p.action==='map_categories'?existing.get(c.activity_id)?.source_text??'':input.user_text;
      quotes(c,source,`${loc}/category_matches/${c.activity_id}`);
      check(available?c.state!=='catalog_unavailable':c.state==='catalog_unavailable','CATALOG_STATE');
      if(c.state==='matched')check(c.include_any.length>0,'EMPTY_MATCH');
      else check(!c.include_any.length && !c.exclude.length,'NONEMPTY_UNMATCHED');
      unique(c.include_any,'DUPLICATE_CATEGORY');unique(c.exclude,'DUPLICATE_CATEGORY');
      check([...c.include_any,...c.exclude].every(id=>leaves.has(id)),'CATEGORY_ID');
      check(c.include_any.every(id=>!c.exclude.includes(id)),'CATEGORY_OVERLAP');
    }
    const edges=new Set((p.action==='new_request'?[]:old?.order??[]).filter(([a,b])=>active.has(a)&&active.has(b)).map(e=>JSON.stringify(e)));
    for(const e of d.order_changes) {
      check(active.has(e.before)&&active.has(e.after),'ACTIVITY_REFERENCE');
      const key=JSON.stringify([e.before,e.after]);
      if(e.op==='remove'){check(edges.has(key),'UNKNOWN_ORDER');edges.delete(key);}else {check(!edges.has(key),'DUPLICATE_ORDER');edges.add(key);}
    }
    const adjacency=new Map([...active.keys()].map(id=>[id,[]]));
    for(const e of edges){const [a,b]=JSON.parse(e);adjacency.get(a)?.push(b);}
    const visiting=new Set(),done=new Set();
    function acyclic(id){if(visiting.has(id))return false;if(done.has(id))return true;visiting.add(id);for(const to of adjacency.get(id)??[])if(!acyclic(to))return false;visiting.delete(id);done.add(id);return true;}
    check([...active.keys()].every(acyclic),'ORDER_CYCLE');
  }
  if(p.action==='new_request') {
    unique(dates,'DUPLICATE_DATE');
    check(!offsets.length || (offsets.length===p.days.length && offsets.every((n,i)=>n===i)),'NONCONTIGUOUS_OFFSETS');
    check(p.date_anchor===null || offsets.length===p.days.length,'ANCHOR_WITHOUT_OFFSETS');
  }
  if(p.action==='map_categories')check(dayIds.length===previous.size && [...previous.keys()].every(id=>dayIds.includes(id)),'ENRICHMENT_DAY_COVERAGE');
  for(const [i,u] of p.unresolved.entries()) {
    quote(u,'text',input.user_text,`/unresolved/${i}/text`);unique(u.day_ids,'DUPLICATE_DAY_REFERENCE');
    check(u.day_ids.every(id=>p.action==='new_request'?dayIds.includes(id):previous.has(id)),'UNKNOWN_DAY');
  }
  if(p.unresolved.length)reason.add('UNRESOLVED');
  result.errors=[...err];result.reasons=[...reason];
  if(err.size)return result;
  if(reason.size)return {...result,status:'needs_clarification'};
  return {...result,status:p.action==='off_topic'?'no_change':result.normalizations.length?'normalized_proposal':'validated_proposal',proposal:p};
}
