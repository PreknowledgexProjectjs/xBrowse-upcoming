const { BrowserWindow, BrowserView, ipcMain } = require('electron');
const fileUrl = require('file-url');
const windowStateKeeper = require('electron-window-state');
const EventEmitter = require('events');
const log = require('electron-log');

log.transports.file.level = false;
log.transports.console.level = false;

/**
 * @typedef {number} TabID
 * @description BrowserView's id as tab id
 */

/**
 * @typedef {object} Tab
 * @property {string} url - tab's url(address bar)
 * @property {string} href - tab's loaded page url(location.href)
 * @property {string} title - tab's title
 * @property {string} favicon - tab's favicon url
 * @property {boolean} isLoading
 * @property {boolean} canGoBack
 * @property {boolean} canGoForward
 */

/**
 * @typedef {Object.<TabID, Tab>} Tabs
 */

/**
 * @typedef {object} Bounds
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * A browser like window
 * @param {object} options
 * @param {number} [options.width = 1024] - browser window's width
 * @param {number} [options.height = 800] - browser window's height
 * @param {string} options.controlPanel - control interface path to load
 * @param {number} [options.controlHeight = 130] - control interface's height
 * @param {object} [options.viewReferences] - webReferences for every BrowserView
 * @param {object} [options.controlReferences] - webReferences for control panel BrowserView
 * @param {object} [options.winOptions] - options for BrowserWindow
 * @param {string} [options.startPage = ''] - start page to load on browser open
 * @param {string} [options.blankPage = ''] - blank page to load on new tab
 * @param {string} [options.blankTitle = 'about:blank'] - blank page's title
 * @param {function} [options.onNewWindow] - custom webContents `new-window` event handler
 * @param {boolean} [options.debug] - toggle debug
 */
class BrowserLikeWindow extends EventEmitter {
  constructor(options) {
    super();

    this.dataSetup = require('data-store')({ path: process.cwd() + '/dataSetup.json' });

    this.options = options;
    const {
      width = 1024,
      height = 800,
      winOptions = {},
      controlPanel,
      controlReferences
    } = options;

    let mainWindowState = windowStateKeeper({
      defaultWidth: width,
      defaultHeight: height
    });

    this.win = new BrowserWindow({
      ...winOptions,
      'x': mainWindowState.x,
      'y': mainWindowState.y,
      'width': mainWindowState.width,
      'height': mainWindowState.height,
      icon:'icons/icon.ico',
      title:"xBrowse ejs",
      frame:false,
    });

    mainWindowState.manage(this.win);

    this.defCurrentViewId = null;
    this.defTabConfigs = {};
    // Prevent browser views garbage collected
    this.views = {};
    // keep order
    this.tabs = [];
    // ipc channel
    this.ipc = null;

    this.controlView = new BrowserView({
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        // Allow loadURL with file path in dev environment
        webSecurity: false,
        ...controlReferences
      }
    });

    // BrowserView should add to window before setup
    this.win.addBrowserView(this.controlView);
    this.controlView.setBounds(this.getControlBounds());
    this.controlView.setAutoResize({ width: true });
    this.controlView.webContents.loadURL(controlPanel);
    ipcMain.on('set-browseview', (event, url) => {
      this.controlView.webContents.loadURL(url);
    })

    
    
    const webContentsAct = actionName => {
      const webContents = this.currentWebContents;
      const action = webContents && webContents[actionName];
      if (typeof action === 'function') {
        if (actionName === 'reload' && webContents.getURL() === '') return;
        action.call(webContents);
        log.debug(
          `do webContents action ${actionName} for ${this.currentViewId}:${webContents &&
            webContents.getTitle()}`
        );
      } else {
        log.error('Invalid webContents action ', actionName);
      }
    };

