import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';

// Intentionally do NOT share `@iobroker/gui-components` (or @mui/*) here: this component does not
// use it, and sharing it as a Module Federation singleton pulls in its full dependency graph
// (10.000+ MUI icon modules), which pushed local build times from a few seconds to 18+ minutes.
// Only `react`/`react-dom` need to be shared so this component reuses Admin's own instances instead
// of bundling its own copies.
const config = {
    plugins: [
        federation({
            manifest: true,
            // Must stay in sync with the first segment of `name` in admin/jsonConfig.json.
            name: 'DataSolectrusItems',
            filename: 'customComponents.js',
            exposes: {
                './Components': './src/Components.tsx',
            },
            remotes: {},
            shared: {
                react: { requiredVersion: '*', singleton: true },
                'react-dom': { requiredVersion: '*', singleton: true },
            },
        }),
        react(),
    ],
    server: {
        port: 4173,
    },
    base: './',
    build: {
        target: 'chrome89',
        outDir: './build',
        sourcemap: true,
    },
};

export default config;
