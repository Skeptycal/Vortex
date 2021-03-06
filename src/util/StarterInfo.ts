import { IDiscoveredTool } from '../types/IDiscoveredTool';
import { getSafe } from '../util/storeHelper';
import Steam from '../util/Steam';
import { IGame } from '../types/IGame';
import { log } from '../util/log';

import { IDiscoveryResult } from '../extensions/gamemode_management/types/IDiscoveryResult';
import { IGameStored } from '../extensions/gamemode_management/types/IGameStored';
import { IToolStored } from '../extensions/gamemode_management/types/IToolStored';
import { getGame } from '../extensions/gamemode_management/util/getGame';

import { IExtensionApi } from '../types/IExtensionContext';

import { MissingInterpreter, UserCanceled, ProcessCanceled, MissingDependency } from './CustomErrors';

import { remote } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as Promise from 'bluebird';

export interface IStarterInfo {
  id: string;
  gameId: string;
  isGame: boolean;
  iconPath: string;
  iconOutPath: string;
  name: string;
  exePath: string;
  commandLine: string[];
  workingDirectory: string;
  environment: { [key: string]: string };
}

const userDataPath = ((): () => string => {
  let cache: string;
  return () => {
    if (cache === undefined) {
      cache = remote.app.getPath('userData');
    }
    return cache;
  };
})();

type OnShowErrorFunc =
  (message: string, details?: string | Error | any, allowReport?: boolean) => void;

/**
 * holds info about an executable to start
 *
 * @class StarterInfo
 */
class StarterInfo implements IStarterInfo {
  public static getGameIcon(game: IGameStored, gameDiscovery: IDiscoveryResult): string {
    const extensionPath = gameDiscovery.extensionPath || game.extensionPath;
    const logoName = gameDiscovery.logo || game.logo;
    return StarterInfo.gameIcon(game.id, extensionPath, logoName);
  }

  private static executeWithSteam(info: StarterInfo, api: IExtensionApi, args?: string[]): Promise<void> {
    // Should never happen but it's worth adding 
    //  the game check just in case.
    if (!info.isGame) {
      return Promise.reject(`Attempted to execute a tool via Steam - ${info.exePath}`);
    }

    return new Promise((resolve, reject) => {
      Steam.getSteamExecutionPath(path.dirname(info.exePath), args).then(execInfo => 
        api.runExecutable(execInfo.steamPath, execInfo.arguments, {
          cwd: path.dirname(execInfo.steamPath),
          env: info.environment,
          suggestDeploy: true,
          shell: true,
      }))
      .then(() => resolve())
      .catch(err => reject(err));
    })
  }

  private static runGameExecutable(info: StarterInfo, api: IExtensionApi, onShowError: OnShowErrorFunc): Promise<void> {
    return api.runExecutable(info.exePath, info.commandLine, {
      cwd: info.workingDirectory,
      env: info.environment,
      suggestDeploy: true,
      shell: info.shell,
    })
    .catch(ProcessCanceled, () => undefined)
    .catch(UserCanceled, () => undefined)
    .catch(MissingDependency, () => {
      onShowError('Failed to run tool', {
        executable: info.exePath,
        message: 'An Application/Tool dependency is missing, please consult the Application/Tool documentation for required dependencies.',
      }, false);
    })
    .catch(err => {
      if (err.errno === 'ENOENT') {
        onShowError('Failed to run tool', {
          Executable: info.exePath,
          message: 'Executable doesn\'t exist, please check the configuration for info tool.',
          stack: err.stack,
        }, false);
      } else if (err.errno === 'UNKNOWN') {
        // info sucks but node.js doesn't give us too much information about what went wrong
        // and we can't have users misconfigure their tools and then report the error they
        // get as feedback
        onShowError('Failed to run tool', {
          Executable: info.exePath,
          message: 'File is not executable, please check the configuration for info tool.',
          stack: err.stack,
        }, false);
      } else if (err instanceof MissingInterpreter) {
        const par = {
          Error: err.message,
        };
        if (err.url !== undefined) {
          par['Download url'] = err.url;
        }
        onShowError('Failed to run tool', par, false);
      } else {
        onShowError('Failed to run tool', {
          executable: info.exePath,
          error: err.stack,
        });
      }
    })
  }

  public static run(info: StarterInfo, api: IExtensionApi, onShowError: OnShowErrorFunc) {
    const game: IGame = getGame(info.gameId);
    const steamPromise = game.requiresSteamStart !== undefined 
      ? game.requiresSteamStart(path.dirname(info.exePath)).catch(err => {
        log('warn', err);
        return Promise.resolve(false);
      })
      : Promise.resolve(false);

    return steamPromise.then(res => res 
      ? StarterInfo.executeWithSteam(info, api).catch(err => {
        log('warn', err);
        return StarterInfo.runGameExecutable(info, api, onShowError)
      })
      : StarterInfo.runGameExecutable(info, api, onShowError));
  }

