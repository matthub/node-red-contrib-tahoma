'use strict';

var request = require('request');
var util = require('util');

var Q = require('q');

// log levels are 0=disabled, 1=error, 2=warning, 3=debug
const LogLevels = {
  DISABLED: 0,
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
  DEBUG: 4,
};

// trying to get log level from the environment
const REQUESTED_LOG_LEVEL = process.env.TAHOMA_LOG;
var LOG_LEVEL = LogLevels.INFO;
if (REQUESTED_LOG_LEVEL === 'ERROR') {
  LOG_LEVEL = LogLevels.ERROR;
} else if (REQUESTED_LOG_LEVEL === 'WARNING') {
  LOG_LEVEL = LogLevels.WARNING;
} else if (REQUESTED_LOG_LEVEL === 'INFO') {
  LOG_LEVEL = LogLevels.INFO;
} else if (REQUESTED_LOG_LEVEL === 'DEBUG') {
  LOG_LEVEL = LogLevels.DEBUG;
} else {
  LOG_LEVEL = isNaN(parseInt(REQUESTED_LOG_LEVEL, 10))
    ? LogLevels.INFO : parseInt(REQUESTED_LOG_LEVEL, 10);
}

var log = {
  component: '[tahomalink]',
  debug: function(s) {
    if (LOG_LEVEL >= LogLevels.DEBUG) {
      util.log('[debug] ' + log.component, s);
    }
  },
  warn: function(s) {
    if (LOG_LEVEL >= LogLevels.WARNING) {
      util.log('[warn] ' + log.component, s);
    }
  },
  error: function(s) {
    if (LOG_LEVEL >= LogLevels.ERROR) {
      util.log('[error] ' + log.component, s);
    }
  },
  log: function(s) {
    if (LOG_LEVEL >= LogLevels.INFO) {
      util.log('[info] ' + log.component, s);
    }
  },
  info: function(s) {
    if (LOG_LEVEL >= LogLevels.INFO) {
      util.log('[info] ' + log.component, s);
    }
  },
};

/* eslint-env es6 */
const STATE_NOT_LOGGED_IN = 0;
const STATE_LOGGING_IN = 1;
const STATE_LOGGED_IN = 2;
global.state = STATE_NOT_LOGGED_IN;

const MAX_LOGIN_TRIES = 10;
global.loginTries = 0;

var TAHOMA_LINK_BASE_URL = 'https://www.tahomalink.com/enduser-mobile-web'
  + '/enduserAPI';

var login = function login(username, password) {
  var deferred = Q.defer();

  if (global.state === STATE_LOGGED_IN) {
    deferred.resolve();
    return deferred.promise;
  } else if (username == null || username === ''
      || password == null || password === '') {
    var err = 'no username or password given, cannot login!';
    log.warn(err);
    deferred.reject(err);
  } else if (global.state === STATE_LOGGING_IN) {
    var waitingTime = Math.round(1000 + (1000 * Math.random()));
    log.debug('another login attempt was called in parallel, '
      + 'waiting ' + waitingTime + 'ms, then retrying...');
    setTimeout(function() {
      log.debug('retrying login after ' + waitingTime + 'ms...');
      deferred.resolve(login(username, password));
    }, waitingTime);
    return deferred.promise;
  }
  global.state = STATE_LOGGING_IN;
  log.debug('login attempt for user ' + username + ' to '
    + TAHOMA_LINK_BASE_URL + '...');

  request({
    url: TAHOMA_LINK_BASE_URL + '/login',
    method: 'POST',
    form: {
      userId: username,
      userPassword: password,
    },
    jar: true,
  }, function(err, res) {
    if (res.statusCode === 200) {
      global.state = STATE_LOGGED_IN;
      deferred.resolve();
    } else {
      global.state = STATE_NOT_LOGGED_IN;
      deferred.reject(err);
    }
  });

  return deferred.promise;
};

