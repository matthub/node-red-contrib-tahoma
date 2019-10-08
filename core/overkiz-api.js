/* eslint-env es6 */
'use strict';

var request = require('request').defaults({ jar: true });
var pollingtoevent = require('polling-to-event');

var Command = function(name, parameters) {
  this.type = 1;
  this.name = name;
  if (typeof (parameters) === 'undefined') parameters = [];
  if (!Array.isArray(parameters)) parameters = [parameters];
  this.parameters = parameters;
};

var Execution = function(name, deviceURL, commands) {
  this.label = name;
  this.metadata = null;
  this.actions = [{
    deviceURL: deviceURL,
    commands: commands,
  }];
};

var ExecutionState = {
  INITIALIZED: 'INITIALIZED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

var State = {
  STATE_MANUFACTURER: 'core:ManufacturerNameState',
  STATE_MODEL: 'core:ModelState',
  STATE_CLOSURE: 'core:ClosureState',
  STATE_OPEN_CLOSED: 'core:OpenClosedState',
  STATE_OPEN_CLOSED_PEDESTRIAN: 'core:OpenClosedPedestrianState',
  STATE_LOCKED_UNLOCKED: 'core:LockedUnlockedState',
  STATE_PRIORITY_LOCK: 'core:PriorityLockLevelState',
  STATE_ACTIVE_ZONES: 'core:ActiveZonesState',
  STATE_TARGET_TEMP: 'core:TargetTemperatureState',
  STATE_HEATING_ON_OFF: 'core:HeatingOnOffState',
  STATE_OPEN_CLOSED_UNKNOWN: 'core:OpenClosedUnknownState',
  STATE_RSSI: 'core:RSSILevelState',
  STATE_ON_OFF: 'core:OnOffState',
  STATE_INTENSITY: 'core:IntensityState',
};

var Server = {
  Cozytouch: 'ha110-1.overkiz.com',
  TaHoma: 'tahomalink.com',
  Connexoon: 'tahomalink.com',
  'Connexoon RTS': 'ha201-1.overkiz.com',
};

module.exports = {
  Command: Command,
  Execution: Execution,
  ExecutionState: ExecutionState,
  State: State,
  Api: OverkizApi,
};

function OverkizApi(log, config) {
  this.log = log;

  // Default values
  this.debugUrl = config['debugUrl'] || false;
  this.alwaysPoll = config['alwaysPoll'] || false;
  // Poll for events every 2 seconds by default
  this.pollingPeriod = config['pollingPeriod'] || 2;
  // Refresh device states every 30 minutes by default
  this.refreshPeriod = config['refreshPeriod'] || (60 * 30);
  this.service = config['service'] || 'TaHoma';

  this.user = config['user'];
  this.password = config['password'];
  this.server = Server[this.service];

  if (!this.user || !this.password)
    throw new Error("You must provide credentials ('user'/'password')");
  if (!this.server)
    throw new Error("Invalid service name '" + this.service + "'");

  this.isLoggedIn = false;
  this.listenerId = null;
  this.executionCallback = [];
  this.platformAccessories = [];
  this.stateChangedEventListener = null;

  var that = this;
  this.eventpoll = pollingtoevent(function(done) {
    if (that.isLoggedIn && that.listenerId !== null && that.listenerId !== 0) {
      that.post({
        url: that.urlForQuery('/events/' + that.listenerId + '/fetch'),
        json: true,
      }, function(error, data) {
        done(error, data);
      });
    } else {
      done(null, []);
    }
  }, {
    longpolling: true,
    interval: (1000 * this.pollingPeriod),
  });

  this.eventpoll.on('longpoll', function(data) {
    if (this.log) {
      this.log.debug('longpoll, data: ' + JSON.stringify(data));
    } else if (that.log) {
      that.log.debug('longpoll, data: ' + JSON.stringify(data));
    } else {
      console.log('longpoll, data: ' + JSON.stringify(data));
    }
    for (var event of data) {
      if (event.name === 'DeviceStateChangedEvent') {
        if (that.stateChangedEventListener !== null)
          that.stateChangedEventListener.onStatesChange(event.deviceURL,
            event.deviceStates);
      } else if (event.name === 'ExecutionStateChangedEvent') {
        var cb = that.executionCallback[event.execId];
        if (cb !== null) {
          cb(event.newState,
            event.failureType === undefined ? null : event.failureType);
          if (event.timeToNextState === -1) {
            // No more state expected for this execution
            delete that.executionCallback[event.execId];
            if (!that.alwaysPoll
              && Object.keys(that.executionCallback).length === 0) {
              // Unregister listener when no more execution running
              that.unregisterListener();
            }
          }
        }
      }
    }
  });

  this.eventpoll.on('error', function(error) {
    that.log.error('Error with listener ' + that.listenerId + ' => ' + error);
    that.listenerId = null;
  });

  var refreshpoll = pollingtoevent(function(done) {
    if (that.isLoggedIn) {
      that.refreshStates(function(error, data) {
        setTimeout(function() {
          that.getDevices(function(error, data) {
            if (!error) {
              for (var device of data) {
                if (that.stateChangedEventListener !== null) {
                  that.stateChangedEventListener.onStatesChange(
                    device.deviceURL, device.states);
                }
              }
            }
          });
        }, 10 * 1000); // Read devices states after 10s
        done(error, data);
      });
    }
  }, {
    longpolling: true,
    interval: (1000 * this.refreshPeriod),
  });

  refreshpoll.on('error', function(error) {
    that.log.error(error);
  });
}

OverkizApi.prototype = {
  urlForQuery: function(query) {
    if (this.debugUrl) {
      return this.debugUrl + '&query=' + query;
    } else {
      return 'https://' + this.server + '/enduser-mobile-web/enduserAPI'
        + query;
    }
  },

  post: function(options, callback) {
    // this.log("POST " + options.url);
    var fct = request.post.bind(request, options);
    this.requestWithLogin(fct, callback);
  },

  get: function(options, callback) {
    // this.log("GET " + options.url);
    var fct = request.get.bind(request, options);
    this.requestWithLogin(fct, callback);
  },

  put: function(options, callback) {
    // this.log("PUT " + options.url);
    var fct = request.put.bind(request, options);
    this.requestWithLogin(fct, callback);
  },

  delete: function(options, callback) {
    // this.log("DELETE " + options.url);
    var fct = request.delete.bind(request, options);
    this.requestWithLogin(fct, callback);
  },

  getDevices(callback) {
    this.get({
      url: this.urlForQuery('/setup/devices'),
      json: true,
    }, function(error, json) {
      callback(error, json);
    });
  },

  getActionGroups(callback) {
    this.get({
      url: this.urlForQuery('/actionGroups'),
      json: true,
    }, function(error, json) {
      callback(error, json);
    });
  },

  requestWithLogin: function(myRequest, callback) {
    // this.log("requestWithLogin ? " + (this.isLoggedIn ? 'true' : 'false'));
    var that = this;
    var authCallback = function(err, response, json) {
      if (response !== undefined && response.statusCode === 401) {
        // Reauthenticated
        that.isLoggedIn = false;
        // that.log(json.error);
        that.requestWithLogin(myRequest, callback);
      } else if (err) {
        that.log.warn('Unable to request : ' + err);
        callback(err);
      } else if (response !== undefined
          && (response.statusCode < 200 || response.statusCode >= 300)) {
        var msg = 'Error ' + response.statusCode;
        if (json && json.error != null)
          msg += ' ' + json.error;
        if (json && json.errorCode != null)
          msg += ' (' + json.errorCode + ')';
        that.log.debug(msg);
        callback(msg);
      } else {
        callback(null, json);
      }
    };
    if (this.isLoggedIn) {
      myRequest(authCallback);
    } else {
      // var that = this;
      that.listenerId = null;
      that.log.debug('Logging in to ' + this.service + ' server...');
      request.post({
        url: this.urlForQuery('/login'),
        form: {
          userId: this.user,
          userPassword: this.password,
        },
        json: true,
      }, function(err, response, json) {
        that.log.debug('RESP : ' + JSON.stringify(json));
        if (err) {
          that.log.warn('Unable to login: ' + err);
          callback(err);
        } else if (json && json.success) {
          that.isLoggedIn = true;
          myRequest(authCallback);
          that.log.warn('Unable to login: ' + err);
          if (that.alwaysPoll)
            that.registerListener();
        } else if (json && json.error) {
          that.log.warn('Login fail: ' + json.error);
          callback(json.error);
        } else {
          that.log.error('Unable to login');
          callback('Unable to login');
        }
      });
    }
  },

  registerListener: function() {
    var that = this;
    if (this.listenerId == null) {
      this.listenerId = 0;
      this.log.debug('Register listener');
      this.post({
        url: that.urlForQuery('/events/register'),
        json: true,
      }, function(error, data) {
        if (!error) {
          that.listenerId = data.id;
          that.log.debug('Listener registered ' + that.listenerId);
        } else {
          that.listenerId = null;
          that.log.error('Error while registering listener');
        }
      });
    }
  },

  unregisterListener: function() {
    var that = this;
    if (this.listenerId != null) {
      this.log.debug('Unregister listener');
      this.post({
        url: that.urlForQuery('/events/' + this.listenerId + '/unregister'),
        json: true,
      }, function(error, data) {
        if (!error) {
          that.listenerId = null;
        }
      });
    }
  },

  refreshStates: function(callback) {
    this.put({
      url: this.urlForQuery('/setup/devices/states/refresh'),
      json: true,
    }, function(error, data) {
      callback(error, data);
    });
  },

  requestState: function(deviceURL, state, callback) {
    // var that = this;
    this.get({
      url: this.urlForQuery('/setup/devices/' + encodeURIComponent(deviceURL)
        + '/states/' + encodeURIComponent(state)),
      json: true,
    }, function(error, data) {
      // that.log(data);
      callback(error, data.value);
    });
  },

  cancelCommand: function(execId, callback) {
    // var that = this;
    this.delete({
      url: this.urlForQuery('/exec/current/setup/' + execId),
      json: true,
    }, function(error, json) {
      callback(error);
    });
  },

  /*
          cmdName: The command to execute
          params: Parameter of the command
          callback: Callback function executed when command sended
          refresh: Callback function executed when command succeed
      */
  executeCommand: function(execution, callback, highPriority) {
    if (highPriority)
      this.execute('apply/highPriority', execution, callback);
    else
      this.execute('apply', execution, callback);
  },

  /*
          oid: The command OID or 'apply' if immediate execution
          execution: Body parameters
          callback: Callback function executed when command sended
      */
  execute: function(oid, execution, callback) {
    var that = this;
    // this.log(command);
    this.post({
      url: that.urlForQuery('/exec/' + oid),
      // headers: {'User-Agent': 'TaHoma iPhone'},
      body: execution,
      json: true,
    }, function(error, json) {
      if (error == null) {
        callback(ExecutionState.INITIALIZED, error, json); // Init OK
        that.executionCallback[json.execId] = callback;
        if (!that.alwaysPoll)
          that.registerListener();
      } else {
        callback(ExecutionState.FAILED, error);
      }
    });
  },

  setDeviceStateChangedEventListener: function(listener) {
    this.stateChangedEventListener = listener;
  },
};
