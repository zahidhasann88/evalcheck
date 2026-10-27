// TypeScript 7 ships no JavaScript compiler API. typescript-eslint and tsup load `typescript`
// as a library, so point them at the TypeScript 6 compatibility package instead of the
// project's TypeScript 7. Remove this once both support TypeScript 7.
const TS6 = 'npm:@typescript/typescript6@^6.0.2';

function readPackage(pkg) {
  const isTsEslint = pkg.name === 'typescript-eslint' || pkg.name.startsWith('@typescript-eslint/');
  const usesApi = isTsEslint || pkg.name === 'ts-api-utils' || pkg.name === 'tsup';
  if (usesApi && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
