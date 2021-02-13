/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Apigee Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

const _ = require('lodash');
const async = require('async');
const bp = require('body-parser');
const cHelpers = require('../lib/helpers');
const debug = require('debug')('swagger-tools:middleware:metadata');
const mHelpers = require('./helpers');
const multer = require('multer');
const parseurl = require('parseurl');
const { pathToRegexp } = require('path-to-regexp');
const regexEscape = require('regex-escape');

// Upstream middlewares
const parseQueryString = mHelpers.parseQueryString;
function queryParser(req, res, next) {
  if (_.isUndefined(req.query)) {
    req.query = parseQueryString(req);
  }

  return next();
};

const textBodyParserOptions = {
  type: '*/*'
};
const realTextBodyParser = bp.text(textBodyParserOptions);
function textBodyParser(req, res, next) {
  if (_.isUndefined(req.body)) {
    realTextBodyParser(req, res, next);
  } else {
    next();
  }
};

const bodyParserOptions = {
  extended: false
};
const jsonBodyParser = bp.json();
const urlEncodedBodyParser = bp.urlencoded(bodyParserOptions);
function bodyParser(req, res, next) {
  if (_.isUndefined(req.body)) {
    urlEncodedBodyParser(req, res, function (err) {
      if (err) {
        next(err);
      } else {
        jsonBodyParser(req, res, next);
      }
    });
  } else {
    next();
  }
};

const multerOptions = {
  storage: multer.memoryStorage()
};
const realMultiPartParser = multer(multerOptions);
function makeMultiPartParser(parser) {
  return function (req, res, next) {
    if (_.isUndefined(req.files)) {
      parser(req, res, next);
    } else {
      next();
    }
  };
};

// Helper functions
function expressStylePath(basePath, apiPath) {
  basePath = parseurl({url: basePath || '/'}).pathname || '/';

  // Make sure the base path starts with '/'
  if (basePath.charAt(0) !== '/') {
    basePath = '/' + basePath;
  }

  // Make sure the base path ends with '/'
  if (basePath.charAt(basePath.length - 1) !== '/') {
    basePath = basePath + '/';
  }

  // Make sure the api path does not start with '/' since the base path will end with '/'
  if (apiPath.charAt(0) === '/') {
    apiPath = apiPath.substring(1);
  }

  // Replace Swagger syntax for path parameters with Express' version (All Swagger path parameters are required)
  return (basePath + apiPath).replace(/{/g, ':').replace(/}/g, '');
};

function processOperationParameters(swaggerMetadata, pathKeys, pathMatch, req, res, next) {
  var spec = cHelpers.getSpec();
  var parameters = !_.isUndefined(swaggerMetadata) ?
                     (swaggerMetadata.operationParameters) :
                     undefined;

  if (!parameters) {
    return next();
  }

  debug('  Processing Parameters');

  var parsers = _.reduce(parameters, function (requestParsers, parameter) {
    var contentType = req.headers['content-type'];
    var paramLocation = parameter.schema.in;
    var paramType = mHelpers.getParameterType(parameter.schema);
    var parsableBody = mHelpers.isModelType(spec, paramType) || ['array', 'object'].indexOf(paramType) > -1;
    var parser;

    switch (paramLocation) {
      case 'body':
      case 'form':
      case 'formData':
        if (paramType.toLowerCase() === 'file' || (contentType && contentType.split(';')[0] === 'multipart/form-data')) {
          // Do not add a parser, multipart will be handled after
          break;
        } else if (paramLocation !== 'body' || parsableBody) {
          parser = bodyParser;
        } else {
          parser = textBodyParser;
        }

        break;

      case 'query':
        parser = queryParser;

        break;
    }

    if (parser && requestParsers.indexOf(parser) === -1) {
      requestParsers.push(parser);
    }

    return requestParsers;
  }, []);

  // Multipart is handled by multer, which needs an array of {parameterName, maxCount}
  var multiPartFields = _.reduce(parameters, function (fields, parameter) {
    var paramLocation = parameter.schema.in;
    var paramType = mHelpers.getParameterType(parameter.schema);
    var paramName = parameter.schema.name;

    switch (paramLocation) {
      case 'body':
      case 'form':
      case 'formData':
        if (paramType.toLowerCase() === 'file') {
          // Swagger spec does not allow array of files, so maxCount should be 1
          fields.push({name: paramName, maxCount: 1});
        }
        break;
    }

    return fields;
  }, []);
  
  var contentType = req.headers['content-type'];
  if (multiPartFields.length) {
    // If there are files, use multer#fields
    parsers.push(makeMultiPartParser(realMultiPartParser.fields(multiPartFields)));
  } else if (contentType && contentType.split(';')[0] === 'multipart/form-data') {
    // If no files but multipart form, use empty multer#array for text fields
    parsers.push(makeMultiPartParser(realMultiPartParser.array()));
  }

  async.map(parsers, function (parser, callback) {
    parser(req, res, callback);
  }, function (err) {
    if (err) {
      return next(err);
    }

    _.each(parameters, function (parameterOrMetadata, index) {
      var parameter = parameterOrMetadata.schema;
      var pLocation = parameter.in;
      var pType = mHelpers.getParameterType(parameter);
      var oVal;
      var value;

      debug('    %s', parameter.name);
      debug('      Type: %s%s', pType, !_.isUndefined(parameter.format) ? ' (format: ' + parameter.format + ')': '');

      // Located here to make the debug output pretty
      oVal = mHelpers.getParameterValue(parameter, pathKeys, pathMatch, req, debug);
      value = mHelpers.convertValue(oVal, _.isUndefined(parameter.schema) ? parameter : parameter.schema, pType, pLocation);

      debug('      Value: %s', value);

      swaggerMetadata.params[parameter.name] = {
        path: parameterOrMetadata.path,
        schema: parameter,
        originalValue: oVal,
        value: value
      };
    });

    return next();
  });
};
function processSwaggerDocuments(rlOrSO, apiDeclarations) {
  if (_.isUndefined(rlOrSO)) {
    throw new Error('rlOrSO is required');
  } else if (!_.isPlainObject(rlOrSO)) {
    throw new TypeError('rlOrSO must be an object');
  }

  var spec = cHelpers.getSpec();
  var apiCache = {};
  var composeParameters = function (apiPath, method, path, operation) {
    var cParams = [];
    var seenParams = [];

    _.each(operation.parameters, function (parameter, index) {
      cParams.push({
        path: apiPath.concat([method, 'parameters', index.toString()]),
        schema: parameter
      });

      seenParams.push(parameter.name + ':' + parameter.in);
    });

    _.each(path.parameters, function (parameter, index) {
      if (seenParams.indexOf(parameter.name + ':' + parameter.in) === -1) {
        cParams.push({
          path: apiPath.concat(['parameters', index.toString()]),
          schema: parameter
        });
      }
    });

    return cParams;
  };

  var createCacheEntry = function (adOrSO, apiOrPath, indexOrName, indent) {
    var apiPath = indexOrName;
    var expressPath = expressStylePath(adOrSO.basePath, indexOrName);
    var keys = [];
    var handleSubPaths = !(rlOrSO.paths && rlOrSO.paths[apiPath]['x-swagger-router-handle-subpaths']);
    var re = pathToRegexp(regexEscape(expressPath), keys, { end: handleSubPaths });
    var cacheKey = re.toString();
    var cacheEntry;

    // This is an absolute path, use it as the cache key
    if (expressPath.indexOf('{') === -1) {
      cacheKey = expressPath;
    }

    debug(new Array(indent + 1).join(' ') + 'Found Path: %s', apiPath);

    cacheEntry = apiCache[cacheKey] = {
      apiPath: indexOrName,
      path: apiOrPath,
      keys: keys,
      re: re,
      operations: {},
      swaggerObject: {
        original: rlOrSO,
        resolved: adOrSO
      }
    };

    return cacheEntry;
  };

  debug('  Identified Swagger version: %s', spec.version);

  // To avoid running into issues with references throughout the Swagger object we will use the resolved version.
  // Getting the resolved version is an asynchronous process but since initializeMiddleware caches the resolved document
  // this is a synchronous action at this point.
  spec.resolve(rlOrSO, function (err, resolved) {
    // Gather the paths, their path regex patterns and the corresponding operations
    _.each(resolved.paths, function (path, pathName) {
      var cacheEntry = createCacheEntry(resolved, path, pathName, 2);

      _.each(['get', 'put', 'post', 'delete', 'options', 'head', 'patch'], function (method) {
        var operation = path[method];

        if (!_.isUndefined(operation)) {
          cacheEntry.operations[method] = {
            operation: operation,
            operationPath: ['paths', pathName, method],
            // Required since we have to compose parameters based on the operation and the path
            operationParameters: composeParameters(['paths', pathName], method, path, operation)
          };
        }
      });
    });
  });
  

  return apiCache;
};

