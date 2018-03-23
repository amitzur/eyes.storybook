'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const jsdom = require('jsdom/lib/old-api');
const { spawn, execSync } = require('child_process');
const { RectangleSize, GeneralUtils } = require('@applitools/eyes.sdk.core');

const StorybookStory = require('./StorybookStory');

const IS_WINDOWS = process.platform.startsWith('win');
const REQUEST_TIMEOUT = 10000; // ms
const WAIT_BETWEEN_REQUESTS = 1000; // ms
const REQUEST_RETRY = 3;

/**
 * @param {Buffer} data
 * @return {string}
 */
const bufferToString = data => data.toString('utf8').trim();

/**
 * @param {PromiseFactory} promiseFactory
 * @param {Object} configs
 * @param {string} storybookCode
 * @returns {Promise.<array<object>>}
 */
const getStorybookInstance = (promiseFactory, configs, storybookCode) =>
  promiseFactory.makePromise((resolve, reject) => {
    // JSDom is node-parser for javascript and therefore it doesn't support some browser's API.
    // The Applitools Storybook API itself don't require them, but they needed to run clients' applications correctly.
    const mocksCode = [
      fs.readFileSync(`${__dirname}/mocks/event-source.js`, 'utf8'),
      fs.readFileSync(`${__dirname}/mocks/local-storage.js`, 'utf8'),
      fs.readFileSync(`${__dirname}/mocks/match-media.js`, 'utf8'),
    ];

    const jsdomConfig = {
      html: '',
      src: mocksCode.concat(storybookCode),
      done: (err, window) => {
        if (err) return reject(err.response.body);
        if (!window || !window.__storybook_stories__) {
          const message = 'Storybook object not found on window. ' +
            'Check window.__storybook_stories__ is set in your Storybook\'s config.js.';
          return reject(new Error(message));
        }

        return resolve(window.__storybook_stories__);
      },
    };

    if (configs.showStorybookOutput) {
      jsdomConfig.virtualConsole = jsdom.createVirtualConsole().sendTo(console);
    }

    jsdom.env(jsdomConfig);
  });

/**
 * @param {Logger} logger
 * @param {PromiseFactory} promiseFactory
 * @param {Object} configs
 * @param {string} previewCode
 * @returns {Promise<StorybookStory[]>}
 */
const prepareStories = (logger, promiseFactory, configs, previewCode) =>
  getStorybookInstance(promiseFactory, configs, previewCode).then(storybook => {
    logger.log('Storybook instance was created.');

    const stories = [];
    Array.from(storybook).forEach(group => {
      Array.from(group.stories).forEach(story => {
        stories.push(new StorybookStory(group.kind, story.name));
      });
    });

    logger.log('Storied were extracted.');

    if (!configs.viewportSize) {
      return stories;
    }

    const newStories = [];
    configs.viewportSize.forEach(viewportSize => {
      stories.forEach(story => {
        newStories.push(new StorybookStory(
          story.getComponentName(),
          story.getState(),
          new RectangleSize(viewportSize)
        ));
      });
    });

    logger.log('Storied were mixed with viewportSize(s).');
    return newStories;
  });

/**
 * @param {PromiseFactory} promiseFactory
 * @param {ChildProcess} storybookProcess
 * @return {Promise<string>}
 */
const waitForStorybookStarted = (promiseFactory, storybookProcess) =>
  promiseFactory.makePromise((resolve, reject) => {
    const stderrListener = str => {
      if (str.includes('Error: listen EADDRINUSE :::')) {
        reject('Storybook port already in use.');
      }
    };

    const stdoutListener = str => {
      if (str.includes('webpack built')) {
        resolve();
      }
    };

    storybookProcess.stdout.on('data', data => stdoutListener(bufferToString(data)));
    storybookProcess.stderr.on('data', data => stderrListener(bufferToString(data)));

    // Set up the timeout
    setTimeout(() => reject('Storybook din\'t start after 5 min waiting.'), 5 * 60 * 1000); // 5 min
  });

