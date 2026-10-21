import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-canvas-tests-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', dir, path.join(root, 'web/src/graph.ts')], { cwd: dir });
// Keep the tests portable on Node 18+ without a TS execution loader.
for (const file of ['graph.js','presentation.js','canvas-state.js','types.js']) {
 const p = path.join(dir, file);
 fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace(/from '(\.\/[^']+)'/g, (_all, name) => `from '${name}.js'`));
}
fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module'}));
fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
const { detailLevel, groupFor, focusedIds, neighborInDirection } = await import(pathToFileURL(path.join(dir,'canvas-state.js')).href);
const { layoutOverview, project, layoutGraph, gridLayout, relationGroup, RELATION_GROUPS, hasTeachingData, orderedStages, layoutTeachingChain, layoutTeachingFiles, layoutTeachingHierarchy } = await import(pathToFileURL(dir+'/graph.js').href);
const { adaptRoute, roundedPath, routeValid } = await import(pathToFileURL(path.join(dir,'edge-route.js')).href);
const { filterNodes, filterActive, EMPTY_FILTER } = await import(pathToFileURL(path.join(dir,'presentation.js')).href);
const items = [
 {id:'g',type:'goal',title:'Goal'}, {id:'f',type:'finding',title:'Finding'},
 {id:'o',type:'observation',title:'Evidence'}, {id:'n',type:'note',title:'Unconnected'},
];
const snapshot = { meta:{focus:'o'}, nodes:items, edges:[{id:'e',from:'o',to:'f',kind:'proves'}] };

test('semantic zoom has three stable, explicit thresholds',()=>{
 assert.equal(detailLevel(.2),'overview'); assert.equal(detailLevel(.65),'compact'); assert.equal(detailLevel(.9),'detail');
});
test('grouping classifies content without changing node type or data',()=>{
 const before=JSON.stringify(items); const connected=new Set(['f','o']);
 assert.deepEqual(items.map(n=>groupFor(n,connected)),['purpose','findings','reasoning','inbox']);
 assert.equal(JSON.stringify(items),before);
});
test('focus follows only explicit one-hop edges, in either direction',()=>{
 const edges=[{source:'a',target:'b'},{source:'b',target:'c'},{source:'d',target:'a'}];
 assert.deepEqual([...focusedIds('a',edges)].sort(),['a','b','d']);
 assert.equal(focusedIds(null,edges).size,0);
});
test('overview preserves every real node and edge exactly once',()=>{
 const p=project(snapshot,'all',''); const before=JSON.stringify(p);
 const layout=layoutOverview(p.nodes,p.edges);
 assert.equal(layout.nodes.filter(n=>!n.data.group).length,items.length);
 assert.equal(layout.nodes.filter(n=>n.data.group).length,4);
 assert.deepEqual(layout.edges,p.edges);assert.equal(JSON.stringify(p),before);
 assert.equal(new Set(layout.nodes.map(n=>n.id)).size,layout.nodes.length);
});
test('overview children follow their frames and remain inside them',()=>{
 const layout=layoutOverview(project(snapshot,'all','').nodes,[]);
 for(const node of layout.nodes.filter(n=>!n.data.group)){
  const parent=layout.nodes.find(n=>n.id===node.parentId);
  assert.ok(parent && parent.data.group);
  assert.ok(node.position.x>=0 && node.position.y>=0);
  assert.ok(node.position.x+240<=parent.style.width);
  assert.ok(node.position.y+112<=parent.style.height);
 }
});
test('large overview layout has no overlapping children within a group',()=>{
 const nodes=Array.from({length:150},(_,i)=>({id:`n${i}`,type:'note',title:`Record ${i}`}));
 const layout=layoutOverview(project({meta:{},nodes,edges:[]},'all','').nodes,[]);
 const cells=layout.nodes.filter(n=>!n.data.group);
 for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){
  const a=cells[i],b=cells[j];
  assert.ok(Math.abs(a.position.x-b.position.x)>=240 || Math.abs(a.position.y-b.position.y)>=112);
 }
});
test('empty board adds no phantom display groups',()=>{
 assert.deepEqual(layoutOverview([],[]),{nodes:[],edges:[]});
});
test('regular layout keeps correct direction and no display-only parents',async()=>{
 const p=project(snapshot,'all','');const layout=await layoutGraph(p.nodes,p.edges,'DOWN');
 assert.equal(layout.nodes.length,4);
 assert.ok(layout.nodes.every(n=>n.data.direction==='DOWN' && !n.parentId));
});

