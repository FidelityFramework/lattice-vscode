'use strict';

// Observe only the isolated test app's renderer, using Chromium's loopback CDP.
const fs = require('node:fs');
const path = require('node:path');

async function rendererProbe(root, title) {
    const portFile = path.join(root, 'user-data/DevToolsActivePort');
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid isolated CDP port.');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const candidates = targets.filter(target => target.type === 'page' && target.title.includes(title));
    if (candidates.length !== 1) throw new Error('Expected one demo renderer: ' + JSON.stringify(targets.map(t => t.title)));
    const socket = new WebSocket(candidates[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    const send = (method, params) => new Promise((resolve, reject) => {
        const ticket = ++id;
        const timer = setTimeout(() => { pending.delete(ticket); reject(new Error('CDP request timed out: ' + method)); }, 10000);
        pending.set(ticket, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: ticket, method, params }));
    });
    // Use a normal editor layout; Electron's headless default is only 300×300.
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    return {
        async evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        },
        async click(point) {
            // Exercise the rendered control's DOM handler, not the extension
            // command directly. Hit-testing preserves occluding UI behavior.
            const result = await send('Runtime.evaluate', { expression: `(() => {
                const element = document.elementFromPoint(${Number(point.x)}, ${Number(point.y)});
                if (!element || typeof element.click !== 'function') throw new Error('No rendered control at the tested point.');
                element.click();
                return { tag: element.tagName, id: element.id, label: element.getAttribute('aria-label'), html: element.outerHTML.slice(0, 900) };
            })()`, returnByValue: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
        },
        dispose() {
            for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP probe disposed.')); }
            pending.clear();
            socket.close();
        }
    };
}

module.exports = { rendererProbe };
