// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

// Shared flat ESLint config for the monorepo. Workspace packages re-export this
// (apps/web uses the Next.js config instead).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Secrets/config are resolved through the validated config layer
    // (config/env.ts + ConfigService), never ad-hoc process.env reads. The few
    // legitimate bootstrap/subprocess reads carry an inline eslint-disable with
    // a reason. Tests and their support code may read and set env freely.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/testing/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Resolve configuration through ConfigService / config/env.ts, not process.env directly.',
        },
        {
          // Which diets a recipe qualifies for follows from its ingredients.
          selector: "Property[key.name='dietTags'] > ArrayExpression[elements.length>0]",
          message:
            'Diet tags are worked out by recipeFacts() from the ingredients; they are never written by hand.',
        },
      ],
    },
  },
);
