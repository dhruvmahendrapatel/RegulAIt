import pg from 'pg';
import { importJWK } from 'jose';
import { createDb } from '../../packages/db/dist/index.js';
import { replica } from './server.mjs';
import { verifyResource } from './verify.mjs';

let server, db, pool;
process.on('message', async message => {
  try {
    if (message.type === 'init') {
      const { connection, issuerJwk, issuer, audience, nonceSecret, clients } = message;
      db = createDb(connection); pool = new pg.Pool({ connectionString: connection });
      server = await replica({ db, pool, issuerJwk, issuer, audience, nonceSecret, clients,
        signingKey: await importJWK(issuerJwk, 'ES256') });
      const { d, ...publicKey } = issuerJwk;
      server.app.s0Verify = req => verifyResource(new Request(`${audience}/call`, { method: 'POST',
        headers: { authorization: req.headers['x-s0-authorization'] ?? '', dpop: req.headers.dpop ?? '' } }),
      { pool, issuer, audience, nonceSecret, keys: [publicKey] });
      process.send({ type: 'ready', address: server.address, pid: process.pid });
    } else if (message.type === 'shutdown') {
      await server?.app.close(); await Promise.all(server?.auditWrites ?? []);
      await pool?.end(); await db?.$client.end();
      process.send({ type: 'stopped' }, () => process.exit(0));
    }
  } catch (error) {
    process.send({ type: 'error', name: error.name, message: error.message });
    await pool?.end(); await db?.$client.end();
    process.exit(1);
  }
});