test('narrow overview stacks frames vertically without overlaps',()=>{
 const p=project(snapshot,'all','');const layout=layoutOverview(p.nodes,p.edges,1);
 const frames=layout.nodes.filter(n=>n.data.group);
 assert.ok(frames.every(n=>n.position.x===0));
 for(let i=1;i<frames.length;i++) assert.ok(frames[i].position.y>=frames[i-1].position.y+frames[i-1].style.height);
});

test('arrow keys move only along explicit edges, toward the pressed side',()=>{
 const boxes=[{id:'a',x:0,y:0,w:100,h:50},{id:'r',x:300,y:0,w:100,h:50},{id:'r2',x:300,y:200,w:100,h:50},{id:'l',x:-300,y:0,w:100,h:50},{id:'far',x:600,y:0,w:100,h:50}];
 const edges=[{source:'a',target:'r'},{source:'a',target:'r2'},{source:'l',target:'a'}];
 assert.equal(neighborInDirection('a',boxes,edges,'ArrowRight'),'r');
 assert.equal(neighborInDirection('a',boxes,edges,'ArrowLeft'),'l');
 assert.equal(neighborInDirection('a',boxes,edges,'ArrowDown'),'r2');
 assert.equal(neighborInDirection('a',boxes,edges,'ArrowUp'),null);
 assert.equal(neighborInDirection(null,boxes,edges,'ArrowRight'),null);
 assert.equal(neighborInDirection('far',boxes,edges,'ArrowLeft'),null);
});
test('grid fallback layout never overlaps and keeps every node and edge',()=>{
 const nodes=Array.from({length:37},(_,i)=>({id:`n${i}`,type:'note',title:`N${i}`}));
 const p=project({meta:{},nodes,edges:[]},'all','');
 const out=gridLayout(p.nodes,p.edges,'DOWN');
 assert.equal(out.nodes.length,37);assert.ok(out.nodes.every(n=>n.data.direction==='DOWN'));
 const cells=new Set(out.nodes.map(n=>`${n.position.x},${n.position.y}`));assert.equal(cells.size,37);
});

test('sidebar filters: values within a facet are alternatives, facets narrow each other',()=>{
 const nodes=[
  {id:'a',type:'hypothesis',title:'A',status:'open'},
  {id:'b',type:'hypothesis',title:'B',status:'dead'},
  {id:'c',type:'finding',title:'C',status:'confirmed',severity:'high',confidence:'reproduced'},
  {id:'d',type:'vuln',title:'D',severity:'low',confidence:'static-confirmed'},
 ];
 const ids=(f)=>filterNodes(nodes,{...EMPTY_FILTER,...f}).map(n=>n.id);
 assert.equal(filterActive(EMPTY_FILTER),false);
 assert.deepEqual(ids({}),['a','b','c','d']);
 assert.deepEqual(ids({types:['hypothesis','finding']}),['a','b','c']);
 assert.deepEqual(ids({types:['hypothesis'],statuses:['open']}),['a']);
 assert.deepEqual(ids({riskOnly:true}),['c']);
 assert.deepEqual(ids({confidences:['static-confirmed']}),['d']);
 assert.deepEqual(ids({statuses:['']}),['d']);
 assert.equal(filterActive({...EMPTY_FILTER,riskOnly:true}),true);
});

