import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNodeChanges } from '@xyflow/react';
import { nodeBounds, regionContains } from '../shared/geometry.js';
const node = (id, kind, x, y, width, height) => ({id, type:'research',position:{x,y},data:{kind},style:{width,height}});
const resize = (node,width,height) => applyNodeChanges([{id:node.id,type:'dimensions',dimensions:{width,height},setAttributes:true}], [node])[0];

test('enlarged region includes both notes, including the one outside its original size',()=>{
  const original=node('region','region',0,0,720,480);
  const left=node('left','note',100,100,280,220),right=node('right','note',800,200,280,220);
  const enlarged=resize(original,1400,850);
  assert.equal(enlarged.style.width,720); // Actual React Flow resize leaves creation styles unchanged.
  assert.equal(regionContains(enlarged,left),true);
  assert.equal(regionContains(enlarged,right),true);
  assert.equal(regionContains(original,right),false);
  const {measured,...reopened}=enlarged;
  assert.equal(regionContains(reopened,right),true);
});
test('shrinking a region or resizing a note uses its current visible boundary',()=>{
  const region=node('region','region',0,0,1400,850);
  const right=node('right','note',800,200,280,220);
  assert.equal(regionContains(resize(region,720,480),right),false);
  const nearEdge=node('note','note',500,100,400,220);
  const narrowRegion=node('region','region',0,0,720,480);
  assert.equal(regionContains(narrowRegion,nearEdge),false);
  assert.equal(regionContains(narrowRegion,resize(nearEdge,180,100)),true);
  assert.equal(regionContains(narrowRegion,resize(node('note','note',500,100,180,100),400,220)),false);
});
test('measured dimensions take priority and containment includes exact edges without accepting overlaps',()=>{
  const region={...node('region','region',-100,-50,720,480),width:1000,height:700,measured:{width:1200,height:800}};
  assert.deepEqual(nodeBounds(region),{x:-100,y:-50,width:1200,height:800});
  assert.equal(regionContains(region,node('inside','note',820,530,280,220)),true);
  assert.equal(regionContains(region,node('outside','note',821,530,280,220)),false);
  assert.equal(regionContains(region,node('outside','note',820,531,280,220)),false);
});
