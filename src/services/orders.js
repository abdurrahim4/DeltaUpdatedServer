import crypto from 'node:crypto';
import {list,mutate} from '../repositories/jsonStore.js';
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
export class OrderError extends Error { constructor(message,status=400){super(message);this.status=status;} }
export async function priceOrder(body) {
 const branches=await list('branches');
 if(!branches.some(b=>b.id===body.branchId&&b.available)) throw new OrderError('Branch unavailable');
 const products=await list('products'), groups=await list('customization-groups');
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>40) throw new OrderError('Invalid cart');
 const items=body.items.map(item=>{
  const product=products.find(p=>p.id===item.productId&&p.branchId===body.branchId&&!p.archived&&p.available);
  if(!product) throw new OrderError('Product unavailable for selected branch');
  if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>30) throw new OrderError('Invalid quantity');
  const selections=item.selections||{};
  if(Object.keys(selections).some(id=>!product.customizationGroupIds.includes(id))) throw new OrderError('Unknown customization group');
  let extras=0;const chosen=[];
  for(const id of product.customizationGroupIds){
   const group=groups.find(g=>g.id===id);if(!group) throw new OrderError('Invalid product configuration',500);
   const ids=selections[id]||[];
   if(!Array.isArray(ids)||ids.length<group.min||ids.length>group.max||new Set(ids).size!==ids.length) throw new OrderError(`Invalid ${group.name} selections`);
   for(const optionId of ids){const option=group.options.find(o=>o.id===optionId&&o.available);if(!option) throw new OrderError('Unavailable customization');extras+=option.price;chosen.push({groupId:id,groupName:group.name,optionId,name:option.name,price:option.price});}
  }
  const unitPrice=money(product.price+extras);
  return {productId:product.id,name:structuredClone(product.name),quantity:item.quantity,basePrice:product.price,selections:chosen,unitPrice,lineTotal:money(unitPrice*item.quantity),instructions:String(item.instructions||'').slice(0,500)};
 });
 return {items,total:money(items.reduce((s,x)=>s+x.lineTotal,0))};
}
export async function createOrder(body,io){
 const {items,total:foodSubtotal}=await priceOrder(body);const deliveryFee=body.deliveryDetails?.deliveryFee??0;const total=money(foodSubtotal+deliveryFee);
 const now=new Date().toISOString();
 const trackingToken=crypto.randomBytes(32).toString('hex');
 const order={trackingTokenHash:crypto.createHash('sha256').update(trackingToken).digest('hex'),id:`DKB-${crypto.randomUUID()}`,branchId:body.branchId,customer:{name:body.customer.name.trim(),phone:body.customer.phone.trim(),email:(body.customer.email||'').trim(),address:body.customer.address.trim()},items,foodSubtotal,deliveryFee,deliveryDistanceKm:body.deliveryDetails?.distanceKm??null,deliveryPromotionId:body.deliveryDetails?.promotionId??null,total,currency:'PLN',paymentMethod:body.paymentMethod,status:'new',createdAt:now,updatedAt:now,history:[{status:'new',at:now}],cancellationReason:null};
 const record=await mutate('orders',rows=>{
  if(body.idempotencyKey){const existing=rows.find(x=>x.idempotencyKey===body.idempotencyKey&&x.branchId===body.branchId);if(existing)return {order:existing,created:false};}
  order.idempotencyKey=body.idempotencyKey||null;rows.push(order);return {order,created:true};
 });
 if(record.created) io.to(`branch:${body.branchId}`).emit('order:new',{eventId:crypto.randomUUID(),order:record.order});
 return {...record,trackingToken:record.created?trackingToken:null};
}
const transitions={new:['preparing','cancelled'],preparing:['delivering','cancelled'],delivering:['delivered'],delivered:[],cancelled:[]};
export async function changeStatus(branchId,id,status,reason,io){
 const updated=await mutate('orders',rows=>{
  const order=rows.find(o=>o.id===id&&o.branchId===branchId);
  if(!order)throw new OrderError('Order not found',404);
  if(!transitions[order.status].includes(status))throw new OrderError('Invalid status transition',409);
  if(status==='cancelled'&&!String(reason||'').trim())throw new OrderError('Cancellation reason required');
  order.status=status;order.updatedAt=new Date().toISOString();order.history.push({status,at:order.updatedAt});if(status==='cancelled')order.cancellationReason=reason;return structuredClone(order);
 });
 io.to(`branch:${branchId}`).emit('order:updated',{eventId:crypto.randomUUID(),order:updated});return updated;
}