test('every relation kind the model allows maps to a family; unknown kinds stay neutral',async()=>{
 const { EDGE_KINDS } = await import(pathToFileURL(path.join(root,'lib/model.js')).href);
 const ids=new Set(RELATION_GROUPS.map(g=>g.id));
 for (const kind of EDGE_KINDS) assert.ok(ids.has(relationGroup(kind)),kind);
 assert.equal(relationGroup('proves'),'support'); assert.equal(relationGroup('prove'),'support');
 assert.equal(relationGroup('contradicts'),'oppose'); assert.equal(relationGroup('intent-chain'),'derive');
 assert.equal(relationGroup('produce'),'produce'); assert.equal(relationGroup('supersedes'),'replace');
 assert.equal(relationGroup('something-new'),'link');
});

test('layout stores the ELK route of every edge and reuses it only while nodes stay put',async()=>{
 const nodes=['a','b','c','d'].map(id=>({id,type:'fact',title:id}));
 const edges=[['a','b'],['b','c'],['c','d'],['a','d']].map(([from,to],i)=>({id:`e${i}`,from,to,kind:'proves'}));
 const p=project({meta:{},nodes,edges},'all',''); const laid=await layoutGraph(p.nodes,p.edges,'RIGHT');
 for(const edge of laid.edges){
  const route=edge.data.route; assert.ok(route.points.length>=2,edge.id);
  const s=laid.nodes.find(n=>n.id===edge.source).position, t=laid.nodes.find(n=>n.id===edge.target).position;
  assert.ok(routeValid(route,s,t)); assert.ok(!routeValid(route,{x:s.x+10,y:s.y},t));
 }
});
test('routes are pinned to the handles and rounded corners stay inside their segments',()=>{
 const route={points:[{x:0,y:0},{x:50,y:0},{x:50,y:100},{x:100,y:100}],source:{x:0,y:0},target:{x:100,y:100},direction:'RIGHT'};
 const pts=adaptRoute(route,{x:0,y:4},{x:100,y:96});
 assert.deepEqual(pts[0],{x:0,y:4}); assert.deepEqual(pts.at(-1),{x:100,y:96});
 assert.equal(pts[1].y,4); assert.equal(pts[2].y,96);
 assert.match(roundedPath(pts,44),/^M0,4L.*Q50,4 .*L100,96$/);
 assert.equal(roundedPath([{x:0,y:0},{x:10,y:0},{x:10,y:6}],44).includes('Q10,0 10,3'),true);
});

test('teaching projection keeps chain and code nodes and drops pentest-only noise',()=>{
 const snap={meta:{},files:{'a.c':{path:'a.c',lang:'c',hash:'h',lines:10}},nodes:[
  {id:'st1',type:'stage',title:'触发',phase:'trigger'},
  {id:'u1',type:'unit',title:'trigger',file:'a.c',kind:'function',startLine:1,endLine:3},
  {id:'h1',type:'hypothesis',title:'old pentest'},
  {id:'n1',type:'note',title:'note'},
  {id:'m1',type:'unit',title:'BUF_SIZE',file:'a.c',kind:'macro',startLine:1,endLine:1},
 ],edges:[{id:'e1',from:'u1',to:'st1',kind:'implements'}]};
 assert.equal(hasTeachingData(snap),true);
 const p=project(snap,'teaching','');
 assert.deepEqual(p.nodes.map(n=>n.id).sort(),['n1','st1','u1']); // macros move to the macro lookup table
 assert.equal(p.edges.length,1);
 assert.equal(hasTeachingData({meta:{},nodes:[],edges:[]}),false);
});
test('orderedStages follows explicit step-before edges and keeps disconnected stages',()=>{
 const nodes=[
  {id:'st3',type:'stage',title:'C',ts:3},
  {id:'st1',type:'stage',title:'A',ts:1},
  {id:'st2',type:'stage',title:'B',ts:2},
  {id:'st9',type:'stage',title:'Z',ts:9},
 ];
 const edges=[
  {id:'e1',from:'st1',to:'st2',kind:'step-before'},
  {id:'e2',from:'st2',to:'st3',kind:'step-before'},
 ];
 assert.deepEqual(orderedStages(nodes,edges).map(n=>n.id),['st1','st2','st3','st9']);
});