    const channels = Object.entries({
      'control-ready': e => {
        this.ipc = e;

        this.newTab(this.options.startPage || '');
        /**
         * control-ready event.
         *
         * @event BrowserLikeWindow#control-ready
         * @type {IpcMainEvent}
         */
        this.emit('control-ready', e);
      },
      'url-change': (e, url) => {
        this.setTabConfig(this.currentViewId, { url });
      },
      'url-enter': (e, url) => {
        this.loadURL(url);
      },
      act: (e, actName) => webContentsAct(actName),
      'new-tab': (e, url, references) => {
        log.debug('new-tab with url', url);
        this.newTab(url, undefined, references);
      },
      'switch-tab': (e, id) => {
        this.switchTab(id);
      },
      'close-tab': (e, id) => {
        log.debug('close tab ', { id, currentViewId: this.currentViewId });
        if (id === this.currentViewId) {
          const removeIndex = this.tabs.indexOf(id);
          const nextIndex = removeIndex === this.tabs.length - 1 ? 0 : removeIndex + 1;
          this.setCurrentView(this.tabs[nextIndex]);
        }
        this.tabs = this.tabs.filter(v => v !== id);
        this.tabConfigs = {
          ...this.tabConfigs,
          [id]: undefined
        };
        this.destroyView(id);

        if (this.tabs.length === 0) {
          this.newTab();
        }
      }
    });

    channels
      .map(([name, listener]) => [
        name,
        (e, ...args) => {
          // Support multiple BrowserLikeWindow
          if (this.controlView && e.sender === this.controlView.webContents) {
            log.debug(`Trigger ${name} from ${e.sender.id}`);
            listener(e, ...args);
          }
        }
      ])
      .forEach(([name, listener]) => ipcMain.on(name, listener));

    /**
     * closed event
     *
     * @event BrowserLikeWindow#closed
     */
    this.win.on('closed', () => {
      // Remember to clear all ipcMain events as ipcMain bind
      // on every new browser instance
      channels.forEach(([name, listener]) => ipcMain.removeListener(name, listener));

      // Prevent BrowserView memory leak on close
      this.tabs.forEach(id => this.destroyView(id));
      if (this.controlView) {
        this.controlView.webContents.destroy();
        this.controlView = null;
        log.debug('Control view destroyed');
      }
      this.emit('closed');
    });

