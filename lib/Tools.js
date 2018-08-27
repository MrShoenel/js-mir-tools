const fs = require('fs')
, path = require('path')
, fsX = require('fs-extra')
, { tmpdir, cpus } = require('os')
, { parse } = require('fast-xml-parser')
, { ProcessWrapper, Job, JobQueue, mergeObjects } = require('sh.orchestration-tools')
, { createHash } = require('crypto')
, { probeDir } = require('sh.misc-tools')
, crypto = require('crypto')
, aesKey = 'x'
, tmp = tmpdir()
, hash = str => createHash('md5').update(str).digest('hex')
, { AES, enc } = require('crypto-js');



/**
 * @typedef Feature
 * @type {Object}
 * @param {string} name
 * @param {number} dimensionality
 */

/**
 * @typedef SectionFeature
 * @type {Object}
 * @param {string} name
 * @param {string|number|Array.<string|number>} v
 */

/**
 * @typedef Section
 * @type {Array.<SectionFeature>}
 */

/**
 * @typedef ParsedValues
 * @type {{ id: string, features: Array.<string>, sectionVectors: Array.<Array.<number>> }}
 */

/**
 * @typedef DatasetRow
 * @type {Object}
 * @property {string} f the file name
 * @property {string} id the file's ID formatted as binary string
 * @property {Array.<number>} data
 */

/**
 * @typedef Dataset
 * @type {Object}
 * @property {Array.<DatasetRow>} data
 * @property {Array.<string>} features
 */


class Tools {
  /**
   * @param {string} pathTojAudioJar
   * @param {string} pathTojAudioSettings
   */
  constructor(pathTojAudioJar, pathTojAudioSettings, pathToFeatureDefs) {
    this.pathTojAudioJar = path.resolve(pathTojAudioJar);
    this.pathTojAudioSettings = path.resolve(pathTojAudioSettings);
    this.pathToFeatureDefs = path.resolve(pathToFeatureDefs);
  };

  /**
   * @param {string} str
   * @returns {string} as hex-encoded
   */
  static encrypt(str) {
    return enc.Base64.parse(AES.encrypt(str, aesKey).toString()).toString(enc.Hex);
  };

  /**
   * @param {string} hexStr a hex-encoded string to decrypt
   * @returns {string} the decrypted string
   */
  static decrypt(hexStr) {
    return AES.decrypt(enc.Hex.parse(hexStr).toString(enc.Base64), aesKey).toString(enc.Utf8);
  };

  /**
   * @param {string} filePath
   * @returns {Promise.<Array.<Feature>>}
   */
  static parseFeatures(filePath) {
    return new Promise((resolve, reject) => {
      try {
        let data = fs.readFileSync(filePath, { encoding: 'utf8' }).toString();
        const obj = parse(data);

        resolve(obj.feature_key_file.feature.map(f => {
          return {
            name: f.name,
            dimensionality: f.parallel_dimensions
          };
        }));
      } catch (e) {
        reject(e);
      }
    });
  };


  /**
   * @param {string} filePath
   * @param {Array.<Feature>} features
   * @returns {Promise.<ParsedValues>}
   */
  static parseValues(filePath, features) {
    return new Promise((resolve, reject) => {
      try {
        let data = fs.readFileSync(filePath, { encoding: 'utf8' }).toString();
        const obj = parse(data);
        /** @type {Array.<Section>} */
        const sections = obj.feature_vector_file.data_set.section.filter(s => s.feature.length === features.length).map(s => s.feature);

        /** @type {Array.<Array.<number>>} */
        const sectionVectors = sections.map(s => {
          return [].concat(...features.map(f => {
            const idx = s.findIndex(x => x.name === f.name);
            if (idx < 0) {
              throw new Error(`s does not have ${f.name}`);
            }
            if (f.dimensionality > 1 && !Array.isArray(s[idx].v)) {
              throw new Error();
            }

            return (Array.isArray(s[idx].v) ? s[idx].v : [s[idx].v]).map(parseFloat);
          }));
        });

        const featuresExpanded = [].concat(...features.map(f => {
          if (f.dimensionality === 1) {
            return [f.name.replace(/\s+/g, '_')];
          }

          return Array(f.dimensionality).fill().map((_, idx) => {
            return f.name.replace(/\s+/g, '_') + `_${idx}`;
          });
        }));

        // Just a check..
        sectionVectors.forEach(v => {
          if (v.length !== featuresExpanded.length) {
            throw new Error();
          };
        });

        resolve({
          id: obj.feature_vector_file.data_set.data_set_id,
          features: featuresExpanded,
          sectionVectors
        });
      } catch (e) {
        reject(e);
      }
    });
  };


