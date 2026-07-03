import { DefaultOkfToolbox } from '../../src/index.js';
import { FileOkfStore } from '../../src/fs/index.js';
import { OkfSearchEngine } from '../../src/search/index.js';

const store = new FileOkfStore('tests/fixtures/minimal');
const toolbox = new DefaultOkfToolbox(new OkfSearchEngine(store));

console.log(await toolbox.context('completed customer order'));
