'use strict';

require('chromedriver');
const {Builder} = require('selenium-webdriver');
const {BatchInfo} = require('eyes.sdk');

const EyesStorybook = require('./EyesStorybook');
const EyesSeleniumUtils = require('./EyesSeleniumUtils');

class EyesStorybookRunner {

    constructor(logger, promiseFactory, configs) {
        /** @type {Logger} */
        this._logger = logger;
        /** @type {PromiseFactory} */
        this._promiseFactory = promiseFactory;
        /** @type {Object} */
        this._configs = configs;

        this._testBatch = new BatchInfo(configs.appName);
        this._inferred = null;
        this._scaleProviderFactory = null;
    }

    /**
     * @param {StorybookStory[]} stories
     * @returns {Promise.<TestResults[]>}
     */
    testStories(stories) {
        this._logger.log('Splitting stories for parallel threads...');

        const threadsCount = stories.length > this._configs.maxRunningBrowsers ? this._configs.maxRunningBrowsers : stories.length;
        const storiesParts = [];

        let storiesMod = stories.length % threadsCount;
        const storiesPerThread = (stories.length - storiesMod) / threadsCount;
        let startStory, endStory = 0;
        for (let i = 0; i < threadsCount; ++i) {
            startStory = endStory;
            endStory = startStory + storiesPerThread + (storiesMod-- > 0 ? 1 : 0);
            storiesParts.push(stories.slice(startStory, endStory));
        }

        const firstStory = storiesParts[0][0];
        storiesParts[0].shift();

        const that = this;
        const storiesPromises = [];
        let firstStoryPromise;
        this._logger.log('Splitting stories for parallel threads...');
        return that._promiseFactory.makePromise(resolve => {
            const driver = this.createSeleniumDriver();
            firstStoryPromise = that.testStory(driver, firstStory, () => resolve());
            storiesPromises.push(firstStoryPromise);
        }).then(() => {
            const threadsPromises = [];
            storiesParts.forEach((stories, i) => {
                let threadPromise = i === 1 ? firstStoryPromise : that._promiseFactory.resolve();
                const driver = this.createSeleniumDriver();
                stories.forEach(story => {
                    threadPromise = threadPromise.then(() => {
                        const promise = that.testStory(driver, story);
                        storiesPromises.push(promise);
                        return promise;
                    });
                });
                threadsPromises.push(threadPromise);
            });
            return that._promiseFactory.all(threadsPromises);
        }).then(() => {
            return Promise.all(storiesPromises);
        });
    }

    /**
     * @param driver
     * @param {StorybookStory} story
     * @param {function} [startNextCallback]
     * @returns {Promise.<TestResults>}
     */
    testStory(driver, story, startNextCallback) {
        this._logger.verbose('Starting collecting resources...');

        let promise = this._promiseFactory.resolve();

        const that = this;
        if (!that._inferred) {
            promise = promise.then(() => {
                return driver.executeScript('return navigator.userAgent;');
            }).then(userAgent => {
                that._inferred = 'useragent:' + userAgent;
            }).then(() => {
                return EyesSeleniumUtils.updateScalingParams(that._logger, driver);
            }).then(scaleProviderFactory => {
                that._scaleProviderFactory = scaleProviderFactory;
            });
        }

        return promise.then(() => {
            if (startNextCallback) {
                startNextCallback();
            }

            return that.getScreenshotOfStory(driver, story);
        }).then(screenshot => {
            that._logger.verbose('Preparing Eyes instance...');
            const eyes = new EyesStorybook(that._configs.serverUrl, that._promiseFactory);
            eyes.setApiKey(that._configs.apiKey);
            eyes.setBatch(that._testBatch);
            eyes.addProperty("Component name", story.getComponentName());
            eyes.addProperty("State", story.getState());
            eyes.setInferredEnvironment(that._inferred);
            if (that._configs.debug) {
                eyes.setLogHandler(that._logger.getLogHandler());
            }

            return eyes.open(that._configs.appName, story.getCompoundTitle(), story.getViewportSize()).then(() => {
                return eyes.checkImage(screenshot, story.getCompoundTitle());
            }).then(() => {
                return eyes.close(false);
            }).then(results => {
                that._logger.verbose('Sending requests - done.');
                return results;
            });
        });
    }


    /**
     * @param driver
     * @param {StorybookStory} story
     * @returns {Promise.<MutableImage>}
     */
    getScreenshotOfStory(driver, story) {
        if (story.getViewportSize()) {
            this._logger.verbose(`Setting viewport size ${story.getViewportSize()} of '${story.getCompoundTitle()}'...`);
            EyesSeleniumUtils.setViewportSize(this._logger, driver, story.getViewportSize());
        }

        this._logger.verbose("Opening url of '" + story.getCompoundTitle() + "'...");
        driver.get(story.getStorybookUrl(this._configs.storybookAddress));

        const that = this;
        return driver.controlFlow().execute(() => {
            that._logger.verbose(`Capturing screenshot of '${story.getCompoundTitle()}' ${story.getViewportSize()}...`);
            return EyesSeleniumUtils.getScreenshot(driver, that._scaleProviderFactory, that._promiseFactory).then((screenshot) => {
                that._logger.log(`Capturing screenshot of '${story.getCompoundTitle()}' ${story.getViewportSize()} done.`);
                return screenshot;
            });
        });
    }

    createSeleniumDriver() {
        const builder = new Builder();
        if (this._configs.seleniumAddress) {
            builder.usingServer(this._configs.seleniumAddress);
        }

        if (this._configs.capabilities && Object.keys(this._configs.capabilities).length) {
            for (const key in this._configs.capabilities) {
                if (this._configs.capabilities.hasOwnProperty(key)) {
                    builder.getCapabilities().set(key, this._configs.capabilities[key]);
                }
            }
        }

        return builder.build();
    }
}

module.exports = EyesStorybookRunner;
