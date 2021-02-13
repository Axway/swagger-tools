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
const debug = require('debug')('swagger-tools:middleware');
const { printValidationResults, getSpec } = require('./lib/helpers');

function initializeMiddleware (rlOrSO, resources, callback) {
  debug('Initializing middleware');

  if (_.isUndefined(rlOrSO)) {
    throw new Error('rlOrSO is required');
  } else if (!_.isPlainObject(rlOrSO)) {
    throw new TypeError('rlOrSO must be an object');
  }

  const args = [rlOrSO];
  const spec = getSpec();

  debug('  Identified Swagger version: %s', spec.version);
  
  callback = arguments[1];

  if (_.isUndefined(callback)) {
    throw new Error('callback is required');
  } else if (!_.isFunction(callback)) {
    throw new TypeError('callback must be a function');
  }

  args.push((err, results) => {
    if (results && results.errors.length + _.reduce(results.apiDeclarations || [], (count, apiDeclaration) => {
      return count += (apiDeclaration ? apiDeclaration.errors.length : 0);
    }, 0) > 0) {
      err = new Error('Swagger document(s) failed validation so the server cannot start');
      err.failedValidation = true;
      err.results = results;
    }

    debug('  Validation: %s', err ? 'failed' : 'succeeded');

    try {
      if (err) {
        throw err;
      }

      callback({
        // Create a wrapper to avoid having to pass the non-optional arguments back to the swaggerMetadata middleware
        swaggerMetadata: () => {
          const swaggerMetadata = require('./middleware/swagger-metadata');
          return swaggerMetadata.apply(undefined, args.slice(0, args.length - 1));
        },
        swaggerRouter: require('./middleware/swagger-router'),
        swaggerSecurity: require('./middleware/swagger-security'),
        swaggerValidator: require('./middleware/swagger-validator')
      });
    } catch (err) {
      if (process.env.RUNNING_SWAGGER_TOOLS_TESTS === 'true') {
        // When running the swagger-tools test suite, we want to return an error instead of exiting the process.  This
        // does not mean that this function is an error-first callback but due to json-refs using Promises, we have to
        // return the error to avoid the error being swallowed.
        callback(err);
      } else {
        if (err.failedValidation === true) {
          printValidationResults(rlOrSO, resources, results, true);
        } else {
          console.error('Error initializing middleware');
          console.error(err.stack);
        }

        process.exit(1);
      }
    }
  });

  spec.validate.apply(spec, args);
};

module.exports = {
  initializeMiddleware,
  specs: require('./lib/specs')
};