test('teaching chain layout is a rightward tree with one placement per node',()=>{
 const nodes=[
  {id:'g',type:'goal',title:'Root'},
  {id:'st1',type:'stage',title:'触发',phase:'trigger'},
  {id:'st2',type:'stage',title:'提权',phase:'escalate'},
  {id:'u1',type:'unit',title:'trigger',file:'a.c',kind:'function',startLine:1,endLine:5},
  {id:'u2',type:'unit',title:'helper',file:'a.c',kind:'function',startLine:7,endLine:9},
  {id:'u3',type:'unit',title:'escalate',file:'b.c',kind:'function',startLine:1,endLine:8},
  {id:'p1',type:'primitive',title:'UAF'},
 ];
 const edges=[
  {id:'e1',from:'u1',to:'st1',kind:'implements'},
  {id:'e2',from:'p1',to:'st1',kind:'enables'},
  {id:'e3',from:'u3',to:'st2',kind:'implements'},
  {id:'e4',from:'st1',to:'st2',kind:'step-before'},
  {id:'e5',from:'u1',to:'u2',kind:'calls'},
  {id:'e6',from:'u3',to:'u1',kind:'calls'},
 ];
 const projection=project({meta:{},nodes,edges},'teaching','');
 const laid=layoutTeachingChain(projection.nodes,projection.edges);
 assert.equal(laid.nodes.length,projection.nodes.length);
 assert.equal(new Set(laid.nodes.map(n=>n.id)).size,laid.nodes.length);
 const at=(id)=>laid.nodes.find(n=>n.id===id).position;
 assert.ok(at('st1').x<at('u1').x,'stage sits left of its implementing unit');
 assert.equal(at('st1').x,at('st2').x,'stages share the spine column');
 assert.ok(at('u2').x>at('u1').x,'callee branches further right');
 assert.ok(at('p1').x>at('st1').x,'primitive branches right of the stage');
 const positions=new Set(laid.nodes.map(n=>`${n.position.x},${n.position.y}`));
 assert.equal(positions.size,laid.nodes.length,'tree positions are unique');
 const byId=new Map(laid.edges.map(e=>[e.id,e]));
 assert.equal(byId.get('e1').data.cross,false);
 assert.equal(byId.get('e4').data.cross,false);
 assert.equal(byId.get('e5').data.cross,false);
 assert.deepEqual(byId.get('e6').data.crossFile,{from:'b.c',to:'a.c'});
 assert.equal(byId.get('e6').label,'trigger');
});

