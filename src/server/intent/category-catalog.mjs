// Deterministic full catalog verification. No credentials, network or disk on import.
import { createHash } from 'node:crypto';
const safeFailure = () => ({ error_code: 'CATALOG_FETCH_FAILED' });

export class CatalogError extends Error {}
const fail = code => { throw new CatalogError(code); };
const identifier = value => typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...values].sort(compare);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sizeOf = text => ({characters:[...text].length, utf8_bytes:Buffer.byteLength(text,'utf8')});

function projectItem(item, regionId, depth=0) {
  if(depth>24) fail('TREE_DEPTH_EXCEEDED');
  if(!item || !identifier(item.id) || item.id==='0') fail('INVALID_CATEGORY_ID');
  if(typeof item.name!=='string' || !item.name.trim() || item.name.length>10000) fail('INVALID_CATEGORY_NAME');
  if(!['general_rubric','rubric'].includes(item.type)) fail('UNKNOWN_CATEGORY_TYPE');
  if(item.region_id!==undefined && item.region_id!==regionId) fail('REGION_MISMATCH');
  const result={id:item.id,name:item.name,type:item.type};
  if(item.region_id!==undefined) result.region_id=item.region_id;
  if(item.caption!==undefined){
    if(typeof item.caption!=='string' || item.caption.length>10000) fail('INVALID_CAPTION');
    result.caption=item.caption;
  }
  if(item.parent_id!==undefined){
    if(!identifier(item.parent_id)) fail('INVALID_PARENT_ID');
    result.parent_id=item.parent_id;
  }
  if(item.rubrics!==undefined){
    if(!Array.isArray(item.rubrics)) fail('INVALID_NESTED_ARRAY');
    if(item.type==='rubric' && item.rubrics.length) fail('CHILDREN_ON_LEAF');
    result.rubrics=item.rubrics.map(child=>projectItem(child,regionId,depth+1));
  }
  return result;
}

export function projectResponse(response, regionId) {
  if(response?.http_status!==200) fail('HTTP_ERROR');
  const body=response.body;
  if(body?.meta?.code!==200) fail('PROVIDER_ERROR');
  if(!Array.isArray(body?.result?.items) || !Number.isSafeInteger(body.result.total) || body.result.total<0) fail('INVALID_PAGE');
  if(typeof body.meta.issue_date!=='string' || !body.meta.issue_date || typeof body.meta.api_version!=='string') fail('MISSING_PROVIDER_VERSION');
  return {meta:{code:200,issue_date:body.meta.issue_date,api_version:body.meta.api_version},
    total:body.result.total,items:body.result.items.map(item=>projectItem(item,regionId))};
}

// Production reads the provider's complete root page, including its embedded
// child rubrics, in one request. It does not persist or reuse the result across
// user requests. The deeper per-parent verification below remains for bounded
// offline evaluation, where completeness must be independently cross-checked.
export async function collectEmbeddedCatalog({regionId,fetchRoot}) {
  const summary={complete:false,region_id:regionId,http_calls:0,
    completeness_scope:'Categories API /list embedded root tree, requested region only',
    verification_method:'single_response_embedded_tree',atomic_snapshot_guaranteed:true,
    raw_provider_payload_persisted:false,sent_to_llm:false};
  try {
    if(!identifier(regionId) || regionId==='0') fail('INVALID_OPTIONS');
    summary.http_calls=1;
    const projected=projectResponse(await fetchRoot({regionId}),regionId);
    if(projected.items.length!==projected.total || projected.total===0) fail('INCOMPLETE_ROOT_PAGE');
    const roots=[], nodes=new Map();
    for(const root of projected.items){
      if(root.type!=='general_rubric' || !Array.isArray(root.rubrics)) fail('INCOMPLETE_EMBEDDED_TREE');
      if(nodes.has(root.id)) fail('DUPLICATE_CATEGORY_ID');
      roots.push(root.id);
      nodes.set(root.id,{id:root.id,name:root.name,type:root.type,caption:root.caption??null,
        parent_ids:[],declared_parent_ids:[]});
      for(const child of root.rubrics){
        if(child.type!=='rubric' || (child.rubrics?.length??0)>0 || child.parent_id!==root.id || nodes.has(child.id))
          fail('INVALID_EMBEDDED_CHILD');
        nodes.set(child.id,{id:child.id,name:child.name,type:child.type,caption:child.caption??null,
          parent_ids:[root.id],declared_parent_ids:[root.id]});
      }
    }
    const items=[...nodes.values()].sort((a,b)=>compare(a.id,b.id));
    const catalog={version:'',format:'2gis-category-catalog.v1',region_id:regionId,complete:true,
      provider_version:{issue_date:projected.meta.issue_date,api_version:projected.meta.api_version},
      roots:sorted(roots),items};
    const {version:unusedVersion,...versionInput}=catalog;
    catalog.version=`2gis:${regionId}:${sha256(JSON.stringify(versionInput))}`;
    Object.assign(summary,{complete:true,root_categories:roots.length,unique_categories:items.length,
      leaf_categories:items.length-roots.length,version:catalog.version});
    return {summary,catalog};
  } catch(error) {
    summary.error_code=error instanceof CatalogError ? error.message : safeFailure(error).error_code;
    return {summary,catalog:null};
  }
}

