// Shared compile-time asset: Rust creates containers with this identical policy.
import policy from "../assets/seccomp.json" with { type: "json" };
export const seccompPolicy = Object.freeze(policy);

// This operates only on a task-owned, read-only probe mount. An isolation failure
// never tests host-repository writes. The real command uses the identical flags.
export const confinementProbe = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const child = require('node:child_process');
(async () => {
  assert.throws(() => fs.writeFileSync('/outside-conductor-probe', 'denied'), { code: 'EROFS' });
  assert.throws(() => fs.writeFileSync('/workspace/read-only-canary', 'denied'), { code: 'EROFS' });
  for (const address of [{ host: '127.0.0.1', port: 1 }, { path: '/tmp/probe.sock' }]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(address);
      socket.once('error', error => error.code === 'EPERM' ? resolve() : reject(error));
      socket.once('connect', () => { socket.destroy(); reject(new Error('socket unexpectedly connected')); });
    });
  }
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^CapEff:\\s+0+$/m);
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\\s+1$/m);
  const mount = child.spawnSync('/bin/mount', ['-t', 'tmpfs', 'tmpfs', '/mnt']);
  assert.notEqual(mount.status, 0);
  console.log('CONDUCTOR_CONFINEMENT_V1_PASS');
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
`;
