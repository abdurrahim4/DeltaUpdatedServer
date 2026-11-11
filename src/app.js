import {quoteDelivery,settings,DEFAULT_TIERS,readQuote} from './services/delivery.js';
import {storageMode} from './repositories/jsonStore.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {z} from 'zod';
import {list,mutate,createBranchAndEmployee,saveProductWithOptions} from './repositories/jsonStore.js';
import {auth,access,manager,tokenFor} from './middleware/auth.js';
import {createOrder,changeStatus,OrderError} from './services/orders.js';
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(status,message)=>{throw new OrderError(message,status);};
const page=(rows,req)=>{const limit=Math.min(100,Math.max(1,Number(req.query.limit)||20)),offset=Math.max(0,Number(req.query.offset)||0);return {data:rows.slice(offset,offset+limit),pagination:{total:rows.length,limit,offset}};};
const text=z.string().trim().min(1).max(250);
const productSchema=z.object({name:z.record(z.string()).refine(o=>!!o.pl||!!o.en),description:z.record(z.string()).default({}),categoryId:text,price:z.number().finite().min(0).max(100000),available:z.boolean().default(true),imageUrl:z.string().max(2000).default(''),customizationGroupIds:z.array(z.string()).default([]),sortOrder:z.number().int().default(0)});
const groupBaseSchema=z.object({name:text,min:z.number().int().min(0).max(30),max:z.number().int().min(1).max(30),options:z.array(z.object({id:z.string().min(1).max(100),name:text,price:z.number().finite().min(0).max(100000),available:z.boolean().default(true)})).min(1).max(60)});
const validGroupLimits=x=>x.min<=x.max&&x.max<=x.options.length;
const groupSchema=groupBaseSchema.refine(validGroupLimits,{message:'Invalid selection limits'});
const orderSchema=z.object({branchId:text,customer:z.object({name:text,phone:text,email:z.string().email().max(254).optional().or(z.literal('')),address:text}),items:z.array(z.object({productId:text,quantity:z.number().int().min(1).max(30),selections:z.record(z.array(z.string())).optional(),instructions:z.string().max(500).optional()})).min(1).max(40),paymentMethod:z.enum(['cash_on_delivery','card_on_delivery']),idempotencyKey:z.string().min(8).max(120).optional(),deliveryQuoteToken:z.string().max(5000).optional()});
const settingsSchema=z.object({available:z.boolean().optional(),hours:z.object({open:z.string().regex(/^\d\d:\d\d$/),close:z.string().regex(/^\d\d:\d\d$/)}).optional(),phone:z.string().max(40).optional()});
export function createApp(io){
 const app=express();app.disable('x-powered-by');app.use(helmet());
 app.use(cors());
 // Parse JSON request bodies for login, checkout and management routes.
 app.use(express.json({ limit: '100kb' }));
 app.use('/api',rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-7',legacyHeaders:false}));
 app.get('/health',(_q,r)=>r.json({status:'ok',storage:storageMode()}));
 app.post('/api/v1/auth/login',rateLimit({windowMs:60000,limit:10}),wrap(async(req,res)=>{
  const {email,password}=z.object({email:z.string().min(1),password:z.string().min(1)}).parse(req.body);
  const users=await list('users');const user=users.find(u=>(u.email?.toLowerCase()===email.toLowerCase()||u.username?.toLowerCase()===email.toLowerCase())&&u.active);
  if(!user||!await bcrypt.compare(password,user.passwordHash))fail(401,'Invalid credentials');
  res.json({data:{token:tokenFor(user),user:{id:user.id,email:user.email,role:user.role,branchIds:user.branchIds}}});
 }));
 app.get('/api/v1/auth/me',auth,wrap(async(req,res)=>{const user=(await list('users')).find(u=>u.id===req.user.sub&&u.active);if(!user)fail(401,'Account disabled');res.json({data:{id:user.id,email:user.email,role:user.role,branchIds:user.branchIds}});}));
 app.get('/api/v1/restaurants',wrap(async(req,res)=>{let rows=(await list('branches')).filter(b=>!b.deletedAt);if(req.query.city)rows=rows.filter(b=>b.city.toLowerCase().includes(String(req.query.city).toLowerCase()));if(req.query.search)rows=rows.filter(b=>(b.name+' '+b.city).toLowerCase().includes(String(req.query.search).toLowerCase()));if(req.query.available!==undefined)rows=rows.filter(b=>b.available===(req.query.available==='true'));res.json(page(rows,req));}));
 app.get('/api/v1/restaurants/:id',wrap(async(req,res)=>{const b=(await list('branches')).find(b=>b.id===req.params.id);if(!b||b.deletedAt)fail(404,'Branch not found');res.json({data:b});}));
 app.get('/api/v1/restaurants/:id/products',wrap(async(req,res)=>{let rows=(await list('products')).filter(p=>p.branchId===req.params.id&&!p.archived&&p.available);if(req.query.category)rows=rows.filter(p=>p.categoryId===req.query.category);if(req.query.search)rows=rows.filter(p=>Object.values(p.name).join(' ').toLowerCase().includes(String(req.query.search).toLowerCase()));res.json(page(rows.sort((a,b)=>a.sortOrder-b.sortOrder),req));}));
 app.get('/api/v1/restaurants/:id/products/:productId',wrap(async(req,res)=>{const p=(await list('products')).find(p=>p.id===req.params.productId&&p.branchId===req.params.id&&!p.archived&&p.available);if(!p)fail(404,'Product not found');const groups=(await list('customization-groups')).filter(g=>p.customizationGroupIds.includes(g.id));res.json({data:{...p,customizationGroups:groups}});}));
 app.get('/api/v1/restaurants/:id/categories',wrap(async(req,res)=>{const products=(await list('products')).filter(p=>p.branchId===req.params.id&&!p.archived);const ids=new Set(products.map(p=>p.categoryId));res.json({data:(await list('categories')).filter(c=>ids.has(c.id))});}));
 app.get('/api/v1/restaurants/:id/customizations',wrap(async(req,res)=>res.json({data:(await list('customization-groups')).filter(g=>g.branchId===req.params.id||!g.branchId)})));
 app.post('/api/v1/orders',wrap(async(req,res)=>{const body=orderSchema.parse(req.body);const q=readQuote(body.deliveryQuoteToken);if(q.branchId!==body.branchId)fail(409,'Delivery branch changed; verify address again');const {priceOrder}=await import('./services/orders.js');const priced=await priceOrder(body);if(Math.abs(q.subtotal-priced.total)>0.009)fail(409,'Cart changed; verify delivery address again');if(body.customer.address!==q.address)fail(409,'Delivery address changed; verify again');body.deliveryDetails=q;const {order,created,trackingToken}=await createOrder(body,io);const {trackingTokenHash,idempotencyKey,...publicOrder}=order;res.status(created?201:200).json({data:{...publicOrder,trackingToken},created});}));
 // Guest tracking is authorized by a 256-bit token returned only at checkout.
 app.get('/api/v1/orders/:id/track',rateLimit({windowMs:60000,limit:60}),wrap(async(req,res)=>{
  const token=req.get('X-Order-Token')||'';
  if(!/^[a-f0-9]{64}$/i.test(token))fail(403,'Tracking token required');
  const o=(await list('orders')).find(o=>o.id===req.params.id);
  if(!o?.trackingTokenHash)fail(404,'Tracking unavailable');
  const candidate=crypto.createHash('sha256').update(token).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(o.trackingTokenHash,'hex')))fail(403,'Invalid tracking token');
  res.set('Cache-Control','no-store');res.json({data:{id:o.id,branchId:o.branchId,total:o.total,status:o.status,createdAt:o.createdAt,updatedAt:o.updatedAt,acceptedAt:o.acceptedAt||null,estimatedMinutes:o.estimatedMinutes||null,estimatedDeliveryAt:o.estimatedDeliveryAt||null}});
 }));
 // Guest order lookup requires a secret generated at checkout. Existing orders are intentionally inaccessible to unauthenticated callers.
 app.get('/api/v1/orders/:id',auth,wrap(async(req,res)=>{const o=(await list('orders')).find(o=>o.id===req.params.id);if(!o)fail(404,'Order not found');if(req.user.role!=='super_admin'&&!req.user.branchIds.includes(o.branchId))fail(403,'Access denied');res.json({data:o});}));

 const onlySuper=(req,res,next)=>req.user?.role==='super_admin'?next():res.status(403).json({error:{code:'FORBIDDEN',message:'Super Admin required'}});
 const addressSchema=z.object({street:z.string().trim().min(1).max(180),houseNumber:z.string().trim().min(1).max(40),city:z.string().trim().min(1).max(120),postalCode:z.string().max(20).optional(),apartment:z.string().max(50).optional(),floor:z.string().max(30).optional()});
 app.post('/api/v1/delivery/quote',rateLimit({windowMs:60000,limit:20}),wrap(async(req,res)=>{const body=z.object({branchId:text,address:addressSchema,subtotal:z.number().finite().min(0)}).parse(req.body);res.json({data:await quoteDelivery(body)});}));
 app.get('/api/v1/management/delivery',auth,onlySuper,wrap(async(req,res)=>res.json({data:{settings:await settings(),promotions:await list('delivery-promotions')}})));
 app.put('/api/v1/management/delivery/settings',auth,onlySuper,wrap(async(req,res)=>{const body=z.object({maxKm:z.literal(15),tiers:z.array(z.object({km:z.number().positive().max(15),fee:z.number().min(0).max(1000)})).length(15)}).refine(x=>x.tiers.every((t,i)=>t.km===i+1),{message:'Exactly 1–15 km tiers required'}).parse(req.body);const data=await mutate('delivery-settings',rows=>{rows.splice(0,rows.length,{id:'global',...body});return rows[0]});res.json({data})}));
 const promoSchema=z.object({name:z.string().trim().min(1).max(120),type:z.enum(['all','minimum']),minSubtotal:z.number().min(0).max(100000),startAt:z.string().datetime(),endAt:z.string().datetime(),enabled:z.boolean(),branchIds:z.array(z.string()).max(100)}).refine(x=>Date.parse(x.endAt)>Date.parse(x.startAt),{message:'End must be after start'});
 app.post('/api/v1/management/delivery/promotions',auth,onlySuper,wrap(async(req,res)=>{const body=promoSchema.parse(req.body);const p={id:crypto.randomUUID(),...body};await mutate('delivery-promotions',rows=>rows.push(p));res.status(201).json({data:p})}));
 app.put('/api/v1/management/delivery/promotions/:id',auth,onlySuper,wrap(async(req,res)=>{const body=promoSchema.parse(req.body);const p=await mutate('delivery-promotions',rows=>{const found=rows.find(x=>x.id===req.params.id);if(!found)fail(404,'Promotion not found');Object.assign(found,body);return structuredClone(found)});res.json({data:p})}));
 app.delete('/api/v1/management/delivery/promotions/:id',auth,onlySuper,wrap(async(req,res)=>{await mutate('delivery-promotions',rows=>{const i=rows.findIndex(x=>x.id===req.params.id);if(i<0)fail(404,'Promotion not found');rows.splice(i,1)});res.json({data:{deleted:true}})}));
 app.patch('/api/v1/management/delivery/branches/:id/coordinates',auth,onlySuper,wrap(async(req,res)=>{const {latitude,longitude}=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).parse(req.body);const b=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.id&&!x.deletedAt);if(!b)fail(404,'Branch not found');b.latitude=latitude;b.longitude=longitude;return structuredClone(b)});res.json({data:b})}));
 const hhmm=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
 const schedule=z.record(z.enum(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']),z.object({closed:z.boolean(),open:hhmm.optional(),close:hhmm.optional()}).refine(x=>x.closed||(x.open&&x.close),'Open and close times required')).refine(x=>Object.keys(x).length===7,'All seven days required');
 const branchFields=z.object({name:text,restaurantName:text,address:text,city:text,postalCode:z.string().max(30).default(''),phone:text,email:z.union([z.string().email(),z.literal('')]).default(''),timezone:z.string().min(1).max(100).default('Europe/Warsaw'),mapsUrl:z.union([z.string().url(),z.literal('')]).default(''),active:z.boolean().default(true),schedule});
 const employeeFields=z.object({fullName:text,username:z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),password:z.string().min(10).max(128),role:z.enum(['manager','staff'])});
 const publicEmployee=u=>({id:u.id,fullName:u.fullName,username:u.username,role:u.role,branchIds:u.branchIds,active:u.active});
 app.post('/api/v1/management/branches',auth,onlySuper,wrap(async(req,res)=>{
   const {employee,...rest}=z.object({...branchFields.shape,employee:employeeFields}).parse(req.body);
   try { new Intl.DateTimeFormat('en',{timeZone:rest.timezone}); } catch { fail(400,'Invalid timezone'); }
   const id=crypto.randomUUID();
   const branch={...rest,id,restaurantId:'delta-kebab',available:rest.active,deletedAt:null,createdAt:new Date().toISOString(),hours:{open:rest.schedule.monday.open||'00:00',close:rest.schedule.monday.close||'00:00'}};
   const username=employee.username.toLowerCase();
   const user={id:crypto.randomUUID(),email:username+'@staff.deltakebab.local',username,fullName:employee.fullName,role:employee.role,branchIds:[id],active:true,passwordHash:await bcrypt.hash(employee.password,12)};
   await createBranchAndEmployee(branch,user);
   res.status(201).json({data:{branch,employee:publicEmployee(user)}});
 }));
 app.get('/api/v1/management/branches',auth,onlySuper,wrap(async(req,res)=>{
   let rows=await list('branches');
   if(req.query.search){const q=String(req.query.search).toLowerCase();rows=rows.filter(b=>[b.name,b.restaurantName,b.city,b.address,b.id].some(x=>String(x||'').toLowerCase().includes(q)));}
   if(req.query.status==='active')rows=rows.filter(b=>b.active!==false&&!b.deletedAt);
   if(req.query.status==='inactive')rows=rows.filter(b=>b.active===false&&!b.deletedAt);
   if(req.query.status==='deleted')rows=rows.filter(b=>!!b.deletedAt);
   res.json(page(rows,req));
 }));
 app.patch('/api/v1/management/branches/:branchId',auth,onlySuper,wrap(async(req,res)=>{
   const body=branchFields.partial().parse(req.body);
   if(body.timezone){try{new Intl.DateTimeFormat('en',{timeZone:body.timezone})}catch{fail(400,'Invalid timezone')}}
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b||b.deletedAt)fail(404,'Branch not found');Object.assign(b,body);if(body.active!==undefined)b.available=body.active;if(body.schedule)b.hours={open:body.schedule.monday?.open||'00:00',close:body.schedule.monday?.close||'00:00'};return structuredClone(b)});
   res.json({data:branch});
 }));
 app.delete('/api/v1/management/branches/:branchId',auth,onlySuper,wrap(async(req,res)=>{
   const hasOrders=(await list('orders')).some(o=>o.branchId===req.params.branchId);
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b||b.deletedAt)fail(404,'Branch not found');b.deletedAt=new Date().toISOString();b.active=false;b.available=false;return structuredClone(b)});
   res.json({data:{...branch,softDeleted:true,hasOrders}});
 }));
 app.post('/api/v1/management/branches/:branchId/restore',auth,onlySuper,wrap(async(req,res)=>{
   const branch=await mutate('branches',rows=>{const b=rows.find(x=>x.id===req.params.branchId);if(!b)fail(404,'Branch not found');b.deletedAt=null;b.active=true;b.available=true;return structuredClone(b)});res.json({data:branch});
 }));
 app.get('/api/v1/management/branches/:branchId/employees',auth,access,manager,wrap(async(req,res)=>{
   res.json({data:(await list('users')).filter(u=>u.branchIds?.includes(req.params.branchId)).map(publicEmployee)});
 }));
 app.post('/api/v1/management/branches/:branchId/employees',auth,onlySuper,wrap(async(req,res)=>{
   const body=employeeFields.parse(req.body);
   if(!(await list('branches')).some(b=>b.id===req.params.branchId&&!b.deletedAt))fail(404,'Branch not found');
   const username=body.username.toLowerCase();
   const user={id:crypto.randomUUID(),email:username+'@staff.deltakebab.local',username,fullName:body.fullName,role:body.role,branchIds:[req.params.branchId],active:true,passwordHash:await bcrypt.hash(body.password,12)};
   await mutate('users',rows=>{if(rows.some(u=>u.username?.toLowerCase()===username||u.email?.toLowerCase()===user.email))fail(409,'Username already exists');rows.push(user)});
   res.status(201).json({data:publicEmployee(user)});
 }));
 app.patch('/api/v1/management/branches/:branchId/employees/:employeeId',auth,onlySuper,wrap(async(req,res)=>{
   const body=z.object({fullName:text.optional(),username:z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/).optional(),role:z.enum(['manager','staff']).optional(),active:z.boolean().optional()}).strict().parse(req.body);
   if(!Object.keys(body).length)fail(400,'No changes provided');
   const updated=await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId)&&x.role!=='super_admin');if(!u)fail(404,'Employee not found');if(body.username){const username=body.username.toLowerCase();if(rows.some(x=>x.id!==u.id&&(x.username?.toLowerCase()===username||x.email?.toLowerCase()===username+'@staff.deltakebab.local')))fail(409,'Username already in use');u.username=username;u.email=username+'@staff.deltakebab.local';}if(body.fullName!==undefined)u.fullName=body.fullName;if(body.role!==undefined)u.role=body.role;if(body.active!==undefined)u.active=body.active;return publicEmployee(u)});
   res.json({data:updated});
 }));
 app.delete('/api/v1/management/branches/:branchId/employees/:employeeId',auth,onlySuper,wrap(async(req,res)=>{
   const updated=await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId)&&x.role!=='super_admin');if(!u)fail(404,'Employee not found');u.active=false;u.deletedAt=new Date().toISOString();return publicEmployee(u)});
   res.json({data:updated});
 }));
 app.patch('/api/v1/management/branches/:branchId/employees/:employeeId/password',auth,onlySuper,wrap(async(req,res)=>{
   const {password}=z.object({password:z.string().min(10).max(128)}).parse(req.body);
   const hash=await bcrypt.hash(password,12);
   await mutate('users',rows=>{const u=rows.find(x=>x.id===req.params.employeeId&&x.branchIds?.includes(req.params.branchId));if(!u)fail(404,'Employee not found');u.passwordHash=hash});
   res.json({data:{updated:true}});
 }));

 const branch='/api/v1/management/branches/:branchId';app.use(branch,auth,access);
 app.get(branch+'/orders',wrap(async(req,res)=>{let rows=(await list('orders')).filter(o=>o.branchId===req.params.branchId);if(req.query.status)rows=rows.filter(o=>o.status===req.query.status);res.json(page(rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),req));}));
 // Permanently delete an order; authentication and branch access apply above.
 app.delete(branch+'/orders/:orderId',onlySuper,wrap(async(req,res)=>{
  const deleted=await mutate('orders',rows=>{
   const index=rows.findIndex(o=>o.id===req.params.orderId&&o.branchId===req.params.branchId);
   if(index<0)fail(404,'Order not found');
   const [order]=rows.splice(index,1);
   return {id:order.id,branchId:order.branchId};
  });
  console.info('Order permanently deleted',{orderId:deleted.id,branchId:deleted.branchId,actorId:req.user.sub,at:new Date().toISOString()});
  io?.to(`branch:${deleted.branchId}`)?.emit('order:updated',{eventId:crypto.randomUUID(),orderId:deleted.id,deleted:true});
  res.json({data:{deleted:true,orderId:deleted.id}});
 }));
 app.delete(branch+'/orders/:orderId/items/:itemIndex',wrap(async(req,res)=>{
  // Only super admins can change a placed order's contents.
  if(req.user.role!=='super_admin')fail(403,'Super Admin required to remove ordered items');
  const index=Number(req.params.itemIndex);
  if(!Number.isSafeInteger(index)||index<0)fail(400,'Invalid item index');
  const updated=await mutate('orders',rows=>{
   const order=rows.find(o=>o.id===req.params.orderId&&o.branchId===req.params.branchId);
   if(!order)fail(404,'Order not found');
   if(!['new','preparing'].includes(order.status))fail(409,'Only new or preparing orders can be edited');
   if(order.paymentMethod!=='cash_on_delivery')fail(409,'Paid orders require a separate refund and reconciliation workflow');
   if(index>=order.items.length)fail(404,'Item not found');
   if(order.items.length===1)fail(409,'Cannot remove the last item; cancel the order instead');
   const [removed]=order.items.splice(index,1);
   const round=n=>Math.round((n+Number.EPSILON)*100)/100;
   order.foodSubtotal=round(order.items.reduce((sum,item)=>sum+Number(item.lineTotal||0),0));
   order.total=round(order.foodSubtotal+Number(order.deliveryFee||0));
   order.updatedAt=new Date().toISOString();
   order.history=Array.isArray(order.history)?order.history:[];
   order.history.push({event:'item_removed',at:order.updatedAt,removedItem:removed,actorId:req.user.sub});
   return structuredClone(order);
  });
  io.to(`branch:${req.params.branchId}`).emit('order:updated',{eventId:crypto.randomUUID(),order:updated});
  res.json({data:updated});
 }));
  // Estimated delivery deadline is set when accepting an order; super admins and branch staff are already scoped by auth/access.
  const etaMinutes=z.number().int().refine(n=>[30,40,50,60,90].includes(n),{message:'Choose 30, 40, 50, 60 or 90 minutes'});
  app.patch(branch+'/orders/:orderId/estimate',wrap(async(req,res)=>{
   const {minutes}=z.object({minutes:etaMinutes}).strict().parse(req.body);
   const updated=await mutate('orders',rows=>{
    const o=rows.find(x=>x.id===req.params.orderId&&x.branchId===req.params.branchId);
    if(!o)fail(404,'Order not found');
    if(['delivered','cancelled'].includes(o.status))fail(409,'Cannot set an estimate for a closed order');
    const now=new Date();
    if(o.status==='new'){
     o.status='preparing';o.acceptedAt=now.toISOString();
     o.history=Array.isArray(o.history)?o.history:[];
     o.history.push({status:'preparing',at:o.acceptedAt,actorId:req.user.sub});
    }
    o.estimatedMinutes=minutes;
    o.estimatedDeliveryAt=new Date(now.getTime()+minutes*60000).toISOString();
    o.updatedAt=now.toISOString();
    o.history.push({event:'estimate_updated',at:o.updatedAt,minutes,actorId:req.user.sub});
    return structuredClone(o);
   });
   io.to(`branch:${req.params.branchId}`).emit('order:updated',{eventId:crypto.randomUUID(),order:updated});
   res.json({data:updated});
  }));
 app.patch(branch+'/orders/:orderId/status',wrap(async(req,res)=>{const {status,reason}=z.object({status:z.enum(['preparing','delivering','delivered','cancelled']),reason:z.string().max(500).optional()}).parse(req.body);res.json({data:await changeStatus(req.params.branchId,req.params.orderId,status,reason,io)});}));
 app.get(branch+'/products',wrap(async(req,res)=>{let rows=(await list('products')).filter(p=>p.branchId===req.params.branchId);if(req.query.search)rows=rows.filter(p=>Object.values(p.name).join(' ').toLowerCase().includes(String(req.query.search).toLowerCase()));if(req.query.archived!==undefined)rows=rows.filter(p=>p.archived===(req.query.archived==='true'));res.json(page(rows,req));}));
 // Atomic inline product editor: base price + size, sauce, meat and extras groups.
 const inlineGroupSchema=groupBaseSchema.extend({id:z.string().uuid().optional()}).refine(validGroupLimits,{message:'Invalid selection limits'});
 const inlineProductSchema=z.object({product:productSchema.omit({customizationGroupIds:true}),groups:z.array(inlineGroupSchema).max(20)});
 app.post(branch+'/products/with-options',manager,wrap(async(req,res)=>{
  const body=inlineProductSchema.parse(req.body);
  const p=await saveProductWithOptions(req.params.branchId,null,body.product,body.groups);
  res.status(201).json({data:p});
 }));
 app.patch(branch+'/products/:productId/with-options',manager,wrap(async(req,res)=>{
  const body=inlineProductSchema.parse(req.body);
  const p=await saveProductWithOptions(req.params.branchId,req.params.productId,body.product,body.groups);
  res.json({data:p});
 }));
 app.post(branch+'/products',manager,wrap(async(req,res)=>{const body=productSchema.parse(req.body);const p={...body,id:crypto.randomUUID(),branchId:req.params.branchId,currency:'PLN',archived:false};await mutate('products',rows=>rows.push(p));res.status(201).json({data:p});}));
 app.patch(branch+'/products/:productId',manager,wrap(async(req,res)=>{const body=productSchema.partial().parse(req.body);const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');Object.assign(x,body);return structuredClone(x);});res.json({data:p});}));
 app.delete(branch+'/products/:productId',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.archived=true;return structuredClone(x);});res.json({data:p});}));
 app.post(branch+'/products/:productId/restore',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.archived=false;return structuredClone(x);});res.json({data:p});}));
 app.patch(branch+'/products/:productId/availability',manager,wrap(async(req,res)=>{const {available}=z.object({available:z.boolean()}).parse(req.body);const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');x.available=available;return structuredClone(x);});res.json({data:p});}));
 app.post(branch+'/products/:productId/duplicate',manager,wrap(async(req,res)=>{const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');const copy={...structuredClone(x),id:crypto.randomUUID(),archived:false};rows.push(copy);return copy;});res.status(201).json({data:p});}));
 app.post(branch+'/products/:productId/copy',manager,wrap(async(req,res)=>{const {targetBranchId}=z.object({targetBranchId:text}).parse(req.body);if(req.user.role!=='super_admin'&&!req.user.branchIds.includes(targetBranchId))fail(403,'Target branch denied');const p=await mutate('products',rows=>{const x=rows.find(p=>p.id===req.params.productId&&p.branchId===req.params.branchId);if(!x)fail(404,'Product not found');const copy={...structuredClone(x),id:crypto.randomUUID(),branchId:targetBranchId,archived:false};rows.push(copy);return copy;});res.status(201).json({data:p});}));
 app.patch(branch+'/bulk/products',manager,wrap(async(req,res)=>{const {ids,available,price}=z.object({ids:z.array(text).min(1).max(100),available:z.boolean().optional(),price:z.number().min(0).max(100000).optional()}).parse(req.body);const changed=await mutate('products',rows=>{const affected=rows.filter(p=>p.branchId===req.params.branchId&&ids.includes(p.id));for(const p of affected){if(available!==undefined)p.available=available;if(price!==undefined)p.price=price;}return affected.length;});res.json({data:{updated:changed}});}));
 app.get(branch+'/settings',wrap(async(req,res)=>{const b=(await list('branches')).find(x=>x.id===req.params.branchId);res.json({data:b});}));
 app.patch(branch+'/settings',manager,wrap(async(req,res)=>{const body=settingsSchema.parse(req.body);const b=await mutate('branches',rows=>{const x=rows.find(x=>x.id===req.params.branchId);if(!x)fail(404,'Branch not found');Object.assign(x,body);return structuredClone(x);});res.json({data:b});}));
 app.get(branch+'/categories',wrap(async(req,res)=>res.json({data:await list('categories')})));
 app.get(branch+'/customizations',wrap(async(req,res)=>{const products=await list('products');const groups=await list('customization-groups');res.json({data:groups.filter(g=>g.branchId===req.params.branchId||(!g.branchId&&products.some(p=>p.branchId===req.params.branchId&&p.customizationGroupIds?.includes(g.id))))})}));
 app.post(branch+'/customizations',manager,wrap(async(req,res)=>{const body=groupSchema.parse(req.body);const group={...body,id:crypto.randomUUID(),branchId:req.params.branchId};await mutate('customization-groups',rows=>rows.push(group));res.status(201).json({data:group})}));
 app.patch(branch+'/customizations/:groupId',manager,wrap(async(req,res)=>{const body=groupSchema.parse(req.body);const updated=await mutate('customization-groups',rows=>{const g=rows.find(x=>x.id===req.params.groupId&&x.branchId===req.params.branchId);if(!g)fail(404,'Customization group not found');Object.assign(g,body);return structuredClone(g)});res.json({data:updated})}));
 app.delete(branch+'/customizations/:groupId',manager,wrap(async(req,res)=>{const used=(await list('products')).some(p=>p.branchId===req.params.branchId&&p.customizationGroupIds?.includes(req.params.groupId)&&!p.archived);if(used)fail(409,'Remove this group from active products before deleting it');await mutate('customization-groups',rows=>{const i=rows.findIndex(g=>g.id===req.params.groupId&&g.branchId===req.params.branchId);if(i<0)fail(404,'Group not found');rows.splice(i,1)});res.json({data:{deleted:true}})}));
 app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Route not found'}}));
 app.use((err,_req,res,next)=>{if(res.headersSent)return next(err);if(err instanceof z.ZodError)return res.status(400).json({error:{code:'VALIDATION',details:err.flatten()}});const status=err.status||500;if(status>=500)console.error(err);res.status(status).json({error:{code:status===500?'INTERNAL_ERROR':'REQUEST_ERROR',message:status===500?'Internal server error':err.message}});});
 return app;
}