test('teaching file layout groups units into file frames and marks cross-file calls',()=>{
 const nodes=[
  {id:'u1',type:'unit',title:'trigger',file:'a.c',lang:'c',kind:'function',startLine:1,endLine:5},
  {id:'u2',type:'unit',title:'helper',file:'a.c',lang:'c',kind:'function',startLine:7,endLine:9},
  {id:'u3',type:'unit',title:'escalate',file:'b.c',lang:'c',kind:'function',startLine:1,endLine:8},
  {id:'u4',type:'unit',title:'struct_name',file:'b.h',lang:'c',kind:'struct',startLine:1,endLine:4},
 ];
 const edges=[
  {id:'e1',from:'u1',to:'u2',kind:'calls'},
  {id:'e2',from:'u3',to:'u1',kind:'calls'},
 ];
 const projection=project({meta:{},files:{'a.c':{path:'a.c',lang:'c',hash:'x',lines:10},'b.c':{path:'b.c',lang:'c',hash:'y',lines:10},'b.h':{path:'b.h',lang:'c',hash:'z',lines:4}},nodes,edges},'teaching','',{onlyCode:true});
 assert.ok(projection.nodes.every(n=>n.data.item.type==='unit'));
 const laid=layoutTeachingFiles(projection.nodes,projection.edges);
 const frames=laid.nodes.filter(n=>n.data.group);
 assert.equal(frames.length,3,'one frame per file with units');
 assert.ok(frames.every(f=>f.type==='boardGroup'&&/^__file_/.test(f.id)));
 const units=laid.nodes.filter(n=>!n.data.group);
 assert.equal(units.length,4);
 for(const unit of units){
  const frame=frames.find(f=>f.id===unit.parentId);
  assert.ok(frame,'unit belongs to a frame');
  assert.ok(unit.position.x>=0 && unit.position.y>=0);
  assert.ok(unit.position.x+288<=frame.style.width);
  assert.ok(unit.position.y+128<=frame.style.height);
 }
 // a.c: trigger -> helper becomes depth 1
 const aFrame=frames.find(f=>f.data.item.title==='a.c');
 const u1=laid.nodes.find(n=>n.id==='u1'), u2=laid.nodes.find(n=>n.id==='u2');
 assert.equal(u1.parentId,aFrame.id); assert.equal(u2.parentId,aFrame.id);
 assert.ok(u2.position.y>u1.position.y,'within-file order keeps callers before callees');
 const byId=new Map(laid.edges.map(e=>[e.id,e]));
 assert.equal(byId.get('e1').data.cross,false,'same-file call is a tree edge');
 assert.equal(byId.get('e2').data.cross,true,'cross-file call is a cross link');
 assert.deepEqual(byId.get('e2').data.crossFile,{from:'b.c',to:'a.c'});
 assert.equal(byId.get('e2').label,'trigger','cross-file edge is labelled with the referenced function');
});

test('retired nodes are hidden from every projection',()=>{
 const nodes=[
  {id:'u1',type:'unit',title:'a',file:'a.c',kind:'function',startLine:1,endLine:2,status:'active'},
  {id:'st1',type:'stage',title:'old chain',status:'removed'},
 ];
 const p=project({meta:{},nodes,edges:[]},'teaching','');
 assert.deepEqual(p.nodes.map(n=>n.id),['u1']);
});

test('hierarchy layout puts overall functions top-left and basics bottom-right',()=>{
 const nodes=[
  {id:'main',type:'unit',title:'main',symbol:'main',file:'a.c',kind:'function',startLine:1,endLine:5},
  {id:'a',type:'unit',title:'a',symbol:'a',file:'a.c',kind:'function',startLine:7,endLine:9},
  {id:'b',type:'unit',title:'b',symbol:'b',file:'b.c',kind:'function',startLine:1,endLine:3},
  {id:'leaf',type:'unit',title:'leaf',symbol:'leaf',file:'b.c',kind:'function',startLine:5,endLine:7},
 ];
 const edges=[
  {id:'e1',from:'main',to:'a',kind:'calls'},
  {id:'e2',from:'main',to:'b',kind:'calls'},
  {id:'e3',from:'a',to:'leaf',kind:'calls'},
 ];
 const projection=project({meta:{},nodes,edges},'teaching','',{onlyCode:true});
 const laid=layoutTeachingHierarchy(projection.nodes,projection.edges);
 assert.equal(laid.nodes.length,4);
 const at=(id)=>laid.nodes.find(n=>n.id===id).position;
 assert.ok(at('main').x<at('a').x && at('a').x<at('leaf').x,'caller sits left of callee');
 assert.ok(at('main').y<at('a').y,'root sits above its subtree');
 const byId=new Map(laid.edges.map(e=>[e.id,e]));
 assert.equal(byId.get('e1').data.cross,false);
 assert.equal(byId.get('e2').data.cross,false);
 assert.equal(byId.get('e3').data.cross,false);
});
