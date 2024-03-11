/**********************************************************************
 * Copyright (C) 2023 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { ElectronApplication, JSHandle, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';

type WindowState = {
  isVisible: boolean;
  isDevToolsOpened: boolean;
  isCrashed: boolean;
};

export class PodmanDesktopRunner {
  private _options: object;
  private _running: boolean;
  private _app: ElectronApplication | undefined;
  private _page: Page | undefined;
  private readonly _profile: string;
  private readonly _customFolder;
  private readonly _testOutput: string;
  private _videoAndTraceName: string | undefined;

  constructor(profile = '', customFolder = 'podman-desktop') {
    this._running = false;
    this._profile = profile;
    this._testOutput = path.join('tests', 'output', this._profile);
    this._customFolder = path.join(this._testOutput, customFolder);
    this._options = this.defaultOptions();
    this._videoAndTraceName = undefined;
  }

  public async start(): Promise<Page> {
    if (this.isRunning()) {
      throw Error('Podman Desktop is already running');
    }

    try {
      // start the app with given properties
      this._running = true;
      console.log(`### STARTING PODMAN DESKTOP APP ###`);
      console.log(`Options: `);
      Object.keys(this._options).forEach( key => {
        console.log(`${key}: ${(this._options as {[k: string]: string})[key]}`);
      });
      this._app = await electron.launch({
        ...this._options,
      });
      // setup state
      this._page = await this.getElectronApp().firstWindow();
      const exe = this.getElectronApp().evaluate(async ({app}) => {
        return app.getPath('exe');
      });
      console.log(`The Executable Electron app. file: ${exe}`);

      // Evaluate that the main window is visible
      // at the same time, the function also makes sure that event 'ready-to-show' was triggered
      // const windowState = await this.getBrowserWindowState();
      // console.log(`Application Browser's window is visible: ${windowState.isVisible}`);
    } catch (err) {
      console.log(`Caught exception in startup: ${err}`);
      throw Error(`Podman Desktop could not be started correctly with error: ${err}`);
    }

    // Direct Electron console to Node terminal.
    this.getPage().on('console', console.log);

    // Start playwright tracing
    await this.startTracing();

    // also get stderr from the node process
    this._app.process().stderr?.on('data', data => {
      console.log(`STDERR: ${data}`);
    });

    return this._page;
  }

  public getPage(): Page {
    if (this._page) {
      return this._page;
    } else {
      throw Error('Application was not started yet');
    }
  }

  public getElectronApp(): ElectronApplication {
    if (this._app) {
      return this._app;
    } else {
      throw Error('Application was not started yet');
    }
  }

  public async getBrowserWindow(): Promise<JSHandle<BrowserWindow>> {
    return await this.getElectronApp().browserWindow(this.getPage());
  }

  public async screenshot(filename: string) {
    await this.getPage().screenshot({ path: path.join(this._testOutput, 'screenshots', filename) });
  }

  public async startTracing() {
    await this.getPage().context().tracing.start({ screenshots: true, snapshots: true });
  }

  public async stopTracing() {
    let name = '';
    if (this._videoAndTraceName) name = this._videoAndTraceName;

    name = name + '_trace.zip';
    await this.getPage()
      .context()
      .tracing.stop({ path: path.join(this._testOutput, 'traces', name) });
  }

  public async getBrowserWindowState(): Promise<WindowState> {
    return await (
      await this.getBrowserWindow()
    ).evaluate((mainWindow): Promise<WindowState> => {
      const getState = () => {
        return {
          isVisible: mainWindow.isVisible(),
          isDevToolsOpened: mainWindow.webContents.isDevToolsOpened(),
          isCrashed: mainWindow.webContents.isCrashed(),
        };
      };

      return new Promise(resolve => {
        /**
         * The main window is created hidden, and is shown only when it is ready.
         * See {@link ../packages/main/src/mainWindow.ts} function
         */
        if (mainWindow.isVisible()) {
          resolve(getState());
        } else
          mainWindow.once('ready-to-show', () => {
            resolve(getState());
          });
      });
    });
  }

  async saveVideoAs(path: string) {
    const video = this.getPage().video();
    if (video) {
      await video.saveAs(path);
    } else {
      console.log(`Video file associated was not found`);
    }
  }

  public async close() {
    // Stop playwright tracing
    await this.stopTracing();

    if (!this.isRunning()) {
      throw Error('Podman Desktop is not running');
    }

    if (this.getElectronApp()) {
      const elapsed = await this.trackTime(async () => await this.getElectronApp().close());
      console.log(`Elapsed time of closing the electron app: ${elapsed} ms`);
    }

    if (this._videoAndTraceName) {
      const videoPath = path.join(this._testOutput, 'videos', `${this._videoAndTraceName}.webm`);
      const elapsed = await this.trackTime(async () => await this.saveVideoAs(videoPath));
      console.log(`Saving a video file took: ${elapsed} ms`);
      console.log(`Video file saved as: ${videoPath}`);
    }
    this._running = false;
  }

  protected async trackTime(fn: () => Promise<void>): Promise<number> {
    const start = performance.now();
    return await fn
      .call(() => {
        /* no actual logic */
      })
      .then(() => {
        return performance.now() - start;
      });
  }

  private defaultOptions() {
    const directory = path.join(this._testOutput, 'videos');
    const tracesDir = path.join(this._testOutput, 'traces', 'raw');
    console.log(`video will be written to: ${directory}`);
    const env = this.setupPodmanDesktopCustomFolder();
    const recordVideo = {
      dir: directory,
      size: {
        width: 1050,
        height: 700,
      },
    };
    let executablePath = undefined;
    let args = undefined;
    if (process.env.PODMAN_DESKTOP_BINARY) {
      executablePath = process.env.PODMAN_DESKTOP_BINARY;
    } 
    if (process.env.PODMAN_DESKTOP_ARGS) {
      args = [process.env.PODMAN_DESKTOP_ARGS];
    } else {
      args = ['.'];
    }
    const timeout = 45000;
    return {
      args,
      executablePath,
      env,
      recordVideo,
      timeout,
      tracesDir,
    };
  }

  private setupPodmanDesktopCustomFolder(): object {
    const env: { [key: string]: string } = Object.assign({}, process.env as { [key: string]: string });
    const dir = path.join(this._customFolder);
    console.log(`podman desktop custom config will be written to: ${dir}`);
    env.PODMAN_DESKTOP_HOME_DIR = dir;

    // add a custom config file by disabling OpenDevTools
    const settingsFile = path.resolve(dir, 'configuration', 'settings.json');

    // create parent folder if missing
    const parentDir = path.dirname(settingsFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const settingsContent = JSON.stringify({
      'preferences.OpenDevTools': 'none',
    });

    // write the file
    console.log(`disabling OpenDevTools in configuration file ${settingsFile}`);
    fs.writeFileSync(settingsFile, settingsContent);

    return env;
  }

  public isRunning(): boolean {
    return this._running;
  }

  public setOptions(value: object) {
    this._options = value;
  }

  public setVideoAndTraceName(name: string) {
    this._videoAndTraceName = name;
  }

  public getTestOutput(): string {
    return this._testOutput;
  }

  public get options(): object {
    return this._options;
  }
}
