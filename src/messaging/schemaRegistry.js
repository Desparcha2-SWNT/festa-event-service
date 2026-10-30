import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Compila el sobre y todos los esquemas de `data` del catálogo de contratos, indexados por
 * routing key (= eventType). No importa de qué dominio venga un mensaje: cualquier eventType
 * conocido tiene su validador, sin que este servicio necesite saber a qué exchange pertenece.
 */
function build(contractsDir) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const validateEnvelope = ajv.compile(readJson(path.join(contractsDir, 'envelope.schema.json')));

  const dataValidators = new Map();
  const eventsDir = path.join(contractsDir, 'events');
  for (const domain of fs.readdirSync(eventsDir)) {
    const domainDir = path.join(eventsDir, domain);
    for (const file of fs.readdirSync(domainDir)) {
      const schema = readJson(path.join(domainDir, file));
      dataValidators.set(schema['x-routing-key'], ajv.compile(schema));
    }
  }

  return {
    validateEnvelope,
    /** El validador de ajv para `data` de ese eventType, o undefined si no hay esquema. */
    getDataValidator: (eventType) => dataValidators.get(eventType),
  };
}

let cached;

/** Se compila una sola vez por proceso: hay ~38 esquemas y no cambian en caliente. */
export function getSchemaRegistry(contractsDir) {
  cached ??= build(contractsDir);
  return cached;
}

export function _resetForTests() {
  cached = undefined;
}