  /**
   * 
   * @param {string} filePath
   * @param {Array.<Feature>} features
   * @returns {Promise.<ParsedValues>}
   */
  async analyzeSong(filePath, features) {
    const hashed = `${hash(path.basename(filePath))}_`
    , xmlPath = path.join(tmp, hashed)
    , xmlResultPath = path.join(tmp, `${hashed}FV.xml`)
    , xmlResultFKPath = path.join(tmp, `${hashed}FK.xml`);

    const pw = new ProcessWrapper('java', [
      '-jar', this.pathTojAudioJar,
      '-s', this.pathTojAudioSettings,
      xmlPath,
      filePath
    ], {
      cwd: path.dirname(this.pathTojAudioJar)
    });

    try {
      await pw.run(false);
      return await Tools.parseValues(xmlResultPath, features);
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      try {
        fs.unlinkSync(xmlResultPath);
        fs.unlinkSync(xmlResultFKPath);
      } catch (e) { }
    }
  };

  /**
   * @param {string} dir 
   * @param {string} targetDir 
   * @param {Array.<Feature>} features 
   * @param {number} [numParallel] Defaults to os.cpus().length
   */
  async analyzeMany(dir, targetDir, features, numParallel = null) {
    numParallel = numParallel === null ? cpus().length : numParallel;

    const queue = new JobQueue(numParallel).pause()
    , jobs = fs.readdirSync(path.resolve(dir)).filter(f => /\.[a-z0-9]+$/i.test(f)).map(f => {
      return new Job(async() => {
        try {
          const targetFile = path.resolve(path.join(targetDir, `${path.basename(f)}.json`));
          if (fs.existsSync(targetFile)) {
            console.info(`SKIP: ${f}`);
            return;
          }
          const r = await this.analyzeSong(
            path.resolve(path.join(dir, f)), features);
          fs.writeFileSync(targetFile, JSON.stringify(r));
          console.log(`Track done: ${f}`);
        } catch (e) {
          console.error(`FAILED: ${f}`);
        }
      });
    });

    jobs.forEach(j => queue.addJob(j));

    await queue.runToCompletion();
  };

  /**
   * Generates random and unique array indexes.
   * 
   * @param {number} amount The amount of random indexes
   * @param {number} maxIdxExcl The maximum exclusive index
   * @returns {Array.<number>}
   */
  static getRandomIndexes(amount, maxIdxExcl) {
    const s = new Set();

    while (s.size < amount) {
      s.add(Tools.randomUint % maxIdxExcl);
    }

    return [...s.values()];
  };

  /**
   * @returns {number} An positive 32-bit integer.
   */
  static get randomUint() {
    return Math.abs(crypto.randomBytes(4).readInt32LE(0));
  };
  
  /**
   * srcDir is the directory with the JSONs from the analysis.
   * targetDir is where to store the dataset
   * 
   * @param {{ srcDir: string, targetDir: string, numFiles: number, numSectionsTrain: number, numSectionsValidate: number }} opts
   * @returns {Promise.<{ training: Dataset, validate: Dataset }>}
   */
  static async createDataset(opts) {
    const numBits = Math.ceil(Math.log(opts.numFiles) / Math.log(2));
    let files = (await probeDir(opts.srcDir))
      .filter(f => /\.json$/i.test(f))
      .sort((a, b) => Tools.randomUint % 2 === 0 ? -1 : 1);

    if (opts.numFiles < files.length) {
      files = files.slice(0, opts.numFiles);
    }

    /** @type {Array.<string>} */
    let features = [];

    const train = [], validate = [];
    files.forEach((f, idx) => {
      const fId = idx.toString(2).padStart(numBits, '0');
      /** @type {ParsedValues} */
      const pv = JSON.parse(fs.readFileSync(
        path.resolve(path.join(opts.srcDir, f))).toString('utf8'));

      if (features.length === 0) {
        features = pv.features;
      }

      const sectionIndexes = Tools.getRandomIndexes(
        opts.numSectionsTrain + opts.numSectionsValidate,
        pv.sectionVectors.length);

      let i = 0;
      while (i < sectionIndexes.length) {
        /** @type {Dataset} */
        let arr = i < opts.numSectionsTrain ? train : validate;
        arr.push({
          f,
          id: `b${fId}`,
          data: pv.sectionVectors[sectionIndexes[i]]
        });
        i++;
      }
    });

    return {
      training: {
        data: train,
        features
      },
      validate: {
        data: validate,
        features
      }
    };
  };