var getSetup = function getSetup(options) {
  var deferred = Q.defer();

  request({
    url: TAHOMA_LINK_BASE_URL + '/setup',
    method: 'GET',
    jar: true,
  }, function(err, res, body) {
    if (res.statusCode === 200) {
      log.debug('getSetup: ' + JSON.stringify(body));
      deferred.resolve(body);
      global.loginTries = 0;
    } else if (res.statusCode === 401 && options) {
      log.debug('401, reason: ' + JSON.stringify(body));
      if (typeof body !== 'object') {
        body = JSON.parse(body);
      }

      global.state = STATE_NOT_LOGGED_IN;
      if (body.errorCode === 'RESOURCE_ACCESS_DENIED') {
        // this reason can be wrong credentials as well as
        // token timeout
        if (global.loginTries > MAX_LOGIN_TRIES) {
          log.warn('401, rejecting number of max login tries reached!');
          // resetting counter to allow further retries in future
          global.loginTries = 0;
          deferred.reject(body);
        } else {
          log.debug('401, resource access denied, retrying ('
            + global.loginTries + ') with login...');
          global.loginTries = global.loginTries + 1;
          setTimeout(function() {
            deferred.resolve(login(options.username, options.password)
              .then(getSetup(options)));
          }, 1000);
        }
      } else {
        // e.g. AUTHENTICATION_ERROR indicates too many
        // parallel logins
        log.warn('401, rejecting because of given reason: '
          + JSON.stringify(body));
        deferred.reject(body);
      }
    } else {
      deferred.reject(err);
    }
  });

  return deferred.promise;
};

var execute = function execute(row, options) {
  var deferred = Q.defer();

  request({
    url: TAHOMA_LINK_BASE_URL + '/exec/apply',
    method: 'POST',
    body: row,
    json: true,
    jar: true,
  }, function(err, res, body) {
    if (res.statusCode === 200) {
      deferred.resolve(body);
    } else if (res.statusCode === 401 && options) {
      log.debug('401, reason:' + JSON.stringify(body));
      if (typeof body !== 'object') {
        body = JSON.parse(body);
      }

      global.state = STATE_NOT_LOGGED_IN;
      if (body.errorCode === 'RESOURCE_ACCESS_DENIED') {
        // this reason can be wrong credentials as well as
        // token timeout
        if (global.loginTries > MAX_LOGIN_TRIES) {
          log.warn('401, rejecting number of max login tries reached!');
          // resetting counter to allow further retries in future
          global.loginTries = 0;
          deferred.reject(body);
        } else {
          log.debug('401, resource access denied, retrying ('
            + global.loginTries + ') with login...');
          global.loginTries = global.loginTries + 1;
          setTimeout(function() {
            deferred.resolve(login(options.username, options.password)
              .then(execute(row, options)));
          }, 1000);
        }
      } else {
        // e.g. AUTHENTICATION_ERROR indicates too many
        // parallel logins
        log.warn('401, rejecting because of given reason: '
          + JSON.stringify(body));
        deferred.reject(body);
      }
    } else {
      deferred.reject(err);
    }
  });

  return deferred.promise;
};

var getDeviceState = function getDeviceState(deviceURL, options) {
  var deferred = Q.defer();

  getSetup(options).then(function(body) {
    if (typeof body !== 'object') {
      body = JSON.parse(body);
    }

    var devices = body.devices;

    for (var i = 0; i < devices.length; i++) {
      if (devices[i].deviceURL === deviceURL) {
        var _thisDevice = devices[i];
        var response = {};

        response.label = _thisDevice.label;

        for (var j = 0; j < _thisDevice.states.length; j++) {
          if (_thisDevice.states[j].name === 'core:OpenClosedState') {
            response.open = _thisDevice.states[j].value;
          }

          if (_thisDevice.states[j].name === 'core:ClosureState') {
            response.position = _thisDevice.states[j].value;
          }

          // - Exposes SunSensor value
          // - https://github.com/nikkow/node-red-contrib-tahoma/issues/6
          if (_thisDevice.states[j].name === 'core:LuminanceState') {
            response.luminance = _thisDevice.states[j].value;
          }

          // - Exposes door handle value
          if (_thisDevice.states[j].name ===
              'core:ThreeWayHandleDirectionState') {
            response.handleState = _thisDevice.states[j].value;
          }
        }

        return deferred.resolve(response);
      }
    }
  }, function() {
    deferred.reject();
  });

  return deferred.promise;
};

var isFirstLaunch = true;
var continueWhenFinished = function continueWhenFinished(
  deviceURL,
  expectedState,
  options
) {
  return Q.Promise(function(resolve) {
    setTimeout(function() {
      getDeviceState(deviceURL, options).then(function(state) {
        // - Checking on the position seems enough for now.
        if (state.position === expectedState.position) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    }, isFirstLaunch ? 0 : 2000);

    isFirstLaunch = false;
  })
    .then(function(finished) {
      return finished ? true : continueWhenFinished(deviceURL, expectedState,
        options);
    });
};

module.exports = {
  login: login,
  getSetup: getSetup,
  execute: execute,
  getDeviceState: getDeviceState,
  continueWhenFinished: continueWhenFinished,
  log: log,
};