  private static gameIcon(gameId: string, extensionPath: string, logo: string) {
    try {
      const iconPath = this.gameIconRW(gameId);
      fs.statSync(iconPath);
      return iconPath;
    } catch (err) {
      if (logo !== undefined) {
        return path.join(extensionPath, logo);
      } else {
        return undefined;
      }
    }
  }

  private static gameIconRW(gameId: string) {
    return path.join(userDataPath(), gameId, 'icon.png');
  }

  private static toolIcon(gameId: string, extensionPath: string,
                          toolId: string, toolLogo: string): string {
    try {
      const iconPath = this.toolIconRW(gameId, toolId);
      fs.statSync(iconPath);
      return iconPath;
    } catch (err) {
      try {
        const iconPath = path.join(extensionPath, toolLogo);
        fs.statSync(iconPath);
        return iconPath
      } catch (err) {
        return undefined;
      }
    }
  }
  private static toolIconRW(gameId: string, toolId: string) {
    return path.join(userDataPath(), gameId, 'icons', toolId + '.png');
  }

  public id: string;
  public gameId: string;
  public isGame: boolean;
  public iconOutPath: string;
  public name: string;
  public exePath: string;
  public commandLine: string[];
  public workingDirectory: string;
  public environment: { [key: string]: string };
  public shell: boolean;
  private mExtensionPath: string;
  private mLogoName: string;
  private mIconPathCache: string;

  constructor(game: IGameStored, gameDiscovery: IDiscoveryResult,
              tool?: IToolStored, toolDiscovery?: IDiscoveredTool) {
    this.gameId = gameDiscovery.id || game.id;
    this.mExtensionPath = gameDiscovery.extensionPath || game.extensionPath;

    if ((tool === undefined) && (toolDiscovery === undefined)) {
      this.id = this.gameId;
      this.isGame = true;
      this.initFromGame(game, gameDiscovery);
    } else {
      this.id = getSafe(toolDiscovery, ['id'], getSafe(tool, ['id'], undefined));
      this.isGame = false;
      this.initFromTool(this.gameId, tool, toolDiscovery);
    }
    if ((this.id === undefined) || (this.name === undefined)) {
      throw new Error('invalid starter information');
    }
  }

  public get iconPath(): string {
    if (this.mIconPathCache === undefined) {
      if (this.isGame) {
        this.mIconPathCache = StarterInfo.gameIcon(
            this.gameId, this.mExtensionPath, this.mLogoName);
      } else {
        this.mIconPathCache = StarterInfo.toolIcon(
            this.gameId, this.mExtensionPath, this.id, this.mLogoName);
      }
    }

    return this.mIconPathCache;
  }

  private initFromGame(game: IGameStored, gameDiscovery: IDiscoveryResult) {
    this.name = gameDiscovery.name || game.name;
    this.exePath = path.join(gameDiscovery.path, gameDiscovery.executable || game.executable);
    this.commandLine = [];
    this.workingDirectory = path.dirname(this.exePath);
    this.environment = gameDiscovery.environment || {};
    this.iconOutPath = StarterInfo.gameIconRW(this.gameId);
    this.shell = gameDiscovery.shell || game.shell;
    this.mLogoName = gameDiscovery.logo || game.logo;
  }

  private initFromTool(gameId: string, tool: IToolStored, toolDiscovery: IDiscoveredTool) {
    if (toolDiscovery !== undefined) {
      this.name = getSafe(toolDiscovery, ['name'], getSafe(tool, ['name'], undefined));
      this.exePath = toolDiscovery.path;
      this.commandLine = getSafe(toolDiscovery, ['parameters'], getSafe(tool, ['parameters'], []));
      this.environment =
        getSafe(toolDiscovery, ['environment'], getSafe(tool, ['environment'], {})) || {};
      this.mLogoName = getSafe(toolDiscovery, ['logo'], getSafe(tool, ['logo'], undefined));
      this.workingDirectory = toolDiscovery.workingDirectory !== undefined
        ? toolDiscovery.workingDirectory
        : path.dirname(toolDiscovery.path || '');
      this.shell = getSafe(toolDiscovery, ['shell'], getSafe(tool, ['shell'], undefined));
    } else {
      // defaults for undiscovered & unconfigured tools
      this.name = tool.name;
      this.exePath = '';
      this.commandLine = tool.parameters;
      this.workingDirectory = '';
      this.environment = tool.environment || {};
      this.mLogoName = tool.logo;
      this.shell = tool.shell;
    }
    this.iconOutPath = StarterInfo.toolIconRW(gameId, this.id);
  }

}

export default StarterInfo;
