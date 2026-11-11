import test from 'node:test';
import assert from 'node:assert/strict';
import {list} from '../src/repositories/jsonStore.js';
import {priceOrder} from '../src/services/orders.js';
test('ten branches and fifty products',async()=>{assert.ok((await list('branches')).length>=10);assert.ok((await list('products')).length>=50);});
test('branch-specific pricing',async()=>{const p=await list('products');assert.notEqual(p.find(x=>x.id==='kowale-p1').price,p.find(x=>x.id==='gdansk-p1').price);});
test('cross-branch product is rejected',async()=>{await assert.rejects(priceOrder({branchId:'kowale',items:[{productId:'gdansk-p1',quantity:1}]}));});
test('valid selections are priced by server',async()=>{const result=await priceOrder({branchId:'kowale',items:[{productId:'kowale-p1',quantity:2,selections:{size:['mega'],meat:['beef']}}]});assert.equal(result.total,62);});
test('required options enforced',async()=>{await assert.rejects(priceOrder({branchId:'kowale',items:[{productId:'kowale-p1',quantity:1}]}));});