class StorybookUtils {
  /**
   * @param {Logger} logger
   * @param {PromiseFactory} promiseFactory
   * @param {Object} configs
   * @return {Promise<String>}
   */
  static startServer(logger, promiseFactory, configs) {
    if (configs.storybookAddress) {
      logger.log('storybookAddress set, starting Storybook skipped.');
      return promiseFactory.resolve(configs.storybookAddress);
    }

    logger.log('Starting Storybook...');

    const storybookPath = path.resolve(process.cwd(), `node_modules/.bin/start-storybook${IS_WINDOWS ? '.cmd' : ''}`);
    const args = ['-p', configs.storybookPort, '-h', configs.storybookHost, '-c', configs.storybookConfigDir];

    if (configs.storybookStaticDir) {
      args.push('-s');
      args.push(configs.storybookStaticDir);
    }

    const storybookConfigPath = path.resolve(process.cwd(), configs.storybookConfigDir, 'config.js');
    if (!fs.existsSync(storybookConfigPath)) {
      return promiseFactory.reject(new Error(`Storybook config file not found: ${storybookConfigPath}`));
    }

    let isConfigOverridden = false;
    const storybookConfigBody = fs.readFileSync(storybookConfigPath, 'utf8');
    if (!storybookConfigBody.includes('__storybook_stories__')) {
      isConfigOverridden = true;
      let template = fs.readFileSync(`${__dirname}/configTemplates/storybook.v${configs.storybookVersion}.js`, 'utf8');
      // eslint-disable-next-line no-template-curly-in-string
      template = template.replace('${configBody}', storybookConfigBody).replace('${app}', configs.storybookApp);
      fs.writeFileSync(storybookConfigPath, template, { encoding: 'utf8' });
    }

    logger.log(`${storybookPath.toString()} ${args.join(' ')}`);
    const storybookProcess = spawn(storybookPath, args, { detached: !IS_WINDOWS });

    storybookProcess.stderr.on('data', data => console.error(bufferToString(data))); // eslint-disable-line no-console
    if (configs.showStorybookOutput) {
      storybookProcess.stdout.on('data', data => console.log(bufferToString(data))); // eslint-disable-line no-console
    }

    // exit on terminate
    process.on('exit', () => {
      if (isConfigOverridden) {
        fs.writeFileSync(storybookConfigPath, storybookConfigBody, { encoding: 'utf8' });
      }

      try {
        if (IS_WINDOWS) {
          spawn('taskkill', ['/pid', storybookProcess.pid, '/f', '/t']);
        } else {
          process.kill(-storybookProcess.pid);
        }
      } catch (e) {
        console.error('Can\'t kill child (Storybook) process.', e); // eslint-disable-line no-console
      }
    });

    process.on('SIGINT', () => process.exit());
    process.on('SIGTERM', () => process.exit());
    process.on('uncaughtException', () => process.exit(1));

    return waitForStorybookStarted(promiseFactory, storybookProcess)
      .then(() => {
        logger.log('Storybook was started.');
        return `http://${configs.storybookHost}:${configs.storybookPort}/`;
      });
  }

  /**
   * @param {Logger} logger
   * @param {PromiseFactory} promiseFactory
   * @param {Object} configs
   * @return {Promise<void>}
   */
  static buildStorybook(logger, promiseFactory, configs) {
    if (configs.skipStorybookBuild) {
      return promiseFactory.resolve();
    }

    logger.log('Building Storybook...');
    const storybookPath = path.resolve(process.cwd(), `node_modules/.bin/build-storybook${IS_WINDOWS ? '.cmd' : ''}`);
    const args = ['-c', configs.storybookConfigDir, '-o', configs.storybookOutputDir];

    if (configs.storybookStaticDir) {
      args.push('-s');
      args.push(configs.storybookStaticDir);
    }

    const storybookConfigPath = path.resolve(process.cwd(), configs.storybookConfigDir, 'config.js');
    if (!fs.existsSync(storybookConfigPath)) {
      return promiseFactory.reject(new Error(`Storybook config file not found: ${storybookConfigPath}`));
    }

    let isConfigOverridden = false;
    const storybookConfigBody = fs.readFileSync(storybookConfigPath, 'utf8');
    if (!storybookConfigBody.includes('__storybook_stories__')) {
      isConfigOverridden = true;
      let template = fs.readFileSync(`${__dirname}/configTemplates/storybook.v${configs.storybookVersion}.js`, 'utf8');
      // eslint-disable-next-line no-template-curly-in-string
      template = template.replace('${configBody}', storybookConfigBody).replace('${app}', configs.storybookApp);
      fs.writeFileSync(storybookConfigPath, template, { encoding: 'utf8' });
    }

    logger.log(`${storybookPath.toString()} ${args.join(' ')}`);
    execSync(storybookPath, args);

    if (isConfigOverridden) {
      fs.writeFileSync(storybookConfigPath, storybookConfigBody, { encoding: 'utf8' });
    }

    logger.log('Storybook was built.');
    return promiseFactory.resolve();
  }

