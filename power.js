// Owner attestation of wall power. The SDK cannot prove mains power on this
// solar-capable battery camera, so the owner sets EUFY_CONTINUOUS_POWER=owner-confirmed
// while the camera is plugged in. A cloud report that it is explicitly NOT charging
// still withdraws the confirmation, so an unplugged camera is not drained.
export function continuousPowerConfirmed(env, battery) {
  return env.EUFY_CONTINUOUS_POWER === "owner-confirmed" && battery?.charging !== false;
}
