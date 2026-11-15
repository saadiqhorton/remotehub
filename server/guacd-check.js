// `npm run guacd:check`: one fresh guacd health probe with the configured settings
// (SAA-301). Prints JSON; exit 0 when guacd is ready, 1 otherwise, 2 when disabled.
import { createGuacdHealth, guacdConfigFromEnv } from './guacd.js';

const config = guacdConfigFromEnv(process.env);
const health = createGuacdHealth({ ...config, enabled: true });
const result = await health.check({ fresh: true });
console.log(JSON.stringify({ ...result, enabledInRemoteHub: config.enabled }, null, 2));
process.exitCode = result.status === 'up' ? (config.enabled ? 0 : 2) : 1;
