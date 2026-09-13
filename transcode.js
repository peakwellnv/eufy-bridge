import { spawn } from 'node:child_process';
import { MediaError } from './media.js';

/** Decode only caller-supplied bytes; no filesystem or network input protocols. */
export function transcode(input, inputFormat, outputFormat) {
  if (!['ogg','wav','mp3','mp4'].includes(inputFormat) || !['adts','wav'].includes(outputFormat)) throw new MediaError('Unsupported audio format',400);
  return new Promise((resolve,reject)=>{
    const args=['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-f',inputFormat,'-i','pipe:0','-vn','-t','31','-ac','1','-ar','16000'];
    args.push(...(outputFormat==='adts'?['-c:a','aac','-profile:a','aac_low','-b:a','16k']:['-c:a','pcm_s16le']));
    args.push('-f',outputFormat,'pipe:1');
    const child=spawn(process.env.FFMPEG_PATH || 'ffmpeg',args,{stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,settled=false;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(Buffer.concat(chunks));};
    const timer=setTimeout(()=>finish(new MediaError('Audio conversion timed out')),15000);
    child.on('error',()=>finish(new MediaError('Audio decoder is unavailable')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)finish(new MediaError('Decoded audio exceeded limit',413));else chunks.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('close',code=>finish(code===0&&size?null:new MediaError('Audio could not be decoded',400)));
    child.stdin.end(input);
  });
}
