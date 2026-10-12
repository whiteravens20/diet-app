// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// Next.js 16 ships eslint-config-next as a native flat config.
import next from 'eslint-config-next';

const config = [
  ...next,
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  {
    // Dates, numbers and units are written as the language of the application
    // writes them, in one place. Anything that formats by itself would follow
    // the browser's language, or the server's time zone.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/lib/use-format.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]',
          message: 'Format through useFormat() (lib/use-format.ts): this follows the language of the browser, not of the application.',
        },
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message: 'Format through useFormat() (lib/use-format.ts): this writes a dot in every language. To round a number, use Math.round.',
        },
        {
          selector: "MemberExpression[object.name='Intl']",
          message: 'Format through useFormat() (lib/use-format.ts), which knows the language of the application and the time zone of the reader.',
        },
        {
          selector: "ImportSpecifier[imported.name='useFormatter']",
          message: 'Use useFormat() (lib/use-format.ts): the formatter of the provider writes a moment in the time zone of the server.',
        },
      ],
    },
  },
];

export default config;
