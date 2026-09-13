/** Verified T86P2 relay-handshake compatibility for SDK 0.1.2.
 *
 * Protocol provenance: bropat/eufy-security-client src/p2p/session.ts LOOKUP_ADDR2,
 * TURN_SERVER_OK, TURN_SERVER_TOKEN branches and utils.ts buildCheckCamPayload2.
 * The SDK currently passes LOOKUP_ADDR2 to its direct CHECK_CAM path, dropping
 * the relay nonce. This opt-in adapter was verified on real T86P2 hardware on 2026-09-13.
 * It only negotiates media transport; it issues no camera setting commands.
 */
import { P2PSession, p2pCodec } from '@mega-yfue/eufy-sdk';
const installed = Symbol.for('sage.eufy.cellularRelay');
const relayStates = new WeakMap();
const type = n => Buffer.from([0xf1, n]);
export function installCellularRelay() {
  const proto = P2PSession.prototype;
  if (proto[installed]) return;
  proto[installed] = true;
  const originalLookup = proto.sendLookups;
  proto.sendLookups = function() {
    originalLookup.call(this);
    if (this.cfg.stationSn.startsWith('T86P2') && !this.connected && this.socket && this.cfg.dskKey) {
      const payload = p2pCodec.buildLookupWithKeyPayload2(this.cfg.p2pDid, this.cfg.dskKey);
      for (const cloud of this.cfg.cloudAddresses || []) this.send(cloud, type(0x6a), payload);
    }
  };
  const original = proto.onMessage;
  proto.onMessage = function(message, peer) {
    if (!this.cfg.stationSn.startsWith('T86P2') || this.connected || message.length < 4 || message[0] !== 0xf1)
      return original.call(this, message, peer);
    const kind = message[1];
    if (kind === 0x21 && message.length >= 6) this.logger.debug(`relay-step: lookupCode${message.readUInt16LE(4)}`);
    if (![0x82,0x71,0x73].includes(kind)) return original.call(this, message, peer);
    this.logger.debug(`[relay] received header=f1${kind.toString(16)} len=${message.length}`);
    let state = relayStates.get(this);
    if (!state || state.generation !== this.connectionGeneration) {
      state = {generation:this.connectionGeneration, initialized:new Set(), confirmed:false};
      relayStates.set(this,state);
    }
    const did = p2pCodec.p2pDidToBuffer(this.cfg.p2pDid);
    const check = (address, nonce) => {
      const payload = Buffer.concat([nonce, did, Buffer.alloc(4)]);
      for (let i=0;i<4;i++) this.send(address, type(0x83), payload);
    };
    if (kind === 0x82) {
      if (message.length < 24) { this.logger.debug("relay-step: shortLookup"); return; }
      const address = p2pCodec.parseLookupAddr(message);
      if (!address.port || address.host === '0.0.0.0') { this.logger.debug("relay-step: invalidAddress"); return; }
      this.logger.debug("relay-step: sentCheck");
      clearInterval(this.lookupTimer);
      check(address, message.subarray(20,24));
      if (!state.initialized.has(address.host)) {
        state.initialized.add(address.host);
        this.send(address, type(0x70));
      }
    } else if (kind === 0x71) {
      if (!state.confirmed) {
        this.send({host:peer.address,port:peer.port},type(0x72));
        state.confirmed = true;
      }
    } else {
      if (message.length < 10) return;
      const port = message.readUInt16BE(8);
      if (!port) return;
      const address={host:peer.address,port};
      const nonce=message.subarray(4,8);
      check(address,nonce);
      const portBytes=Buffer.alloc(2);portBytes.writeUInt16LE(port);
      const ip=Buffer.from(peer.address.split('.').reverse().map(Number));
      const payload=Buffer.concat([did,Buffer.from([0,2]),portBytes,ip,Buffer.alloc(8),nonce]);
      for(const cloud of this.cfg.cloudAddresses || []) this.send(cloud,type(0x80),payload);
    }
  };
}
