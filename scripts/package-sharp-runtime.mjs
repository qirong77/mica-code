import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Stage a portable sharp runtime next to a compiled binary.
 * Bun --compile cannot reliably embed sharp native addons, so the binary
 * keeps sharp external and loads these files via package.json autoload.
 */
export function packageSharpRuntime(targetDir) {
  if (!targetDir) throw new Error('packageSharpRuntime requires targetDir');
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  const sharpPkgPath = require.resolve('sharp/package.json');
  const sharpRoot = dirname(sharpPkgPath);
  const sharpPkg = JSON.parse(readFileSync(sharpPkgPath, 'utf8'));
  const version = sharpPkg.version;

  const nodeModules = join(targetDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });

  copyPackage('sharp', sharpRoot, join(nodeModules, 'sharp'));

  for (const dep of ['detect-libc', 'semver']) {
    const depRoot = dirname(require.resolve(`${dep}/package.json`, { paths: [sharpRoot] }));
    copyPackage(dep, depRoot, join(nodeModules, dep));
  }

  // @img/colour is a normal dependency of sharp 0.35.
  try {
    const colourRoot = dirname(require.resolve('@img/colour/package.json', { paths: [sharpRoot] }));
    copyPackage('@img/colour', colourRoot, join(nodeModules, '@img', 'colour'));
  } catch {
    // Older sharp builds may not need this package.
  }

  // Prefer the platform package already installed for this host.
  const platformArch = `${process.platform}-${process.arch}`;
  const platformCandidates = [
    `@img/sharp-${platformArch}`,
    // Bun/Node on linux may need musl variants; try both.
    process.platform === 'linux' ? `@img/sharp-linuxmusl-${process.arch}` : null,
  ].filter(Boolean);

  let platformPkgName = null;
  let platformRoot = null;
  for (const name of platformCandidates) {
    try {
      platformRoot = dirname(require.resolve(`${name}/package.json`, { paths: [sharpRoot, process.cwd()] }));
      platformPkgName = name;
      break;
    } catch {
      // try next
    }
  }
  if (!platformPkgName || !platformRoot) {
    throw new Error(
      `Unable to locate sharp platform package for ${platformArch}. Run bun install on the target OS/CPU first.`,
    );
  }

  copyPackage(platformPkgName, platformRoot, join(nodeModules, ...platformPkgName.split('/')));

  const platformPkg = JSON.parse(readFileSync(join(platformRoot, 'package.json'), 'utf8'));
  const libvipsName = Object.keys(platformPkg.optionalDependencies || {}).find((name) =>
    name.startsWith('@img/sharp-libvips-'),
  );
  if (libvipsName) {
    const libvipsRoot = dirname(
      require.resolve(`${libvipsName}/package.json`, { paths: [platformRoot, sharpRoot, process.cwd()] }),
    );
    copyPackage(libvipsName, libvipsRoot, join(nodeModules, ...libvipsName.split('/')));
  }

  writeFileSync(
    join(targetDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'mica-sharp-runtime',
        private: true,
        type: 'module',
        dependencies: {
          sharp: version,
        },
      },
      null,
      2,
    )}\n`,
  );

  return {
    version,
    platformPkgName,
    targetDir,
  };
}

function copyPackage(name, sourceRoot, targetRoot) {
  mkdirSync(dirname(targetRoot), { recursive: true });
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const base = source.split(/[\\/]/).pop() || '';
      // Skip nested package managers / docs noise if present.
      return base !== '.git' && base !== 'node_modules';
    },
  });
  // Re-link nested deps for packages that expect local node_modules is unnecessary:
  // we install flat top-level packages that Node/Bun can resolve from the runtime root.
  void name;
}

if (import.meta.main) {
  const target = process.argv[2] || join('dist', 'sharp-runtime');
  const result = packageSharpRuntime(target);
  console.log(`Packaged sharp@${result.version} (${result.platformPkgName}) -> ${result.targetDir}`);
}
