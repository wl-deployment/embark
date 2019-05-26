import { BlockchainClient, Simulator } from 'embark-blockchain-process';
import { __ } from 'embark-i18n';
import { dappPath, embarkPath } from 'embark-utils';
import findUp from 'find-up';
let async = require('async');
const constants = require('embark-core/constants');
const Logger = require('embark-logger');
const {reset: embarkReset, paths: defaultResetPaths} = require('embark-reset');
const fs = require('../lib/core/fs.js');

require('colors');

let version = require('../../package.json').version;

class EmbarkController {

  constructor(options) {
    this.version = version;
    this.options = options || {};

    // set a default context. should be overwritten by an action
    // method before being used
    this.context = {};
  }

  initConfig(env, options) {
    let Events = require('../lib/core/events.js');
    let Config = require('../lib/core/config.js');

    this.events = new Events();
    this.logger = new Logger({logLevel: Logger.logLevels.debug, events: this.events, context: this.context});

    this.config = new Config({env: env, logger: this.logger, events: this.events, context: this.context, version: this.version});
    this.config.loadConfigFiles(options);
    this.plugins = this.config.plugins;
  }

  blockchain(env, client) {
    this.context = [constants.contexts.blockchain];
    return BlockchainClient(this.config.blockchainConfig, {
      clientName: client,
      env,
      certOptions: this.config.webServerConfig.certOptions,
      logger: this.logger,
      events: this.events,
      isStandalone: true,
      fs
    }).run();
  }

  simulator(options) {
    this.context = options.context || [constants.contexts.simulator, constants.contexts.blockchain];
    let simulator = new Simulator({
      blockchainConfig: this.config.blockchainConfig,
      contractsConfig: this.config.contractsConfig,
      logger: this.logger,
      fs
    });
    simulator.run(options);
  }

  generateTemplate(templateName, destinationFolder, name, url) {
    this.context = [constants.contexts.templateGeneration];
    let TemplateGenerator = require('../lib/utils/template_generator.js');
    let templateGenerator = new TemplateGenerator(templateName);

    if (url) {
      return templateGenerator.downloadAndGenerate(url, destinationFolder, name);
    }
    templateGenerator.generate(destinationFolder, name);
  }

