import { deleteFoldersRecursive, npmInstall, buildReact, copyFiles } from '@iobroker/build-tools';

const src = `${__dirname}/src-admin/`;

// admin/ also holds hand-maintained files (jsonConfig.json, i18n/, the adapter icon) that are NOT
// produced by this build, so cleaning is scoped to admin/custom/ only - never wipe all of admin/.
function clean(): void {
    deleteFoldersRecursive(`${__dirname}/admin/custom`);
    deleteFoldersRecursive(`${src}build`);
}

function copyAllFiles(): void {
    copyFiles(['src-admin/build/customComponents.js'], 'admin/custom');
    // Admin reads this manifest to see which component library / GUI API generation the build
    // targets, and refuses to start the component if it targets an older generation.
    copyFiles(['src-admin/build/mf-manifest.json'], 'admin/custom');
    copyFiles(['src-admin/build/assets/*'], 'admin/custom/assets');
}

if (process.argv.includes('--0-clean')) {
    clean();
} else if (process.argv.includes('--1-npm')) {
    npmInstall(src).catch((e: unknown) => console.error(`Cannot install npm: ${e as Error}`));
} else if (process.argv.includes('--2-build')) {
    buildReact(src, { vite: true }).catch((e: unknown) => console.error(`Cannot build: ${e as Error}`));
} else if (process.argv.includes('--3-copy')) {
    copyAllFiles();
} else {
    clean();
    npmInstall(src)
        .then(() => buildReact(src, { vite: true }))
        .then(() => copyAllFiles())
        .catch((e: unknown) => {
            console.error(e);
            process.exit(2);
        });
}
