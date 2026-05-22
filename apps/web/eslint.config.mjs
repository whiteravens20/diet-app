// Next.js 16 ships eslint-config-next as a native flat config.
import next from 'eslint-config-next';

const config = [...next, { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] }];

export default config;