/**
 * Middleware for providing Swagger information to downstream middleware and request handlers.  For all requests that
 * match a Swagger path, 'req.swagger' will be provided with pertinent Swagger details.  Since Swagger 1.2 and 2.0
 * differ a bit, the structure of this object will change so please view the documentation below for more details:
 *
 *     https://github.com/apigee-127/swagger-tools/blob/master/docs/Middleware.md#swagger-metadata
 *
 * @param {object} rlOrSO - The Resource Listing (Swagger 1.2) or Swagger Object (Swagger 2.0)
 * @param {object[]} apiDeclarations - The array of API Declarations (Swagger 1.2)
 *
 * @returns the middleware function
 */
module.exports = (rlOrSO, apiDeclarations) => {
  debug('Initializing swagger-metadata middleware');

  var apiCache = processSwaggerDocuments(rlOrSO, apiDeclarations);

  if (_.isUndefined(rlOrSO)) {
    throw new Error('rlOrSO is required');
  } else if (!_.isPlainObject(rlOrSO)) {
    throw new TypeError('rlOrSO must be an object');
  }

  return function swaggerMetadata (req, res, next) {
    var method = req.method.toLowerCase();
    var path = parseurl(req).pathname;
    var cacheEntry;
    var match;
    var metadata;

    cacheEntry = apiCache[path] || _.find(apiCache, function (metadata) {
      match = metadata.re.exec(path);
      return _.isArray(match);
    });

    debug('%s %s', req.method, req.url);
    debug('  Is a Swagger path: %s', !_.isUndefined(cacheEntry));

    // Request does not match an API defined in the Swagger document(s)
    if (!cacheEntry) {
      return next();
    }

    metadata = {
      apiPath : cacheEntry.apiPath,
      path: cacheEntry.path,
      params: {},
      swaggerObject: cacheEntry.swaggerObject.resolved
    };

    if (_.isPlainObject(cacheEntry.operations[method])) {
      metadata.operation = cacheEntry.operations[method].operation;
      metadata.operationPath = cacheEntry.operations[method].operationPath;
      metadata.operationParameters = cacheEntry.operations[method].operationParameters;
      metadata.security = metadata.operation.security || metadata.swaggerObject.security || [];
    }

    req.swagger = metadata;

    debug('  Is a Swagger operation: %s', !_.isUndefined(metadata.operation));

    if (metadata.operation) {
      // Process the operation parameters
      return processOperationParameters(metadata, cacheEntry.keys, match, req, res, next, debug);
    } else {
      return next();
    }
  };
};
