import jwt from 'jsonwebtoken';
import {list} from '../repositories/jsonStore.js';
export function tokenFor(user) {return jwt.sign({sub:user.id,role:user.role,branchIds:user.branchIds},process.env.JWT_SECRET,{expiresIn:'8h'});}
export async function auth(req,res,next) {
  const token=req.headers.authorization?.replace(/^Bearer /i,'');
  try {
    if(!token)throw Error('Missing token');
    const payload=jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});
    const user=(await list('users')).find(u=>u.id===payload.sub&&u.active);
    if(!user)throw Error('Account inactive');
    req.user={...payload,role:user.role,branchIds:user.branchIds||[]};
    next();
  }catch {res.status(401).json({error:{code:'UNAUTHORIZED',message:'Valid login required'}})}
}
export function access(req,res,next) {
  if(req.user.role==='super_admin'||req.user.branchIds.includes(req.params.branchId)) return next();
  return res.status(403).json({error:{code:'FORBIDDEN',message:'Branch access denied'}});
}
export function manager(req,res,next) {
  if(['super_admin','owner','manager'].includes(req.user.role)) return next();
  return res.status(403).json({error:{code:'FORBIDDEN',message:'Manager role required'}});
}
