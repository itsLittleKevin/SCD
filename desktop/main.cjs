const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const { URL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");

let mainWindow = null;
let apiProcess = null;
let desktopServer = null;
let desktopBaseUrl = "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const API_HOST = "127.0.0.1";
const API_PORT = 5174;

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const getApiEntry = () => {
  // Packaged output goes to dist/src/api-server.js from existing tsconfig.
  return path.join(app.getAppPath(), "dist", "src", "api-server.js");
};

const getUiRoot = () => path.join(app.getAppPath(), "dist");

const resolveFilePath = (requestPath) => {
  const uiRoot = getUiRoot();
  const cleanPath = decodeURIComponent(requestPath.split("?")[0]);
  const relative = cleanPath === "/" ? "/index.html" : cleanPath;
  const absolute = path.normalize(path.join(uiRoot, relative));
  if (!absolute.startsWith(path.normalize(uiRoot))) {
    return path.join(uiRoot, "index.html");
  }
  return absolute;
};

const proxyToApi = (req, res) => {
  const reqUrl = new URL(req.url, `http://${API_HOST}`);
  const options = {
    hostname: API_HOST,
    port: API_PORT,
    path: `${reqUrl.pathname}${reqUrl.search}`,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${API_HOST}:${API_PORT}`,
      origin: desktopBaseUrl,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "desktop_api_proxy_failed" }));
  });

  req.pipe(proxyReq);
};

const startDesktopServer = async () => {
  const uiRoot = getUiRoot();
  desktopServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      if (reqUrl.pathname.startsWith("/api/")) {
        proxyToApi(req, res);
        return;
      }

      let target = resolveFilePath(reqUrl.pathname);
      let stat = null;
      try {
        stat = await fsp.stat(target);
      } catch {
        target = path.join(uiRoot, "index.html");
        stat = await fsp.stat(target);
      }

      if (stat.isDirectory()) {
        target = path.join(target, "index.html");
      }

      const ext = path.extname(target).toLowerCase();
      const contentType = mimeByExt[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
      fs.createReadStream(target).pipe(res);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("desktop_server_error");
    }
  });

  await new Promise((resolve, reject) => {
    desktopServer.once("error", reject);
    desktopServer.listen(0, "127.0.0.1", resolve);
  });

  const address = desktopServer.address();
  if (!address || typeof address === "string") {
    throw new Error("desktop_server_bind_failed");
  }
  desktopBaseUrl = `http://127.0.0.1:${address.port}`;
};

const startApiServer = async () => {
  const apiEntry = getApiEntry();
  apiProcess = spawn(process.execPath, [apiEntry], {
    cwd: app.getAppPath(),
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  apiProcess.on("exit", () => {
    apiProcess = null;
  });

  // Give backend a short startup window.
  await wait(900);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load through local desktop gateway to keep /assets and /api absolute paths working.
  mainWindow.loadURL(desktopBaseUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  await startApiServer();
  await startDesktopServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (desktopServer) {
    try {
      desktopServer.close();
    } catch {
      // ignore
    }
  }

  if (apiProcess && !apiProcess.killed) {
    try {
      apiProcess.kill();
    } catch {
      // ignore
    }
  }
});
