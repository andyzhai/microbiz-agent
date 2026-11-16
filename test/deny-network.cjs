// Test-only network tripwire; any attempted connection fails the child process.
const deny = () => {
  process.exitCode = 99;
  process.stderr.write('NETWORK_ATTEMPT\n');
  throw new Error('Network disabled by acceptance test');
};
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:module').syncBuiltinESMExports();
