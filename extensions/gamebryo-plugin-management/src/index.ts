import {updateLoadOrder} from './actions/loadOrder';
import {setPluginList} from './actions/plugins';
import {loadOrderReducer} from './reducers/loadOrder';
import {pluginsReducer} from './reducers/plugins';
import {settingsReducer} from './reducers/settings';
import {IPlugins} from './types/IPlugins';
import PluginList from './views/PluginList';

import LootInterface from './autosort';

import {
  gameSupported,
  isNativePlugin,
  nativePlugins,
  pluginPath,
  supportedGames,
} from './util/gameSupport';
import PluginPersistor from './util/PluginPersistor';

import * as Promise from 'bluebird';
import { remote } from 'electron';
import * as fs from 'fs-extra-promise';
import { log, selectors, types, util } from 'nmm-api';
import * as path from 'path';

interface IModState {
  enabled: boolean;
}

type IModStates = { [modId: string]: IModState };

function isPlugin(fileName: string): boolean {
  return ['.esp', '.esm'].indexOf(path.extname(fileName).toLowerCase()) !== -1;
}

function updatePluginList(store: Redux.Store<any>, oldModList: IModStates,
                          newModList: IModStates): Promise<void> {
  if (newModList === undefined) {
    return;
  }

  const state = store.getState();

  const gameMode = selectors.activeGameId(state);
  let pluginSources: { [pluginName: string]: string } = {};

  const currentDiscovery = selectors.currentGameDiscovery(state);
  let readErrors = [];

  const gameMods = state.persistent.mods[gameMode];

  return Promise.map(Object.keys(gameMods), (modId: string) => {
    let mod = gameMods[modId];
    return fs.readdirAsync(path.join(selectors.installPath(state), mod.installationPath))
    .then((fileNames: string[]) => {
      fileNames
      .filter((fileName: string) => ['.esp', '.esm'].indexOf(path.extname(fileName)) !== -1)
      .forEach((fileName: string) => {
        pluginSources[fileName] = mod.name || mod.id;
      });
    })
    .catch((err: Error) => {
      readErrors.push(mod.id);
      log('warn', 'failed to read mod directory',
        { path: mod.installationPath, error: err.message });
    });
  })
  .then(() => {
    if (readErrors.length > 0) {
      util.showError(
        store.dispatch,
        'Failed to read some mods',
        'The following mods could not be searched (see log for details):\n' +
          readErrors.join('\n')
        );
    }
    if (currentDiscovery === undefined) {
      return Promise.resolve([]);
    }
    let modPath = currentDiscovery.modPath;
    return fs.readdirAsync(modPath);
  })
  .then((fileNames: string[]) => {
    let pluginNames: string[] = fileNames.filter(isPlugin);
    let pluginStates: IPlugins = {};
    pluginNames.forEach((fileName: string) => {
      let modName = pluginSources[fileName];
      pluginStates[fileName] = {
        modName: modName || '',
        filePath: path.join(currentDiscovery.modPath, fileName),
        isNative: modName === undefined && isNativePlugin(gameMode, fileName),
      };
    });
    store.dispatch(setPluginList(pluginStates));
    store.dispatch(updateLoadOrder(pluginNames));
    return Promise.resolve();
  })
  .catch((err: Error) => {
    util.showError(store.dispatch, 'Failed to update plugin list', err);
  })
  ;
}

interface IExtensionContextExt extends types.IExtensionContext {
  registerProfileFile: (gameId: string, filePath: string) => void;
}

let persistor: PluginPersistor;
let loot: LootInterface;
let refreshTimer: NodeJS.Timer;

function register(context: IExtensionContextExt) {
  context.registerMainPage('puzzle-piece', 'Plugins', PluginList, {
    hotkey: 'E',
    visible: () => gameSupported(selectors.activeGameId(context.api.store.getState())),
    props: () => ({
      nativePlugins: nativePlugins(selectors.activeGameId(context.api.store.getState())),
    }),
  });

  if (context.registerProfileFile) {
    for (let game of supportedGames()) {
      context.registerProfileFile(game, path.join(pluginPath(game), 'plugins.txt'));
      context.registerProfileFile(game, path.join(pluginPath(game), 'loadorder.txt'));
    }
  }

  context.registerStyle(path.join(__dirname, 'plugin_management.scss'));

  context.registerReducer(['session', 'plugins'], pluginsReducer);
  context.registerReducer(['loadOrder'], loadOrderReducer);
  context.registerReducer(['settings', 'plugins'], settingsReducer);
}

function initPersistor(context: IExtensionContextExt) {
  // TODO: Currently need to stop this from being called in the main process.
  //   This is mega-ugly and needs to go
  if ((persistor === undefined) && (remote !== undefined)) {
    persistor = new PluginPersistor();
  }
  if (persistor !== undefined) {
    context.registerPersistor('loadOrder', persistor);
  }
}

function updateCurrentProfile(store: Redux.Store<any>, gameId: string): Promise<void> {
  if (!gameSupported(gameId)) {
    return;
  }

  return updatePluginList(store, {}, selectors.activeProfile(store.getState()).modState);
}

function init(context: IExtensionContextExt) {
  register(context);
  initPersistor(context);

  context.once(() => {
    const store = context.api.store;

    loot = new LootInterface(context);

    const profiles = store.getState().persistent.profiles;
    Promise.map(Object.keys(profiles), (profileId: string) => {
      const gameMode = profiles[profileId].gameId;
      return updateCurrentProfile(store, gameMode);
    })
    .then(() => {
      log('info', 'active plugin lists refreshed');
    });

    let watcher: fs.FSWatcher;

    context.api.events.on('gamemode-activated', (newGameMode: string) => {
      if (watcher !== undefined) {
        watcher.close();
        watcher = undefined;
      }

      if (!gameSupported(newGameMode)) {
        return;
      }

      if (persistor !== undefined) {
        persistor.loadFiles(newGameMode);
        let modPath = selectors.currentGameDiscovery(store.getState()).modPath;
        watcher = fs.watch(modPath, {}, (evt: string, fileName: string) => {
          if (refreshTimer !== undefined) {
            clearTimeout(refreshTimer);
          }
          refreshTimer = setTimeout(() => {
            updateCurrentProfile(store, newGameMode)
                .then(() => { context.api.events.emit('autosort-plugins'); });
            refreshTimer = undefined;
          }, 500);
        });
      }
    });

    Object.keys(store.getState().persistent.profiles)
        .forEach((gameId: string) => {
          context.api.onStateChange(
              ['persistent', 'profiles', gameId], (oldProfiles, newProfiles) => {
                const activeProfileId = selectors.activeProfile(store.getState).id;
                const oldProfile = oldProfiles[activeProfileId];
                const newProfile = newProfiles[activeProfileId];

                if (oldProfile !== newProfile) {
                  updatePluginList(store, oldProfile.modState,
                                   newProfile.modState)
                      .then(() => {
                        context.api.events.emit('autosort-plugins');
                      });
                }
              });
          context.api.onStateChange(
              ['settings', 'profiles', 'activeProfileId'],
              (oldProfileId: string, newProfileId: string) => {
                const oldProfile = util.getSafe(
                    store.getState(),
                    ['persistent', 'profiles', oldProfileId], {} as any);

                const newProfile = util.getSafe(
                    store.getState(),
                    ['persistent', 'profiles', newProfileId], {} as any);

                updatePluginList(store, oldProfile.modState,
                                 newProfile.modState)
                    .then(
                        () => { context.api.events.emit('autosort-plugins'); });
              });
        });
  });

  return true;
}

export default init;
