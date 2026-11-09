/**
 * t-r5-8 的假 `web/src/api/socket` —— 只实现 store 用得到的面，并把"发出去没有"记下来。
 *
 * 关键点：socket.io 的 `emit()` 在**未连接**时会返回 socket 自己并把包缓存进 sendBuffer，
 *   调用方看到的是"成功返回"。所以这里同样**不抛错**、只记账 ——
 *   才能复现"界面以为是超时失败，其实请求还在缓冲区里等着重连时发出去"这条。
 */
export const sent = [];

export const socket = {
    connected: false,
    id: 'fake-socket',
    sendBuffer: [],
    on() { return this; },
    off() { return this; },
    emit(event, ...args) {
        // 未连接 ⇒ 真 socket.io 会把它塞进 sendBuffer（这就是缺陷的物理载体）
        if (!this.connected) this.sendBuffer.push([event, ...args]);
        sent.push(event);
        return this;
    },
    disconnect() {},
    connect() {},
};

export function isOnline() { return socket.connected; }

export function connect() { socket.connected = true; }

export function request(...args) { return Promise.resolve({ ok: true, _fake: true, args }); }

export function emitControl(...args) {
    // 与生产同口径：没连接就不发，返回 false
    if (!socket.connected) return false;
    socket.emit(...args);
    return true;
}
