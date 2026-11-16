import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTerrainNetwork} from './terrain-network.mjs';

test('terrain downloads back off on spikes relative to the connection and resume after recovery', () => {
  const network = createTerrainNetwork();
  network.sample(145,0);
  network.sample(152,1250);
  assert.equal(network.constrained(1250),false);
  network.sample(195,2500);
  assert.equal(network.constrained(2500),true);
  network.sample(405,3750);
  network.sample(148,5000);
  assert.equal(network.constrained(6000),true);
  assert.equal(network.constrained(6750),false);

  network.sample(null,8000);
  assert.equal(network.constrained(8250),true);
  network.sample(380,40_000);
  network.sample(385,41_250);
  assert.equal(network.constrained(41_250),false);
});
