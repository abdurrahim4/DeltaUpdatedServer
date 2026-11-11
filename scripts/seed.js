import 'dotenv/config';
import bcrypt from 'bcryptjs';
import {mutate} from '../src/repositories/jsonStore.js';
// Local demonstration accounts only. Change passwords before any public deployment.
const demoPassword='DeltaKebabDemo2026!';
const users=[
 {id:'admin-demo',email:'admin@deltakebab.demo',role:'super_admin',branchIds:[],active:true},
 {id:'owner',email:'owner@deltakebab.demo',role:'owner',branchIds:['kowale','gdansk','pruszcz'],active:true},
 ...['kowale','gdansk','pruszcz'].map(id=>({id:`staff-${id}`,email:`${id}@deltakebab.demo`,role:'staff',branchIds:[id],active:true}))
];
const hash=await bcrypt.hash(demoPassword,12);
await mutate('users',rows=>{for(const u of users){const existing=rows.find(x=>x.id===u.id);if(existing)Object.assign(existing,u,{passwordHash:hash});else rows.push({...u,passwordHash:hash});}});
console.log('Demo accounts seeded. Login: admin@deltakebab.demo / DeltaKebabDemo2026!');
console.log('WARNING: local demo credentials; replace before production.');