    if (this.options.debug) {
      this.controlView.webContents.openDevTools({ mode: 'detach' });
      log.transports.console.level = 'debug';
    }
  }

  /**
   * Get control view's bounds
   *
   * @returns {Bounds} Bounds of control view(exclude window's frame)
   */
  getControlBounds() {
    const contentBounds = this.win.getContentBounds();
    return {
      x: 0,
      y: 0,
      width: contentBounds.width,
      height: this.options.controlHeight || 130
    };
  }

  /**
   * Set web contents view's bounds automatically
   * @ignore
   */
  setContentBounds() {
    const [contentWidth, contentHeight] = this.win.getContentSize();
    const controlBounds = this.getControlBounds();
    if (this.currentView) {
      this.currentView.setBounds({
      //  x: 25,
        x: 0,
        y: controlBounds.y + controlBounds.height,
        width: contentWidth,
        height: contentHeight - controlBounds.height
      });

      console.log(`x:0 y:${controlBounds.y + controlBounds.height + 10}`);
    }
  }

  get currentView() {
    return this.currentViewId ? this.views[this.currentViewId] : null;
  }

  get currentWebContents() {
    const { webContents } = this.currentView || {};
    return webContents;
  }

  // The most important thing to remember about the get keyword is that it defines an accessor property,
  // rather than a method. So, it can’t have the same name as the data property that stores the value it accesses.
  get currentViewId() {
    return this.defCurrentViewId;
  }

  set currentViewId(id) {
    this.defCurrentViewId = id;
    this.setContentBounds();
    if (this.ipc) {
      this.ipc.reply('active-update', id);
    }
  }

  get tabConfigs() {
    return this.defTabConfigs;
  }

  set tabConfigs(v) {
    this.defTabConfigs = v;
    if (this.ipc) {
      this.ipc.reply('tabs-update', {
        confs: v,
        tabs: this.tabs
      });
    }
  }

  setTabConfig(viewId, kv) {
    const tab = this.tabConfigs[viewId];
    const { webContents } = this.views[viewId] || {};
    this.tabConfigs = {
      ...this.tabConfigs,
      [viewId]: {
        ...tab,
        canGoBack: webContents && webContents.canGoBack(),
        canGoForward: webContents && webContents.canGoForward(),
        ...kv
      }
    };
    return this.tabConfigs;
  }

  loadURL(url) {
    const { currentView } = this;
    const fileUrl = require('file-url');
    if (!url || !currentView) return;

    const { id, webContents } = currentView;

    // Prevent addEventListeners on same webContents when enter urls in same tab
    const MARKS = '__IS_INITIALIZED__';
    if (webContents[MARKS]) {
      if(url.includes('px://')){
        url.replace("px://", "");
        url = fileUrl(`${__dirname}/main/renderer/${url.replace("px://", "")}.html`);
      }
      webContents.loadURL(url);
      return;
    }

    const onNewWindow = (e, newUrl, frameName, disposition, winOptions) => {
      log.debug('on new-window', { disposition, newUrl, frameName });

      if (!new URL(newUrl).host) {
        // Handle newUrl = 'about:blank' in some cases
        log.debug('Invalid url open with default window');
        return;
      }

      e.preventDefault();

      if (disposition === 'new-window') {
        e.newGuest = new BrowserWindow(winOptions);
      } else if (disposition === 'foreground-tab') {
        this.newTab(newUrl, id);
        // `newGuest` must be setted to prevent freeze trigger tab in case.
        // The window will be destroyed automatically on trigger tab closed.
        e.newGuest = new BrowserWindow({ ...winOptions, show: false });
      } else {
        this.newTab(newUrl, id);
      }
    };

    webContents.on('new-window', this.options.onNewWindow || onNewWindow);

    ipcMain.on('print-webContent', (event,device) => {
      console.log("print request > "+this.currentView.id);
      this.printView(this.currentView.id,device);
    });
    
    this.currentView.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        let allowedPermissions = ["audioCapture","hid","geolocation"]; // Full list here: https://developer.chrome.com/extensions/declare_permissions#manifest

        if (allowedPermissions.includes(permission)) {
                callback(true); // Approve permission request
        } else {
          console.error(
            `The application tried to request permission for '${permission}'. This permission was not whitelisted and has been blocked.`
          );
            callback(false); // Deny
        }
    });
    // Keep event in order

    webContents
      .on('did-start-loading', () => {
        log.debug('did-start-loading > set loading');
        this.setTabConfig(id, { isLoading: true });
      })
      .on('did-fail-load', (event, code, desc, url, isMainFrame) => {
        log.debug(`did-fail-loading > \n ErrorDesc : ${desc} \n ErrorCode : ${code} `);
        webContents.loadURL(fileUrl(`${__dirname}/main/renderer/web_fail_code.html`)+`?errorDescription=${desc}&code=${code}&url=${url}`);
        this.setTabConfig(id, { isLoading: false });
      })
      .on('did-start-navigation', (e, href, isInPlace, isMainFrame) => {
        if (isMainFrame) {
          const fileUrl = require('file-url');
          if(href == this.options.blankPage){
            href = "";
          }

          if(href.includes(fileUrl(`${__dirname}/main/renderer/settings.html`))){
            href = "px://settings";
          }

          if(href.includes(fileUrl(`${__dirname}/main/renderer/about.html`))){
            href = "px://about";
          }

          if(href.includes(fileUrl(`${__dirname}/main/renderer/help.html`))){
            href = "px://help";
          }

          if(href.includes(fileUrl(`${__dirname}/main/renderer/web_fail_code.html`))){
            href = "px://network-error";
          }

          if(href.includes(fileUrl(`${__dirname}/main/renderer/credits.html`))){
            href = "px://credits";
          }

          log.debug('did-start-navigation > set url address', {
            href,
            isInPlace,
            isMainFrame
          });
          this.setTabConfig(id, { url: href, href });
          /**
           * url-updated event.
           *
           * @event BrowserLikeWindow#url-updated
           * @return {BrowserView} view - current browser view
           * @return {string} href - updated url
           */
          this.emit('url-updated', { view: currentView, href });
        }
      })
      .on('will-redirect', (e, href) => {
        log.debug('will-redirect > update url address', { href });
        this.setTabConfig(id, { url: href, href });
        this.emit('url-updated', { view: currentView, href });
      })
      .on('page-title-updated', (e, title) => {
        log.debug('page-title-updated', title);
        this.setTabConfig(id, { title });
      })
      .on('page-favicon-updated', (e, favicons) => {
        log.debug('page-favicon-updated', favicons);
        this.setTabConfig(id, { favicon: favicons[0] });
      })
      .on('did-stop-loading', () => {

        log.debug('did-stop-loading', { title: webContents.getTitle() });
        this.setTabConfig(id, { isLoading: false });
      })
      .on('dom-ready', () => {
        webContents.focus();
      });

    webContents.loadURL(url);
    webContents[MARKS] = true;

    webContents.on('unresponsive', async () => {
      const { response } = await dialog.showMessageBox({
        message: 'this Website has become unresponsive',
        title: 'Do you want to try forcefully reloading the website?',
        buttons: ['OK', 'Cancel'],
        cancelId: 1
      })
      if (response === 0) {
        webContents.forcefullyCrashRenderer()
        webContents.reload()
      }
    })

    webContents
      .executeJavaScript('localStorage.user_agent', true)
      .then(result => {
        if (result == undefined) {
          webContents.setUserAgent(`Mozilla/5.0 (Windows NT ${require('os').release()}; Win64; ${require('os').arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36`)
        }else{
          webContents.setUserAgent(result);
        }
      });

    //webContents.setUserAgent(`Mozilla/5.0 (Windows NT ${require('os').release()}; Win64; ${require('os').arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36`)

    this.setContentBounds();

    if (this.options.debug) {
     // webContents.openDevTools({ mode: 'detach' });
    }
  }

  setCurrentView(viewId) {
    if (!viewId) return;
    this.win.removeBrowserView(this.currentView);
    this.win.addBrowserView(this.views[viewId]);
    this.currentViewId = viewId;
  }

  /**
   * Create a tab
   *
   * @param {string} [url=this.options.blankPage]
   * @param {number} [appendTo] - add next to specified tab's id
   * @param {object} [references=this.options.viewReferences] - custom webPreferences to this tab
   *
   * @fires BrowserLikeWindow#new-tab
   */
  newTab(url, appendTo, references) {
    const view = new BrowserView({
      webPreferences: {
        // Set sandbox to support window.opener
        // See: https://github.com/electron/electron/issues/1865#issuecomment-249989894
        sandbox: true,
        ...(references || this.options.viewReferences)
      }
    });

    view.id = view.webContents.id;

    if (appendTo) {
      const prevIndex = this.tabs.indexOf(appendTo);
      this.tabs.splice(prevIndex + 1, 0, view.id);
    } else {
      this.tabs.push(view.id);
    }
    this.views[view.id] = view;

    // Add to manager first
    const lastView = this.currentView;
    this.setCurrentView(view.id);
    view.setAutoResize({ width: true, height: true });
    this.loadURL(url || this.options.blankPage);
    this.setTabConfig(view.id, {
      title: this.options.blankTitle || 'about:blank'
    });
    /**
     * new-tab event.
     *
     * @event BrowserLikeWindow#new-tab
     * @return {BrowserView} view - current browser view
     * @return {string} [source.openedURL] - opened with url
     * @return {BrowserView} source.lastView - previous active view
     */
    // var uril = "px://newtab";
    // this.emit('url-updated', { view: view, uril });
    // this.emit('new-tab', view, { openedURL: uril, lastView });
    return view;
  }

  /**
   * Swith to tab
   * @param {TabID} viewId
   */
  switchTab(viewId) {
    log.debug('switch to tab', viewId);
    this.setCurrentView(viewId);
    this.currentView.webContents.focus();
  }

  /**
   * Destroy tab
   * @param {TabID} viewId
   * @ignore
   */
  destroyView(viewId) {
    const view = this.views[viewId];
    if (view) {
      view.webContents.destroy();
      this.views[viewId] = undefined;
      log.debug(`${viewId} destroyed`);
    }
  }

  /**
   * Print View test
   */
   printView(viewId,data) {
    const view = this.views[viewId];
    if (view) {
      view.webContents.print(data
      ,function(callback){
        console.log(callback);
      });
      log.debug(`${viewId} Printing`);
    }
   }

   toggleDevTools(){
    const view = this.views[this.currentView.id];
    view.webContents.toggleDevTools({mode:"bottom"});
   }

   getWebContents(){
    try{
      if (this.currentView.id) {
        const view = this.views[this.currentView.id];
        return view.webContents;
      }else{
        return webContents;
      }
    }catch(e){
      log.debug("Error happend")
    }
   }


}

module.exports = BrowserLikeWindow;