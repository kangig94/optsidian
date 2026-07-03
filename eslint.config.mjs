import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', '**/*.cjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        sourceType: 'module',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-implicit-coercion': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportAllDeclaration',
          message: 'Do not use export * from. Re-export explicit names from index files.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignoreTernaryTests: true,
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'module',
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-implicit-coercion': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },

  {
    files: ['src/core/lifecycle/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../daemon/**', '../../cli/**', '../../mcp/**'],
              message: 'Core lifecycle primitives must not import adapter layers.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/core/kiwi/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../search/**'],
              message: 'Core Kiwi runtime must stay independent from core search modules.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs'],
    ignores: ['src/daemon/**/*.ts', 'src/core/search/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportAllDeclaration',
          message: 'Do not use export * from. Re-export explicit names from index files.',
        },
        {
          selector: 'ImportDeclaration[source.value=/core\\/search\\/index\\.(?:js|ts)$/]',
          message: 'Do not import core search execution APIs outside daemon or core search modules.',
        },
        {
          selector: 'ExportNamedDeclaration[source.value=/core\\/search\\/index\\.(?:js|ts)$/]',
          message: 'Do not re-export core search execution APIs outside daemon or core search modules.',
        },
        {
          selector: 'ImportExpression[source.value=/core\\/search\\/index\\.(?:js|ts)$/]',
          message: 'Do not dynamically import core search execution APIs outside daemon or core search modules.',
        },
      ],
    },
  },

  prettierConfig,
);
