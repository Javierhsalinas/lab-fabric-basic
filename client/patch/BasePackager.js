/*
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
 */


'use strict';

const fs = require('fs-extra');
const klaw = require('klaw');
const tar = require('tar-stream');
const path = require('path');
const zlib = require('zlib');
const utils = require('../utils.js');

const logger = utils.getLogger('packager/BasePackager.js');

const BasePackager = class {

    /**
     * Constructor
     *
     * @param {*} [keep] Array of valid source file extensions
     */
    constructor(keep) {
        if (this.constructor === BasePackager) {
            // BasePackager can not be constructed.
            throw new TypeError('Can not construct abstract class.');
        }
        if (this.package === BasePackager.prototype.package) {
            throw new TypeError('Please implement method package from child class');
        }

        this.keep = keep;
    }

    /**
     * All of the files in the directory of request.chaincodePath will be
     * included in an archive file.
     *
     * @param chaincodePath
     * @param metadataPath
     */
    package(chaincodePath, metadataPath) {
        throw new TypeError('Please implement method package from child class');
    }

    /**
     * Given an input 'filePath', recursively parse the filesystem for any files
     * that fit the criteria for being valid chaincode source (ISREG + keep)
     *
     * @param filepath
     */
    findSource(filepath) {
        throw new Error('abstract function called');
    }

    /**
     * Find the metadata descriptor files.
     *
     * @param filePath The top-level directory containing the metadata descriptors.
     * Only files with a ".json" extension will be included in the results.
     * @returns {Promise}
     */
    findMetadataDescriptors(filePath) {
        return new Promise((resolve, reject) => {
            logger.debug('findMetadataDescriptors : start');
            const descriptors = [];
            klaw(filePath)
                .on('data', (entry) => {
                    if (entry.stats.isFile() && this.isMetadata(entry.path)) {

                        const desc = {
                            name: path.join('META-INF', path.relative(filePath, entry.path)).split('\\').join('/'), // for windows style paths
                            fqp: entry.path
                        };
                        logger.debug(' findMetadataDescriptors  :: %j', desc);
                        descriptors.push(desc);
                    }
                })
                .on('error', (error, item) => {
                    logger.error('error while packaging item %j :: %s', item, error);
                    reject(error);
                })
                .on('end', () => {
                    resolve(descriptors);
                });
        });
    }

    /**
     * Predicate function for determining whether a given path should be
     * considered a valid metadata descriptor based entirely on the
     * file extension.
     * @param filePath The top-level directory containing the metadata descriptors.
     * @returns {boolean} Returns true for valid metadata descriptors.
     */
    isMetadata(filePath) {
        const extensions = ['.json'];
        return (extensions.indexOf(path.extname(filePath)) !== -1);
    }

    /**
     * Predicate function for determining whether a given path should be
     * considered valid source code, based entirely on the extension.  It is
     * assumed that other checks for file type (e.g. ISREG) have already been
     * performed.
     * @param filePath
     * @returns {boolean}
     */
    isSource(filePath) {
        return (this.keep.indexOf(path.extname(filePath)) !== -1);
    }

    /**
     * Given an {fqp, name} tuple, generate a tar entry complete with sensible
     * header and populated contents read from the filesystem.
     *
     * @param pack
     * @param desc
     * @returns {Promise}
     */
    packEntry(pack, desc) {
        return new Promise((resolve, reject) => {
            // Use a synchronous read to reduce non-determinism
            const content = fs.readFileSync(desc.fqp);
            if (!content) {
                reject(new Error('failed to read ' + desc.fqp));
            } else {
                // Use a deterministic "zero-time" for all date fields
                const zeroTime = new Date(0);
                const header = {
                    name: desc.name,
                    size: content.size,
                    mode: 0o100644,
                    atime: zeroTime,
                    mtime: zeroTime,
                    ctime: zeroTime
                };

                pack.entry(header, content, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            }
        });
    }

    /**
     * Creates an .tar.gz stream from the provided descriptor entries
     *
     * @param descriptors
     * @param dest
     * @returns {Promise}
     */
    generateTarGz(descriptors, dest) {
        return new Promise(async (resolve, reject) => {
            const pack = tar.pack();
            // Setup the pipeline to compress on the fly and resolve/reject the promise
            pack.pipe(zlib.createGzip()).pipe(dest)
                .on('finish', () => {
                    resolve(true);
                })
                .on('error', (err) => {
                    reject(err);
                });

            // Iterate through each descriptor in the order it was provided and resolve
            // the entry asynchronously.  We will gather results below before
            // finalizing the tarball
            for (const desc of descriptors) {
                try {
                    await this.packEntry(pack, desc);
                } catch (err) {
                    reject(err);
                }
            }

            // Block here until all entries have been gathered, and then finalize the
            // tarball.  This should result in a flush of the entire pipeline before
            // resolving the top-level promise.
            pack.finalize();
        });
    }

};

module.exports = BasePackager;
