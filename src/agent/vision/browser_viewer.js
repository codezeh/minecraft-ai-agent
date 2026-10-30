import settings from '../settings.js';

// prismarine-viewer pulls in the native `canvas` module at require time, which
// needs a C++ toolchain to build. Load it lazily so mindcraft runs fine on
// machines without one as long as render_bot_view is disabled.
export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view)
        return;
    import('prismarine-viewer').then(({ default: prismarineViewer }) => {
        const mineflayerViewer = prismarineViewer.mineflayer;
        mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
    }).catch((err) => {
        console.error('[browser_viewer] prismarine-viewer unavailable (native `canvas` not built):', err.message);
    });
}
