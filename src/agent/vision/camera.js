import fs from 'fs/promises';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';
import worker_threads from 'worker_threads';
import { createRequire } from 'module';

global.Worker = worker_threads.Worker;

const require = createRequire(import.meta.url);

// The viewer stack (prismarine-viewer/viewer + three + node-canvas-webgl)
// depends on the native `canvas` addon, which has to be compiled locally.
// Requiring it lazily keeps mindcraft usable with allow_vision=false on
// machines without a C++ toolchain.
function loadViewerStack() {
    try {
        const { Viewer } = require('prismarine-viewer/viewer/lib/viewer.js');
        const { WorldView } = require('prismarine-viewer/viewer/lib/worldView.js');
        const { getBufferFromStream } = require('prismarine-viewer/viewer/lib/simpleUtils.js');
        const THREE = require('three');
        const { createCanvas } = require('node-canvas-webgl/lib/index.js');
        return { Viewer, WorldView, getBufferFromStream, THREE, createCanvas };
    } catch (err) {
        throw new Error(
            'Vision requires the native `canvas` addon, which is not built on this machine. ' +
            'Install a C++ toolchain (or a Node version with prebuilt canvas binaries) and run `npm install` again, ' +
            'or set "allow_vision": false in settings.js. Original error: ' + err.message
        );
    }
}

export class Camera extends EventEmitter {
    constructor (bot, fp) {
        super();
        const { Viewer, WorldView, getBufferFromStream, THREE, createCanvas } = loadViewerStack();
        this.WorldView = WorldView;
        this.getBufferFromStream = getBufferFromStream;
        this.THREE = THREE;
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = 12;
        this.width = 800;
        this.height = 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        this._init().then(() => {
            this.emit('ready');
        })
    }

    async _init () {
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new this.WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }

    async capture() {
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, this.bot.entity.yaw, this.bot.entity.pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const buf = await this.getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);
        return filename;
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }
}
