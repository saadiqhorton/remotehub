import { config } from './config.js';
import { Store } from './store.js';

const command = process.argv[2];

if (command === 'reset-owner') {
  const store = await new Store(config.dataDir).load();
  await store.setOwner(null);
  console.log('Owner password removed. Restart RemoteHub to get a new setup code.');
  console.log('Saved computers and fingerprints were kept.');
} else {
  console.log('Usage: npm run reset-owner');
  process.exit(1);
}
