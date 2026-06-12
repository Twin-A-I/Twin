// Force Metro to treat apps/mobile as the server root during EAS monorepo builds.
process.env.EXPO_NO_METRO_WORKSPACE_ROOT = '1';

// Learn more https://docs.expo.dev/guides/customizing-metro
if (!Array.prototype.toReversed) {
  // Metro uses ES2023 array helpers; keep local builds working on older Node.
  Object.defineProperty(Array.prototype, 'toReversed', {
    value() {
      return [...this].reverse();
    },
    writable: true,
    configurable: true,
  });
}

const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const vendorSharedRoot = path.resolve(projectRoot, 'vendor-shared');
const sharedPackageRoot = path.resolve(workspaceRoot, 'packages/shared');
const monorepoNodeModules = path.resolve(workspaceRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

// Prefer vendored shared package for EAS; fall back to workspace package locally.
const sharedRoot = fs.existsSync(vendorSharedRoot) ? vendorSharedRoot : sharedPackageRoot;

config.watchFolders = [sharedRoot, path.resolve(projectRoot, 'modules/background-recorder')];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), monorepoNodeModules];

config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = true;

config.resolver.extraNodeModules = {
  '@twin/shared': sharedRoot,
  'background-recorder': path.resolve(projectRoot, 'modules/background-recorder'),
};

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === '../../App' &&
    context.originModulePath.includes('node_modules/expo/AppEntry')
  ) {
    return {
      filePath: path.resolve(projectRoot, 'App.tsx'),
      type: 'sourceFile',
    };
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.sourceExts = [...config.resolver.sourceExts, 'mjs', 'cjs'];

module.exports = config;
