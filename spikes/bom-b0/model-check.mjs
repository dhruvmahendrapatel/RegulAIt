// B0 item 1: does @cyclonedx/cyclonedx-library 10.3.0 represent the ML-BOM fields ADR-0189 needs?
// Checked at RUNTIME, three ways: (a) the fields on constructed model instances and their prototypes,
// (b) whether the library's own JSON serializer emits a field if we force it onto an instance,
// (c) whether the library's own strict JSON validator runs without the unadmitted ajv-formats-draft2019.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CDX = require('@cyclonedx/cyclonedx-library');
const pkg = require('@cyclonedx/cyclonedx-library/package.json');
const { Models, Enums, Spec, Serialize, Validation } = CDX;

const fieldsOf = (o) => {
  const names = new Set(Object.getOwnPropertyNames(o));
  for (let p = Object.getPrototypeOf(o); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== 'constructor') names.add(n);
  }
  return [...names].map((n) => n.replace(/^#/, '')).sort();
};

const bom = new Models.Bom();
const model = new Models.Component(Enums.ComponentType.MachineLearningModel, 'example-model', { bomRef: 'model-1', version: '2026-01' });
const dataset = new Models.Component(Enums.ComponentType.Data, 'example-dataset', { bomRef: 'dataset-1' });
const service = new Models.Service('example-endpoint', { bomRef: 'svc-1' });

const wanted = {
  Bom: ['formulation', 'declarations', 'definitions', 'compositions', 'annotations', 'externalReferences'],
  Component: ['modelCard', 'data', 'omniborId', 'swhid', 'manufacturer', 'authors', 'tags'],
  Service: ['endpoints', 'data', 'trustZone', 'authenticated', 'x-trust-boundary'],
};
const seen = { Bom: fieldsOf(bom), Component: fieldsOf(model), Service: fieldsOf(service) };
const absent = Object.fromEntries(Object.entries(wanted).map(([k, list]) => [k, list.filter((f) => !seen[k].includes(f))]));
const present = Object.fromEntries(Object.entries(wanted).map(([k, list]) => [k, list.filter((f) => seen[k].includes(f))]));

// (b) force the fields onto instances and serialize with the library's own 1.7 normalizer
// positive control: a field the model DOES know, set the same way, must survive serialization
model.description = 'control-description';
model.modelCard = { considerations: { useCases: ['x'] } };
dataset.data = [{ type: 'dataset', name: 'd' }];
service.data = [{ flow: 'outbound', classification: 'confidential' }];
service.endpoints = ['https://example.invalid/v1'];
bom.declarations = { attestations: [] };
bom.formulation = [];
bom.compositions = [{ aggregate: 'incomplete' }];
bom.components.add(model);
bom.components.add(dataset);
bom.services.add(service);
bom.serialNumber = 'urn:uuid:00000000-0000-4000-8000-000000000000';
const serializer = new Serialize.JsonSerializer(new Serialize.JSON.Normalize.Factory(Spec.Spec1dot7));
const json = JSON.parse(serializer.serialize(bom, { sortLists: true }));
const out = {
  bomKeys: Object.keys(json).sort(),
  modelComponentKeys: Object.keys(json.components.find((c) => c['bom-ref'] === 'model-1')).sort(),
  dataComponentKeys: Object.keys(json.components.find((c) => c['bom-ref'] === 'dataset-1')).sort(),
  serviceKeys: Object.keys(json.services[0]).sort(),
};
const positiveControlEmitted = json.components.find((c) => c['bom-ref'] === 'model-1').description === 'control-description';
const droppedOnSerialize = {
  modelCard: !('modelCard' in json.components.find((c) => c['bom-ref'] === 'model-1')),
  componentData: !('data' in json.components.find((c) => c['bom-ref'] === 'dataset-1')),
  serviceData: !('data' in json.services[0]),
  serviceEndpoints: !('endpoints' in json.services[0]),
  declarations: !('declarations' in json),
  formulation: !('formulation' in json),
  compositions: !('compositions' in json),
};

// (c) the library's own strict JSON validator, without ajv-formats-draft2019 installed
let validatorResult;
try {
  const v = new Validation.JsonStrictValidator(Spec.Version.v1dot7);
  await v.validate(JSON.stringify(json));
  validatorResult = 'ran';
} catch (e) {
  validatorResult = `${e.constructor.name}: ${String(e.message).split('\n')[0]}`;
}

const externalReferenceTypeHasModelCard = Object.values(Enums.ExternalReferenceType).includes('model-card');

const result = {
  library: `${pkg.name}@${pkg.version}`,
  node: process.version,
  fieldsSeen: seen,
  absent,
  present,
  serializedKeys: out,
  positiveControlEmitted,
  droppedOnSerialize,
  externalReferenceTypeHasModelCard,
  libraryStrictJsonValidator: validatorResult,
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
