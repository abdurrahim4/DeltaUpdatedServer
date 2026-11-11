const base=process.env.BASE_URL||'http://localhost:5000';
const count=Number(process.env.COUNT||50);const start=performance.now();
const results=await Promise.all(Array.from({length:count},()=>fetch(base+'/api/v1/restaurants').then(r=>r.status).catch(()=>0)));
console.log(JSON.stringify({count,ok:results.filter(s=>s===200).length,ms:Math.round(performance.now()-start),note:'Small local smoke/load check, not a production benchmark'}));
