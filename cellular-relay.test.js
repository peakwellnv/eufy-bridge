import test from 'node:test';
import assert from 'node:assert/strict';
import { P2PSession } from '@mega-yfue/eufy-sdk';
import { installCellularRelay } from './cellular-relay.js';
installCellularRelay();
function fake() {
  const sent=[];
  return { sent, connected:false, cfg:{stationSn:'T86P200000000000',p2pDid:'TEST-000001-ABCDE',cloudAddresses:[]},
    logger:{debug(){}},send(address,type,payload){sent.push({address,type,payload});} };
}
test('relay lookup echoes nonce using relay CHECK_CAM2',()=>{
  const session=fake();const packet=Buffer.alloc(24);packet[0]=0xf1;packet[1]=0x82;
  packet.writeUInt16LE(32100,6);packet.set([5,2,0,192],8);packet.set([1,2,3,4],20);
  P2PSession.prototype.onMessage.call(session,packet,{address:'192.0.2.6',port:32100});
  assert.equal(session.sent.length,5);
  assert.equal(session.sent[0].type.toString('hex'),'f183');
  assert.equal(session.sent[0].payload.length,28);
  assert.equal(session.sent[0].payload.subarray(0,4).toString('hex'),'01020304');
  assert.deepEqual(session.sent[0].address,{host:'192.0.2.5',port:32100});
  assert.equal(session.sent[4].type.toString('hex'),'f170');
});
test('truncated relay packets produce no traffic',()=>{
  for(const header of [0x82,0x73]) {
    const session=fake();P2PSession.prototype.onMessage.call(session,Buffer.from([0xf1,header,0,0]),{address:'192.0.2.5',port:1234});
    assert.equal(session.sent.length,0);
  }
});
test('relay OK gets its confirmation',()=>{
  const session=fake();P2PSession.prototype.onMessage.call(session,Buffer.from([0xf1,0x71,0,0]),{address:'192.0.2.5',port:1234});
  assert.equal(session.sent.length,1);assert.equal(session.sent[0].type.toString('hex'),'f172');
});
test('repeated relay offers do not restart negotiation; reconnect resets deduplication',()=>{
 const session=fake();const packet=Buffer.alloc(24);packet[0]=0xf1;packet[1]=0x82;
 packet.writeUInt16LE(32100,6);packet.set([5,2,0,192],8);
 const peer={address:'192.0.2.5',port:32100};
 for(let i=0;i<10;i++){
  P2PSession.prototype.onMessage.call(session,packet,peer);
  P2PSession.prototype.onMessage.call(session,Buffer.from([0xf1,0x71,0,0]),peer);
 }
 assert.equal(session.sent.filter(x=>x.type[1]===0x70).length,1);
 assert.equal(session.sent.filter(x=>x.type[1]===0x72).length,1);
 session.connectionGeneration=2;
 P2PSession.prototype.onMessage.call(session,packet,peer);
 P2PSession.prototype.onMessage.call(session,Buffer.from([0xf1,0x71,0,0]),peer);
 assert.equal(session.sent.filter(x=>x.type[1]===0x70).length,2);
 assert.equal(session.sent.filter(x=>x.type[1]===0x72).length,2);
});