export async function collectCatalog({regionId,fetchPage,pageSize=10000,maxCalls=40,onProgress=()=>{}}) {
  const summary={complete:false,region_id:regionId,http_calls:0,verified_parent_lists:0,nested_sets_verified:0,
    exact_tokens:null,sent_to_llm:false,raw_provider_payload_persisted:false,
    completeness_scope:'Categories API /list, requested region only; not all geographic objects or all Russia',
    atomic_snapshot_guaranteed:false};
  const pages=[], nodes=new Map(), expectations=new Map(), directLists=new Map(), queue=['0'];
  const scheduled=new Set(queue);
  let providerVersion=null;
  const observe = (item,parentId) => {
    let n=nodes.get(item.id);
    if(n && (n.name!==item.name || n.type!==item.type ||
      (n.caption!==null && item.caption!==undefined && n.caption!==item.caption))) fail('CATEGORY_CONFLICT');
    if(!n){n={id:item.id,name:item.name,type:item.type,caption:item.caption??null,parent_ids:new Set(),declared_parent_ids:new Set()};nodes.set(item.id,n);}
    if(n.caption===null && item.caption!==undefined) n.caption=item.caption;
    if(parentId!=='0') n.parent_ids.add(parentId);
    if(item.parent_id!==undefined && item.parent_id!=='0') n.declared_parent_ids.add(item.parent_id);
    if(item.type==='general_rubric' && !scheduled.has(item.id)){scheduled.add(item.id);queue.push(item.id);}
    if(item.type==='general_rubric' && item.rubrics!==undefined){
      const ids=item.rubrics.map(child=>child.id);
      if(new Set(ids).size!==ids.length) fail('DUPLICATE_NESTED_ID');
      const expected=sorted(ids);
      if(expectations.has(item.id) && !equal(expectations.get(item.id),expected)) fail('NESTED_SET_CHANGED');
      expectations.set(item.id,expected);
    }
    for(const child of item.rubrics??[]) observe(child,item.id);
  };
  try{
    if(!identifier(regionId) || regionId==='0' || !Number.isInteger(pageSize) || pageSize<1 || pageSize>10000 ||
      !Number.isInteger(maxCalls) || maxCalls<1 || maxCalls>40) fail('INVALID_OPTIONS');
    for(let index=0;index<queue.length;index++){
      const parentId=queue[index], ids=new Set();
      let total=null;
      for(let page=1;total===null || ids.size<total;page++){
        if(summary.http_calls>=maxCalls) fail('CALL_BUDGET_EXCEEDED');
        summary.http_calls++;
        onProgress({call:summary.http_calls,maximum:maxCalls,parent_id:parentId,page});
        const response=await fetchPage({regionId,parentId,page,pageSize});
        summary.last_http_status=Number.isInteger(response?.http_status)?response.http_status:null;
        summary.last_provider_code=Number.isInteger(response?.body?.meta?.code)?response.body.meta.code:null;
        const projected=projectResponse(response,regionId);
        const currentVersion={issue_date:projected.meta.issue_date,api_version:projected.meta.api_version};
        if(providerVersion && !equal(providerVersion,currentVersion)) fail('PROVIDER_VERSION_CHANGED');
        providerVersion=currentVersion;
        if(total!==null && total!==projected.total) fail('TOTAL_CHANGED');
        total=projected.total;
        for(const item of projected.items){
          if(ids.has(item.id)) fail('DUPLICATE_PAGE_ID');
          ids.add(item.id);
          observe(item,parentId);
        }
        const expectedLength=Math.min(pageSize,Math.max(0,total-(page-1)*pageSize));
        if(projected.items.length!==expectedLength || ids.size>total) fail('INCOMPLETE_PAGE');
        pages.push({parent_id:parentId,page,page_size:pageSize,...projected});
        if(total===0) break;
      }
      directLists.set(parentId,sorted(ids));
      summary.verified_parent_lists++;
      if(expectations.has(parentId)){
        if(!equal(expectations.get(parentId),sorted(ids))) fail('NESTED_SET_MISMATCH');
        summary.nested_sets_verified++;
      }
    }
    // Recheck after all observations, including a nested group shared by several parents.
    for(const [id,expected] of expectations){
      if(!equal(expected,directLists.get(id))) fail('NESTED_SET_MISMATCH');
    }
    const visited=new Set(), active=new Set();
    const visit = id => {
      if(active.has(id)) fail('CATEGORY_CYCLE');
      if(visited.has(id)) return;
      active.add(id);
      for(const childId of directLists.get(id)??[]) visit(childId);
      active.delete(id); visited.add(id);
    };
    visit('0');
    for(const n of nodes.values()){
      if(!visited.has(n.id)) fail('UNREACHABLE_CATEGORY');
      for(const parentId of n.declared_parent_ids){
        if(!nodes.has(parentId)) fail('UNKNOWN_DECLARED_PARENT');
        if(!n.parent_ids.has(parentId)) fail('DECLARED_PARENT_NOT_MEMBERSHIP');
      }
    }
    const items=[...nodes.values()].map(n=>({...n,parent_ids:sorted(n.parent_ids),declared_parent_ids:sorted(n.declared_parent_ids)}))
      .sort((a,b)=>compare(a.id,b.id));
    const catalog={version:'',format:'2gis-category-catalog.v1',region_id:regionId,complete:true,provider_version:providerVersion,
      roots:directLists.get('0'),items};
    const {version: unusedVersion, ...versionInput}=catalog;
    catalog.version=`2gis:${regionId}:${sha256(JSON.stringify(versionInput))}`;
    summary.complete=true;
    Object.assign(summary,{root_categories:catalog.roots.length,unique_categories:items.length,
      general_categories:items.filter(n=>n.type==='general_rubric').length,leaf_categories:items.filter(n=>n.type==='rubric').length,
      categories_with_multiple_parents:items.filter(n=>n.parent_ids.length>1).length,
      category_memberships:items.reduce((sum,n)=>sum+n.parent_ids.length,0),
      version:catalog.version,provider_version:providerVersion,
      canonical_size:sizeOf(JSON.stringify(catalog)),compact_size:sizeOf(JSON.stringify(compactCatalog(catalog)))});
    return {summary,pages,catalog};
  }catch(error){
    summary.error_code=error instanceof CatalogError ? error.message : safeFailure(error).error_code;
    return {summary,pages,catalog:null};
  }
}

const columns=['id','name','type','caption','parent_ids','declared_parent_ids'];
export function compactCatalog(catalog) {
  if(catalog?.complete!==true || catalog?.format!=='2gis-category-catalog.v1') fail('INCOMPLETE_CATALOG');
  const {items,...metadata}=catalog;
  return {...metadata,format:'2gis-category-catalog.rows.v1',columns,rows:items.map(n=>columns.map(key=>n[key]))};
}
export function expandCompact(compact) {
  if(compact?.format!=='2gis-category-catalog.rows.v1' || !equal(compact.columns,columns) || !Array.isArray(compact.rows)) fail('INVALID_COMPACT_FORMAT');
  const {columns:unused,rows,...metadata}=compact;
  return {...metadata,format:'2gis-category-catalog.v1',items:rows.map(row=>{
    if(!Array.isArray(row) || row.length!==columns.length) fail('INVALID_COMPACT_ROW');
    return Object.fromEntries(columns.map((key,index)=>[key,row[index]]));
  })};
}
