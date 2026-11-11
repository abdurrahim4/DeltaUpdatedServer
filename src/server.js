
import dns from 'node:dns';

dns.setServers(['8.8.8.8', '1.1.1.1']);
import 'dotenv/config';
import http from 'node:http';
import {Server} from 'socket.io';
import jwt from 'jsonwebtoken';
import {createApp} from './app.js';
import {list, initStorage, closeStorage, storageMode} from './repositories/jsonStore.js';
if(!process.env.JWT_SECRET||process.env.JWT_SECRET.length<32)throw Error('Set JWT_SECRET (at least 32 characters) in .env');
const origins = '*';
const server=http.createServer(createAppProxy);
// Attach Express exactly once; Socket.IO installs its own Engine.IO request routing.
let appHandler;
function createAppProxy(req,res){return appHandler(req,res);}
const io=new Server(server,{cors:{origin:origins}});
appHandler=createApp(io);
io.use(async(socket,next)=>{
 try {const user=jwt.verify(socket.handshake.auth?.token,process.env.JWT_SECRET,{algorithms:['HS256']});const dbUser=(await list('users')).find(u=>u.id===user.sub&&u.active);if(!dbUser)throw Error('Unauthorized');socket.data.user=dbUser;next();}
 catch {next(new Error('Unauthorized'));}
});
io.on('connection',socket=>{
 const user=socket.data.user;
 for(const branchId of user.branchIds)socket.join(`branch:${branchId}`);
 if(user.role==='super_admin')list('branches').then(branches=>branches.forEach(b=>socket.join(`branch:${b.id}`))).catch(console.error);
 socket.on('orders:sync',async ({branchId}={},reply)=>{
  if(typeof reply!=='function')return;
  if(user.role!=='super_admin'&&!user.branchIds.includes(branchId))return reply({error:'Forbidden'});
  const rows=(await list('orders')).filter(o=>o.branchId===branchId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));reply({data:rows.slice(0,100)});
 });
});

await initStorage();
const port=Number(process.env.PORT||5000);server.listen(port,()=>console.log(`Delta Kebab (${storageMode()}) API: http://localhost:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{io.close();server.close(async()=>{await closeStorage();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();});
