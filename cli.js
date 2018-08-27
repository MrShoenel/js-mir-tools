/**
 * Note that this file was used by me directly and changed as I needed it.
 * But you should be able to get a glimpse how these tools work and what
 * they can do for you.
 * 
 * You'll find a web-tool in ./web/decode-names.html to help you with de-
 * coding AES-encrypted file-names. File names were encrypted so you don't
 * cheat on yourself when conducting experiments.
 */

const { Tools } = require('./lib/Tools')
, path = require('path');


const t = setTimeout(()=> { }, 999999)
, settingsFile = path.resolve(
    path.join(__dirname, './jAudio/settings.xml'))
, featDefFile = path.resolve(
    path.join(__dirname, './jAudio/feature_definitions_1.xml'));

const analyzeMany = async() => {
  const features = await Tools.parseFeatures(featDefFile);
  const t = new Tools(
    'C:\\temp\\jAudio\\jAudio.jar',
    settingsFile,
    featDefFile
  );

  await t.analyzeMany(
    'C:\\temp\\short',
    'C:\\temp\\json',
    features);
};

const createDatasets = async() => {
  const sets = await Tools.createDataset({
    srcDir: 'C:\\temp\\json',
    targetDir: 'C:\\temp',
    numFiles: 25,
    numSectionsTrain: 256, // 4,8,16,32,64,128
    numSectionsValidate: 0 // We're doing cross-validation so there's no need for it
  });
  
  Tools.writeDatasetToCsv(sets.training, 'C:\\temp\\training.csv');
  Tools.writeDatasetToJson(sets.training, 'C:\\temp\\training.json');
  
  // We're doing cross-validation so there's no need for it
  // Tools.writeDatasetToCsv(sets.validate, 'C:\\temp\\validate.csv');
  // Tools.writeDatasetToJson(sets.validate, 'C:\\temp\\validate.json');
};

const createListenSamples = async() => {
  await Tools.createListenSamples(
    'C:\\temp\\ffmpeg\\ffmpeg.exe',
    'C:\\temp\\short',
    'C:\\temp\\listenSamples',
    Tools.readDatasetFromJson('C:\\temp\\training.json'),
    Math.round(750),
    // 512,256,128,64,32,16
    // 40, 80, 120, 160, 200, 240
    // 50, 100, 150, 200, 250, 300
    11);
};




(async() => {
  try {
    await createDatasets();
    // await createListenSamples();
  } catch (e) {
    console.error(e);
  } finally {
    clearTimeout(t);
  }
})();