  /**
   * @param {Logger} logger
   * @param {PromiseFactory} promiseFactory
   * @param {Object} configs
   * @param {int} [retry]
   * @returns {Promise.<StorybookStory[]>}
   */
  static getStoriesFromWeb(logger, promiseFactory, configs, retry = REQUEST_RETRY) {
    logger.log('Getting stories from storybook server...', retry !== REQUEST_RETRY ? (` ${retry} retries left.`) : '');

    return axios.get(`${configs.storybookAddress}static/preview.bundle.js`, { timeout: REQUEST_TIMEOUT })
      .then(previewResponse => { // eslint-disable-line arrow-body-style
        return axios.get(`${configs.storybookAddress}static/vendor.bundle.js`, { timeout: REQUEST_TIMEOUT })
          .then(vendorResponse => `${vendorResponse.data};\n${previewResponse.data}`)
          .catch(err => {
            if (err && err.response.status !== 404) {
              logger.verbose('Getting vendor.bundle.js file failed.');
            }

            return previewResponse.data;
          })
          .then(storybookCode => {
            logger.log('Storybook code was received from server.');
            return prepareStories(logger, promiseFactory, configs, storybookCode)
              .then(stories => {
                logger.log('Stories were prepared.');
                return stories;
              });
          });
      }, err => {
        logger.log('Error on getting stories: ', err);
        if (retry <= 1) throw err;

        return GeneralUtils.sleep(WAIT_BETWEEN_REQUESTS, promiseFactory)
          .then(() => StorybookUtils.getStoriesFromWeb(logger, promiseFactory, configs, retry - 1));
      });
  }

  /**
   * @param {Logger} logger
   * @param {PromiseFactory} promiseFactory
   * @param {Object} configs
   * @returns {Promise.<StorybookStory[]>}
   */
  static getStoriesFromStatic(logger, promiseFactory, configs) {
    return promiseFactory.makePromise((resolve, reject) => {
      logger.log('Getting stories from storybook build...');
      const staticDirPath = path.resolve(process.cwd(), configs.storybookOutputDir, 'static');
      fs.readdir(staticDirPath, (err, files) => {
        if (err) {
          if (String.prototype.includes.call(err.message, 'ENOENT: no such file or directory, scandir')) {
            return reject('Storybook Build folder not found. ' +
              'Build Storybook before running the command or add `--build` option');
          }
          return reject(err);
        }

        const previewFile = files.find(filename => filename.startsWith('preview.') && filename.endsWith('.bundle.js'));
        const vendorFile = files.find(filename => filename.startsWith('vendor.') && filename.endsWith('.bundle.js'));
        return fs.readFile(path.resolve(staticDirPath, previewFile), 'utf8', (previewErr, previewCode) => {
          if (previewErr) return reject(previewErr);
          if (!vendorFile) {
            return resolve(previewCode);
          }

          return fs.readFile(path.resolve(staticDirPath, vendorFile), 'utf8', (vendorErr, vendorCode) => {
            if (vendorErr) {
              logger.verbose('Getting vendor.bundle.js file failed.');
              return reject(vendorErr);
            }
            return resolve(`${vendorCode};\n${previewCode}`);
          });
        });
      });
    })
      .then(storybookCode => {
        logger.log('Storybook code was loaded from build.');
        return prepareStories(logger, promiseFactory, configs, storybookCode);
      })
      .then(stories => {
        logger.log('Stories were prepared.');
        return stories;
      });
  }

  /**
   * @param {PromiseFactory} promiseFactory
   * @param {Buffer} htmlContent
   * @returns {Promise.<any>}
   */
  static getDocumentFromHtml(promiseFactory, htmlContent) {
    return promiseFactory.makePromise((resolve, reject) => {
      const jsdomConfig = {
        html: htmlContent,
        done: (err, window) => {
          if (err) return reject(err);
          return resolve(window.document);
        },
      };
      jsdom.env(jsdomConfig);
    });
  }

  /**
   * @param {object} json
   * @param {array<string>} supportedStorybookApps
   * @returns {{app: string, version: number}}
   */
  static retrieveStorybookVersion(json, supportedStorybookApps) {
    // noinspection JSUnresolvedVariable
    const dependencies = json.dependencies || {};
    // noinspection JSUnresolvedVariable
    const devDependencies = json.devDependencies || {};

    if (dependencies['@kadira/storybook'] || devDependencies['@kadira/storybook']) {
      return { app: 'react', version: 2 };
    }

    const version = 3;
    for (let i = 0, l = supportedStorybookApps.length; i < l; i += 1) {
      const app = supportedStorybookApps[i];

      if (dependencies[`@storybook/${app}`] || devDependencies[`@storybook/${app}`]) {
        return { app, version };
      }
    }

    throw new Error('Storybook module not found in package.json!');
  }
}

module.exports = StorybookUtils;