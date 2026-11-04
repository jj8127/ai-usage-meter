const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usage", {
  getState: () => ipcRenderer.invoke("get-state"),
  refresh: () => ipcRenderer.invoke("refresh"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("set-open-at-login", enabled),
  setLocked: (locked) => ipcRenderer.invoke("set-locked", locked),
  setScale: (value) => ipcRenderer.invoke("set-scale", value),
  setClaudePlan: (v) => ipcRenderer.invoke("set-claude-plan", v),
  setFollowTaskbar: (follow) => ipcRenderer.invoke("set-follow-taskbar", follow),
  setNotify: (on) => ipcRenderer.invoke("set-notify", on),
  setInterval: (sec) => ipcRenderer.invoke("set-interval", sec),

  mouseUp: () => ipcRenderer.send("widget-mouseup"),
  openSettings: () => ipcRenderer.send("open-settings"),
  setHold: (value) => ipcRenderer.send("widget-hold", value),
  closePopup: () => ipcRenderer.send("close-popup"),
  quit: () => ipcRenderer.send("quit"),

  noticeClick: () => ipcRenderer.send("notice-click"),
  noticeClose: () => ipcRenderer.send("notice-close"),
  noticeHold: (v) => ipcRenderer.send("notice-hold", v),
  onNotice: (fn) => ipcRenderer.on("notice", (_e, n) => fn(n)),

  onState: (fn) => ipcRenderer.on("state", (_e, state) => fn(state)),
  onSettled: (fn) => ipcRenderer.on("settled", () => fn()),
  onWidgetVisible: (fn) => ipcRenderer.on("widget-visible", (_e, visible) => fn(visible)),
  onFocusSettings: (fn) => ipcRenderer.on("focus-settings", () => fn()),
  onPopupShown: (fn) => ipcRenderer.on("popup-shown", () => fn()),
});
