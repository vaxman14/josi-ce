import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const base=resolve('artifacts/windows-native');
const metadata=JSON.parse(await readFile(join(base,'evidence/release-metadata.json'),'utf8'));
const toolRoot=join(base,'tools/sbom-validator');
const require=createRequire(join(toolRoot,'package.json'));
const Ajv=require('ajv');
const addFormats=require('ajv-formats');
const addInternationalFormats=require('ajv-formats-draft2019');
assert.equal(require('ajv/package.json').version,'8.20.0');
assert.equal(require('ajv-formats/package.json').version,'3.0.1');
assert.equal(require('ajv-formats-draft2019/package.json').version,'1.6.1');
const ajv=new Ajv({strict:false,allErrors:true,validateFormats:true});
addFormats(ajv);
addInternationalFormats(ajv);
const schemas=join(base,'cache/cyclonedx-1.6');
const inventory=JSON.parse(await readFile(join(schemas,'inventory.json'),'utf8'));
const schemaFormats=new Set();
function inspectFormats(value){if(!value||typeof value!=='object')return;if(typeof value.format==='string')schemaFormats.add(value.format);for(const child of Object.values(value))inspectFormats(child);}
for(const file of inventory){const bytes=await readFile(join(schemas,file.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);const schema=JSON.parse(bytes);inspectFormats(schema);ajv.addSchema(schema);}
for(const format of schemaFormats)assert.ok(ajv.formats[format],`Unsupported schema format: ${format}`);
const bom=JSON.parse(await readFile(join(metadata.output,'windows.cdx.json'),'utf8'));
const validate=ajv.getSchema('http://cyclonedx.org/schema/bom-1.6.schema.json');
const valid=validate(bom);
const errors=structuredClone(validate.errors??[]);
// Exercise format validation, rather than just accepting a valid generated BOM.
const malformed=structuredClone(bom);malformed.serialNumber='this is not a URI';
assert.equal(validate(malformed),false,'Malformed serial URI was accepted');
const invalidTime=structuredClone(bom);invalidTime.metadata.timestamp='not-a-date';
assert.equal(validate(invalidTime),false,'Malformed timestamp was accepted');
const refs=new Set([bom.metadata.component['bom-ref'],...bom.components.map(item=>item['bom-ref'])]);
const unresolved=[];
for(const dependency of bom.dependencies??[]){for(const ref of [dependency.ref,...dependency.dependsOn??[]])if(!refs.has(ref))unresolved.push(ref);}
const unique=refs.size===bom.components.length+1;
const report={passed:Boolean(valid)&&!unresolved.length&&unique,officialSchemaStructuralValidation:Boolean(valid),formatAnnotationsValidated:true,
  componentIdentitiesUnique:refs.size===bom.components.length+1,dependencyGraphReferencesResolved:!unresolved.length,
  unresolvedReferences:[...new Set(unresolved)],errors,components:bom.components.length,notices:metadata.noticesVerified,
  invalidUriRefused:true,invalidTimestampRefused:true,schemaFormats:[...schemaFormats].sort(),validatorVersions:{ajv:'8.20.0',ajvFormats:'3.0.1',ajvInternationalFormats:'1.6.1'},
  validatorLockSha256:createHash('sha256').update(await readFile(join(toolRoot,'package-lock.json'))).digest('hex'),
  licenseGatePassed:metadata.licenseGatePassed,schemaInventory:inventory,recordedAt:new Date().toISOString()};
await writeFile(join(base,'evidence/release-sbom-validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,components:report.components,errors:report.errors.map(item=>({path:item.instancePath,message:item.message})),unresolvedReferences:report.unresolvedReferences},null,2));
assert.ok(report.passed,'SBOM validation failed; do not mark the release gate accepted');
