import net from 'net';
import mc from 'minecraft-protocol';

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {number} port - The port to check.
 * @param {number} timeout - The connection timeout in ms.
 * @param {boolean} verbose - Whether to print output on connection errors.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function serverInfo(ip, port, timeout = 1000, verbose = false) {
    return new Promise((resolve) => {

        let timeoutId = setTimeout(() => {
            if (verbose)
                console.error(`Timeout pinging server ${ip}:${port}`);
            resolve(null); // Resolve as null if no response within timeout
        }, timeout);

        mc.ping({
            host: ip,
            port
        }, (err, response) => {
            clearTimeout(timeoutId);

            if (err) {
                if (verbose)
                    console.error(`Error pinging server ${ip}:${port}`, err);
                return resolve(null);
            }

            // extract version number from modded servers like "Paper 1.21.4"
            const version = response?.version?.name || '';
            const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
            const numericVersion = match ? match[0] : null;
            if (numericVersion !== version) {
                console.log(`Modded server found (${version}), attempting to use ${numericVersion}...`);
            }

            const serverInfo = {
                host: ip,
                port,
                name: response.description.text || 'No description provided.',
                ping: response.latency,
                version: numericVersion
            };

            resolve(serverInfo);
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {boolean} earlyExit - Whether to exit early after finding a server.
 * @param {number} timeout - The connection timeout in ms.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function findServers(ip, earlyExit = false, timeout = 100, opts = {}) {
    const servers = [];
    const startPort = Number.isFinite(opts.startPort) ? opts.startPort : 49000;
    const endPort = Number.isFinite(opts.endPort) ? opts.endPort : 65000;
    // ★ R6 #32：**总预算 + 并发度**。原来是"49000→65000 逐端口串行"，每个端口最多 100ms
    //   ⇒ 最坏 ~27 分钟，期间全进程日志静默（见下），且没有任何上限能把它掐断。
    const totalBudgetMs = Number.isFinite(opts.totalBudgetMs) ? opts.totalBudgetMs : 20000;
    const concurrency = Math.max(1, Math.min(256, Number.isFinite(opts.concurrency) ? opts.concurrency : 64));
    const deadline = Date.now() + totalBudgetMs;

    const checkPort = (port) => {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                resolve(port); // Port is open
            });
            socket.on('error', () => resolve(null)); // Port is closed
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
        });
    };

    // ★ R6 #32：`try/finally` 必须还原 console.log —— 原来中途抛错会让它**永久**是空函数
    //   （直到重启），后续日志全静默（排查者只会以为"服务卡死了"）。
    const originalConsoleLog = console.log;
    const muted = () => { };
    console.log = muted;
    try {
        for (let port = startPort; port <= endPort; port += concurrency) {
            if (Date.now() >= deadline) {
                console.warn(`[mcserver] 端口扫描超过总预算 ${totalBudgetMs}ms（已扫到 ${port}），提前结束`
                    + `（已发现 ${servers.length} 个）；请直接在 settings 里显式写 port`);
                break;
            }
            const batch = [];
            for (let p = port; p < port + concurrency && p <= endPort; p += 1) batch.push(p);
            // 并发探测再加上每个"开着"的端口 ping 一次（保持原来的发现语义，只是不再串行）
            const found = await Promise.all(batch.map((p) => checkPort(p)));
            for (const openPort of found) {
                if (!openPort) continue;
                const server = await serverInfo(ip, openPort, 200, false);
                if (!server) continue;
                servers.push(server);
                if (earlyExit) return servers;
            }
        }
    } finally {
        // 只还原"还是我们那个空函数"的情况：别人若在这期间换了 console.log，别覆盖他
        if (console.log === muted) console.log = originalConsoleLog;
    }

    return servers;
}

/**
 * Gets the MC server info from the host and port.
 * @param {string} host - The host to search for.
 * @param {number} port - The port to search for.
 * @param {string} version - The version to search for.
 * @returns {Promise<Object>} - A Promise that resolves to the server info object.
 */
export async function getServer(host, port, version) {
    let server = null;
    let serverString = "";
    let serverVersion = "";
    
    // Search for server
    if (port == -1)
    {
        console.log(`No port provided. Searching for LAN server on host ${host}...`);
        
        await findServers(host, true).then((servers) => {
            if (servers.length > 0)
                server = servers[0];
        });

        if (server == null)
            throw new Error(`No server found on LAN.`);
    }
    else
        server = await serverInfo(host, port, 1000, true);

    // Server not found
    if (server == null) 
        throw new Error(`MC server not found. (Host: ${host}, Port: ${port}) Check the host and port in settings.js, and ensure the server is running and open to public or LAN.`);

    serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === "auto") 
        serverVersion = server.version;
    else
        serverVersion = version;
    // Server version unsupported / mismatch
    const isSupported = mc.supportedVersions.some(v => 
        serverVersion === v || (serverVersion.startsWith(v) && serverVersion.charAt(v.length) === '.')
    ); // Checks version or parent version (e.g. if 1.7 is supported then 1.7.2 will be allowed)
     if (!isSupported)
        throw new Error(`MC server was found ${serverString}, but version is unsupported. Supported versions are: ${mc.supportedVersions.join(", ")}.`);
    else if (version !== "auto" && server.version !== version)
        throw new Error(`MC server was found ${serverString}, but version is incorrect. Expected ${version}, but found ${server.version}. Check the server version in settings.js.`);
    else
        console.log(`MC server found. ${serverString}`);

    return server;
}