  /**
   * @param {Dataset} dataset 
   * @param {string} targetFile 
   */
  static writeDatasetToCsv(dataset, targetFile) {
    /** @type {Array.<string>} */
    let rows = [];

    dataset.data.forEach(row => {
      rows.push([ row.id, Tools.encrypt(row.f)/*, row.f.replace(/[^a-z0-9-_\.\s]/gi, '')*/ ].concat(row.data).join(','));
    });

    rows = rows.sort((a, b) => Tools.randomUint % 2 === 0 ? -1 : 1);
    rows.unshift(['id', 'file_b64'].concat(dataset.features).join(','));

    fs.writeFileSync(targetFile, rows.join("\n"));
  };

  /**
   * @param {Dataset} dataset 
   * @param {string} targetFile 
   */
  static writeDatasetToJson(dataset, targetFile) {
    /** @type {Dataset} */
    const newDs = mergeObjects({}, dataset);
    newDs.data = dataset.data.map(row => {
      return {
        f: Tools.encrypt(row.f),
        id: row.id,
        data: row.data
      };
    });
    fs.writeFileSync(targetFile, JSON.stringify(newDs));
  };

  /**
   * @param {string} file
   * @returns {Dataset}
   */
  static readDatasetFromJson(file) {
    return JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }));
  };

  /**
   * @param {string} ffmpeg path to ffmpeg
   * @param {string} tracksDir directory with audio files
   * @param {string} dir output directory of samples
   * @param {Dataset} dataset 
   * @param {number} sampleLengthMs 
   * @param {number} numSamplesPerTrack 
   */
  static async createListenSamples(ffmpeg, tracksDir, dir, dataset, sampleLengthMs, numSamplesPerTrack) {
    if (fs.existsSync(dir)) {
      fsX.removeSync(dir);
    }
    fsX.mkdirp(dir);

    const audioFiles = [...new Set(dataset.data.map(row => Tools.decrypt(row.f)))].map(af => af.replace(/\.json$/i, ''));
    /* Info:
     * - Each track is 60 seconds, so we choose samples in range [0, 60e3-sampleLengthMs]
     * - We do not want overlapping samples
     * - choosing a sample at 0 is fine, since the 60 seconds samples were generated after seeking 30 seconds into the file
     * - We have to divide 60e3 by the sampleLengthMs to get the amount of valid offsets (and then subtract 1) -> e.g. if sampleLengthMs = 500, we get 120 possible offsets without overlaps, with the last one being invalid.
     */

    const randomIndexes = Tools.getRandomIndexes(numSamplesPerTrack, Math.floor(60e3 / sampleLengthMs) - 1);

    /** @type {Array.<Job>} */
    const jobs = [];

    for (const audioFile of audioFiles) {
      const audioFileEnc = Tools.encrypt(audioFile);
      let i = 0;
      while (i < randomIndexes.length) {
        const seekSeconds = Math.floor((randomIndexes[i] * sampleLengthMs) / 1e3)
        , seekMs = randomIndexes[i] * sampleLengthMs - (seekSeconds * 1e3);
        const pw = new ProcessWrapper(ffmpeg, [
          '-ss', `00:00:${seekSeconds.toString().padStart(2, '0')}.${seekMs.toString().padStart(3, '0')}`,
          '-i', path.resolve(path.join(tracksDir, audioFile)),
          '-map', '0:a',
          '-c:a', 'copy',
          '-map_metadata', '-1',
          '-t', `${(Math.floor(sampleLengthMs / 1e3))}.${sampleLengthMs.toString().padStart(3, '0')}`,
          path.resolve(path.join(dir, `${audioFileEnc}_${i.toString().padStart(3, '0')}.mp3`))
        ]);

        jobs.push(Job.fromProcess(pw));
        i++;
      }
    }

    const queue = new JobQueue(cpus().length);
    queue.addJobs(...jobs);
    await queue.runToCompletion();
  };
};


module.exports = Object.freeze({
  Tools
});
