import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, fsyncSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { MediaError } from './media.js';

/** Persist claim before transmission. A crash or uncertain result must never replay speech. */
export class SpeechLedger {
  constructor(directory){this.directory=directory;mkdirSync(directory,{recursive:true,mode:0o700});}
  async run(key,bytes,send){
    if(typeof key!=='string'||key.length<8||key.length>200)throw new MediaError('Idempotency-Key (8–200 characters) is required',400);
    const hash=createHash('sha256').update(bytes).digest('hex');
    const file=path.join(this.directory,createHash('sha256').update(key).digest('hex')+'.json');
    let descriptor;
    try{descriptor=openSync(file,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let old;try{old=JSON.parse(readFileSync(file,'utf8'));}catch{throw new MediaError('Speech claim unreadable; replay refused',409);}
      if(old.hash!==hash)throw new MediaError('Idempotency-Key was already used with different audio',409);
      if(old.state==='complete')return old.result;
      throw new MediaError('Prior speech outcome is uncertain; automatic replay refused',409);
    }
    try{writeFileSync(descriptor,JSON.stringify({hash,state:'claimed',at:new Date().toISOString()}));fsyncSync(descriptor);}
    finally{closeSync(descriptor);}
    const result=await send();
    const temp=file+'.tmp';writeFileSync(temp,JSON.stringify({hash,state:'complete',result}),{mode:0o600});renameSync(temp,file);
    return result;
  }
}
