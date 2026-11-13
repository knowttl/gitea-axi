import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'evidence/**', 'src/vendor.generated.ts'] },
  ...tseslint.configs.recommended,
);
