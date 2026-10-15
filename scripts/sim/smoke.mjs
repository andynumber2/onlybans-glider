// Smoke test: does the game boot and tick offline?
import { createSim } from './harness.mjs';

const t0 = Date.now();
const sim = await createSim({ seed: 1 });
console.log('booted', sim.bundleName, 'tick', sim.G.T);
const startButton = [...sim.window.document.querySelectorAll('button')].find(b => /PURIST|FUNDED/i.test(b.textContent));
console.log('start button:', startButton ? startButton.textContent.trim().slice(0, 40) : 'none');
await sim.run(60);
console.log('after 60s game time: tick', sim.G.T, 'bans', sim.G.s.bans, 'bps', sim.G.bps);
console.log('wall ms', Date.now() - t0);
process.exit(0);
