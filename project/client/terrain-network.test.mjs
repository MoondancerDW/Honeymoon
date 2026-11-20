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

test('background work stays paused throughout recovery and respects any remaining latency backoff', () => {
  const network = createTerrainNetwork();
  network.setRecovery(true);
  network.sample(120,100);
  assert.equal(network.backgroundPaused(),true);
  assert.equal(network.constrained(10_000),true);
  network.sample(null,10_000);
  network.setRecovery(false);
  assert.equal(network.backgroundPaused(),false);
  assert.equal(network.constrained(11_000),true);
  assert.equal(network.constrained(13_000),false);
});
