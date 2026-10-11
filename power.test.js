import test from "node:test";
import assert from "node:assert/strict";
import { continuousPowerConfirmed } from "./power.js";

test("unset flag never confirms", () => {
  assert.equal(continuousPowerConfirmed({}, { charging: true, level: 100 }), false);
});
test("owner flag confirms when charging is true or unknown", () => {
  const env = { EUFY_CONTINUOUS_POWER: "owner-confirmed" };
  assert.equal(continuousPowerConfirmed(env, { charging: true }), true);
  assert.equal(continuousPowerConfirmed(env, { charging: null }), true);
  assert.equal(continuousPowerConfirmed(env, undefined), true);
});
test("explicit not-charging withdraws the confirmation", () => {
  assert.equal(continuousPowerConfirmed({ EUFY_CONTINUOUS_POWER: "owner-confirmed" }, { charging: false }), false);
});
test("any other flag value does not confirm", () => {
  assert.equal(continuousPowerConfirmed({ EUFY_CONTINUOUS_POWER: "true" }, { charging: true }), false);
});
