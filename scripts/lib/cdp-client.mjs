export function connectCdp(wsUrl, callTimeoutMs = 15000) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const openTimer = setTimeout(() => {
    fail(new Error("WebSocket connection timed out"));
    socket.close();
  }, callTimeoutMs);
  function fail(error) {
    clearTimeout(openTimer);
    rejectReady(error);
    for (const slot of pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(error);
    }
    pending.clear();
  }
  socket.onopen = () => {
    clearTimeout(openTimer);
    resolveReady();
  };
  socket.onerror = () => fail(new Error("WebSocket connection failed"));
  socket.onclose = () => fail(new Error("WebSocket connection closed"));
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      fail(new Error("Invalid CDP response"));
      socket.close();
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail(new Error("Invalid CDP response"));
      socket.close();
      return;
    }
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    clearTimeout(slot.timer);
    if (message.error)
      slot.reject(new Error(message.error.message ?? "CDP command failed"));
    else slot.resolve(message.result);
  };
  return {
    ready,
    close() {
      fail(new Error("CDP client closed"));
      socket.close();
    },
    send(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error("CDP client is not open"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
  };
}
