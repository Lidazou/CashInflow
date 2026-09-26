import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { join } from 'node:path'
import { openDatabase, type DatabaseHandle } from './database/connection'
import { Services } from './services'
import { registerIpcHandlers } from './ipc'
import { IPC_CHANNELS } from '@shared/types/ipc-contract'

/**
 * Main process entry point.
 *
 * STARTUP ORDER MATTERS
 * ---------------------
 * The database is opened and migrated BEFORE any window is created. If a
 * migration fails we want to show a real error dialog rather than flashing an
 * empty window that the user reads as "all my data is gone".
 */

/**
 * Fix the application name BEFORE anything reads a path.
 *
 * `app.getPath('userData')` is derived from the application name, and when
 * Electron is launched directly (development, or any run where the app is not
 * installed) that name defaults to "Electron". The database would then be created
 * in `%APPDATA%\Electron\spendwise.db` — a directory shared with every other
 * unbranded Electron app on the machine, which is both confusing and a genuine
 * privacy hazard for a file holding someone's financial history.
 *
 * In a packaged build the name comes from package.json's `productName`, but in
 * development it does not, so the two would disagree and a developer's data would
 * land somewhere different from a user's. Setting it explicitly makes the
 * location identical in both cases:
 *
 *     C:\Users\<user>\AppData\Roaming\CashInflow\spendwise.db
 *
 * This must run before the first `app.getPath` call, which is why it sits at
 * module scope rather than inside `whenReady`.
 */
app.setName('CashInflow')

const isDev = !app.isPackaged

let dbHandle: DatabaseHandle | null = null
let services: Services | null = null
let mainWindow: BrowserWindow | null = null

/** Resolved app data directory. Electron guarantees this exists per-app. */
function dataDir(): string {
  return app.getPath('userData')
}

function databasePath(): string {
  return join(dataDir(), 'spendwise.db')
}

function getServices(): Services {
  if (!services) {
    throw new Error('The database is not open. This indicates a startup failure.')
  }
  return services
}

function getDbHandle(): DatabaseHandle {
  if (!dbHandle) {
    throw new Error('The database is not open. This indicates a startup failure.')
  }
  return dbHandle
}

/** Broadcast a data-change notification so open pages refetch. */
function notifyDataChanged(reason: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.eventDataChanged, { reason })
    }
  }
}

/**
 * Rebuild the services over a freshly opened database.
 * Used after a restore replaces the file on disk.
 */
function reopenServices(): void {
  try {
    dbHandle?.close()
  } catch {
    /* the connection may already be closed by the caller */
  }
  dbHandle = openDatabase({ dataDir: dataDir() })
  services = new Services(dbHandle.db)
}

/**
 * Initial window size, overridable by environment variable.
 *
 * The dashboard is a three-column layout that only fits above roughly 1440 CSS
 * pixels, so the documented screenshots have to be taken on a window wide enough
 * to show it. Without this, the only way to capture that view was to hand-resize
 * the window before every shot, which is not reproducible.
 *
 * An environment variable rather than a CLI flag because it is not part of the
 * app's supported interface: it exists for this repository's tooling, has an
 * obvious default, and an invalid value is ignored rather than fatal.
 */
function windowDimension(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 1024 ? Math.trunc(raw) : fallback
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: windowDimension('CASHINFLOW_WINDOW_WIDTH', 1400),
    height: windowDimension('CASHINFLOW_WINDOW_HEIGHT', 900),
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#F7F7F5',
    title: 'CashInflow',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // --- Security configuration (spec 搂39) -----------------------------
      // The renderer runs in its own world with no direct access to Node or to
      // the database. Everything it can do is enumerated in the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required so the preload can use bundled helpers
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Deny every permission request by default; this app needs none of them.
      // Local-first software that quietly asks for camera access is a red flag.
      spellcheck: false
    }
  })

  // Avoid a white flash: only show once the first paint is ready.
  window.once('ready-to-show', () => {
    window.show()
  })

  // Any attempt to open a new window goes to the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the bundled UI. Without this, a stray
  // link could replace the app shell with a remote page that still has the
  // preload bridge attached.
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    const isDevServerUrl = devServer ? url.startsWith(devServer) : false
    if (!isDevServerUrl && !url.startsWith('file://')) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  // Deny permission requests (geolocation, notifications, media, ...).
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

/** A minimal menu: the app is keyboard-driven, but copy/paste must work. */
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Only one instance may run at a time.
 *
 * Two processes writing the same SQLite file would work at the database level
 * (WAL handles it) but would leave the two windows showing different data, which
 * in a finance app looks like corruption. Focusing the existing window is both
 * simpler and more honest.
 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    try {
      dbHandle = openDatabase({ dataDir: dataDir() })
      services = new Services(dbHandle.db)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A failure here means the app cannot function at all; say so plainly
      // instead of opening a window that merely appears empty.
      dialog.showErrorBox(
        'CashInflow could not start',
        `The local database could not be opened.\n\n${message}\n\nLocation: ${databasePath()}`
      )
      app.quit()
      return
    }

    registerIpcHandlers({
      getServices,
      getDbHandle,
      dataDir: dataDir(),
      databasePath: databasePath(),
      reopen: reopenServices,
      notifyDataChanged
    })

    buildMenu()
    mainWindow = createWindow()

    // Warm the exchange-rate cache in the background.
    //
    // Deliberately not awaited: a slow or unreachable provider must never delay
    // the window appearing. The app is fully usable without rates — amounts fall
    // back to their own currency and say so — so this is an enhancement, not a
    // precondition. Fetching here means the first screen usually has real rates
    // by the time the user looks at it, and the renderer's own `ratesInfo` call
    // is then a cache hit rather than a network round trip.
    void services?.ensureRates()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Close the database cleanly so the WAL is checkpointed into the main file.
  // Without this, a user who copies spendwise.db while the app is closed would
  // otherwise be fine, but one who copies it after a crash might not be.
  app.on('before-quit', () => {
    try {
      dbHandle?.close()
    } catch {
      /* nothing useful to do at shutdown */
    }
    dbHandle = null
    services = null
  })
}