  run(options) {
    let self = this;
    self.context = options.context || [constants.contexts.run, constants.contexts.build];
    let Dashboard = require('./dashboard/dashboard.js');

    const webServerConfig = {};

    if (options.runWebserver !== null && options.runWebserver !== undefined) {
      webServerConfig.enabled = options.runWebserver;
    }

    if (options.serverHost !== null && options.serverHost !== undefined) {
      webServerConfig.host = options.serverHost;
    }

    if (options.serverPort !== null && options.serverPort !== undefined) {
      webServerConfig.port = options.serverPort;
    }

    if (options.openBrowser !== null && options.openBrowser !== undefined) {
      webServerConfig.openBrowser = options.openBrowser;
    }

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: options.embarkConfig || 'embark.json',
      logFile: options.logFile,
      logLevel: options.logLevel,
      context: self.context,
      useDashboard: options.useDashboard,
      webServerConfig: webServerConfig,
      webpackConfigName: options.webpackConfigName,
      singleUseAuthToken: options.singleUseAuthToken,
      ipcRole: 'server'
    });

    async.waterfall([
      function initEngine(callback) {
        engine.init({}, () => {
          engine.startService("embarkListener");
          if (!options.useDashboard) {
            engine.logger.info('========================'.bold.green);
            engine.logger.info((__('Welcome to Embark') + ' ' + engine.version).yellow.bold);
            engine.logger.info('========================'.bold.green);
          }
          callback();
        });
      },
      function (callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }

        engine.startService("processManager");
        engine.startService("coreProcess");
        engine.startService("blockchainListener");
        engine.startService("serviceMonitor");
        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("web3");
        engine.startService("pipeline");
        engine.startService("deployment");
        engine.startService("storage");
        engine.startService("codeGenerator");
        engine.startService("console");
        engine.startService("cockpit");
        engine.startService("pluginCommand");

        engine.events.on('check:backOnline:Ethereum', function () {
          engine.logger.info(__('Ethereum node detected') + '..');
          engine.config.reloadConfig();
          engine.events.request('deploy:contracts', function (err) {
            if (err) {
              return engine.logger.error(err.message || err);
            }
            engine.logger.info(__('Deployment Done'));
          });
        });

        engine.events.on('outputDone', function () {
          engine.logger.info((__("Looking for documentation? You can find it at") + " ").cyan + "http://embark.status.im/docs/".green.underline + ".".cyan);
          engine.logger.info(__("Ready").underline);
          engine.events.emit("status", __("Ready").green);
        });

        if (webServerConfig.enabled !== false) {
          engine.startService("webServer");
        }
        engine.startService("fileWatcher");
        callback();
      },
      function startDashboard(callback) {
        if (!options.useDashboard) {
          return callback();
        }

        let dashboard = new Dashboard({
          events: engine.events,
          logger: engine.logger,
          plugins: engine.plugins,
          version: self.version,
          env: engine.env,
          ipc: engine.ipc
        });
        dashboard.start(function () {
          engine.logger.info(__('dashboard start'));
          callback();
        });
      }
    ], function (err, _result) {
      if (err) {
        engine.logger.error(err.message);
        engine.logger.info(err.stack);
      } else {
        engine.events.emit('firstDeploymentDone');
      }
    });
  }

  build(options) {
    this.context = options.context || [constants.contexts.build];

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: 'embark.json',
      interceptLogs: false,
      logFile: options.logFile,
      logLevel: options.logLevel,
      events: options.events,
      logger: options.logger,
      config: options.config,
      plugins: options.plugins,
      context: this.context,
      webpackConfigName: options.webpackConfigName
    });


    async.waterfall([
      function initEngine(callback) {
        engine.init({}, callback);
      },
      function startServices(callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }

        engine.startService("processManager");
        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("pipeline");
        engine.startService("codeGenerator");
        if (!options.onlyCompile) {
          engine.startService("web3");
          engine.startService("deployment", {onlyCompile: options.onlyCompile});
          engine.startService("storage");
        } else {
          engine.startService('compiler');
        }

        callback();
      },
      function buildOrBuildAndDeploy(callback) {
        if (options.onlyCompile) {
          return engine.events.request('contracts:build', {}, err => {
            if (err !== undefined) return callback(err);
            engine.events.request('pipeline:build:contracts', err => callback(err));
          });
        }

        // deploy:contracts will trigger a build as well
        engine.events.request('deploy:contracts', err => callback(err));
      },
      function waitForWriteFinish(callback) {
        if (options.onlyCompile) {
          engine.logger.info("Finished compiling".underline);
          return callback(null, true);
        }
        engine.logger.info("Finished deploying".underline);
        engine.events.on('outputDone', (err) => {
          engine.logger.info(__("Finished building").underline);
          callback(err, true);
        });
      }
    ], function (err, canExit) {
      if(err) {
        engine.logger.error(err.message || err);
      }
      // TODO: this should be moved out and determined somewhere else
      if (canExit || !engine.config.contractsConfig.afterDeploy || !engine.config.contractsConfig.afterDeploy.length) {
        process.exit(err ? 1 : 0);
      }
      engine.logger.info(__('Waiting for after deploy to finish...'));
      engine.logger.info(__('You can exit with CTRL+C when after deploy completes'));
    });
  }

  console(options) {
    this.context = options.context || [constants.contexts.run, constants.contexts.console];
    const REPL = require('./dashboard/repl.js');
    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: options.embarkConfig || 'embark.json',
      logFile: options.logFile,
      logLevel: options.logLevel,
      context: this.context,
      singleUseAuthToken: options.singleUseAuthToken,
      webpackConfigName: options.webpackConfigName
    });

    const isSecondaryProcess = (engine) => { return engine.ipc.connected && engine.ipc.isClient(); };

    async.waterfall([
      function initEngine(callback) {
        engine.init({}, callback);
      },
      function startServices(callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }

        engine.startService("web3");
        engine.startService("deployment");
        engine.startService("codeGenerator");
        engine.startService("codeRunner");
        engine.startService("console");

        if (isSecondaryProcess(engine)) {
          return callback();
        }
        engine.startService("embarkListener");
        engine.startService("processManager");
        engine.startService("coreProcess");
        engine.startService("serviceMonitor");
        engine.startService("libraryManager");
        engine.startService("pipeline");
        engine.startService("storage");
        engine.startService("cockpit");
        engine.startService("pluginCommand");
        engine.events.request('blockchain:ready', callback);
      },
      function ipcConnect(callback) {
        // Do specific work in case we are connected to a socket:
        //  - Setup Web3
        //  - Apply history
        if(isSecondaryProcess(engine)) {
          return callback();
        }
        engine.events.request("console:provider:ready", callback);
      },
      function deploy(callback) {
        // Skip if we are connected to a websocket, the server will do it
        if(isSecondaryProcess(engine)) {
          return callback();
        }
        engine.config.reloadConfig();
        engine.events.request('deploy:contracts', function (err) {
          callback(err);
        });
      },
      function waitForWriteFinish(callback) {
        // Skip if we are connected to a websocket, the server will do it
        if(isSecondaryProcess(engine)) {
          return callback();
        }
        engine.logger.info("Finished deploying".underline);
        engine.events.once('outputDone', (err) => {
          engine.logger.info(__("finished building").underline);
          callback(err);
        });
      },
      function startREPL(callback) {
        new REPL({
          events: engine.events,
          env: engine.env,
          ipc: engine.ipc,
          useDashboard: false,
          logger: engine.logger
        }).start(callback);
      }
    ], function (err, _result) {
      if (err) {
        engine.logger.error(err.message);
        engine.logger.info(err.stack);
      } else {
        engine.events.emit('firstDeploymentDone');
      }
    });
  }

  graph(options) {
    this.context = options.context || [constants.contexts.graph];
    options.onlyCompile = true;

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      version: this.version,
      embarkConfig: options.embarkConfig || 'embark.json',
      logFile: options.logFile,
      context: this.context
    });


    async.waterfall([
      function (callback) {
        engine.init({}, callback);
      },
      function (callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }

        engine.startService("processManager");
        engine.startService("serviceMonitor");
        engine.startService("libraryManager");
        engine.startService("compiler");
        engine.startService("codeGenerator");
        engine.startService("graph");
        engine.events.request('contracts:build', {}, callback);
      }
    ], (err) => {
      if (err) {
        engine.logger.error(err.message);
        engine.logger.info(err.stack);
      } else {

        engine.events.request("graph:create", options, () => {
          engine.logger.info(__("Done. %s generated", options.output).underline);
        });
      }
      process.exit(err ? 1 : 0);
    });

  }

  async reset(options) {
    const embarkConfig = require(dappPath(options.embarkConfig || 'embark.json'));

    let removePaths = [];
    let defaultPaths = [...defaultResetPaths];

    defaultPaths.push(embarkConfig.buildDir);
    if (embarkConfig.generationDir) {
      defaultPaths.push(embarkConfig.generationDir);
    }

    if (embarkConfig.options && embarkConfig.options.reset) {
      if (embarkConfig.options.reset.defaults) {
        removePaths = removePaths.concat(defaultPaths);
      }
      if (embarkConfig.options.reset.files) {
        removePaths = removePaths.concat(embarkConfig.options.reset.files);
      }
    } else {
      removePaths = defaultPaths;
    }
    removePaths = [
      ...new Set(removePaths.map(path => {
        return path.charAt(path.length - 1) === '/' ? path.substr(0, path.length - 1) : path;
      }))
    ];
    await embarkReset({removePaths});
  }

  ejectWebpack() {
    const embarkConfig = (findUp.sync('node_modules/embark-pipeline/dist/webpack.config.js', {cwd: embarkPath()}) || embarkPath("node_modules/embark-pipeline/dist/webpack.config.js"));
    const dappConfig = dappPath('webpack.config.js');
    fs.copyPreserve(embarkConfig, dappConfig);
    console.log(__('webpack config ejected to:').dim.yellow);
    console.log(`${dappConfig}`.green);
    const embarkOverrides = (findUp.sync('node_modules/embark-pipeline/dist/babel-loader-overrides.js', {cwd: embarkPath()}) || embarkPath("node_modules/embark-pipeline/dist/babel-loader-overrides.js"));
    const dappOverrides = dappPath('babel-loader-overrides.js');
    fs.copyPreserve(embarkOverrides, dappOverrides);
    console.log(__('webpack overrides ejected to:').dim.yellow);
    console.log(`${dappOverrides}`.green);
  }

  scaffold(options) {
    this.context = options.context || [constants.contexts.scaffold];

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: 'embark.json',
      interceptLogs: false,
      logFile: options.logFile,
      logLevel: options.logLevel,
      events: options.events,
      logger: options.logger,
      config: options.config,
      plugins: options.plugins,
      context: this.context,
      webpackConfigName: options.webpackConfigName
    });

    async.waterfall([
      function initEngine(callback) {
        engine.init({}, callback);
      },
      function startServices(callback) {
        engine.startService("scaffolding");
        callback();
      },
      function generateContract(callback) {
        engine.events.request('scaffolding:generate:contract', options, function(files) {
          files.forEach(file => engine.events.request('config:contractsFiles:add', file));
          callback();
        });
      },
      function initEngineServices(callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }
        engine.startService("processManager");
        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("web3");
        engine.startService("deployment", {onlyCompile: true});

        callback();
      },
      function deploy(callback) {
        engine.events.request('deploy:contracts', function(err) {
          callback(err);
        });
      },
      function generateUI(callback) {
        engine.events.request("scaffolding:generate:ui", options, () => {
          callback();
        });
      }
    ], function(err) {
      if (err) {
        engine.logger.error(__("Error generating the UI: "));
        engine.logger.error(err.message || err);
        process.exit(1);
      }
      engine.logger.info(__("finished generating the UI").underline);
      engine.logger.info(__("To see the result, execute {{cmd}} and go to /{{contract}}.html", {cmd: 'embark run'.underline, contract: options.contract}));
      process.exit(0);
    });
  }

  upload(options) {
    this.context = options.context || [constants.contexts.upload, constants.contexts.build];

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: 'embark.json',
      interceptLogs: false,
      logFile: options.logFile,
      logLevel: options.logLevel,
      events: options.events,
      logger: options.logger,
      config: options.config,
      plugins: options.plugins,
      context: this.context,
      webpackConfigName: options.webpackConfigName
    });

    let platform;

    async.waterfall([
      function initEngine(callback) {
        engine.init({}, () => {
          if (engine.config.embarkConfig.config.storage === false || engine.config.storageConfig.enabled === false) {
            engine.logger.error(__('Storage configuration is disabled in embark.json. Please provide a storage file before uploading'));
            engine.logger.info(__('You can find an example here: %s', 'https://github.com/embark-framework/embark/blob/master/templates/demo/config/storage.js'.underline));
            process.exit(1);
          }
          platform = engine.config.storageConfig.upload.provider;
          callback();
        });
      },
      function startServices(callback) {

        engine.startService("processManager");
        engine.startService("serviceMonitor");
        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("web3");
        engine.startService("pipeline");
        engine.startService("deployment");
        engine.startService("storage");
        engine.startService("codeGenerator");
        callback();
      },
      function listLoadedPlugin(callback) {
        let pluginList = engine.plugins.listPlugins();
        if (pluginList.length > 0) {
          engine.logger.info(__("loaded plugins") + ": " + pluginList.join(", "));
        }
        callback();
      },
      function deploy(callback) {
        engine.events.on('outputDone', function () {
          engine.events.request("storage:upload", callback);
        });
        engine.events.on('check:backOnline:Ethereum', function () {
          engine.logger.info(__('Ethereum node detected') + '..');
          engine.config.reloadConfig();
          engine.events.request('deploy:contracts', function (err) {
            if (err) {
              return engine.logger.error(err.message || err);
            }
            engine.logger.info(__('Deployment Done'));
          });
        });
      },
      function associateToENS(hash, callback) {
        if(!options.ensDomain) {
          return callback(null, hash);
        }
        engine.events.request("storage:ens:associate",
          {name: options.ensDomain, storageHash: hash}, (err) => {
            if (err) {
              return callback(err);
            }
            engine.logger.info(__('ENS association completed for {{hash}} at {{domain}}', {hash, domain: options.ensDomain}));
            callback();
          });
      }
    ], function (err) {
      if (err) {
        if (err.message) {
          engine.logger.error(err.message);
          engine.logger.debug(err.stack);
        }
        engine.logger.error(err);
      } else {
        engine.logger.info((__("finished building DApp and deploying to") + " " + platform).underline);
      }

      // needed due to child processes
      process.exit(err ? 1 : 0);
    });
  }

  runTests(options) {
    this.context = [constants.contexts.test];

    const Engine = require('../lib/core/engine.js');
    const engine = new Engine({
      env: options.env,
      client: options.client,
      locale: options.locale,
      version: this.version,
      embarkConfig: options.embarkConfig || 'embark.json',
      logFile: options.logFile,
      logLevel: options.logLevel || Logger.logLevels.warn,
      context: this.context,
      useDashboard: options.useDashboard,
      webpackConfigName: options.webpackConfigName,
      ipcRole: 'client',
      interceptLogs: false
    });

    async.waterfall([
      function initEngine(callback) {
        engine.init({}, callback);
      },
      function startServices(callback) {
        engine.startService("processManager");
        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("web3", {wait: true, node: options.node});
        engine.startService("deployment", {
          trackContracts: false,
          compileOnceOnly: true,
          isCoverage: options.coverage
        });
        engine.startService("storage");
        engine.startService("codeGenerator");
        engine.startService("console");
        engine.startService("pluginCommand");
        if (options.coverage) {
          engine.startService("codeCoverage");
        }
        engine.startService("testRunner");
        engine.events.request('code-generator:embarkjs:build', () => {
          callback();
        });
      },
      function runTests(callback) {
        engine.events.request('tests:run', options, callback);
      }
    ], function (err) {
      if (err) {
        engine.logger.error(err.message || err);
      }

      process.exit(err ? 1 : 0);
    });
  }
}

module.exports = EmbarkController;
